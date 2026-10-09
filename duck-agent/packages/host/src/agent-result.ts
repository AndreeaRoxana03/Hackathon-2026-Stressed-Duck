export type AgentRunStatus = "success" | "failure" | "needs_clarification" | "aborted";

export type AgentActivityStatus = "completed" | "failed";

export interface AgentActivity {
  readonly tool: string;
  readonly status: AgentActivityStatus;
  readonly detail?: string;
}

export interface AgentEditProposal {
  readonly path: string;
  readonly oldText: string;
  readonly newText: string;
  readonly diff: string;
  readonly baseText?: string;
}

export interface AgentResult {
  readonly status: AgentRunStatus;
  readonly responseText: string;
  readonly roast?: string;
  readonly diagnosis?: string;
  readonly explanation?: string;
  readonly verification: readonly string[];
  readonly activity: readonly AgentActivity[];
  readonly proposedEdits: readonly AgentEditProposal[];
  readonly clarificationQuestion?: string;
  readonly threadId?: string;
  readonly runId?: string;
  readonly legs: number;
  readonly toolCalls: number;
  readonly workspaceRoot?: string;
  readonly generation?: number;
}