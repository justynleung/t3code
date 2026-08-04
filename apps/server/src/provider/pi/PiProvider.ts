import type { PiSettings, ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { makePiRpcTransport, type PiRpcResponse } from "./PiRpcTransport.ts";

export const MINIMUM_PI_VERSION = "0.80.4";
export const PI_VANILLA_FLAGS = [
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
] as const;
export const piSessionArgs = (sessionId: string): ReadonlyArray<string> => [
  "--mode",
  "rpc",
  "--session-id",
  sessionId,
  ...PI_VANILLA_FLAGS,
];
export const PI_METADATA_ARGS: ReadonlyArray<string> = [
  "--mode",
  "rpc",
  "--no-session",
  "--no-tools",
  ...PI_VANILLA_FLAGS,
];

export const PI_PRESENTATION = {
  displayName: "Pi Agent",
  showInteractionModeToggle: false,
  supportedRuntimeModes: ["full-access"],
} as const;

const EMPTY_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });

interface PiModel {
  readonly provider: string;
  readonly id: string;
  readonly name?: string;
  readonly input?: ReadonlyArray<string>;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function parseModel(value: unknown): PiModel | undefined {
  const input = record(value);
  if (!input || typeof input.provider !== "string" || typeof input.id !== "string") {
    return undefined;
  }
  return {
    provider: input.provider,
    id: input.id,
    ...(typeof input.name === "string" ? { name: input.name } : {}),
    ...(Array.isArray(input.input)
      ? { input: input.input.filter((entry): entry is string => typeof entry === "string") }
      : {}),
  };
}

function responseData(response: PiRpcResponse): Readonly<Record<string, unknown>> {
  return record(response.data) ?? {};
}

export function piModelsFromRpc(
  stateResponse: PiRpcResponse,
  modelsResponse: PiRpcResponse,
): ReadonlyArray<ServerProviderModel> {
  const current = parseModel(responseData(stateResponse).model);
  const rawModels = responseData(modelsResponse).models;
  const models = Array.isArray(rawModels) ? rawModels.map(parseModel) : [];
  const seen = new Set<string>();
  return models
    .filter((model): model is PiModel => model !== undefined)
    .map((model): ServerProviderModel | undefined => {
      const slug = `${model.provider}/${model.id}`;
      if (seen.has(slug)) return undefined;
      seen.add(slug);
      const isDefault = current?.provider === model.provider && current.id === model.id;
      return {
        slug,
        name: model.name?.trim() || model.id,
        subProvider: model.provider,
        isCustom: false,
        supportsImages: model.input?.includes("image") === true,
        ...(isDefault ? { isDefault: true } : {}),
        capabilities: EMPTY_CAPABILITIES,
      };
    })
    .filter((model): model is ServerProviderModel => model !== undefined);
}

export const makePendingPiProvider = (settings: PiSettings): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: [],
      probe: settings.enabled
        ? {
            installed: true,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Checking Pi Agent availability...",
          }
        : {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Pi Agent is disabled in T3 Code settings.",
          },
    });
  });

export const checkPiProviderStatus = Effect.fn("checkPiProviderStatus")(function* (
  settings: PiSettings,
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!settings.enabled) return yield* makePendingPiProvider(settings);

  const binaryPath = settings.binaryPath || "pi";
  const versionResult = yield* Effect.gen(function* () {
    const command = yield* resolveSpawnCommand(binaryPath, ["--version"], {
      env: environment,
      extendEnv: true,
    });
    return yield* spawnAndCollect(
      binaryPath,
      ChildProcess.make(command.command, command.args, {
        env: environment,
        extendEnv: true,
        shell: command.shell,
      }),
    );
  }).pipe(Effect.timeoutOption(4_000), Effect.exit);

  if (Exit.isFailure(versionResult)) {
    const cause = Cause.squash(versionResult.cause);
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: [],
      probe: {
        installed: !isCommandMissingCause(cause),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(cause)
          ? "Pi Agent (`pi`) is not installed or not on PATH."
          : "Failed to execute the Pi Agent health check.",
      },
    });
  }
  if (Option.isNone(versionResult.value)) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: [],
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Pi Agent timed out while running `pi --version`.",
      },
    });
  }

  const versionOutput = versionResult.value.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0 || !version) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: [],
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Pi Agent is installed but its version could not be determined.",
      },
    });
  }
  if (compareSemverVersions(version, MINIMUM_PI_VERSION) < 0) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: [],
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `Pi Agent ${MINIMUM_PI_VERSION} or newer is required. Upgrade Pi and retry.`,
      },
    });
  }

  const probe = yield* Effect.scoped(
    Effect.gen(function* () {
      const transport = yield* makePiRpcTransport({
        binaryPath,
        args: PI_METADATA_ARGS,
        cwd,
        env: { ...environment, PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1" },
      });
      const [state, models] = yield* Effect.all([
        transport.request({ type: "get_state" }),
        transport.request({ type: "get_available_models" }),
      ]);
      yield* transport.close;
      return piModelsFromRpc(state, models);
    }),
  ).pipe(Effect.timeoutOption(15_000), Effect.exit);

  if (Exit.isFailure(probe)) {
    const cause = Cause.squash(probe.cause);
    const detail = (cause instanceof Error ? cause.message : String(cause))
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240);
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: [],
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: detail ? `Pi Agent RPC startup failed: ${detail}` : "Pi Agent RPC startup failed.",
      },
    });
  }
  if (Option.isNone(probe.value)) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: [],
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Pi Agent RPC startup timed out.",
      },
    });
  }

  const models = probe.value.value;
  if (models.length === 0) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Pi Agent has no authenticated models. Run `pi`, then use `/login`.",
      },
    });
  }

  return buildServerProvider({
    presentation: PI_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: { status: "authenticated" },
    },
  });
});
