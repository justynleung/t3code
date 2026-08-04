import { describe, expect, it } from "vite-plus/test";

import { newOutputSuffix, piTokenUsageFromStats } from "./PiAdapter.ts";

describe("Pi adapter streaming", () => {
  it("emits only the new suffix from cumulative tool output", () => {
    expect(newOutputSuffix(undefined, "one")).toBe("one");
    expect(newOutputSuffix("one", "one two")).toBe(" two");
    expect(newOutputSuffix("one two", "replacement")).toBe("replacement");
  });

  it("maps cumulative and current-context Pi token statistics", () => {
    expect(
      piTokenUsageFromStats({
        tokens: { input: 50_000, output: 10_000, total: 105_000 },
        contextUsage: { tokens: 60_000, contextWindow: 200_000 },
      }),
    ).toEqual({ usedTokens: 60_000, totalProcessedTokens: 105_000 });
  });
});
