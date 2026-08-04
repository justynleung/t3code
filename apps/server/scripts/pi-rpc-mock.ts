#!/usr/bin/env node

// Minimal Pi-compatible JSONL process used by the transport integration test.
if (process.argv.includes("--version")) {
  process.stdout.write(`${process.env.MOCK_PI_VERSION ?? "0.82.1"}\n`);
  process.exit(0);
}

let buffer = "";
const exitOnState = process.argv.includes("--exit-on-state");
const malformedOnState = process.argv.includes("--malformed-on-state");

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function handle(line: string): void {
  const command = JSON.parse(line) as { id: string; type: string };
  switch (command.type) {
    case "get_state":
      if (exitOnState) {
        process.exit(7);
      }
      if (malformedOnState) {
        process.stdout.write("{malformed\n");
        return;
      }
      emit({
        id: command.id,
        type: "response",
        command: command.type,
        success: true,
        data: {
          sessionId: "mock-session",
          model: process.env.MOCK_PI_NO_MODELS === "1" ? null : { provider: "mock", id: "model" },
        },
      });
      return;
    case "get_available_models":
      emit({
        id: command.id,
        type: "response",
        command: command.type,
        success: true,
        data: {
          models:
            process.env.MOCK_PI_NO_MODELS === "1"
              ? []
              : [{ provider: "mock", id: "model", name: "Mock Model", input: ["text"] }],
        },
      });
      return;
    case "prompt":
      emit({ id: command.id, type: "response", command: command.type, success: true });
      emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello\u2028pi" },
      });
      emit({ type: "agent_settled" });
      return;
    default:
      emit({ id: command.id, type: "response", command: command.type, success: true });
  }
}

process.stdin.on("data", (chunk: Buffer) => {
  buffer += chunk.toString("utf8");
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).replace(/\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (line) handle(line);
    newline = buffer.indexOf("\n");
  }
});

process.stderr.write("mock-pi-ready\n");
