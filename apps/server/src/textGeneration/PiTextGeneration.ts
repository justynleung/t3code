import type { ModelSelection, PiSettings } from "@t3tools/contracts";
import { TextGenerationError } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { PI_METADATA_ARGS } from "../provider/pi/PiProvider.ts";
import { makePiRpcTransport, type PiRpcEvent } from "../provider/pi/PiRpcTransport.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

const PI_TEXT_GENERATION_TIMEOUT_MS = 180_000;

function splitPiModel(
  selection: ModelSelection,
): { provider: string; modelId: string } | undefined {
  const separator = selection.model.indexOf("/");
  if (separator <= 0 || separator === selection.model.length - 1) return undefined;
  return {
    provider: selection.model.slice(0, separator),
    modelId: selection.model.slice(separator + 1),
  };
}

function textDelta(event: PiRpcEvent): string {
  if (event.type !== "message_update") return "";
  const update = event.assistantMessageEvent;
  if (!update || typeof update !== "object" || Array.isArray(update)) return "";
  const record = update as Readonly<Record<string, unknown>>;
  return record.type === "text_delta" && typeof record.delta === "string" ? record.delta : "";
}

export const makePiTextGeneration = Effect.fn("makePiTextGeneration")(function* (
  settings: PiSettings,
  environment?: NodeJS.ProcessEnv,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const resolvedEnvironment = environment ?? process.env;

  const runPiJson = <S extends Schema.Top>(input: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    cwd: string;
    prompt: string;
    outputSchema: S;
    modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.scoped(
      Effect.gen(function* () {
        const model = splitPiModel(input.modelSelection);
        if (!model) {
          return yield* new TextGenerationError({
            operation: input.operation,
            detail: `Invalid Pi model slug: ${input.modelSelection.model}.`,
          });
        }
        const transport = yield* makePiRpcTransport({
          binaryPath: settings.binaryPath || "pi",
          args: PI_METADATA_ARGS,
          cwd: input.cwd,
          env: {
            ...resolvedEnvironment,
            PI_TELEMETRY: "0",
            PI_SKIP_VERSION_CHECK: "1",
          },
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

        yield* transport.request({ type: "set_model", ...model });
        const eventsFiber = yield* transport.events.pipe(
          Stream.takeUntil((event) => event.type === "agent_settled"),
          Stream.runCollect,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* transport.request({ type: "prompt", message: input.prompt });
        const events = yield* Fiber.join(eventsFiber);
        yield* transport.close;
        const output = Array.from(events).map(textDelta).join("").trim();
        if (!output) {
          return yield* new TextGenerationError({
            operation: input.operation,
            detail: "Pi Agent returned empty output.",
          });
        }
        return yield* Schema.decodeEffect(Schema.fromJsonString(input.outputSchema))(
          extractJsonObject(output),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation: input.operation,
                detail: "Pi Agent returned invalid structured output.",
                cause,
              }),
          ),
        );
      }).pipe(
        Effect.timeoutOption(PI_TEXT_GENERATION_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({
                  operation: input.operation,
                  detail: "Pi Agent request timed out.",
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
        Effect.mapError((cause) =>
          Schema.is(TextGenerationError)(cause)
            ? cause
            : new TextGenerationError({
                operation: input.operation,
                detail: "Pi Agent text generation failed.",
                cause,
              }),
        ),
      ),
    );

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("PiTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });
      const generated = yield* runPiJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });
      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("PiTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt(input);
      const generated = yield* runPiJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("PiTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt(input);
      const generated = yield* runPiJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });
      return { branch: sanitizeBranchFragment(generated.branch) };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("PiTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt(input);
      const generated = yield* runPiJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizeThreadTitle(generated.title) };
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
