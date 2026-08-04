import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type PiSettings,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { ProviderAdapterShape, ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import { piSessionArgs } from "./PiProvider.ts";
import {
  makePiRpcTransport,
  type PiRpcEvent,
  type PiRpcResponse,
  type PiRpcTransport,
} from "./PiRpcTransport.ts";

const PROVIDER = ProviderDriverKind.make("piAgent");
const RESUME_SCHEMA_VERSION = 1 as const;

interface PiSessionContext {
  session: ProviderSession;
  sessionId: string;
  readonly scope: Scope.Closeable;
  readonly transport: PiRpcTransport;
  activeTurnId: TurnId | undefined;
  interrupted: boolean;
  failed: boolean;
  stopped: boolean;
  readonly startedItems: Set<string>;
  readonly emittedToolOutput: Map<string, string>;
}

type PiAdapterError =
  | ProviderAdapterRequestError
  | ProviderAdapterSessionNotFoundError
  | ProviderAdapterValidationError;

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function responseData(response: PiRpcResponse): Readonly<Record<string, unknown>> {
  return record(response.data) ?? {};
}

function parseResumeCursor(raw: unknown): string | undefined {
  const value = record(raw);
  return value?.schemaVersion === RESUME_SCHEMA_VERSION && typeof value.sessionId === "string"
    ? value.sessionId.trim() || undefined
    : undefined;
}

function splitModel(model: string): { provider: string; modelId: string } | undefined {
  const slash = model.indexOf("/");
  return slash > 0 && slash < model.length - 1
    ? { provider: model.slice(0, slash), modelId: model.slice(slash + 1) }
    : undefined;
}

function toolItemType(name: string) {
  if (name === "bash") return "command_execution" as const;
  if (name === "edit" || name === "write") return "file_change" as const;
  return "dynamic_tool_call" as const;
}

function toolText(value: unknown): string {
  const result = record(value);
  const content = result?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const item = record(part);
      return item?.type === "text" && typeof item.text === "string" ? item.text : "";
    })
    .join("");
}

export function newOutputSuffix(previous: string | undefined, next: string): string {
  if (!previous) return next;
  if (next.startsWith(previous)) return next.slice(previous.length);
  return next;
}

export function piTokenUsageFromStats(data: Readonly<Record<string, unknown>>): {
  usedTokens: number;
  totalProcessedTokens: number;
} {
  const tokens = record(data.tokens) ?? {};
  const contextUsage = record(data.contextUsage) ?? {};
  const totalProcessedTokens =
    typeof tokens.total === "number"
      ? tokens.total
      : typeof tokens.input === "number" && typeof tokens.output === "number"
        ? tokens.input + tokens.output
        : 0;
  const usedTokens =
    typeof contextUsage.tokens === "number" ? contextUsage.tokens : totalProcessedTokens;
  return { usedTokens, totalProcessedTokens };
}

function entriesToSnapshot(threadId: ThreadId, response: PiRpcResponse): ProviderThreadSnapshot {
  const entries = responseData(response).entries;
  if (!Array.isArray(entries)) return { threadId, turns: [] };
  const turns: Array<{ id: TurnId; items: Array<unknown> }> = [];
  for (const entry of entries) {
    const value = record(entry);
    const message = record(value?.message);
    if (value?.type === "message" && message?.role === "user") {
      const id = typeof value.id === "string" ? value.id : `pi-turn-${turns.length + 1}`;
      turns.push({ id: TurnId.make(id), items: [entry] });
    } else if (turns.length > 0) {
      turns.at(-1)?.items.push(entry);
    }
  }
  return { threadId, turns };
}

export const makePiAdapter = Effect.fn("makePiAdapter")(function* (
  settings: PiSettings,
  options: {
    readonly instanceId: ProviderInstanceId;
    readonly environment?: NodeJS.ProcessEnv;
  },
) {
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serverConfig = yield* ServerConfig;
  const adapterScope = yield* Scope.Scope;
  const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, PiSessionContext>();
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const randomUuid = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "crypto/randomUUIDv4",
          detail: "Failed to generate a Pi runtime identifier.",
          cause,
        }),
    ),
  );

  const stamp = (context: PiSessionContext, raw?: PiRpcEvent) =>
    Effect.all({ eventId: randomUuid.pipe(Effect.map(EventId.make)), createdAt: nowIso }).pipe(
      Effect.map((base) => ({
        ...base,
        provider: PROVIDER,
        providerInstanceId: options.instanceId,
        threadId: context.session.threadId,
        ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
        ...(raw ? { raw: { source: "pi.rpc.event" as const, payload: raw } } : {}),
      })),
    );
  const emit = (event: ProviderRuntimeEvent) => Queue.offer(events, event).pipe(Effect.asVoid);
  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<PiSessionContext, ProviderAdapterSessionNotFoundError> => {
    const context = sessions.get(threadId);
    if (context && !context.stopped) return Effect.succeed(context);
    return Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
  };
  const rpcRequest = (
    transport: PiRpcTransport,
    command: Readonly<Record<string, unknown>> & { readonly type: string },
  ): Effect.Effect<PiRpcResponse, ProviderAdapterRequestError> =>
    transport.request(command).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: command.type,
            detail: cause.message,
            cause,
          }),
      ),
    );

  const emitItemStart = (context: PiSessionContext, itemId: string, payload: unknown) =>
    context.startedItems.has(itemId)
      ? Effect.void
      : Effect.gen(function* () {
          context.startedItems.add(itemId);
          yield* emit({
            ...(yield* stamp(context)),
            type: "item.started",
            itemId: RuntimeItemId.make(itemId),
            payload,
          } as ProviderRuntimeEvent);
        });

  const handleEvent = (context: PiSessionContext, event: PiRpcEvent) =>
    Effect.gen(function* () {
      const turnId = context.activeTurnId;
      if (!turnId && !["agent_start", "agent_settled"].includes(event.type)) return;
      const base = yield* stamp(context, event);

      if (event.type === "message_update") {
        const update = record(event.assistantMessageEvent);
        if (!update) return;
        const kind = update?.type;
        const index = typeof update?.contentIndex === "number" ? update.contentIndex : 0;
        if (kind === "text_delta" || kind === "thinking_delta") {
          const itemId = `${turnId}:${kind === "text_delta" ? "assistant" : "reasoning"}:${index}`;
          yield* emitItemStart(context, itemId, {
            itemType: kind === "text_delta" ? "assistant_message" : "reasoning",
            status: "inProgress",
          });
          if (typeof update.delta === "string" && update.delta.length > 0) {
            yield* emit({
              ...base,
              type: "content.delta",
              itemId: RuntimeItemId.make(itemId),
              payload: {
                streamKind: kind === "text_delta" ? "assistant_text" : "reasoning_text",
                delta: update.delta,
                contentIndex: index,
              },
            });
          }
        } else if (kind === "text_end" || kind === "thinking_end") {
          const itemId = `${turnId}:${kind === "text_end" ? "assistant" : "reasoning"}:${index}`;
          yield* emitItemStart(context, itemId, {
            itemType: kind === "text_end" ? "assistant_message" : "reasoning",
            status: "inProgress",
          });
          yield* emit({
            ...base,
            type: "item.completed",
            itemId: RuntimeItemId.make(itemId),
            payload: {
              itemType: kind === "text_end" ? "assistant_message" : "reasoning",
              status: "completed",
            },
          });
        } else if (kind === "error") {
          context.failed = true;
          yield* emit({
            ...base,
            type: "runtime.error",
            payload: {
              message: "Pi Agent failed while generating a response.",
              class: "provider_error",
            },
          });
        }
        return;
      }

      if (event.type === "tool_execution_start") {
        const callId =
          typeof event.toolCallId === "string" ? event.toolCallId : `pi-tool-${turnId}`;
        const name = typeof event.toolName === "string" ? event.toolName : "tool";
        yield* emitItemStart(context, callId, {
          itemType: toolItemType(name),
          status: "inProgress",
          title: name,
          data: event.args,
        });
        return;
      }

      if (event.type === "tool_execution_update" || event.type === "tool_execution_end") {
        const callId =
          typeof event.toolCallId === "string" ? event.toolCallId : `pi-tool-${turnId}`;
        const name = typeof event.toolName === "string" ? event.toolName : "tool";
        const result = event.type === "tool_execution_update" ? event.partialResult : event.result;
        const output = toolText(result);
        const delta = newOutputSuffix(context.emittedToolOutput.get(callId), output);
        context.emittedToolOutput.set(callId, output);
        if (delta.length > 0) {
          yield* emit({
            ...base,
            type: "content.delta",
            itemId: RuntimeItemId.make(callId),
            payload: {
              streamKind:
                name === "bash"
                  ? "command_output"
                  : name === "edit" || name === "write"
                    ? "file_change_output"
                    : "unknown",
              delta,
            },
          });
        }
        if (event.type === "tool_execution_end") {
          yield* emit({
            ...base,
            type: "item.completed",
            itemId: RuntimeItemId.make(callId),
            payload: {
              itemType: toolItemType(name),
              status: event.isError === true ? "failed" : "completed",
              title: name,
              ...(output.trim() ? { detail: output.trim() } : {}),
            },
          });
        }
        return;
      }

      if (event.type === "compaction_start" || event.type === "compaction_end") {
        const itemId = `${turnId}:compaction`;
        yield* emit({
          ...base,
          type: event.type === "compaction_start" ? "item.started" : "item.completed",
          itemId: RuntimeItemId.make(itemId),
          payload: {
            itemType: "context_compaction",
            status: event.type === "compaction_start" ? "inProgress" : "completed",
            title: "Context compaction",
            data: event.result,
          },
        } as ProviderRuntimeEvent);
        return;
      }

      if (event.type.startsWith("auto_retry") || event.type.startsWith("summarization_retry")) {
        yield* emit({
          ...base,
          type: "runtime.warning",
          payload: { message: "Pi Agent is retrying the request.", detail: event },
        });
        return;
      }

      if (event.type === "extension_error") {
        context.failed = true;
        yield* emit({
          ...base,
          type: "runtime.error",
          payload: {
            message:
              typeof event.error === "string"
                ? event.error
                : "Pi Agent reported an extension runtime error.",
            class: "provider_error",
          },
        });
        return;
      }

      if (event.type === "agent_settled" && turnId) {
        const completedAt = yield* nowIso;
        const state = context.interrupted ? "interrupted" : context.failed ? "failed" : "completed";
        const { activeTurnId: _active, ...ready } = context.session;
        context.session = { ...ready, status: "ready", updatedAt: completedAt };
        context.activeTurnId = undefined;
        context.interrupted = false;
        context.failed = false;
        yield* emit({ ...base, type: "turn.completed", payload: { state } });

        const stats = yield* rpcRequest(context.transport, { type: "get_session_stats" }).pipe(
          Effect.option,
        );
        if (Option.isSome(stats)) {
          const data = responseData(stats.value);
          yield* emit({
            ...(yield* stamp(context)),
            type: "thread.token-usage.updated",
            payload: { usage: piTokenUsageFromStats(data) },
          });
        }
      }
    });

  const stopContext = (context: PiSessionContext) =>
    Effect.gen(function* () {
      if (context.stopped) return;
      context.stopped = true;
      sessions.delete(context.session.threadId);
      yield* context.transport.close.pipe(Effect.ignore);
      yield* Scope.close(context.scope, Exit.void).pipe(Effect.ignore);
    });

  const startSession: ProviderAdapterShape<PiAdapterError>["startSession"] = (input) =>
    Effect.gen(function* () {
      if (input.runtimeMode !== "full-access") {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: "Pi Agent supports Full access only.",
        });
      }
      const existing = sessions.get(input.threadId);
      if (existing && !existing.stopped) return existing.session;
      const cwd = input.cwd ?? serverConfig.cwd;
      const sessionId = parseResumeCursor(input.resumeCursor) ?? (yield* randomUuid);
      const sessionScope = yield* Scope.make();
      const transport = yield* makePiRpcTransport({
        binaryPath: settings.binaryPath || "pi",
        args: piSessionArgs(sessionId),
        cwd,
        env: {
          ...options.environment,
          PI_TELEMETRY: "0",
          PI_SKIP_VERSION_CHECK: "1",
        },
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(Scope.Scope, sessionScope),
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/start",
              detail: cause.message,
              cause,
            }),
        ),
      );
      const model = input.modelSelection?.model;
      if (model) {
        const selection = splitModel(model);
        if (!selection) {
          yield* Scope.close(sessionScope, Exit.void);
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Invalid Pi model slug: ${model}.`,
          });
        }
        yield* rpcRequest(transport, { type: "set_model", ...selection });
      }
      yield* rpcRequest(transport, { type: "get_state" });
      if (parseResumeCursor(input.resumeCursor)) {
        yield* rpcRequest(transport, { type: "get_entries" });
      }
      const now = yield* nowIso;
      const session: ProviderSession = {
        provider: PROVIDER,
        providerInstanceId: options.instanceId,
        status: "ready",
        runtimeMode: "full-access",
        cwd,
        ...(model ? { model } : {}),
        threadId: input.threadId,
        resumeCursor: { schemaVersion: RESUME_SCHEMA_VERSION, sessionId },
        createdAt: now,
        updatedAt: now,
      };
      const context: PiSessionContext = {
        session,
        sessionId,
        scope: sessionScope,
        transport,
        activeTurnId: undefined,
        interrupted: false,
        failed: false,
        stopped: false,
        startedItems: new Set(),
        emittedToolOutput: new Map(),
      };
      sessions.set(input.threadId, context);
      yield* transport.events.pipe(
        Stream.runForEach((event) => handleEvent(context, event)),
        Effect.catchCause((cause) => Effect.logError("Pi RPC event processing failed.", { cause })),
        Effect.forkIn(sessionScope),
      );
      yield* transport.exitCode.pipe(
        Effect.flatMap((code) =>
          Effect.gen(function* () {
            if (context.stopped) return;
            context.stopped = true;
            sessions.delete(context.session.threadId);
            const stderr = (yield* context.transport.stderr).trim();
            const message = stderr || `Pi Agent exited with code ${code}.`;
            if (context.activeTurnId) {
              yield* emit({
                ...(yield* stamp(context)),
                type: "turn.completed",
                payload: { state: "failed" },
              });
            }
            yield* emit({
              ...(yield* stamp(context)),
              type: "runtime.error",
              payload: { message, class: "transport_error" },
            });
            yield* emit({
              ...(yield* stamp(context)),
              type: "session.exited",
              payload: { reason: message, recoverable: false, exitKind: "error" },
            });
          }),
        ),
        Effect.catch((cause) => Effect.logError("Pi RPC exit watcher failed.", { cause })),
        Effect.forkIn(sessionScope),
      );
      yield* emit({
        ...(yield* stamp(context)),
        type: "session.started",
        payload: { resume: session.resumeCursor },
      });
      yield* emit({
        ...(yield* stamp(context)),
        type: "session.state.changed",
        payload: { state: "ready", reason: "Pi RPC session ready" },
      });
      yield* emit({
        ...(yield* stamp(context)),
        type: "thread.started",
        payload: { providerThreadId: sessionId },
      });
      return session;
    });

  const sendTurn: ProviderAdapterShape<PiAdapterError>["sendTurn"] = (input) =>
    Effect.gen(function* () {
      const context = yield* requireSession(input.threadId);
      if (input.interactionMode === "plan") {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "Pi Agent does not support plan interaction mode.",
        });
      }
      const message = input.input?.trim() ?? "";
      const images = yield* Effect.forEach(input.attachments ?? [], (attachment) =>
        Effect.gen(function* () {
          const path = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          if (!path) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: `Invalid attachment id '${attachment.id}'.`,
            });
          }
          const bytes = yield* fileSystem.readFile(path).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "attachment/read",
                  detail: cause.message,
                  cause,
                }),
            ),
          );
          return {
            type: "image",
            data: Buffer.from(bytes).toString("base64"),
            mimeType: attachment.mimeType,
          };
        }),
      );
      if (!message && images.length === 0) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "Turn requires non-empty text or attachments.",
        });
      }
      if (input.modelSelection?.model && input.modelSelection.model !== context.session.model) {
        const selection = splitModel(input.modelSelection.model);
        if (!selection) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: `Invalid Pi model slug: ${input.modelSelection.model}.`,
          });
        }
        yield* rpcRequest(context.transport, { type: "set_model", ...selection });
        context.session = { ...context.session, model: input.modelSelection.model };
      }
      if (context.activeTurnId) {
        yield* rpcRequest(context.transport, { type: "steer", message, images });
        return {
          threadId: input.threadId,
          turnId: context.activeTurnId,
          resumeCursor: context.session.resumeCursor,
        };
      }
      const turnId = TurnId.make(yield* randomUuid);
      context.activeTurnId = turnId;
      context.startedItems.clear();
      context.emittedToolOutput.clear();
      context.session = {
        ...context.session,
        status: "running",
        activeTurnId: turnId,
        updatedAt: yield* nowIso,
      };
      yield* emit({
        ...(yield* stamp(context)),
        type: "turn.started",
        payload: context.session.model ? { model: context.session.model } : {},
      });
      yield* rpcRequest(context.transport, { type: "prompt", message, images });
      return { threadId: input.threadId, turnId, resumeCursor: context.session.resumeCursor };
    });

  const interruptTurn: ProviderAdapterShape<PiAdapterError>["interruptTurn"] = (threadId, turnId) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      if (turnId && context.activeTurnId && turnId !== context.activeTurnId) return;
      context.interrupted = true;
      yield* rpcRequest(context.transport, { type: "abort" });
    });

  const unsupported = (method: string) =>
    Effect.fail(
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method,
        detail: "Pi Agent does not support this operation in Full access mode.",
      }),
    );

  const readThread: ProviderAdapterShape<PiAdapterError>["readThread"] = (threadId) =>
    requireSession(threadId).pipe(
      Effect.flatMap((context) => rpcRequest(context.transport, { type: "get_entries" })),
      Effect.map((response) => entriesToSnapshot(threadId, response)),
    );

  const rollbackThread: ProviderAdapterShape<PiAdapterError>["rollbackThread"] = (
    threadId,
    numTurns,
  ) =>
    Effect.gen(function* () {
      if (!Number.isInteger(numTurns) || numTurns < 1) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "numTurns must be an integer >= 1.",
        });
      }
      const context = yield* requireSession(threadId);
      const forkable = yield* rpcRequest(context.transport, { type: "get_fork_messages" });
      const messages = responseData(forkable).messages;
      if (!Array.isArray(messages) || messages.length <= numTurns) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "fork",
          detail: "Pi Agent cannot roll back past the first user message.",
        });
      }
      const target = record(messages[messages.length - numTurns - 1]);
      if (typeof target?.entryId !== "string") {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "fork",
          detail: "Pi Agent returned an invalid fork cursor.",
        });
      }
      yield* rpcRequest(context.transport, { type: "fork", entryId: target.entryId });
      const state = yield* rpcRequest(context.transport, { type: "get_state" });
      const nextSessionId = responseData(state).sessionId;
      if (typeof nextSessionId === "string") {
        context.sessionId = nextSessionId;
        context.session = {
          ...context.session,
          resumeCursor: { schemaVersion: RESUME_SCHEMA_VERSION, sessionId: nextSessionId },
        };
      }
      return yield* readThread(threadId);
    });

  const stopAll = () =>
    Effect.forEach([...sessions.values()], stopContext, { discard: true }).pipe(Effect.asVoid);
  yield* Scope.addFinalizer(adapterScope, stopAll());

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session" },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest: () => unsupported("respondToRequest"),
    respondToUserInput: () => unsupported("respondToUserInput"),
    stopSession: (threadId) => requireSession(threadId).pipe(Effect.flatMap(stopContext)),
    listSessions: () => Effect.sync(() => [...sessions.values()].map((context) => context.session)),
    hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
    readThread,
    rollbackThread,
    stopAll,
    streamEvents: Stream.fromQueue(events),
  } satisfies ProviderAdapterShape<PiAdapterError>;
});
