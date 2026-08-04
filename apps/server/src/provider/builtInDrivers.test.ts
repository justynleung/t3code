import { describe, expect, it } from "vite-plus/test";

import { BUILT_IN_DRIVERS } from "./builtInDrivers.ts";

describe("built-in provider registry", () => {
  it("keeps the baseline providers and adds Pi Agent", () => {
    expect(BUILT_IN_DRIVERS.map((driver) => driver.driverKind)).toEqual([
      "codex",
      "claudeAgent",
      "cursor",
      "grok",
      "opencode",
      "piAgent",
    ]);
  });
});
