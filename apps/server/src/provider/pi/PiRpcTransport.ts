import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

const RpcResponseBase = Schema.Struct({
  type: Schema.Literal("response"),
  id: Schema.String,
  command: Schema.Literals([
    "prompt",
    "steer",
    "abort",
    "get_state",
    "get_available_models",
    "set_model",
    "get_session_stats",
    "get_entries",
    "get_fork_messages",
    "fork",
  ]),
  success: Schema.Boolean,
  data: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.String),
});

const RpcEventBase = Schema.Struct({
  type: Schema.String,
});

const RpcImage = Schema.Struct({
  type: Schema.Literal("image"),
  data: Schema.String,
  mimeType: Schema.String,
});

const RpcCommandBase = Schema.Union([
  Schema.Struct({
    id: Schema.String,
    type: Schema.Literals(["prompt", "steer"]),
    message: Schema.String,
    images: Schema.optional(Schema.Array(RpcImage)),
  }),
  Schema.Struct({
    id: Schema.String,
    type: Schema.Literals([
      "abort",
      "get_state",
      "get_available_models",
      "get_session_stats",
      "get_entries",
      "get_fork_messages",
    ]),
  }),
  Schema.Struct({
    id: Schema.String,
    type: Schema.Literal("set_model"),
    provider: Schema.String,
    modelId: Schema.String,
  }),
  Schema.Struct({
    id: Schema.String,
    type: Schema.Literal("fork"),
    entryId: Schema.String,
  }),
]);

export type PiRpcRecord = Readonly<Record<string, unknown>> & { readonly type: string };
export type PiRpcResponse = PiRpcRecord & typeof RpcResponseBase.Type;
export type PiRpcEvent = PiRpcRecord;

export class PiRpcTransportError extends Schema.TaggedErrorClass<PiRpcTransportError>()(
  "PiRpcTransportError",
  {
    operation: Schema.String,
    detail: Schema.String,
    stderr: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Pi RPC ${this.operation} failed: ${this.detail}`;
  }
}

export interface PiRpcLaunchOptions {
  readonly binaryPath: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface PiRpcTransport {
  readonly request: (
    command: Readonly<Record<string, unknown>> & { readonly type: string },
  ) => Effect.Effect<PiRpcResponse, PiRpcTransportError>;
  readonly events: Stream.Stream<PiRpcEvent>;
  readonly stderr: Effect.Effect<string>;
  readonly exitCode: Effect.Effect<number, PiRpcTransportError>;
  readonly close: Effect.Effect<void>;
}

/**
 * Strict JSONL decoder. It only treats LF as a record boundary and leaves
 * U+2028/U+2029 untouched inside JSON strings. TextDecoder keeps fragmented
 * UTF-8 sequences across chunks.
 */
export class PiJsonlDecoder {
  readonly #decoder = new TextDecoder();
  #buffer = "";

  push(chunk: Uint8Array): ReadonlyArray<string> {
    this.#buffer += this.#decoder.decode(chunk, { stream: true });
    return this.#drain(false);
  }

  finish(): ReadonlyArray<string> {
    this.#buffer += this.#decoder.decode();
    return this.#drain(true);
  }

  #drain(includeRemainder: boolean): ReadonlyArray<string> {
    const records: string[] = [];
    let newline = this.#buffer.indexOf("\n");
    while (newline >= 0) {
      const raw = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (line.length > 0) records.push(line);
      newline = this.#buffer.indexOf("\n");
    }
    if (includeRemainder && this.#buffer.length > 0) {
      const line = this.#buffer.endsWith("\r") ? this.#buffer.slice(0, -1) : this.#buffer;
      this.#buffer = "";
      if (line.length > 0) records.push(line);
    }
    return records;
  }
}

export function decodePiRpcRecord(line: string): PiRpcResponse | PiRpcEvent {
  const parsed = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(line);
  const event = Schema.decodeUnknownSync(RpcEventBase)(parsed) as PiRpcEvent;
  if (event.type !== "response") return event;
  return Schema.decodeUnknownSync(RpcResponseBase)(parsed) as PiRpcResponse;
}

export const makePiRpcTransport = (
  options: PiRpcLaunchOptions,
): Effect.Effect<
  PiRpcTransport,
  PiRpcTransportError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const parentScope = yield* Scope.Scope;
    const processScope = yield* Scope.make();
    yield* Scope.addFinalizer(parentScope, Scope.close(processScope, Exit.void));
    const outgoing = yield* Queue.unbounded<string>();
    const incoming = yield* Queue.unbounded<PiRpcEvent>();
    const stderrRef = yield* Ref.make("");
    const pending = new Map<string, Deferred.Deferred<PiRpcResponse, PiRpcTransportError>>();
    let requestIndex = 0;

    const spawn = yield* resolveSpawnCommand(options.binaryPath, options.args, {
      ...(options.env ? { env: options.env, extendEnv: true } : {}),
    });
    const child = yield* spawner
      .spawn(
        ChildProcess.make(spawn.command, spawn.args, {
          cwd: options.cwd,
          ...(options.env ? { env: options.env, extendEnv: true } : {}),
          shell: spawn.shell,
        }),
      )
      .pipe(
        Effect.provideService(Scope.Scope, processScope),
        Effect.mapError(
          (cause) =>
            new PiRpcTransportError({
              operation: "spawn",
              detail: `Could not start ${options.binaryPath}.`,
              cause,
            }),
        ),
      );

    const failPending = (error: PiRpcTransportError): Effect.Effect<void> =>
      Effect.forEach([...pending.values()], (deferred) => Deferred.fail(deferred, error), {
        discard: true,
      }).pipe(
        Effect.tap(() => Effect.sync(() => pending.clear())),
        Effect.asVoid,
      );

    const handleLine = (line: string): Effect.Effect<void, PiRpcTransportError> =>
      Effect.try({
        try: () => decodePiRpcRecord(line),
        catch: (cause) =>
          new PiRpcTransportError({
            operation: "decode",
            detail: "Pi emitted malformed JSONL.",
            cause,
          }),
      }).pipe(
        Effect.flatMap((message) => {
          if (message.type !== "response")
            return Queue.offer(incoming, message).pipe(Effect.asVoid);
          const response = message as PiRpcResponse;
          const deferred = pending.get(response.id);
          if (!deferred) {
            return Effect.fail(
              new PiRpcTransportError({
                operation: "correlate",
                detail: `Pi returned an unknown response id: ${response.id}.`,
              }),
            );
          }
          pending.delete(response.id);
          return response.success
            ? Deferred.succeed(deferred, response).pipe(Effect.asVoid)
            : Deferred.fail(
                deferred,
                new PiRpcTransportError({
                  operation: response.command,
                  detail: response.error ?? "Pi rejected the RPC command.",
                }),
              ).pipe(Effect.asVoid);
        }),
      );

    const stdoutDecoder = new PiJsonlDecoder();
    yield* child.stdout.pipe(
      Stream.runForEach((chunk) =>
        Effect.forEach(stdoutDecoder.push(chunk), handleLine, { discard: true }),
      ),
      Effect.flatMap(() => Effect.forEach(stdoutDecoder.finish(), handleLine, { discard: true })),
      Effect.catch((cause) =>
        failPending(
          new PiRpcTransportError({
            operation: "stdout",
            detail: "Pi RPC stdout closed unexpectedly.",
            cause,
          }),
        ),
      ),
      Effect.forkIn(processScope),
    );

    yield* child.stderr.pipe(
      Stream.runForEach((chunk) =>
        Ref.update(stderrRef, (current) =>
          (current + new TextDecoder().decode(chunk)).slice(-20_000),
        ),
      ),
      Effect.ignore,
      Effect.forkIn(processScope),
    );

    yield* Stream.fromQueue(outgoing).pipe(
      Stream.encodeText,
      Stream.run(child.stdin),
      Effect.ignore,
      Effect.forkIn(processScope),
    );

    const exitCode: Effect.Effect<number, PiRpcTransportError> = child.exitCode.pipe(
      Effect.map(Number),
      Effect.mapError(
        (cause) =>
          new PiRpcTransportError({
            operation: "process",
            detail: "Failed to read the Pi process exit code.",
            cause,
          }),
      ),
    );
    yield* exitCode.pipe(
      Effect.flatMap((code) =>
        Ref.get(stderrRef).pipe(
          Effect.flatMap((stderr) =>
            failPending(
              new PiRpcTransportError({
                operation: "process",
                detail: `Pi exited with code ${code}.`,
                ...(stderr.trim() ? { stderr: stderr.trim() } : {}),
              }),
            ),
          ),
        ),
      ),
      Effect.catch((cause) => failPending(cause)),
      Effect.ensuring(Queue.shutdown(incoming)),
      Effect.forkIn(processScope),
    );

    const request: PiRpcTransport["request"] = (command) =>
      Effect.gen(function* () {
        const id = `t3-pi-${++requestIndex}`;
        yield* Schema.decodeUnknownEffect(RpcCommandBase)({ ...command, id }).pipe(
          Effect.mapError(
            (cause) =>
              new PiRpcTransportError({
                operation: "encode",
                detail: `Invalid Pi RPC command ${command.type}.`,
                cause,
              }),
          ),
        );
        const deferred = yield* Deferred.make<PiRpcResponse, PiRpcTransportError>();
        pending.set(id, deferred);
        const encoded = yield* Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)({
          ...command,
          id,
        }).pipe(
          Effect.mapError(
            (cause) =>
              new PiRpcTransportError({
                operation: "encode",
                detail: `Could not encode Pi RPC command ${command.type}.`,
                cause,
              }),
          ),
        );
        yield* Queue.offer(outgoing, `${encoded}\n`).pipe(
          Effect.mapError(
            (cause) =>
              new PiRpcTransportError({
                operation: command.type,
                detail: "Pi RPC stdin is closed.",
                cause,
              }),
          ),
        );
        return yield* Deferred.await(deferred);
      });

    return {
      request,
      events: Stream.fromQueue(incoming),
      stderr: Ref.get(stderrRef),
      exitCode,
      close: Scope.close(processScope, Exit.void).pipe(Effect.asVoid),
    };
  });
