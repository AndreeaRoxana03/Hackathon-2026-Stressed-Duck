import assert from "node:assert/strict";
import test from "node:test";
import { StudioAgentRunner } from "./agent-runner.js";
import type { AgentRunContext } from "./orchestrator.js";
import type { StudioClient, StudioRunRequest } from "./studio-client.js";

function context(signal = new AbortController().signal): AgentRunContext {
  return { generation: 1, signal };
}

test("maps streamed assistant text to a successful duck outcome", async () => {
  let request: StudioRunRequest | undefined;
  const client = {
    async run(
      value: StudioRunRequest,
      onEvent: (event: { type: string; [key: string]: unknown }) => void,
    ): Promise<void> {
      request = value;
      onEvent({ type: "TEXT_MESSAGE_CONTENT", delta: "The connection is " });
      onEvent({ type: "TEXT_MESSAGE_CHUNK", delta: "working." });
      onEvent({ type: "RUN_FINISHED", result: { runStatus: "completed" } });
    },
  } as unknown as StudioClient;
  const runner = new StudioAgentRunner({
    client,
    prompt: "Confirm the connection.",
    tools: [],
  });

  const outcome = await runner.run(context());

  assert.deepEqual(request?.messages, [{ role: "user", content: "Confirm the connection." }]);
  assert.equal(outcome.status, "success");
  assert.equal(outcome.comment, "The connection is working.");
  assert.deepEqual(outcome.result, {
    status: "success",
    responseText: "The connection is working.",
    verification: [],
    activity: [],
    proposedEdits: [],
    legs: 1,
    toolCalls: 0,
    generation: 1,
  });
});

test("executes an awaited local tool and resumes the same Studio run", async () => {
  const requests: StudioRunRequest[] = [];
  let call = 0;
  const client = {
    async run(
      request: StudioRunRequest,
      onEvent: (event: { type: string; [key: string]: unknown }) => void,
    ): Promise<void> {
      requests.push(request);
      call += 1;
      if (call === 1) {
        onEvent({ type: "RUN_STARTED", threadId: "thread-1", runId: "run-1" });
        onEvent({ type: "TOOL_CALL_START", toolCallId: "tool-1", toolCallName: "read_file" });
        onEvent({ type: "TOOL_CALL_ARGS", toolCallId: "tool-1", delta: '{"path":"README.md"}' });
        onEvent({ type: "TOOL_CALL_END", toolCallId: "tool-1" });
        onEvent({ type: "RUN_FINISHED", awaitedToolCallIds: ["tool-1"], result: { runStatus: "awaiting_tool" } });
        return;
      }
      onEvent({
        type: "TEXT_MESSAGE_CONTENT",
        delta: 'Caught it.\n\n{"status":"success","roast":"Done.","diagnosis":"Found it.","explanation":"Fixed it.","verification":["Tests pass"]}',
      });
      onEvent({ type: "RUN_FINISHED", awaitedToolCallIds: [], result: { runStatus: "completed" } });
    },
  } as unknown as StudioClient;
  const executor = {
    definitions: [{ name: "read_file", description: "Read a file.", parameters: { type: "object" } }],
    async execute() {
      return { content: "README contents" };
    },
    getLastProposal() {
      return undefined;
    },
    async applyLastProposal() {
      throw new Error("No proposal");
    },
    clearLastProposal() {},
  };
  const runner = new StudioAgentRunner({
    client,
    prompt: "Inspect this.",
    toolExecutor: executor,
  });

  const outcome = await runner.run(context());

  assert.equal(requests.length, 2);
  assert.equal(requests[1]?.threadId, "thread-1");
  assert.equal(requests[1]?.runId, "run-1");
  assert.deepEqual(requests[1]?.messages, [{
    role: "tool",
    toolCallId: "tool-1",
    content: "README contents",
  }]);
  assert.equal(outcome.status, "success");
  assert.equal(outcome.comment, "Done.");
  assert.equal(outcome.result?.legs, 2);
  assert.equal(outcome.result?.toolCalls, 1);
  assert.deepEqual(outcome.result?.verification, ["Tests pass"]);
  assert.deepEqual(outcome.result?.activity, [{ tool: "read_file", status: "completed", detail: "README.md" }]);
});

test("maps a remote run error to a failure without exposing it as a success", async () => {
  const client = {
    async run(
      _request: StudioRunRequest,
      onEvent: (event: { type: string; [key: string]: unknown }) => void,
    ): Promise<void> {
      onEvent({ type: "RUN_ERROR", message: "remote details" });
    },
  } as unknown as StudioClient;
  const runner = new StudioAgentRunner({ client, prompt: "Test failure." });

  const outcome = await runner.run(context());

  assert.equal(outcome.status, "failure");
  assert.equal(outcome.comment, "The Studio run failed. Details are in your editor.");
});

test("aborts the Studio request when the orchestrator signal is cancelled", async () => {
  const controller = new AbortController();
  let requestSignal: AbortSignal | undefined;
  const client = {
    async run(
      _request: StudioRunRequest,
      _onEvent: (event: { type: string; [key: string]: unknown }) => void,
      signal?: AbortSignal,
    ): Promise<void> {
      requestSignal = signal;
      await new Promise<void>((resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
          once: true,
        });
        if (signal?.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
        }
      });
    },
  } as unknown as StudioClient;
  const runner = new StudioAgentRunner({ client, prompt: "Cancel this." });
  const run = runner.run(context(controller.signal));
  controller.abort();

  const outcome = await run;
  assert.equal(outcome.status, "aborted");
  assert.equal(outcome.comment, "The Studio run was cancelled.");
  assert.equal(outcome.result?.status, "aborted");
  assert.equal(requestSignal?.aborted, true);
});

test("rejects truncated streams and non-structured final results", async () => {
  for (const finished of [false, true]) {
    const client = {
      async run(_request: StudioRunRequest, onEvent: (event: { type: string; [key: string]: unknown }) => void) {
        onEvent({ type: "TEXT_MESSAGE_CONTENT", delta: "Unstructured result." });
        if (finished) {
          onEvent({ type: "RUN_FINISHED" });
        }
      },
    } as unknown as StudioClient;
    const runner = new StudioAgentRunner({ client, prompt: "Inspect", requireStructuredResult: true });
    assert.equal((await runner.run(context())).status, "failure");
  }
});

test("clarification invites speech and never exposes proposed edits", async () => {
  const client = {
    async run(_request: StudioRunRequest, onEvent: (event: { type: string; [key: string]: unknown }) => void) {
      onEvent({ type: "TEXT_MESSAGE_CONTENT", delta: JSON.stringify({ status: "needs_clarification", roast: "This function needs evidence.", clarificationQuestion: "Speak what failed and what you expected." }) });
      onEvent({ type: "RUN_FINISHED" });
    },
  } as unknown as StudioClient;
  const runner = new StudioAgentRunner({ client, prompt: "Inspect", requireStructuredResult: true });
  const outcome = await runner.run(context());
  assert.equal(outcome.status, "needs_clarification");
  assert.match(outcome.comment, /speak/i);
  assert.deepEqual(outcome.result?.proposedEdits, []);
});

test("retains completed fixes when the investigation reaches its step limit", async () => {
  const proposal = { path: "code.ts", oldText: "before", newText: "after", baseText: "before", diff: "fix" };
  const client = {
    async run(_request: StudioRunRequest, onEvent: (event: { type: string; [key: string]: unknown }) => void) {
      onEvent({ type: "TOOL_CALL_START", toolCallId: "edit-1", toolCallName: "propose_edit" });
      onEvent({ type: "TOOL_CALL_ARGS", toolCallId: "edit-1", delta: "{}" });
      onEvent({ type: "RUN_FINISHED", awaitedToolCallIds: ["edit-1"] });
    },
  } as unknown as StudioClient;
  let cleared = false;
  const runner = new StudioAgentRunner({
    client,
    prompt: "Fix errors.",
    maxToolLegs: 1,
    toolExecutor: {
      definitions: [],
      async execute() { return { content: "staged", proposal }; },
      getLastProposal() { return proposal; },
      async applyLastProposal() { return proposal; },
      clearLastProposal() { cleared = true; },
    },
  });
  const outcome = await runner.run(context());
  assert.equal(outcome.status, "failure");
  assert.deepEqual(outcome.result?.proposedEdits, [proposal]);
  assert.match(outcome.result?.explanation ?? "", /step limit/);
  assert.equal(cleared, false);
});