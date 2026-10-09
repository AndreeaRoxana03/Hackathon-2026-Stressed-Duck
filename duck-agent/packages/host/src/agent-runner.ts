import type { AgentActivity, AgentResult, AgentRunStatus } from "./agent-result.js";
import type { EditProposal, ToolExecutionResult, WorkspaceToolExecutor } from "./workspace-tools.js";
import type { AgentRunner, AgentRunContext, AgentOutcome } from "./orchestrator.js";
import { fitComment } from "./protocol.js";
import type {
  StudioClient,
  StudioEvent,
  StudioRunMessage,
  StudioRunRequest,
  StudioToolDefinition,
} from "./studio-client.js";

const DEFAULT_SUCCESS_COMMENT = "The agent completed its inspection. Details are in your editor.";
const DEFAULT_FAILURE_COMMENT = "The Studio run failed. Details are in your editor.";
const DEFAULT_ABORT_COMMENT = "The Studio run was cancelled.";
const DEFAULT_CLARIFICATION_COMMENT = "Please speak what failed and what you expected.";
const MAX_TOOL_LEGS = 16;
const MAX_TOOL_CALLS = 32;
const MAX_RESULT_TEXT = 160_000;
const READ_ONLY_TOOLS = new Set(["read_file", "search_files", "git_diff"]);

export interface StudioAgentRunnerOptions {
  readonly client: StudioClient;
  readonly prompt: string;
  readonly tools?: readonly StudioToolDefinition[];
  readonly toolExecutor?: WorkspaceToolExecutor;
  readonly context?: readonly { readonly description: string; readonly value: string }[];
  readonly onEvent?: (event: StudioEvent) => void;
  readonly onActivity?: (activity: AgentActivity) => void;
  readonly maxToolLegs?: number;
  readonly maxToolCalls?: number;
  readonly workspaceRoot?: string;
  readonly requireStructuredResult?: boolean;
  readonly maxRunMs?: number;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function valueText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (value !== undefined) {
    try {
      return JSON.stringify(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function eventText(event: StudioEvent): string | undefined {
  return (
    stringValue(event.delta) ??
    stringValue(event.content) ??
    stringValue(event.text) ??
    stringValue(event.response)
  );
}

function eventRunStatus(event: StudioEvent): string | undefined {
  const result = event.result;
  if (result !== null && typeof result === "object" && !Array.isArray(result)) {
    return stringValue((result as Record<string, unknown>).runStatus);
  }
  return stringValue(event.status);
}

function failedStatus(status: string | undefined): boolean {
  return status !== undefined && ["failed", "error", "cancelled", "aborted"].includes(status.toLowerCase());
}

function eventToolCallId(event: StudioEvent): string | undefined {
  return stringValue(event.toolCallId) ?? stringValue(event.id);
}

function eventToolCallName(event: StudioEvent): string | undefined {
  return stringValue(event.toolCallName) ?? stringValue(event.toolName) ?? stringValue(event.name);
}

function eventToolArguments(event: StudioEvent): string | undefined {
  return (
    valueText(event.delta) ??
    valueText(event.args) ??
    valueText(event.arguments) ??
    valueText(event.input)
  );
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function awaitedToolCallIds(event: StudioEvent): string[] {
  const result = objectValue(event.result);
  return stringArray(event.awaitedToolCallIds ?? result?.awaitedToolCallIds);
}

function responseCandidates(trimmed: string): string[] {
  const candidates = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
  if (fenced) {
    candidates.push(fenced);
  }
  const objectStart = trimmed.indexOf("{");
  const objectEnd = trimmed.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    candidates.push(trimmed.slice(objectStart, objectEnd + 1));
  }
  return [...new Set(candidates)];
}

interface StructuredResponse {
  readonly status?: AgentRunStatus;
  readonly roast?: string;
  readonly diagnosis?: string;
  readonly explanation?: string;
  readonly verification: readonly string[];
  readonly clarificationQuestion?: string;
}

function parseStructuredResponse(responseText: string): StructuredResponse {
  const trimmed = responseText.trim();
  const candidates = responseCandidates(trimmed);

  for (const candidate of candidates) {
    try {
      const value = objectValue(JSON.parse(candidate));
      if (!value) {
        continue;
      }
      const rawStatus = stringValue(value.status)?.toLowerCase();
      const status: AgentRunStatus | undefined = rawStatus === "success" || rawStatus === "failure" || rawStatus === "needs_clarification" || rawStatus === "aborted"
        ? rawStatus
        : undefined;
      return {
        ...(status ? { status } : {}),
        ...(stringValue(value.roast) ?? stringValue(value.comment) ? { roast: stringValue(value.roast) ?? stringValue(value.comment) } : {}),
        ...(stringValue(value.diagnosis) ? { diagnosis: stringValue(value.diagnosis) } : {}),
        ...(stringValue(value.explanation) ?? stringValue(value.fix) ? { explanation: stringValue(value.explanation) ?? stringValue(value.fix) } : {}),
        verification: stringArray(value.verification ?? value.verificationOutput),
        ...(stringValue(value.clarificationQuestion) ?? stringValue(value.question)
          ? { clarificationQuestion: stringValue(value.clarificationQuestion) ?? stringValue(value.question) }
          : {}),
      };
    } catch {
      continue;
    }
  }

  return { verification: [] };
}

function boundedResultText(value: string): string {
  return value.length <= MAX_RESULT_TEXT ? value : `${value.slice(0, MAX_RESULT_TEXT)}\n...[result truncated]`;
}

function toolActivityDetail(name: string, args: unknown): string | undefined {
  const record = objectValue(args);
  if (!record) {
    return undefined;
  }
  if (["read_file", "git_diff", "propose_edit"].includes(name)) {
    return stringValue(record.path);
  }
  if (name === "search_files") {
    return stringValue(record.path) ?? "workspace";
  }
  if (name === "run_tests") {
    return stringValue(record.command);
  }
  return undefined;
}

function proposalList(executor: WorkspaceToolExecutor | undefined): EditProposal[] {
  if (!executor) {
    return [];
  }
  const proposals = executor.getProposals?.() ?? [];
  if (proposals.length > 0) {
    return [...proposals];
  }
  const last = executor.getLastProposal();
  return last ? [last] : [];
}

export class StudioAgentRunner implements AgentRunner {
  private lastResult: AgentResult | undefined;

  public constructor(private readonly options: StudioAgentRunnerOptions) {}

  public getLastResult(): AgentResult | undefined {
    return this.lastResult;
  }

  public async applyProposal(path?: string): Promise<EditProposal> {
    if (!this.options.toolExecutor) {
      throw new Error("No workspace tool executor is attached to this run.");
    }
    if (path && this.options.toolExecutor.applyProposal) {
      return this.options.toolExecutor.applyProposal(path);
    }
    return this.options.toolExecutor.applyLastProposal();
  }

  public rejectProposals(): void {
    this.options.toolExecutor?.clearLastProposal();
    this.options.toolExecutor?.clearProposals?.();
  }

  public async run(context: AgentRunContext): Promise<AgentOutcome> {
    this.lastResult = undefined;
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), this.options.maxRunMs ?? 120_000);
    const abort = () => controller.abort();
    context.signal.addEventListener("abort", abort, { once: true });
    if (context.signal.aborted) {
      controller.abort();
    }

    let messages: StudioRunMessage[] = [{ role: "user", content: this.options.prompt }];
    const request: StudioRunRequest = {
      messages,
      tools: this.options.tools ?? this.options.toolExecutor?.definitions ?? [],
      ...(this.options.context ? { context: this.options.context } : {}),
    };
    let responseText = "";
    let runStatus: string | undefined;
    let threadId: string | undefined;
    let runId: string | undefined;
    let legs = 0;
    let toolCalls = 0;
    const deliveredToolCalls = new Set<string>();
    const toolResults = new Map<string, StudioRunMessage>();
    const verification: string[] = [];
    const activity: AgentActivity[] = [];
    const recordActivity = (entry: AgentActivity): void => {
      activity.push(entry);
      this.options.onActivity?.(entry);
    };

    const outcome = (status: AgentRunStatus, comment: string, structured?: StructuredResponse): AgentOutcome => {
      const proposals = status === "success" || status === "failure" ? proposalList(this.options.toolExecutor) : [];
      if (status === "aborted" || status === "needs_clarification") {
        this.rejectProposals();
      }
      const result: AgentResult = {
        status,
        responseText: boundedResultText(responseText),
        ...(structured?.roast ? { roast: structured.roast } : {}),
        ...(structured?.diagnosis ? { diagnosis: structured.diagnosis } : {}),
        ...(structured?.explanation ? { explanation: structured.explanation } : {}),
        verification: [...verification, ...(structured?.verification ?? [])].map(boundedResultText),
        activity: [...activity],
        proposedEdits: proposals,
        ...(structured?.clarificationQuestion ? { clarificationQuestion: structured.clarificationQuestion } : {}),
        ...(threadId ? { threadId } : {}),
        ...(runId ? { runId } : {}),
        legs,
        toolCalls,
        ...(this.options.workspaceRoot ? { workspaceRoot: this.options.workspaceRoot } : {}),
        generation: context.generation,
      };
      this.lastResult = result;
      return { status, comment: fitComment(comment), result };
    };

    const executeToolCall = async (
      toolCallId: string,
      toolName: string,
      rawArguments: string,
    ): Promise<StudioRunMessage> => {
      if (!this.options.toolExecutor) {
        recordActivity({ tool: toolName || "unknown", status: "failed", detail: "Local tool unavailable" });
        return {
          role: "tool",
          toolCallId,
          content: "The requested local tool is unavailable.",
          error: "No local workspace tool executor is attached.",
        };
      }

      let args: unknown = {};
      try {
        args = rawArguments.trim() ? JSON.parse(rawArguments) : {};
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        recordActivity({ tool: toolName || "unknown", status: "failed", detail: "Invalid arguments" });
        return { role: "tool", toolCallId, content: `Invalid tool arguments: ${message}`, error: message };
      }

      const result: ToolExecutionResult = await this.options.toolExecutor.execute(toolName, args, controller.signal);
      const detail = toolActivityDetail(toolName, args);
      recordActivity({
        tool: toolName || "unknown",
        status: result.error ? "failed" : "completed",
        ...(detail ? { detail } : {}),
      });
      if (toolName === "run_tests") {
        verification.push(result.content);
      }
      return {
        role: "tool",
        toolCallId,
        content: result.content,
        ...(result.error ? { error: result.error } : {}),
      };
    };

    try {
      while (true) {
        if (controller.signal.aborted) {
          return outcome("aborted", DEFAULT_ABORT_COMMENT);
        }
        legs += 1;
        if (legs > (this.options.maxToolLegs ?? MAX_TOOL_LEGS)) {
          return outcome("failure", "The agent used too many investigation steps.", { explanation: "The investigation reached its step limit. Completed fixes are retained, but the diagnosis is incomplete.", verification: [] });
        }

        const calls = new Map<string, { readonly name: string; args: string }>();
        let awaitedIds: string[] = [];
        let finished = false;
        responseText = "";
        runStatus = undefined;
        await this.options.client.run(
          {
            ...request,
            ...(threadId ? { threadId } : {}),
            ...(runId ? { runId } : {}),
            messages,
          },
          (event) => {
            this.options.onEvent?.(event);
            if (event.type === "RUN_STARTED") {
              threadId = stringValue(event.threadId) ?? threadId;
              runId = stringValue(event.runId) ?? runId;
            }
            const toolCallId = eventToolCallId(event);
            if (toolCallId && event.type === "TOOL_CALL_START") {
              calls.set(toolCallId, { name: eventToolCallName(event) ?? "", args: "" });
            }
            if (toolCallId && ["TOOL_CALL_ARGS", "TOOL_CALL_CHUNK"].includes(event.type)) {
              const call = calls.get(toolCallId) ?? { name: eventToolCallName(event) ?? "", args: "" };
              const delta = eventToolArguments(event);
              if (delta) {
                if (call.args.length + delta.length > 48_000) {
                  throw new Error("Tool arguments exceed the run limit.");
                }
                call.args += delta;
              }
              calls.set(toolCallId, call);
            }
            if (toolCallId && eventToolCallName(event) && !calls.has(toolCallId)) {
              calls.set(toolCallId, { name: eventToolCallName(event)!, args: "" });
            }
            const text = eventText(event);
            if (text && ["TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_CHUNK", "message"].includes(event.type)) {
              if (responseText.length + text.length > MAX_RESULT_TEXT) {
                throw new Error("Studio response exceeds the run output limit.");
              }
              responseText += text;
            }
            if (event.type === "RUN_ERROR") {
              throw new Error(stringValue(event.message) ?? DEFAULT_FAILURE_COMMENT);
            }
            if (event.type === "RUN_FINISHED") {
              finished = true;
              runStatus = eventRunStatus(event);
              awaitedIds = awaitedToolCallIds(event);
            }
          },
          controller.signal,
        );

        if (controller.signal.aborted) {
          return outcome("aborted", DEFAULT_ABORT_COMMENT);
        }
        if (failedStatus(runStatus)) {
          return outcome("failure", DEFAULT_FAILURE_COMMENT);
        }
        if (!finished) {
          return outcome("failure", "The Studio stream ended before the run finished.");
        }
        const freshAwaitedIds = [...new Set(awaitedIds)].filter((id) => !deliveredToolCalls.has(id));
        if (freshAwaitedIds.length === 0) {
          if (awaitedIds.length > 0) {
            return outcome("failure", "Studio repeated a tool call that was already delivered.");
          }
          break;
        }
        if (!this.options.toolExecutor) {
          return outcome("failure", "The agent requested a local tool that is unavailable.");
        }
        if (toolCalls + freshAwaitedIds.length > (this.options.maxToolCalls ?? MAX_TOOL_CALLS)) {
          return outcome("failure", "The agent requested too many local tool calls.");
        }

        const readOnly = freshAwaitedIds.filter((id) => READ_ONLY_TOOLS.has(calls.get(id)?.name ?? ""));
        const controlled = freshAwaitedIds.filter((id) => !readOnly.includes(id));
        const execute = async (id: string): Promise<void> => {
          controller.signal.throwIfAborted();
          const call = calls.get(id);
          const message = await executeToolCall(id, call?.name ?? "", call?.args ?? "");
          controller.signal.throwIfAborted();
          toolResults.set(id, message);
          deliveredToolCalls.add(id);
          toolCalls += 1;
        };
        await Promise.all(readOnly.map((id) => execute(id)));
        for (const id of controlled) {
          await execute(id);
        }
        messages = freshAwaitedIds.flatMap((id) => {
          const message = toolResults.get(id);
          return message ? [message] : [];
        });
      }

      if (controller.signal.aborted) {
        return outcome("aborted", DEFAULT_ABORT_COMMENT);
      }
      const structured = parseStructuredResponse(responseText);
      if (this.options.requireStructuredResult && !structured.status) {
        return outcome("failure", "The agent returned an invalid final result. Details are in your editor.");
      }
      const status = structured.status ?? "success";
      let comment = structured.roast ?? (status === "needs_clarification"
        ? (structured.clarificationQuestion ?? (responseText || DEFAULT_CLARIFICATION_COMMENT))
        : responseText || DEFAULT_SUCCESS_COMMENT);
      if (status === "needs_clarification") {
        const question = structured.clarificationQuestion ?? "";
        if (!/\bspeak\b/i.test(comment) && question) {
          comment = `${comment} ${question}`;
        }
        if (!/\bspeak\b/i.test(fitComment(comment))) {
          comment = DEFAULT_CLARIFICATION_COMMENT;
        }
      }
      if (/[`{}\n]|=>|\b(?:function|class|import|const)\s/.test(comment)) {
        comment = status === "needs_clarification" ? DEFAULT_CLARIFICATION_COMMENT : DEFAULT_SUCCESS_COMMENT;
      }
      return outcome(status, comment, structured);
    } catch (error) {
      if (context.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        return outcome("aborted", DEFAULT_ABORT_COMMENT);
      }
      const detail = error instanceof Error ? error.message : "Unknown Studio failure.";
      return outcome("failure", DEFAULT_FAILURE_COMMENT, { explanation: detail, verification: [] });
    } finally {
      clearTimeout(deadline);
      context.signal.removeEventListener("abort", abort);
      if (controller.signal.aborted && threadId && runId && typeof this.options.client.cancel === "function") {
        await this.options.client.cancel(threadId, runId, request.tools).catch(() => {});
      }
    }
  }
}