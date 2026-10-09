import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { parseConfig, type DuckAgentConfig } from "./config.js";

const execFileAsync = promisify(execFile);

const WINDOWS_USER_ENVIRONMENT_NAMES = [
  "DUCK_STUDIO_BASE_URL",
  "DUCK_STUDIO_AGENT_ID",
  "DUCK_STUDIO_CONFIG_ID",
  "DUCK_STUDIO_MODEL_ID",
  "DUCK_STUDIO_ACCESS_TOKEN",
  "DUCK_OAUTH_BASE_URL",
  "DUCK_OAUTH_CLIENT_ID",
  "DUCK_OAUTH_CLIENT_SECRET",
  "DUCK_OAUTH_REDIRECT_URI",
  "DUCK_OAUTH_SCOPES",
  "DUCK_CONFIG_FILE",
  "DUCK_SERIAL_PORT",
  "DUCK_SERIAL_BAUD_RATE",
  "DUCK_SMART_HOLD_MS",
  "DUCK_POST_RUN_COOLDOWN_MS",
  "DUCK_VERBOSE",
  "DUCK_BROKER_PIPE",
  "DUCK_BROKER_TOKEN",
  "DUCK_MOCK_DUCK",
  "DUCK_MOCK_PROMPT",
  "DUCK_ALLOWED_COMMANDS",
  "DUCK_WORKSPACE_ROOT",
  "DUCK_AUDIO_HOST",
  "DUCK_AUDIO_PORT",
  "DUCK_AUDIO_CERT_FILE",
  "DUCK_AUDIO_KEY_FILE",
  "DUCK_AUDIO_DEVICE_TOKEN",
  "DUCK_STT_ENDPOINT",
  "DUCK_STT_MODEL",
  "DUCK_STT_API_KEY",
] as const;

export interface WindowsUserEnvironmentOptions {
  readonly platform?: NodeJS.Platform;
  readonly readVariable?: (name: string) => Promise<string | undefined>;
}

function registryValue(output: string, name: string): string | undefined {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = output.match(new RegExp(`^\\s*${escapedName}\\s+REG_\\S+\\s+(.*)$`, "m"));
  return match?.[1]?.trim() || undefined;
}

async function readWindowsUserEnvironmentVariable(name: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "reg.exe",
      ["query", "HKCU\\Environment", "/v", name],
      { windowsHide: true, maxBuffer: 16 * 1024 },
    );
    return registryValue(stdout, name);
  } catch {
    return undefined;
  }
}

export async function hydrateWindowsUserEnvironment(
  options: WindowsUserEnvironmentOptions = {},
): Promise<void> {
  if ((options.platform ?? process.platform) !== "win32") {
    return;
  }

  const readVariable = options.readVariable ?? readWindowsUserEnvironmentVariable;
  const values = await Promise.all(
    WINDOWS_USER_ENVIRONMENT_NAMES.map(async (name) => [name, await readVariable(name)] as const),
  );
  for (const [name, value] of values) {
    if (process.env[name] === undefined && value !== undefined) {
      process.env[name] = value;
    }
  }
}

export interface DuckRuntimeConfig {
  readonly config: DuckAgentConfig;
  readonly accessToken?: string;
  readonly oauth?: {
    readonly baseUrl: string;
    readonly clientId: string;
    readonly clientSecret: string;
    readonly redirectUri: string;
    readonly scopes: readonly string[];
  };
  readonly configPath: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function section(root: Record<string, unknown>, name: string): Record<string, unknown> {
  return asRecord(root[name]);
}

function environmentInteger(name: string): number | undefined {
  const value = process.env[name]?.trim();
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

async function readOptionalConfig(configPath: string): Promise<Record<string, unknown>> {
  try {
    return asRecord(JSON.parse(await readFile(configPath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw new Error(`Unable to read ${configPath}: ${(error as Error).message}`);
  }
}

export async function loadRuntimeConfig(
  configPath = path.resolve(process.cwd(), process.env.DUCK_CONFIG_FILE?.trim() || "config.json"),
): Promise<DuckRuntimeConfig> {
  const fileConfig = await readOptionalConfig(configPath);
  const serial = section(fileConfig, "serial");
  const studio = section(fileConfig, "studio");
  const runtime = section(fileConfig, "runtime");

  const serialPort = process.env.DUCK_SERIAL_PORT?.trim();
  const serialBaudRate = environmentInteger("DUCK_SERIAL_BAUD_RATE");
  const studioBaseUrl = process.env.DUCK_STUDIO_BASE_URL?.trim();
  const studioAgentId = process.env.DUCK_STUDIO_AGENT_ID?.trim();
  const studioConfigId = process.env.DUCK_STUDIO_CONFIG_ID?.trim();
  const studioModelId = process.env.DUCK_STUDIO_MODEL_ID?.trim();
  const smartHoldMs = environmentInteger("DUCK_SMART_HOLD_MS");
  const postRunCooldownMs = environmentInteger("DUCK_POST_RUN_COOLDOWN_MS");

  const config = parseConfig({
    serial: {
      ...serial,
      ...(serialPort ? { port: serialPort } : {}),
      ...(serialBaudRate === undefined ? {} : { baudRate: serialBaudRate }),
    },
    studio: {
      ...studio,
      ...(studioBaseUrl ? { baseUrl: studioBaseUrl } : {}),
      ...(studioAgentId ? { agentId: studioAgentId } : {}),
      ...(studioConfigId ? { configId: studioConfigId } : {}),
      ...(studioModelId ? { modelId: studioModelId } : {}),
    },
    runtime: {
      ...runtime,
      ...(smartHoldMs === undefined ? {} : { smartHoldMs }),
      ...(postRunCooldownMs === undefined ? {} : { postRunCooldownMs }),
    },
  });

  const oauthClientId = process.env.DUCK_OAUTH_CLIENT_ID?.trim();
  const oauthClientSecret = process.env.DUCK_OAUTH_CLIENT_SECRET?.trim();
  const oauthBaseUrl =
    process.env.DUCK_OAUTH_BASE_URL?.trim() ||
    (config.studio.baseUrl.includes(".dev.") || config.studio.baseUrl.includes(".stage.")
      ? "https://stage.id.trimblecloud.com"
      : "https://id.trimble.com");
  const oauth =
    oauthClientId && oauthClientSecret
      ? {
          baseUrl: oauthBaseUrl,
          clientId: oauthClientId,
          clientSecret: oauthClientSecret,
          redirectUri:
            process.env.DUCK_OAUTH_REDIRECT_URI?.trim() || "http://127.0.0.1:53682/callback",
          scopes: (process.env.DUCK_OAUTH_SCOPES?.trim() ||
            "openid kb ai-studio models agents iam Agentic-N8N-Webhook tools evals kb-ingest").split(/\s+/),
        }
      : undefined;

  return {
    config,
    accessToken: process.env.DUCK_STUDIO_ACCESS_TOKEN?.trim() || undefined,
    ...(oauth ? { oauth } : {}),
    configPath,
  };
}

export function requireStudioConfig(config: DuckAgentConfig): DuckAgentConfig {
  if (!config.studio.baseUrl) {
    throw new Error("DUCK_STUDIO_BASE_URL or studio.baseUrl is required.");
  }
  const baseUrl = new URL(config.studio.baseUrl);
  if (!['http:', 'https:'].includes(baseUrl.protocol)) {
    throw new Error("studio.baseUrl must use http or https.");
  }
  if (!config.studio.agentId) {
    throw new Error("DUCK_STUDIO_AGENT_ID or studio.agentId is required.");
  }
  return config;
}