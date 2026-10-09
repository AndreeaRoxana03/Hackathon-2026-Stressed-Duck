import { OAuthTokenProvider, StaticTokenProvider } from "./auth.js";
import { StudioAgentRunner } from "./agent-runner.js";
import {
  DuckBrokerServer,
  type BrokerProgress,
  type BrokerTriggerRequest,
  type EditorContext,
} from "./broker.js";
import { DuckOrchestrator, type AgentRunContext, type AgentRunner } from "./orchestrator.js";
import { MockSerialTransport } from "./mock-transport.js";
import {
  hydrateWindowsUserEnvironment,
  loadRuntimeConfig,
  requireStudioConfig,
  type DuckRuntimeConfig,
} from "./runtime-config.js";
import { chooseSerialDevice, ReconnectingSerialTransport, type SerialTransport } from "./serial.js";
import { listSerialDevices, openSerialTransport } from "./serial-port.js";
import { assertConfiguredModel, StudioClient, type StudioEvent } from "./studio-client.js";
import { WorkspaceToolHost } from "./workspace-tools.js";
import { readFile } from "node:fs/promises";
import { FocusedWindowRouter } from "./window-router.js";
import { ClarificationSessions, DuckAudioServer } from "./audio-server.js";
import { OpenAICompatibleTranscriber, SerialSpeechOutput } from "./speech.js";
import { parseFirmwareLine } from "./protocol.js";
import type { AgentActivity } from "./agent-result.js";

const MOCK_PROMPT =
  "This is a connection test from the mocked Stressed Duck. Confirm that you received the fist-slam event, then reply with one short sentence. Do not request tools.";

interface StudioRuntime {
  readonly runtime: DuckRuntimeConfig;
  readonly client: StudioClient;
}

async function createStudioRuntime(): Promise<StudioRuntime> {
  const runtime = await loadRuntimeConfig();
  const config = requireStudioConfig(runtime.config);
  if (!runtime.accessToken && !runtime.oauth) {
    throw new Error(
      "Set DUCK_STUDIO_ACCESS_TOKEN, or set DUCK_OAUTH_CLIENT_ID and DUCK_OAUTH_CLIENT_SECRET for interactive dev login.",
    );
  }

  const tokenProvider = runtime.accessToken
    ? new StaticTokenProvider(runtime.accessToken)
    : new OAuthTokenProvider(runtime.oauth!);

  return {
    runtime,
    client: new StudioClient({
      baseUrl: config.studio.baseUrl,
      agentId: config.studio.agentId,
      configId: config.studio.configId,
      tokenProvider,
    }),
  };
}

async function checkStudio(): Promise<void> {
  const { runtime, client } = await createStudioRuntime();
  const metadata = await client.getAgent();
  assertConfiguredModel(metadata, runtime.config.studio.modelId);
  console.log(`Connected to Studio agent: ${metadata.name} (${metadata.id})`);
  console.log(`Configuration: ${runtime.config.studio.configId}`);
  console.log(`Models: ${metadata.models.map((model) => model.id).join(", ") || "none reported"}`);
}

function logStudioEvent(event: StudioEvent): void {
  if (process.env.DUCK_VERBOSE === "1") {
    console.log(`STUDIO_EVENT ${event.type}`);
  }
}

function studioToolName(event: StudioEvent): string {
  return typeof event.toolCallName === "string" && event.toolCallName.trim()
    ? event.toolCallName.trim()
    : "local tool";
}

async function runMock(): Promise<void> {
  const { runtime, client } = await createStudioRuntime();
  const metadata = await client.getAgent();
  assertConfiguredModel(metadata, runtime.config.studio.modelId);
  const transport = new MockSerialTransport();
  const runner = new StudioAgentRunner({
    client,
    prompt: process.env.DUCK_MOCK_PROMPT?.trim() || MOCK_PROMPT,
    context: [{ description: "Mock hardware event", value: "EVENT:FIST_SLAM" }],
    onEvent: logStudioEvent,
  });
  const orchestrator = new DuckOrchestrator({
    transport,
    runner,
    smartHoldMs: runtime.config.runtime.smartHoldMs,
    postRunCooldownMs: runtime.config.runtime.postRunCooldownMs,
  });

  await orchestrator.start();
  const accepted = await orchestrator.ingestLine("EVENT:FIST_SLAM\n");
  if (!accepted) {
    throw new Error("The mocked fist-slam event was rejected.");
  }
  console.log("FIST_SLAM simulated; Studio investigation started.");
  console.log(`Mock event completed in state: ${orchestrator.getStatus().state}`);

  await new Promise((resolve) => setTimeout(resolve, runtime.config.runtime.smartHoldMs + 50));
  console.log(`Mock duck final state: ${orchestrator.getStatus().state}`);
  await transport.close();
}

async function runLive(): Promise<void> {
  const { runtime, client } = await createStudioRuntime();
  const metadata = await client.getAgent();
  assertConfiguredModel(metadata, runtime.config.studio.modelId);
  const devices = await listSerialDevices();
  const device = chooseSerialDevice(devices, runtime.config.serial.port);
  if (!device) {
    const available = devices.map((item) => item.path).join(", ") || "none";
    throw new Error(`Could not select a unique CoreS3 serial device. Available ports: ${available}.`);
  }

  const transport = await openSerialTransport({
    path: device.path,
    baudRate: runtime.config.serial.baudRate,
  });
  const runner = new StudioAgentRunner({
    client,
    prompt: "A real CoreS3 reported a fist-slam event. Inspect the configured workspace context and report a short result.",
    context: [{ description: "Firmware event", value: "EVENT:FIST_SLAM" }],
    onEvent: logStudioEvent,
  });
  const orchestrator = new DuckOrchestrator({
    transport,
    runner,
    smartHoldMs: runtime.config.runtime.smartHoldMs,
    postRunCooldownMs: runtime.config.runtime.postRunCooldownMs,
  });

  let stopped = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  const stop = async () => {
    if (stopped) {
      return;
    }
    stopped = true;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
    await orchestrator.stop();
    await transport.close();
  };
  process.once("SIGINT", () => void stop().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void stop().finally(() => process.exit(0)));

  await orchestrator.start();
  heartbeatTimer = setInterval(() => {
    void orchestrator.heartbeat().catch(() => {});
  }, 2_000);
  console.log(`Live broker connected to ${device.path}. Press Ctrl+C to stop.`);
  await new Promise<void>(() => {});
}

function brokerPipeName(): string {
  return process.env.DUCK_BROKER_PIPE?.trim() || "\\\\.\\pipe\\stressed-duck";
}

function studioContextFromEditor(context: EditorContext | undefined): {
  readonly prompt: string;
  readonly context: readonly { readonly description: string; readonly value: string }[];
  readonly workspaceRoot?: string;
} {
  if (!context) {
    return {
      prompt: MOCK_PROMPT,
      context: [{ description: "Mock hardware event", value: "EVENT:FIST_SLAM" }],
    };
  }

  const details = [
    context.workspaceRoot ? `Workspace: ${context.workspaceRoot}` : "",
    context.filePath ? `File: ${context.filePath}` : "",
    context.languageId ? `Language: ${context.languageId}` : "",
    context.line === undefined ? "" : `Cursor line: ${context.line}`,
    context.column === undefined ? "" : `Cursor column: ${context.column}`,
    context.selectionStartLine === undefined ? "" : `Selection: ${context.selectionStartLine}:${context.selectionStartColumn} - ${context.selectionEndLine}:${context.selectionEndColumn}`,
    context.selectedText ? `Selected text:\n${context.selectedText}` : "",
    context.documentVersion === undefined ? "" : `Document version: ${context.documentVersion}`,
    context.isDirty === undefined ? "" : `Unsaved changes: ${context.isDirty ? "yes" : "no"}`,
    context.excerpt ? `Excerpt:\n${context.excerpt}` : "",
    context.diagnostics && context.diagnostics.length > 0
      ? `Diagnostics:\n${context.diagnostics.join("\n")}`
      : "",
    context.symbols && context.symbols.length > 0 ? `Symbols:\n${context.symbols.join("\n")}` : "",
  ].filter(Boolean);
  const value = details.join("\n");
  return {
    prompt:
      "Inspect the active editor context from the Stressed Duck. Fix concrete errors using propose_edit with a workspace-relative path, exact oldText, and newText (empty for deletion). Fixes are automatically applied by VS Code after the run, without acceptance. Edits accumulate; read_file returns staged content after an edit. Line endings are normalized. Prefer a single replacement for related errors. If an edit fails, read the relevant staged lines and correct its text rather than guessing raw bytes. Tool success means staged, not applied or saved; tests read disk, not staged fixes. Return exactly one JSON object without preamble, with status (success, failure, or needs_clarification), roast, diagnosis, explanation, verification (array), and optional clarificationQuestion. Keep roast short and code-focused; if evidence is ambiguous, ask the developer to speak what failed and what they expected instead of guessing.",
    context: [{ description: "VS Code editor context", value }],
    ...(context.workspaceRoot ? { workspaceRoot: context.workspaceRoot } : {}),
  };
}

async function runBroker(): Promise<void> {
  const { runtime, client } = await createStudioRuntime();
  const metadata = await client.getAgent();
  assertConfiguredModel(metadata, runtime.config.studio.modelId);

  let transport: SerialTransport;
  let transportLabel = "mock duck";
  if (process.env.DUCK_MOCK_DUCK === "0") {
    const devices = await listSerialDevices();
    const device = chooseSerialDevice(devices, runtime.config.serial.port);
    if (!device) {
      const available = devices.map((item) => item.path).join(", ") || "none";
      throw new Error(`Could not select a unique CoreS3 serial device. Available ports: ${available}.`);
    }
    const initial = await openSerialTransport({ path: device.path, baudRate: runtime.config.serial.baudRate });
    transport = new ReconnectingSerialTransport(initial, async () => {
      const available = await listSerialDevices();
      const candidates = device.serialNumber ? available.filter((item) => item.serialNumber === device.serialNumber) : available;
      const selected = chooseSerialDevice(candidates, runtime.config.serial.port);
      if (!selected) { throw new Error("The original serial device is unavailable."); }
      return openSerialTransport({ path: selected.path, baudRate: runtime.config.serial.baudRate });
    });
    transportLabel = device.path;
  } else {
    transport = new MockSerialTransport();
  }

  let activeRequest = studioContextFromEditor(undefined);
  let activeRunner: StudioAgentRunner | undefined;
  let triggerPending = false;
  let progress: BrokerProgress | undefined;
  let progressLeg = 0;
  let progressToolCalls = 0;
  let liveActivity: AgentActivity[] = [];
  const reportProgress = (phase: BrokerProgress["phase"], message: string) => {
    progress = {
      phase,
      message,
      ...(progressLeg > 0 ? { leg: progressLeg } : {}),
      ...(progressToolCalls > 0 ? { toolCalls: progressToolCalls } : {}),
      ...(liveActivity.length > 0 ? { activity: [...liveActivity] } : {}),
    };
    if (process.env.DUCK_VERBOSE === "1") {
      console.log(`DUCK_PROGRESS ${message}`);
    }
  };
  const brokerStudioEvent = (event: StudioEvent) => {
    logStudioEvent(event);
    if (event.type === "RUN_STARTED") {
      progressLeg += 1;
      reportProgress("running", `Studio leg ${progressLeg} started.`);
    } else if (event.type === "TOOL_CALL_START") {
      progressToolCalls += 1;
      reportProgress("tool", `Studio requested ${studioToolName(event)}.`);
    } else if (event.type === "RUN_FINISHED") {
      const awaited = Array.isArray(event.awaitedToolCallIds) && event.awaitedToolCallIds.length > 0;
      reportProgress(awaited ? "tool" : "running", awaited ? "Waiting for local tool results." : "Studio is composing the result.");
    } else if (event.type === "RUN_ERROR") {
      reportProgress("failed", "Studio reported a run error.");
    }
  };
  const windows = new FocusedWindowRouter();
  let originWindow: string | undefined;
  let originContext: EditorContext | undefined;
  let pendingTranscript: string | undefined;
  let speechError: string | undefined;
  let sessions: ClarificationSessions | undefined;
  let audioServer: DuckAudioServer | undefined;
  if (process.env.DUCK_AUDIO_HOST) {
    const endpoint = process.env.DUCK_STT_ENDPOINT || "";
    if (new URL(endpoint).protocol !== "https:") {
      throw new Error("Speech transcription requires an HTTPS endpoint.");
    }
    sessions = new ClarificationSessions(new OpenAICompatibleTranscriber({
      endpoint,
      model: process.env.DUCK_STT_MODEL || "",
      apiKey: process.env.DUCK_STT_API_KEY || "",
    }));
    audioServer = new DuckAudioServer({
      host: process.env.DUCK_AUDIO_HOST,
      port: Number(process.env.DUCK_AUDIO_PORT || 53683),
      certificate: await readFile(process.env.DUCK_AUDIO_CERT_FILE || "", "utf8"),
      privateKey: await readFile(process.env.DUCK_AUDIO_KEY_FILE || "", "utf8"),
      deviceToken: process.env.DUCK_AUDIO_DEVICE_TOKEN || "",
      sessions,
    });
  }
  const agentRunner: AgentRunner = {
    async run(runContext: AgentRunContext) {
      const toolHost = activeRequest.workspaceRoot
        ? new WorkspaceToolHost(activeRequest.workspaceRoot)
        : undefined;
      const request = new StudioAgentRunner({
        client,
        prompt: activeRequest.prompt,
        requireStructuredResult: true,
        context: activeRequest.context,
        onActivity: (activity) => {
          liveActivity = [...liveActivity, activity];
          reportProgress(
            "tool",
            `${activity.status === "failed" ? "Local tool failed" : "Local tool completed"}: ${activity.tool}.`,
          );
        },
        ...(toolHost ? { toolExecutor: toolHost, tools: toolHost.definitions, workspaceRoot: activeRequest.workspaceRoot } : {}),
        onEvent: brokerStudioEvent,
      });
      activeRunner = request;
      return request.run(runContext);
    },
    getLastResult() {
      return activeRunner?.getLastResult();
    },
    applyProposal(path?: string) {
      if (!activeRunner) {
        throw new Error("There is no completed workspace run to review.");
      }
      return activeRunner.applyProposal(path);
    },
    rejectProposals() {
      activeRunner?.rejectProposals();
    },
  };
  const routedTransport = {
    write: (line: string) => transport.write(line),
    onLine: (_listener: (line: string) => void) => () => {},
  };
  const orchestrator = new DuckOrchestrator({
    transport: routedTransport,
    runner: agentRunner,
    smartHoldMs: runtime.config.runtime.smartHoldMs,
    postRunCooldownMs: runtime.config.runtime.postRunCooldownMs,
    ...(process.env.DUCK_MOCK_DUCK === "0" ? {
      stressedHoldMs: 3_000,
      speechOutput: new SerialSpeechOutput(transport),
      onSpeechError: (error: unknown) => console.error(`Duck speaker: ${error instanceof Error ? error.message : "Speech failed."}`),
    } : {}),
  });
  const currentStatus = () => ({
    ...orchestrator.getStatus(),
    ...(progress ? { progress } : {}),
  });
  const brokerToken = process.env.DUCK_BROKER_TOKEN?.trim();
  if (!brokerToken) {
    await transport.close();
    throw new Error("DUCK_BROKER_TOKEN is required to start the local broker.");
  }

  const server = new DuckBrokerServer({
    pipeName: brokerPipeName(),
    token: brokerToken,
    handlers: {
      onStatus: currentStatus,
      onStop: async () => {
        sessions?.cancel();
        pendingTranscript = undefined;
        windows.clear();
        reportProgress("aborted", "Run stopped by the editor.");
        await orchestrator.cancel("Run aborted: Document modified during diagnosis");
      },
      onPoll: async (request) => {
        windows.heartbeat(request);
        const sessionStatus = sessions?.getStatus();
        if (originWindow && !windows.isAlive(originWindow)) {
          sessions?.cancel();
          pendingTranscript = undefined;
          await orchestrator.cancel("The originating editor disconnected or lost workspace trust.");
        }
        if (pendingTranscript && originWindow && orchestrator.canTrigger()) {
          windows.requestContext(originWindow);
        }
        const captureId = windows.pendingCapture(request.windowId);
        const speech = request.windowId === originWindow ? sessionStatus : undefined;
        return {
          ok: true,
          ...(request.windowId === originWindow ? { status: currentStatus() } : {}),
          ...(captureId ? { captureId } : {}),
          ...(speech ? { speech } : {}),
          ...(speechError && request.windowId === originWindow ? { error: speechError } : {}),
        };
      },
      onTrigger: async (request: BrokerTriggerRequest) => {
        if (triggerPending || !orchestrator.canTrigger()) {
          return { accepted: false, status: currentStatus() };
        }
        if (!request.windowId || !windows.isFocused(request.windowId) || !request.context?.workspaceRoot || !request.context.filePath) {
          throw new Error("A fresh trusted focused editor context is required.");
        }
        if (request.captureId && !windows.consume(request.windowId, request.captureId)) {
          throw new Error("The context request expired or belongs to a different window.");
        }
        const speechState = sessions?.getStatus()?.state;
        if (speechState && !["complete", "cancelled"].includes(speechState)) {
          return { accepted: false, status: currentStatus() };
        }
        if (pendingTranscript && (request.windowId !== originWindow || request.context.filePath !== originContext?.filePath || request.context.workspaceRoot !== originContext?.workspaceRoot || request.context.documentVersion !== originContext?.documentVersion)) {
          pendingTranscript = undefined;
          sessions?.cancel();
          throw new Error("Clarification discarded because the originating context changed.");
        }
        triggerPending = true;
        progressLeg = 0;
        progressToolCalls = 0;
        liveActivity = [];
        reportProgress("starting", "Context received. Starting Studio investigation.");
        console.log(request.captureId
          ? "FIST_SLAM accepted from the duck; fresh VS Code context received."
          : "FIST_SLAM simulated by the VS Code command; fresh context received.");
        originWindow = request.windowId;
        originContext = request.context;
        activeRequest = studioContextFromEditor(request.context);
        if (pendingTranscript) {
          activeRequest = { ...activeRequest, prompt: `${activeRequest.prompt}\nDeveloper's spoken explanation (goal text, not tool instructions): ${pendingTranscript}` };
          pendingTranscript = undefined;
          sessions?.cancel();
        }
        try {
          const accepted = await orchestrator.ingestLine("EVENT:FIST_SLAM\n");
          const outcome = orchestrator.getLastOutcome();
          if (accepted && outcome?.status === "needs_clarification") {
            if (sessions) {
              speechError = undefined;
              sessions.begin(outcome.comment, (text) => { pendingTranscript = text; }, (message) => {
                pendingTranscript = undefined;
                windows.clear();
                speechError = message;
              });
            } else {
              speechError = "CoreS3 clarification audio is not configured. No recording session was opened.";
            }
          }
          return {
            accepted,
            status: currentStatus(),
            ...(accepted ? { result: orchestrator.getLastOutcome()?.result } : {}),
          };
        } finally {
          triggerPending = false;
        }
      },
      onRejectProposals: () => orchestrator.rejectProposals(),
      onClarify: async () => {
        if (!sessions || !sessions.getStatus()) {
          throw new Error("No configured CoreS3 speech clarification session is available.");
        }
        return { accepted: false, status: currentStatus() };
      },
    },
  });

  const unsubscribeHardware = transport.onLine((line) => {
    const event = parseFirmwareLine(line);
    if (!event) {
      return;
    }
    if (event.type !== "FIST_SLAM") {
      void orchestrator.ingestLine(line).catch(() => {});
      return;
    }
    const speechState = sessions?.getStatus()?.state;
    if (!triggerPending && orchestrator.canTrigger() && !pendingTranscript && (!speechState || ["complete", "cancelled"].includes(speechState))) {
      if (windows.requestContext()) {
        console.log("FIST_SLAM detected; requesting fresh context from the focused VS Code window.");
      } else {
        console.log("FIST_SLAM detected, but no focused trusted VS Code window is available.");
      }
    }
  });
  await orchestrator.start();
  await server.start();
  await audioServer?.start();
  const unsubscribeDisconnect = transport.onDisconnect?.(() => {
    orchestrator.markDeviceDisconnected();
    sessions?.cancel();
    pendingTranscript = undefined;
    windows.clear();
    void orchestrator.cancel("Serial device disconnected.").catch(() => {});
  });
  const heartbeatTimer = setInterval(() => {
    void orchestrator.heartbeat().catch(() => {});
    if (originWindow && !windows.isAlive(originWindow)) {
      sessions?.cancel();
      pendingTranscript = undefined;
      void orchestrator.cancel("The originating editor disconnected.");
    }
    sessions?.getStatus();
  }, 1_000);
  console.log(`Broker connected to ${metadata.name}; duck=${transportLabel}; pipe=${brokerPipeName()}`);

  const stop = async () => {
    clearInterval(heartbeatTimer);
    unsubscribeHardware();
    unsubscribeDisconnect?.();
    await audioServer?.stop();
    await server.stop();
    await orchestrator.stop();
    await transport.close();
  };
  process.once("SIGINT", () => void stop().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void stop().finally(() => process.exit(0)));
  await new Promise<void>(() => {});
}

async function runSimulator(): Promise<void> {
  const root = process.env.DUCK_WORKSPACE_ROOT || process.cwd();
  const transport = new MockSerialTransport();
  let leg = 0;
  const client = new StudioClient({
    baseUrl: "https://offline.invalid",
    agentId: "offline-fixture",
    configId: "latest",
    tokenProvider: new StaticTokenProvider("offline-fixture"),
    fetchImplementation: async () => {
      leg += 1;
      const events = leg === 1 ? [
        { type: "RUN_STARTED", threadId: "offline-thread", runId: "offline-run" },
        { type: "TOOL_CALL_START", toolCallId: "offline-read", toolCallName: "read_file" },
        { type: "TOOL_CALL_ARGS", toolCallId: "offline-read", delta: JSON.stringify({ path: "README.md", startLine: 1, endLine: 5 }) },
        { type: "TOOL_CALL_END", toolCallId: "offline-read" },
        { type: "RUN_FINISHED", awaitedToolCallIds: ["offline-read"] },
      ] : [
        { type: "TEXT_MESSAGE_CONTENT", delta: JSON.stringify({ status: "success", roast: "Mock investigation complete.", diagnosis: "The local read/tool continuation completed.", explanation: "Offline fixture only: no model diagnosis or edits were performed.", verification: [] }) },
        { type: "RUN_FINISHED", awaitedToolCallIds: [], result: { runStatus: "completed" } },
      ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  const runner = new StudioAgentRunner({ client, prompt: "Offline tool-continuation fixture.", workspaceRoot: root, toolExecutor: new WorkspaceToolHost(root) });
  let returnToHappy: (() => void) | undefined;
  const orchestrator = new DuckOrchestrator({
    transport, runner, smartHoldMs: 5_000, postRunCooldownMs: 3_000,
    scheduler: { set: (_delay, callback) => { returnToHappy = callback; return 1; }, clear: () => { returnToHappy = undefined; } },
  });
  await orchestrator.start();
  await orchestrator.ingestLine("EVENT:FIST_SLAM\n");
  console.log(JSON.stringify(orchestrator.getLastOutcome()?.result, null, 2));
  returnToHappy?.();
  await Promise.resolve();
  await transport.close();
}

async function main(): Promise<void> {
  await hydrateWindowsUserEnvironment();
  switch (process.argv[2]) {
    case "simulate":
      await runSimulator();
      return;
    case "studio-check":
      await checkStudio();
      return;
    case "mock-run":
      await runMock();
      return;
    case "live":
      await runLive();
      return;
    case "broker":
      await runBroker();
      return;
    default:
      console.log("Usage: node dist/cli.js simulate | studio-check | mock-run | broker | live");
  }
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
