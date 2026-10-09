import assert from "node:assert/strict";
import { createConnection } from "node:net";
import test from "node:test";
import { FocusedWindowRouter } from "./window-router.js";
import {
  DuckBrokerServer,
  handleBrokerMessage,
  type BrokerHandlers,
  type BrokerResponse,
} from "./broker.js";

function handlers(): BrokerHandlers {
  return {
    async onTrigger() {
      return { accepted: true, status: { state: "COOL", cooldownUntilMs: 0 } };
    },
    onStatus() {
      return { state: "HAPPY", cooldownUntilMs: 0 };
    },
    async onStop() {},
  };
}

test("routes a knock only to a live focused trusted window and consumes once", () => {
  let now = 0;
  const router = new FocusedWindowRouter(() => now);
  router.heartbeat({ windowId: "first", focused: false, trusted: true });
  router.heartbeat({ windowId: "second", focused: true, trusted: true });
  assert.equal(router.requestContext(), true);
  assert.equal(router.pendingCapture("first"), undefined);
  const id = router.pendingCapture("second")!;
  assert.equal(router.consume("first", id), false);
  assert.equal(router.consume("second", id), true);
  assert.equal(router.consume("second", id), false);
  assert.equal(router.requestContext(), true);
  now = 4_001;
  assert.equal(router.pendingCapture("second"), undefined);
  now = 6_001;
  assert.equal(router.requestContext(), false);
});

test("authorizes and bounds a trigger request", async () => {
  let receivedPrompt = "";
  const requestHandlers: BrokerHandlers = {
    ...handlers(),
    async onTrigger(request) {
      receivedPrompt = request.prompt ?? "";
      assert.equal(request.context?.excerpt?.length, 8_000);
      return { accepted: true, status: { state: "COOL", cooldownUntilMs: 0 } };
    },
  };
  const response = await handleBrokerMessage(
    JSON.stringify({
      type: "trigger",
      protocolVersion: 1,
      token: "broker-token",
      prompt: "Inspect this.",
      context: { excerpt: "x".repeat(10_000) },
    }),
    "broker-token",
    requestHandlers,
  );

  assert.deepEqual(response, {
    ok: true,
    accepted: true,
    status: { state: "COOL", cooldownUntilMs: 0 },
  });
  assert.equal(receivedPrompt, "Inspect this.");
});

test("validates editor completion acknowledgements on window polls", async () => {
  let generation: number | undefined;
  const requestHandlers: BrokerHandlers = {
    ...handlers(),
    async onPoll(request) { generation = request.completedGeneration; return { ok: true }; },
  };
  const request = { type: "poll", token: "broker-token", protocolVersion: 1, windowId: "editor", trusted: true };
  assert.equal((await handleBrokerMessage(JSON.stringify({ ...request, completedGeneration: 2 }), "broker-token", requestHandlers)).ok, true);
  assert.equal(generation, 2);
  for (const invalid of [0, -1, 1.5, "2"]) {
    assert.equal((await handleBrokerMessage(JSON.stringify({ ...request, completedGeneration: invalid }), "broker-token", requestHandlers)).ok, false);
  }
});

test("rejects unauthorized and malformed broker messages", async () => {
  assert.deepEqual(await handleBrokerMessage(JSON.stringify({ type: "status", token: "broker-token", protocolVersion: 999 }), "broker-token", handlers()), {
    ok: false,
    error: "Incompatible broker protocol. Update the host and extension together.",
  });
  assert.deepEqual(await handleBrokerMessage("{}", "broker-token", handlers()), {
    ok: false,
    error: "Unauthorized broker request.",
  });
  assert.deepEqual(await handleBrokerMessage("not-json", "broker-token", handlers()), {
    ok: false,
    error: "Invalid broker request.",
  });
});

test("serves an authorized request over a Windows named pipe", { skip: process.platform !== "win32" }, async (t) => {
  const pipeName = `\\\\.\\pipe\\stressed-duck-test-${process.pid}-${Date.now()}`;
  const server = new DuckBrokerServer({ pipeName, token: "pipe-token", handlers: handlers() });
  await server.start();
  t.after(async () => server.stop());

  const response = await new Promise<BrokerResponse>((resolve, reject) => {
    const socket = createConnection(pipeName);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ type: "status", token: "pipe-token", protocolVersion: 1 })}\n`);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        resolve(JSON.parse(buffer.slice(0, newline)) as BrokerResponse);
        socket.destroy();
      }
    });
  });

  assert.deepEqual(response, {
    ok: true,
    status: { state: "HAPPY", cooldownUntilMs: 0 },
    protocolVersion: 1,
  });
});