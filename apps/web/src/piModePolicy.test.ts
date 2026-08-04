import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  filterThreadRefs,
  isThreadVisible,
  resolveModeModelSelection,
  resolvePiModeWriterRestoration,
} from "./piModePolicy";

const pi = {
  instanceId: ProviderInstanceId.make("piAgent"),
  driver: ProviderDriverKind.make("piAgent"),
  enabled: true,
  installed: true,
  status: "ready",
  version: "0.82.1",
  auth: { status: "authenticated" },
  checkedAt: "2026-08-04T00:00:00.000Z",
  slashCommands: [],
  skills: [],
  models: [
    {
      slug: "anthropic/sonnet",
      name: "Sonnet",
      isCustom: false,
      isDefault: true,
      capabilities: null,
    },
  ],
} as ServerProvider;

const codex = {
  ...pi,
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  models: [{ slug: "gpt-5", name: "GPT-5", isCustom: false, capabilities: null }],
} as ServerProvider;

describe("Pi mode policy", () => {
  it("uses the active session binding before persisted model selection", () => {
    const thread = {
      modelSelection: { instanceId: codex.instanceId, model: "gpt-5" },
      session: { providerInstanceId: pi.instanceId },
    };
    expect(isThreadVisible("pi", thread, [pi, codex])).toBe(true);
  });

  it("hides unknown and non-Pi threads in strict mode", () => {
    const threads = [
      { modelSelection: { instanceId: pi.instanceId, model: "anthropic/sonnet" }, session: null },
      { modelSelection: { instanceId: codex.instanceId, model: "gpt-5" }, session: null },
      {
        modelSelection: { instanceId: ProviderInstanceId.make("missing"), model: "unknown" },
        session: null,
      },
    ];
    expect(filterThreadRefs("pi", threads, [pi, codex])).toEqual([threads[0]]);
  });

  it("prefers a ready remembered model and otherwise uses the live default", () => {
    const remembered = { instanceId: pi.instanceId, model: "anthropic/sonnet" };
    const current = { instanceId: codex.instanceId, model: "gpt-5" };
    expect(resolveModeModelSelection("pi", current, remembered, [pi, codex])).toEqual(remembered);
    expect(resolveModeModelSelection("pi", current, null, [pi, codex])).toEqual(remembered);
  });

  it("does not enter Pi mode without a ready Pi model", () => {
    const current = { instanceId: codex.instanceId, model: "gpt-5" };
    expect(resolveModeModelSelection("pi", current, null, [codex])).toBeNull();
    expect(
      resolveModeModelSelection("pi", current, null, [{ ...pi, status: "error" }, codex]),
    ).toBeNull();
  });

  it("restores only writer selections that still equal the applied Pi selection", () => {
    const applied = { instanceId: pi.instanceId, model: "anthropic/sonnet" };
    const previousText = { instanceId: codex.instanceId, model: "gpt-5" };
    const newerSource = { instanceId: codex.instanceId, model: "gpt-5.1" };
    const restore = {
      previousTextGenerationModelSelection: previousText,
      previousSourceControlWriterModelSelection: null,
      appliedPiSelection: applied,
    };

    expect(resolvePiModeWriterRestoration(applied, applied, restore)).toEqual({
      textGenerationModelSelection: previousText,
      sourceControlWriterModelSelection: null,
    });
    expect(resolvePiModeWriterRestoration(applied, newerSource, restore)).toEqual({
      textGenerationModelSelection: previousText,
    });
  });
});
