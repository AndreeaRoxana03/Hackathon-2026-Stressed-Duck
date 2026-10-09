import type { AccessTokenProvider } from "./auth.js";

export type StudioJsonObject = Record<string, unknown>;

export interface AgentMetadata {
  readonly id: string;
  readonly name: string;
  readonly models: readonly {
    readonly id: string;
    readonly maxOutputTokens?: number;
  }[];
}

export type StudioRunMessage =
  | { readonly role: "user"; readonly content: string }
  | {
      readonly role: "tool";
      readonly toolCallId: string;
      readonly content: string;
      readonly error?: string;
    };

export interface StudioToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: StudioJsonObject;
}

export interface StudioRunRequest {
  readonly threadId?: string;
  readonly runId?: string;
  readonly messages: readonly StudioRunMessage[];
  readonly tools: readonly StudioToolDefinition[];
  readonly context?: readonly { readonly description: string; readonly value: string }[];
}

export type StudioEvent = StudioJsonObject & { readonly type: string };

export interface StudioClientOptions {
  readonly baseUrl: string;
  readonly agentId: string;
  readonly configId: string;
  readonly tokenProvider: AccessTokenProvider;
  readonly fetchImplementation?: typeof fetch;
}

function asObject(value: unknown): StudioJsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as StudioJsonObject)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function errorDetail(body: string): string {
  try {
    const parsed = asObject(JSON.parse(body));
    return (
      asString(parsed?.detail) ??
      asString(parsed?.message) ??
      asString(parsed?.title) ??
      body.trim()
    );
  } catch {
    return body.trim();
  }
}

async function studioError(response: Response, action: string): Promise<Error> {
  const detail = errorDetail(await response.text());
  const requestId = response.headers.get("x-request-id");
  return new Error(
    `Studio ${action} failed with HTTP ${response.status}: ${detail || response.statusText}${
      requestId ? ` (request ${requestId})` : ""
    }`,
  );
}

function parseMetadata(value: unknown, fallbackId: string): AgentMetadata {
  const body = asObject(value);
  const config = asObject(body?.config);
  const rawModels: readonly unknown[] = Array.isArray(body?.models)
    ? (body.models as readonly unknown[])
    : Array.isArray(config?.models)
      ? (config.models as readonly unknown[])
      : [];
  const models = rawModels.flatMap((model): AgentMetadata["models"][number][] => {
    const record = asObject(model);
    const id = asString(record?.id) ?? asString(record?.name);
    if (!id) {
      return [];
    }
    const maxOutputTokens = asFiniteNumber(record?.maxOutputTokens);
    return [{ id, ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }) }];
  });

  return {
    id: asString(body?.id) ?? fallbackId,
    name: asString(body?.name) ?? fallbackId,
    models,
  };
}

function parseEventBlock(block: string): StudioEvent[] {
  const dataLines = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());
  const data = dataLines.join("\n").trim();
  if (dataLines.length > 0) {
    if (!data || data === "[DONE]") {
      return [];
    }
    const event = asObject(JSON.parse(data));
    if (!event || typeof event.type !== "string") {
      throw new Error("Studio SSE event must be a JSON object with a type.");
    }
    return [event as StudioEvent];
  }

  return block
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .map((line) => {
      const event = asObject(JSON.parse(line));
      if (!event || typeof event.type !== "string") {
        throw new Error("Studio SSE event must be a JSON object with a type.");
      }
      return event as StudioEvent;
    });
}

export async function consumeStudioEventStream(
  response: Response,
  onEvent: (event: StudioEvent) => void,
): Promise<void> {
  if (!response.body) {
    throw new Error("Studio returned an empty streaming response.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 160_000) {
        throw new Error("Studio SSE buffer exceeds its size limit.");
      }
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        for (const event of parseEventBlock(block)) {
          onEvent(event);
          if (event.type === "RUN_FINISHED" || event.type === "RUN_ERROR") {
            return;
          }
        }
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      for (const event of parseEventBlock(buffer)) {
        onEvent(event);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class StudioClient {
  private readonly fetchImplementation: typeof fetch;

  public constructor(private readonly options: StudioClientOptions) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  public async getAgent(signal?: AbortSignal): Promise<AgentMetadata> {
    const url = new URL(
      `/v2/agents/${encodeURIComponent(this.options.agentId)}/configs/${encodeURIComponent(
        this.options.configId,
      )}`,
      this.options.baseUrl,
    );
    url.searchParams.set("fields", "models");
    const response = await this.fetchImplementation(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${await this.options.tokenProvider.getAccessToken()}`,
        "Content-Type": "application/json",
      },
      signal,
    });
    if (!response.ok) {
      throw await studioError(response, "agent lookup");
    }
    return parseMetadata(await response.json(), this.options.agentId);
  }

  public async run(
    request: StudioRunRequest,
    onEvent: (event: StudioEvent) => void,
    signal?: AbortSignal,
    cancel = false,
  ): Promise<void> {
    const url = new URL(
      `/v2/agents/${encodeURIComponent(this.options.agentId)}/runs`,
      this.options.baseUrl,
    );
    url.searchParams.set("configId", this.options.configId);
    if (cancel) {
      url.searchParams.set("cancel", "true");
    }
    const response = await this.fetchImplementation(url, {
      method: "POST",
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${await this.options.tokenProvider.getAccessToken()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
      signal,
    });
    if (!response.ok) {
      throw await studioError(response, "agent run");
    }
    await consumeStudioEventStream(response, onEvent);
  }

  public async cancel(threadId: string, runId: string, tools: readonly StudioToolDefinition[]): Promise<void> {
    await this.run({ threadId, runId, messages: [], tools }, () => {}, AbortSignal.timeout(5_000), true);
  }
}

export function assertConfiguredModel(metadata: AgentMetadata, modelId?: string): void {
  if (!modelId) {
    return;
  }
  if (!metadata.models.some((model) => model.id === modelId)) {
    const available = metadata.models.map((model) => model.id).join(", ") || "none reported";
    throw new Error(`Configured Studio model '${modelId}' was not found. Available models: ${available}.`);
  }
}