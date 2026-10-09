import { SERIAL_BAUD_RATE } from "./protocol.js";

export interface DuckAgentConfig {
  readonly serial: {
    readonly port?: string;
    readonly baudRate: number;
  };
  readonly studio: {
    readonly baseUrl: string;
    readonly agentId: string;
    readonly configId: string;
    readonly modelId?: string;
  };
  readonly runtime: {
    readonly smartHoldMs: number;
    readonly postRunCooldownMs: number;
  };
}

export const DEFAULT_CONFIG = {
  serial: {
    baudRate: SERIAL_BAUD_RATE,
  },
  studio: {
    configId: "latest",
  },
  runtime: {
    smartHoldMs: 5000,
    postRunCooldownMs: 3000,
  },
} as const;

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
  return value;
}

function asOptionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return asString(value, name);
}

function asPositiveInteger(value: unknown, name: string, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function parseConfig(value: unknown): DuckAgentConfig {
  const root = asRecord(value, "config");
  const serial = root.serial === undefined ? {} : asRecord(root.serial, "serial");
  const studio = root.studio === undefined ? {} : asRecord(root.studio, "studio");
  const runtime = root.runtime === undefined ? {} : asRecord(root.runtime, "runtime");

  return {
    serial: {
      port: asOptionalString(serial.port, "serial.port"),
      baudRate: asPositiveInteger(serial.baudRate, "serial.baudRate", DEFAULT_CONFIG.serial.baudRate),
    },
    studio: {
      baseUrl: asString(studio.baseUrl ?? "", "studio.baseUrl"),
      agentId: asString(studio.agentId ?? "", "studio.agentId"),
      configId: asString(studio.configId ?? DEFAULT_CONFIG.studio.configId, "studio.configId"),
      modelId: asOptionalString(studio.modelId, "studio.modelId"),
    },
    runtime: {
      smartHoldMs: asPositiveInteger(
        runtime.smartHoldMs,
        "runtime.smartHoldMs",
        DEFAULT_CONFIG.runtime.smartHoldMs,
      ),
      postRunCooldownMs: asPositiveInteger(
        runtime.postRunCooldownMs,
        "runtime.postRunCooldownMs",
        DEFAULT_CONFIG.runtime.postRunCooldownMs,
      ),
    },
  };
}
