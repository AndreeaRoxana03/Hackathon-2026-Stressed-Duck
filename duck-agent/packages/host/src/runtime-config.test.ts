import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { hydrateWindowsUserEnvironment, loadRuntimeConfig, requireStudioConfig } from "./runtime-config.js";

const runtimeOverrideNames = [
  "DUCK_SERIAL_PORT",
  "DUCK_SERIAL_BAUD_RATE",
  "DUCK_STUDIO_BASE_URL",
  "DUCK_STUDIO_AGENT_ID",
  "DUCK_STUDIO_CONFIG_ID",
  "DUCK_STUDIO_MODEL_ID",
  "DUCK_SMART_HOLD_MS",
  "DUCK_POST_RUN_COOLDOWN_MS",
] as const;

async function withoutRuntimeOverrides<T>(callback: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const name of runtimeOverrideNames) {
    previous.set(name, process.env[name]);
    delete process.env[name];
  }
  try {
    return await callback();
  } finally {
    for (const name of runtimeOverrideNames) {
      const value = previous.get(name);
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

test("loads portable JSON runtime configuration", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "stressed-duck-config-"));
  const configPath = path.join(directory, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      serial: { port: "COM7" },
      studio: { baseUrl: "https://agents.example.test", agentId: "agent-1" },
      runtime: { smartHoldMs: 7000 },
    }),
  );

  try {
    const runtime = await withoutRuntimeOverrides(() => loadRuntimeConfig(configPath));
    assert.equal(runtime.config.serial.port, "COM7");
    assert.equal(runtime.config.studio.agentId, "agent-1");
    assert.equal(runtime.config.runtime.smartHoldMs, 7000);
    assert.equal(runtime.config.runtime.postRunCooldownMs, 3000);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("requires a Studio URL and agent id before connecting", () => {
  assert.throws(
    () => requireStudioConfig({
      serial: { baudRate: 115200 },
      studio: { baseUrl: "", agentId: "", configId: "latest" },
      runtime: { smartHoldMs: 5000, postRunCooldownMs: 3000 },
    }),
    /DUCK_STUDIO_BASE_URL/,
  );
});

test("hydrates missing settings from Windows user environment values", async () => {
  const previousBaseUrl = process.env.DUCK_STUDIO_BASE_URL;
  const previousAgentId = process.env.DUCK_STUDIO_AGENT_ID;
  delete process.env.DUCK_STUDIO_BASE_URL;
  delete process.env.DUCK_STUDIO_AGENT_ID;

  try {
    await hydrateWindowsUserEnvironment({
      platform: "win32",
      readVariable: async (name) => ({
        DUCK_STUDIO_BASE_URL: "https://agents.example.test",
        DUCK_STUDIO_AGENT_ID: "agent-from-windows",
      })[name],
    });
    assert.equal(process.env.DUCK_STUDIO_BASE_URL, "https://agents.example.test");
    assert.equal(process.env.DUCK_STUDIO_AGENT_ID, "agent-from-windows");
  } finally {
    if (previousBaseUrl === undefined) {
      delete process.env.DUCK_STUDIO_BASE_URL;
    } else {
      process.env.DUCK_STUDIO_BASE_URL = previousBaseUrl;
    }
    if (previousAgentId === undefined) {
      delete process.env.DUCK_STUDIO_AGENT_ID;
    } else {
      process.env.DUCK_STUDIO_AGENT_ID = previousAgentId;
    }
  }
});