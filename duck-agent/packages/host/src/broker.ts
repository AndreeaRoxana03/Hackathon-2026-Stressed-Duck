import { timingSafeEqual } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import type { AgentActivity, AgentEditProposal, AgentResult } from "./agent-result.js";
import type { OrchestratorState } from "./orchestrator.js";
import type { DuckMood } from "./protocol.js";
import type { AudioSessionStatus } from "./audio-server.js";

const MAX_CONTEXT_EXCERPT = 8_000;
export const BROKER_PROTOCOL_VERSION = 1;
const MAX_DIAGNOSTICS = 50;
const MAX_SYMBOLS = 100;
const MAX_SELECTION_TEXT = 4_000;

export interface EditorContext {
  readonly workspaceRoot?: string;
  readonly filePath?: string;
  readonly languageId?: string;
  readonly line?: number;
  readonly column?: number;
  readonly selectionStartLine?: number;
  readonly selectionStartColumn?: number;
  readonly selectionEndLine?: number;
  readonly selectionEndColumn?: number;
  readonly selectedText?: string;
  readonly documentVersion?: number;
  readonly isDirty?: boolean;
  readonly excerpt?: string;
  readonly diagnostics?: readonly string[];
  readonly symbols?: readonly string[];
}

export interface BrokerTriggerRequest {
  readonly prompt?: string;
  readonly context?: EditorContext;
  readonly windowId?: string;
  readonly captureId?: string;
}

export interface BrokerWindowPoll {
  readonly windowId: string;
  readonly focused: boolean;
  readonly trusted: boolean;
  readonly completedGeneration?: number;
}

export interface BrokerClarificationRequest {
  readonly answer?: string;
  readonly microphone?: boolean;
}

export interface BrokerProgress {
  readonly phase: "starting" | "running" | "tool" | "finished" | "failed" | "aborted";
  readonly message: string;
  readonly leg?: number;
  readonly toolCalls?: number;
  readonly activity?: readonly AgentActivity[];
}

export interface BrokerStatus {
  readonly state: OrchestratorState;
  readonly cooldownUntilMs: number;
  readonly deviceMood?: DuckMood;
  readonly progress?: BrokerProgress;
  readonly lastResult?: AgentResult;
}

export interface BrokerResponse {
  readonly ok: boolean;
  readonly accepted?: boolean;
  readonly status?: BrokerStatus;
  readonly result?: AgentResult;
  readonly proposal?: AgentEditProposal;
  readonly error?: string;
  readonly captureId?: string;
  readonly speech?: AudioSessionStatus;
}

export interface BrokerHandlers {
  readonly onTrigger: (request: BrokerTriggerRequest) => Promise<{
    accepted: boolean;
    status: BrokerStatus;
    result?: AgentResult;
  }>;
  readonly onStatus: () => BrokerStatus;
  readonly onStop: () => Promise<void>;
  readonly onPoll?: (request: BrokerWindowPoll) => Promise<BrokerResponse>;
  readonly onApplyProposal?: (path?: string) => Promise<AgentEditProposal>;
  readonly onRejectProposals?: () => void | Promise<void>;
  readonly onClarify?: (request: BrokerClarificationRequest) => Promise<{
    accepted: boolean;
    status: BrokerStatus;
    result?: AgentResult;
  }>;
}

export interface DuckBrokerServerOptions {
  readonly pipeName: string;
  readonly token: string;
  readonly handlers: BrokerHandlers;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function authorized(expected: string, received: unknown): boolean {
  if (typeof received !== "string") {
    return false;
  }
  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(received);
  return expectedBytes.length === receivedBytes.length && timingSafeEqual(expectedBytes, receivedBytes);
}

function parseContext(value: unknown): EditorContext | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const diagnostics = Array.isArray(record.diagnostics)
    ? record.diagnostics.filter((item): item is string => typeof item === "string").slice(0, MAX_DIAGNOSTICS)
    : undefined;
  const symbols = Array.isArray(record.symbols)
    ? record.symbols.filter((item): item is string => typeof item === "string").slice(0, MAX_SYMBOLS)
    : undefined;
  return {
    ...(stringValue(record.workspaceRoot) ? { workspaceRoot: stringValue(record.workspaceRoot) } : {}),
    ...(stringValue(record.filePath) ? { filePath: stringValue(record.filePath) } : {}),
    ...(stringValue(record.languageId) ? { languageId: stringValue(record.languageId) } : {}),
    ...(numberValue(record.line) === undefined ? {} : { line: numberValue(record.line) }),
    ...(numberValue(record.column) === undefined ? {} : { column: numberValue(record.column) }),
    ...(numberValue(record.selectionStartLine) === undefined ? {} : { selectionStartLine: numberValue(record.selectionStartLine) }),
    ...(numberValue(record.selectionStartColumn) === undefined ? {} : { selectionStartColumn: numberValue(record.selectionStartColumn) }),
    ...(numberValue(record.selectionEndLine) === undefined ? {} : { selectionEndLine: numberValue(record.selectionEndLine) }),
    ...(numberValue(record.selectionEndColumn) === undefined ? {} : { selectionEndColumn: numberValue(record.selectionEndColumn) }),
    ...(stringValue(record.selectedText) ? { selectedText: stringValue(record.selectedText)!.slice(0, MAX_SELECTION_TEXT) } : {}),
    ...(numberValue(record.documentVersion) === undefined ? {} : { documentVersion: numberValue(record.documentVersion) }),
    ...(booleanValue(record.isDirty) === undefined ? {} : { isDirty: booleanValue(record.isDirty) }),
    ...(stringValue(record.excerpt)
      ? { excerpt: stringValue(record.excerpt)!.slice(0, MAX_CONTEXT_EXCERPT) }
      : {}),
    ...(diagnostics && diagnostics.length > 0 ? { diagnostics } : {}),
    ...(symbols && symbols.length > 0 ? { symbols } : {}),
  };
}

function parseClarification(value: unknown): BrokerClarificationRequest {
  const record = asRecord(value);
  return {
    ...(stringValue(record?.answer) ? { answer: stringValue(record?.answer) } : {}),
    ...(typeof record?.microphone === "boolean" ? { microphone: record.microphone } : {}),
  };
}

export async function handleBrokerMessage(
  line: string,
  token: string,
  handlers: BrokerHandlers,
): Promise<BrokerResponse> {
  let request: Record<string, unknown>;
  try {
    const parsed = JSON.parse(line) as unknown;
    const record = asRecord(parsed);
    if (!record) {
      return { ok: false, error: "Invalid broker request." };
    }
    request = record;
  } catch {
    return { ok: false, error: "Invalid broker request." };
  }

  if (!authorized(token, request.token)) {
    return { ok: false, error: "Unauthorized broker request." };
  }
  if (request.protocolVersion !== BROKER_PROTOCOL_VERSION) {
    return { ok: false, error: "Incompatible broker protocol. Update the host and extension together." };
  }

  switch (request.type) {
    case "trigger": {
      const result = await handlers.onTrigger({
        ...(stringValue(request.prompt) ? { prompt: stringValue(request.prompt) } : {}),
        ...(parseContext(request.context) ? { context: parseContext(request.context) } : {}),
        ...(stringValue(request.windowId) ? { windowId: stringValue(request.windowId) } : {}),
        ...(stringValue(request.captureId) ? { captureId: stringValue(request.captureId) } : {}),
      });
      return { ok: true, accepted: result.accepted, status: result.status, ...(result.result ? { result: result.result } : {}) };
    }
    case "status":
      return { ok: true, status: handlers.onStatus() };
    case "poll": {
      if (!handlers.onPoll || !stringValue(request.windowId)) {
        return { ok: false, error: "Window registration is unavailable." };
      }
      if (request.completedGeneration !== undefined &&
          (typeof request.completedGeneration !== "number" || !Number.isSafeInteger(request.completedGeneration) || request.completedGeneration < 1)) {
        return { ok: false, error: "Invalid completed result generation." };
      }
      return handlers.onPoll({
        windowId: stringValue(request.windowId)!, focused: request.focused === true, trusted: request.trusted === true,
        ...(request.completedGeneration === undefined ? {} : { completedGeneration: request.completedGeneration as number }),
      });
    }
    case "stop":
      await handlers.onStop();
      return { ok: true, status: handlers.onStatus() };
    case "apply": {
      if (!handlers.onApplyProposal) {
        return { ok: false, error: "Proposal review is unavailable." };
      }
      const proposal = await handlers.onApplyProposal(stringValue(request.path));
      return { ok: true, proposal, status: handlers.onStatus() };
    }
    case "reject":
      if (!handlers.onRejectProposals) {
        return { ok: false, error: "Proposal review is unavailable." };
      }
      await handlers.onRejectProposals();
      return { ok: true, status: handlers.onStatus() };
    case "clarify": {
      if (!handlers.onClarify) {
        return { ok: false, error: "Clarification is unavailable." };
      }
      const result = await handlers.onClarify(parseClarification(request));
      return { ok: true, accepted: result.accepted, status: result.status, ...(result.result ? { result: result.result } : {}) };
    }
    default:
      return { ok: false, error: "Unknown broker request." };
  }
}

export class DuckBrokerServer {
  private readonly server: Server;

  public constructor(private readonly options: DuckBrokerServerOptions) {
    if (!options.token.trim()) {
      throw new Error("A non-empty broker token is required.");
    }
    this.server = createServer((socket) => this.handleConnection(socket));
  }

  public async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.server.once("error", onError);
      this.server.listen(this.options.pipeName, () => {
        this.server.off("error", onError);
        resolve();
      });
    });
  }

  public async stop(): Promise<void> {
    if (!this.server.listening) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private handleConnection(socket: Socket): void {
    let buffer = "";
    let handled = false;
    socket.setEncoding("utf8");
    socket.setTimeout(180_000, () => socket.destroy());
    socket.on("data", (chunk: string) => {
      if (handled) {
        return;
      }
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 64_000) {
        handled = true;
        socket.end(`${JSON.stringify({ ok: false, error: "Broker request exceeds the size limit." })}\n`);
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      handled = true;
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      void handleBrokerMessage(line, this.options.token, this.options.handlers)
        .catch(() => ({ ok: false, error: "Broker operation failed." } satisfies BrokerResponse))
        .then((response) => socket.end(`${JSON.stringify({ ...response, protocolVersion: BROKER_PROTOCOL_VERSION })}\n`));
    });
  }
}