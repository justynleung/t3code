// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import type { PiSettings } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vite-plus/test";

import {
  MINIMUM_PI_VERSION,
  PI_PRESENTATION,
  PI_METADATA_ARGS,
  PI_VANILLA_FLAGS,
  checkPiProviderStatus,
  makePendingPiProvider,
  piModelsFromRpc,
  piSessionArgs,
} from "./PiProvider.ts";
import type { PiRpcResponse } from "./PiRpcTransport.ts";
import * as Effect from "effect/Effect";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockPiPath = NodePath.resolve(__dirname, "../../../scripts/pi-rpc-mock.ts");

function response(command: PiRpcResponse["command"], data: unknown): PiRpcResponse {
  return { id: command, type: "response", command, success: true, data };
}

describe("Pi provider contract", () => {
  it("pins the settlement-capable minimum and vanilla flags", () => {
    expect(MINIMUM_PI_VERSION).toBe("0.80.4");
    expect(PI_VANILLA_FLAGS).toEqual([
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
    ]);
    expect(piSessionArgs("session-1")).toEqual([
      "--mode",
      "rpc",
      "--session-id",
      "session-1",
      ...PI_VANILLA_FLAGS,
    ]);
    expect(PI_METADATA_ARGS).toEqual([
      "--mode",
      "rpc",
      "--no-session",
      "--no-tools",
      ...PI_VANILLA_FLAGS,
    ]);
    expect(PI_PRESENTATION).toMatchObject({
      showInteractionModeToggle: false,
      supportedRuntimeModes: ["full-access"],
    });
  });

  it("maps authenticated inventory to provider/model slugs and marks the current model", () => {
    const models = piModelsFromRpc(
      response("get_state", { model: { provider: "anthropic", id: "sonnet" } }),
      response("get_available_models", {
        models: [
          { provider: "anthropic", id: "sonnet", name: "Sonnet", input: ["text", "image"] },
          { provider: "openai", id: "gpt-5", name: "GPT-5" },
        ],
      }),
    );
    expect(models.map((model) => model.slug)).toEqual(["anthropic/sonnet", "openai/gpt-5"]);
    expect(models[0]?.isDefault).toBe(true);
    expect(models[0]?.supportsImages).toBe(true);
    expect(models[1]?.supportsImages).toBe(false);
  });

  it("advertises disabled Pi without models", async () => {
    const settings = { enabled: false, binaryPath: "pi" } satisfies PiSettings;
    const snapshot = await Effect.runPromise(makePendingPiProvider(settings));
    expect(snapshot.status).toBe("disabled");
    expect(snapshot.models).toEqual([]);
  });

  effectIt.effect("reports missing, outdated, unauthenticated, and ready installations", () =>
    Effect.gen(function* () {
      const missing = yield* checkPiProviderStatus(
        { enabled: true, binaryPath: `${mockPiPath}.missing` },
        process.cwd(),
      );
      expect(missing.installed).toBe(false);
      expect(missing.status).toBe("error");

      const outdated = yield* checkPiProviderStatus(
        { enabled: true, binaryPath: mockPiPath },
        process.cwd(),
        { ...process.env, MOCK_PI_VERSION: "0.79.0" },
      );
      expect(outdated.status).toBe("error");
      expect(outdated.message).toContain(MINIMUM_PI_VERSION);

      const unauthenticated = yield* checkPiProviderStatus(
        { enabled: true, binaryPath: mockPiPath },
        process.cwd(),
        { ...process.env, MOCK_PI_NO_MODELS: "1" },
      );
      expect(unauthenticated.auth.status).toBe("unauthenticated");
      expect(unauthenticated.message).toContain("/login");

      const ready = yield* checkPiProviderStatus(
        { enabled: true, binaryPath: mockPiPath },
        process.cwd(),
      );
      expect(ready.status).toBe("ready");
      expect(ready.models.map((model) => model.slug)).toEqual(["mock/model"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
