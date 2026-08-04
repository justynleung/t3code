// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";

import { decodePiRpcRecord, makePiRpcTransport, PiJsonlDecoder } from "./PiRpcTransport.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockPiPath = NodePath.resolve(__dirname, "../../../scripts/pi-rpc-mock.ts");

describe("PiJsonlDecoder", () => {
  it("frames only on LF and preserves Unicode line separators", () => {
    const decoder = new PiJsonlDecoder();
    const input = new TextEncoder().encode(
      '{"type":"message_update","text":"one\u2028two\u2029three"}\r\n{"type":"agent_settled"}\n',
    );

    expect(decoder.push(input)).toEqual([
      '{"type":"message_update","text":"one\u2028two\u2029three"}',
      '{"type":"agent_settled"}',
    ]);
  });

  it("preserves fragmented UTF-8 sequences", () => {
    const decoder = new PiJsonlDecoder();
    const encoded = new TextEncoder().encode('{"type":"message_update","text":"π"}\n');
    const splitAt = encoded.indexOf(0xcf) + 1;

    expect(decoder.push(encoded.slice(0, splitAt))).toEqual([]);
    expect(decoder.push(encoded.slice(splitAt))).toEqual(['{"type":"message_update","text":"π"}']);
  });

  it("rejects malformed JSON and invalid response envelopes", () => {
    expect(() => decodePiRpcRecord("{")).toThrow();
    expect(() =>
      decodePiRpcRecord('{"type":"response","command":"get_state","success":"yes"}'),
    ).toThrow();
    expect(() =>
      decodePiRpcRecord('{"type":"response","command":"get_state","success":true}'),
    ).toThrow();
  });
});

describe("PiRpcTransport process integration", () => {
  effectIt.effect("correlates responses and preserves ordered unsolicited events", () =>
    Effect.gen(function* () {
      const transport = yield* makePiRpcTransport({
        binaryPath: "node",
        args: [mockPiPath],
        cwd: process.cwd(),
      });
      const eventsFiber = yield* transport.events.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true }),
      );

      const state = yield* transport.request({ type: "get_state" });
      expect(state.command).toBe("get_state");
      yield* transport.request({ type: "prompt", message: "hello" });

      const events = Array.from(yield* Fiber.join(eventsFiber));
      expect(events.map((event) => event.type)).toEqual(["message_update", "agent_settled"]);
      expect((yield* transport.stderr).trim()).toBe("mock-pi-ready");
      yield* transport.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  effectIt.effect("fails pending requests when the owned child exits", () =>
    Effect.gen(function* () {
      const transport = yield* makePiRpcTransport({
        binaryPath: "node",
        args: [mockPiPath, "--exit-on-state"],
        cwd: process.cwd(),
      });
      const result = yield* transport.request({ type: "get_state" }).pipe(Effect.exit);
      expect(result._tag).toBe("Failure");
      yield* transport.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  effectIt.effect("fails a pending request on malformed process output", () =>
    Effect.gen(function* () {
      const transport = yield* makePiRpcTransport({
        binaryPath: "node",
        args: [mockPiPath, "--malformed-on-state"],
        cwd: process.cwd(),
      });
      const result = yield* transport.request({ type: "get_state" }).pipe(Effect.exit);
      expect(result._tag).toBe("Failure");
      yield* transport.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
