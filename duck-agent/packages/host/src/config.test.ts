import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "./config.js";

test("parses portable config and applies runtime defaults", () => {
  const config = parseConfig({
    serial: { port: null },
    studio: { baseUrl: "https://agents.example.invalid", agentId: "agent" },
  });

  assert.equal(config.serial.port, undefined);
  assert.equal(config.serial.baudRate, 115200);
  assert.equal(config.studio.configId, "latest");
  assert.equal(config.runtime.smartHoldMs, 5000);
  assert.equal(config.runtime.postRunCooldownMs, 3000);
});

test("rejects invalid serial timing", () => {
  assert.throws(
    () =>
      parseConfig({
        serial: { baudRate: 0 },
        studio: {},
      }),
    /serial\.baudRate must be a positive integer/,
  );
});
