import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";

const execFileAsync = promisify(execFile);

interface EditorContext {
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

interface AgentEditProposal {
  readonly path: string;
  readonly oldText: string;
  readonly newText: string;
  readonly diff: string;
  readonly baseText?: string;
}

interface AgentActivity {
  readonly tool: string;
  readonly status: "completed" | "failed";
  readonly detail?: string;
}

interface AgentResult {
  readonly status: string;
  readonly responseText: string;
  readonly roast?: string;
  readonly diagnosis?: string;
  readonly explanation?: string;
  readonly verification: readonly string[];
  readonly activity?: readonly AgentActivity[];
  readonly proposedEdits: readonly AgentEditProposal[];
  readonly clarificationQuestion?: string;
  readonly legs: number;
  readonly toolCalls: number;
  readonly workspaceRoot?: string;
  readonly generation?: number;
}

interface BrokerResponse {
  readonly ok: boolean;
  readonly protocolVersion?: number;
  readonly accepted?: boolean;
  readonly status?: { readonly state: string; readonly cooldownUntilMs: number; readonly lastResult?: AgentResult };
  readonly result?: AgentResult;
  readonly proposal?: AgentEditProposal;
  readonly error?: string;
  readonly captureId?: string;
  readonly speech?: { readonly id: string; readonly state: string };
}

interface BrokerRequestOptions {
  readonly context?: EditorContext;
  readonly path?: string;
  readonly answer?: string;
  readonly microphone?: boolean;
  readonly windowId?: string;
  readonly captureId?: string;
  readonly focused?: boolean;
  readonly trusted?: boolean;
}

interface PendingRun {
  readonly filePath: string;
  readonly workspaceRoot: string;
  readonly documentVersion: number;
  stopped: boolean;
}

const DEFAULT_PIPE = "\\\\.\\pipe\\stressed-duck";
const MAX_SYMBOLS = 100;
const MAX_SYMBOL_TEXT = 8_000;
const BROKER_TOKEN_CACHE_MS = 5_000;

let cachedWindowsBrokerToken: string | undefined;
let cachedWindowsBrokerTokenAt = 0;

function registryValue(output: string, name: string): string | undefined {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = output.match(new RegExp(`^\\s*${escapedName}\\s+REG_\\S+\\s+(.*)$`, "m"));
  return match?.[1]?.trim() || undefined;
}

async function brokerToken(): Promise<string> {
  const processToken = process.env.DUCK_BROKER_TOKEN?.trim();
  if (processToken) {
    return processToken;
  }

  if (process.platform === "win32" && Date.now() - cachedWindowsBrokerTokenAt >= BROKER_TOKEN_CACHE_MS) {
    cachedWindowsBrokerTokenAt = Date.now();
    try {
      const { stdout } = await execFileAsync(
        "reg.exe",
        ["query", "HKCU\\Environment", "/v", "DUCK_BROKER_TOKEN"],
        { windowsHide: true, maxBuffer: 16 * 1024 },
      );
      cachedWindowsBrokerToken = registryValue(stdout, "DUCK_BROKER_TOKEN");
    } catch {
      cachedWindowsBrokerToken = undefined;
    }
  }

  if (!cachedWindowsBrokerToken) {
    throw new Error("DUCK_BROKER_TOKEN is not available to the VS Code extension.");
  }
  return cachedWindowsBrokerToken;
}

function pipeName(): string {
  return (
    vscode.workspace.getConfiguration("stressedDuck").get<string>("brokerPipe") ??
    process.env.DUCK_BROKER_PIPE ??
    DEFAULT_PIPE
  );
}

function bounded(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n...[truncated]`;
}

function symbolKind(kind: vscode.SymbolKind): string {
  return vscode.SymbolKind[kind] ?? "symbol";
}

function formatSymbols(
  symbols: readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[],
  depth = 0,
  output: string[] = [],
): string[] {
  for (const symbol of symbols) {
    if (output.length >= MAX_SYMBOLS) {
      break;
    }
    const range = "range" in symbol ? symbol.range : symbol.location.range;
    output.push(`${"  ".repeat(depth)}${symbolKind(symbol.kind)} ${symbol.name} (${range.start.line + 1}:${range.start.character + 1}-${range.end.line + 1}:${range.end.character + 1})`);
    if ("children" in symbol && symbol.children.length > 0) {
      formatSymbols(symbol.children, depth + 1, output);
    }
  }
  return output;
}

async function documentSymbols(uri: vscode.Uri): Promise<readonly string[]> {
  try {
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_500));
    const result = await Promise.race([
      vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>(
        "vscode.executeDocumentSymbolProvider",
        uri,
      ),
      timeout,
    ]);
    if (!result) {
      return ["Symbol outline unavailable: provider timed out."];
    }
    if (result.length === 0) {
      return ["Symbol outline: no symbols reported."];
    }
    const lines = formatSymbols(result);
    const outline = bounded(lines.join("\n"), MAX_SYMBOL_TEXT);
    return [outline, ...(lines.length >= MAX_SYMBOLS ? ["Symbol outline truncated."] : [])];
  } catch (error) {
    return [`Symbol outline unavailable: ${error instanceof Error ? error.message : String(error)}`];
  }
}

async function captureEditorContext(): Promise<EditorContext> {
  if (!vscode.window.state.focused) {
    throw new Error("The editor window is not focused.");
  }
  if (!vscode.workspace.isTrusted) {
    throw new Error("Stressed Duck requires a trusted VS Code workspace.");
  }
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    throw new Error("Stressed Duck needs an active editor.");
  }
  const document = editor.document;
  if (document.uri.scheme !== "file") {
    throw new Error("Stressed Duck currently supports local file editors only.");
  }
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!workspaceFolder) {
    throw new Error("The active editor is outside a trusted workspace folder.");
  }
  if (document.uri.fsPath.split(/[\\/]/).some((part) => /^\.env(?:\.|$)/i.test(part) || /(?:credentials|secrets?|tokens?)(?:\.|$)/i.test(part) || /\.(?:pem|key|pfx|p12)$/i.test(part))) {
    throw new Error("Secret and credential files are excluded from editor context.");
  }

  const initialVersion = document.version;
  const initialPath = document.uri.fsPath;
  const cursor = editor.selection.active;
  const selection = editor.selection;
  const startLine = Math.max(0, cursor.line - 35);
  const endLine = Math.min(document.lineCount - 1, cursor.line + 35);
  const excerpt = document.lineCount === 0
    ? ""
    : document
      .getText(new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).text.length))
      .slice(0, 8_000);
  const selectedText = document.getText(selection);
  const diagnostics = vscode.languages
    .getDiagnostics(document.uri)
    .slice(0, 50)
    .map((diagnostic) => {
      const severity = ["Error", "Warning", "Information", "Hint"][diagnostic.severity] ?? "Diagnostic";
      return `${severity} ${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1} ${diagnostic.message}`;
    });
  const symbols = await documentSymbols(document.uri);
  const activeEditor = vscode.window.activeTextEditor;
  if (
    !vscode.window.state.focused || document.version !== initialVersion ||
    document.uri.fsPath !== initialPath ||
    activeEditor?.document.uri.fsPath !== initialPath
  ) {
    throw new Error("The active editor changed while context was being captured.");
  }

  return {
    workspaceRoot: workspaceFolder.uri.fsPath,
    filePath: document.uri.fsPath,
    languageId: document.languageId,
    line: cursor.line + 1,
    column: cursor.character + 1,
    selectionStartLine: selection.start.line + 1,
    selectionStartColumn: selection.start.character + 1,
    selectionEndLine: selection.end.line + 1,
    selectionEndColumn: selection.end.character + 1,
    ...(selectedText ? { selectedText: bounded(selectedText, 4_000) } : {}),
    documentVersion: document.version,
    isDirty: document.isDirty,
    excerpt,
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
    symbols,
  };
}

async function requestBroker(
  type: "trigger" | "status" | "stop" | "apply" | "reject" | "clarify" | "poll",
  options: BrokerRequestOptions = {},
): Promise<BrokerResponse> {
  const token = await brokerToken();

  return await new Promise<BrokerResponse>((resolve, reject) => {
    const socket = createConnection(pipeName());
    let buffer = "";
    let settled = false;
    const finish = (error?: Error, response?: BrokerResponse) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      if (error) {
        reject(error);
      } else {
        resolve(response!);
      }
    };

    socket.setTimeout(type === "trigger" ? 180_000 : 15_000, () => finish(new Error("Timed out waiting for the Stressed Duck broker.")));
    socket.setEncoding("utf8");
    socket.once("error", (error) => finish(error));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as BrokerResponse;
        if (response.protocolVersion !== 1) {
          finish(new Error("Incompatible Stressed Duck host/extension protocol versions."));
        } else {
          finish(undefined, response);
        }
      } catch {
        finish(new Error("The Stressed Duck broker returned an invalid response."));
      }
    });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ type, token, protocolVersion: 1, ...options })}\n`);
    });
  });
}

function textBlock(value: string): string {
  return escapeHtml(value).replace(/\r?\n/g, "<br>");
}

function textSection(title: string, value: string | undefined): string {
  return value ? `<section><h2>${escapeHtml(title)}</h2><div class="copy">${textBlock(value)}</div></section>` : "";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

function activityLabel(tool: string): string {
  return tool.replace(/_/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function resultHtml(result: AgentResult): string {
  const nonce = randomUUID();
  const proposals = result.proposedEdits.map((proposal) => `
    <article class="proposal">
      <header><strong>${escapeHtml(proposal.path)}</strong><button data-action="apply" data-path="${escapeHtml(proposal.path)}">Apply fix</button><button data-action="reject" data-path="${escapeHtml(proposal.path)}">Reject</button></header>
      <pre>${escapeHtml(proposal.diff)}</pre>
    </article>`).join("");
  const activityItems = (result.activity ?? []).map((item) => `
    <li class="activity-item ${item.status === "completed" ? "complete" : "failed"}">
      <span class="activity-mark" aria-hidden="true">${item.status === "completed" ? "✓" : "!"}</span>
      <span><strong>${escapeHtml(activityLabel(item.tool))}</strong>${item.detail ? `<small>${escapeHtml(item.detail)}</small>` : ""}</span>
      <span class="activity-status">${item.status === "completed" ? "Completed" : "Failed"}</span>
    </li>`).join("");
  const activity = activityItems
    ? `<section><h2>Investigation</h2><ol class="activity">${activityItems}</ol></section>`
    : "";
  const verification = result.verification.length > 0
    ? `<section><h2>Verification</h2><ul class="checks">${result.verification.map((item) => `<li>${textBlock(item)}</li>`).join("")}</ul></section>`
    : "";
  const clarification = result.clarificationQuestion
    ? `<p class="clarification">${escapeHtml(result.clarificationQuestion)}<button data-action="microphone">Listen for clarification</button></p>`
    : "";
  return `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'"><style nonce="${nonce}">
    body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:20px;line-height:1.5;max-width:960px}
    h1{font-size:1.35em;margin:0 0 18px}h2{font-size:1em;margin:22px 0 8px;color:var(--vscode-textLink-foreground)}
    section{margin:0 0 16px}.copy{background:var(--vscode-textCodeBlock-background);border-left:3px solid var(--vscode-textLink-foreground);padding:12px 14px;overflow-wrap:anywhere}
    pre{white-space:pre-wrap;background:var(--vscode-textCodeBlock-background);padding:12px;overflow:auto;margin:0;font-family:var(--vscode-editor-font-family)}
    button{margin-left:8px;padding:5px 11px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;cursor:pointer}
    button:hover{background:var(--vscode-button-hoverBackground)}.proposal{border-top:1px solid var(--vscode-panel-border);margin-top:16px}.proposal header{padding:10px 0;display:flex;align-items:center;gap:6px}.proposal header strong{margin-right:auto;overflow-wrap:anywhere}.clarification{border-left:3px solid var(--vscode-charts-yellow);padding:10px}.activity{list-style:none;padding:0;margin:0;border-left:1px solid var(--vscode-panel-border)}.activity-item{display:flex;align-items:center;gap:10px;padding:8px 10px;border-bottom:1px solid var(--vscode-panel-border)}.activity-mark{width:18px;height:18px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:var(--vscode-testing-iconPassed);color:var(--vscode-editor-background);font-size:12px}.activity-item.failed .activity-mark{background:var(--vscode-testing-iconFailed)}.activity-item small{display:block;color:var(--vscode-descriptionForeground);overflow-wrap:anywhere}.activity-status{margin-left:auto;color:var(--vscode-descriptionForeground);font-size:.9em}.checks{margin:0;padding-left:22px}.checks li{margin:6px 0;overflow-wrap:anywhere}
  </style></head><body>
    <h1>Stressed Duck: ${escapeHtml(result.status)}</h1>
    ${textSection("Duck", result.roast)}
    ${activity}
    ${textSection("Diagnosis", result.diagnosis)}
    ${textSection("Explanation", result.explanation ?? result.responseText)}
    ${verification}${clarification}
    ${proposals ? `<h2>Proposed edits</h2>${proposals}` : "<p>No edit proposal was produced.</p>"}
    <script nonce="${nonce}">const vscode=acquireVsCodeApi();document.querySelectorAll('button').forEach(button=>button.addEventListener('click',()=>vscode.postMessage({action:button.dataset.action,path:button.dataset.path})));window.addEventListener('message',event=>{if(event.data?.message){const p=document.createElement('p');p.textContent=event.data.message;document.body.prepend(p)}});</script>
  </body></html>`;
}

function showResultPanel(extensionContext: vscode.ExtensionContext, result: AgentResult): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel("stressedDuckResult", "Stressed Duck Result", vscode.ViewColumn.Beside, { enableScripts: true });
  panel.webview.html = resultHtml(result);
  const resolved = new Set<string>();
  let applying = false;
  panel.webview.onDidReceiveMessage(async (message: { action?: string; path?: string }) => {
    try {
      if (message.action === "apply") {
        if (applying || !message.path || resolved.has(message.path)) {
          throw new Error("This proposal is already resolved or being applied.");
        }
        applying = true;
        if (!vscode.workspace.isTrusted || !result.workspaceRoot) {
          throw new Error("Proposal review requires its original trusted workspace.");
        }
        const proposal = result.proposedEdits.find((item) => item.path === message.path);
        if (proposal?.baseText === undefined || !proposal.oldText) {
          throw new Error("The proposal has no verified file snapshot.");
        }
        const root = await realpath(result.workspaceRoot);
        const absolute = await realpath(path.resolve(root, proposal.path));
        const relative = path.relative(root, absolute);
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          throw new Error("The proposal targets a file outside its original workspace.");
        }
        const uri = vscode.Uri.file(absolute);
        if (vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath.toLowerCase() !== result.workspaceRoot.toLowerCase()) {
          throw new Error("The proposal's workspace is no longer open.");
        }
        const document = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(document, { preserveFocus: true, preview: false });
        const text = document.getText();
        if (text !== proposal.baseText || text.split(proposal.oldText).length !== 2) {
          throw new Error("The file changed since diagnosis. No edit was applied.");
        }
        const offset = text.indexOf(proposal.oldText);
        const range = new vscode.Range(document.positionAt(offset), document.positionAt(offset + proposal.oldText.length));
        if (!await editor.edit((edit) => edit.replace(range, proposal.newText))) {
          throw new Error("The document changed or closed before the edit could apply.");
        }
        resolved.add(proposal.path);
        panel.webview.postMessage({ message: `Applied ${proposal.path} in the editor. Not saved automatically.` });
      } else if (message.action === "reject") {
        if (message.path) {
          resolved.add(message.path);
        }
        panel.webview.postMessage({ message: `Rejected ${message.path ?? "proposal"}.` });
      } else if (message.action === "microphone") {
        const response = await requestBroker("clarify", { microphone: true });
        if (!response.ok) {
          throw new Error(response.error ?? "Clarification listening was unavailable.");
        }
        if (response.result) {
          panel.webview.html = resultHtml(response.result);
        }
      }
    } catch (error) {
      panel.webview.postMessage({ message: error instanceof Error ? error.message : String(error) });
    } finally {
      applying = false;
    }
  }, undefined, extensionContext.subscriptions);
  return panel;
}

async function showBrokerResult(
  output: vscode.OutputChannel,
  extensionContext: vscode.ExtensionContext,
  response: BrokerResponse,
): Promise<void> {
  if (!response.ok) {
    throw new Error(response.error ?? "The Stressed Duck broker rejected the request.");
  }
  output.appendLine(
    `Broker response: ${response.accepted === undefined ? "ok" : response.accepted ? "accepted" : "busy"}${
      response.status ? `, state=${response.status.state}` : ""
    }`,
  );
  if (response.result) {
    output.appendLine(`Result: ${response.result.status}`);
    if (response.result.roast) {
      output.appendLine(`Duck: ${response.result.roast}`);
    }
    for (const item of response.result.activity ?? []) {
      output.appendLine(`  ${item.status === "completed" ? "[ok]" : "[failed]"} ${activityLabel(item.tool)}${item.detail ? `: ${item.detail}` : ""}`);
    }
    if (response.result.diagnosis) {
      output.appendLine(`Diagnosis: ${response.result.diagnosis}`);
    }
    if (response.result.explanation) {
      output.appendLine(`Explanation: ${response.result.explanation}`);
    }
    for (const item of response.result.verification) {
      output.appendLine(`Verification: ${item}`);
    }
    if (!response.result.roast && !response.result.diagnosis && !response.result.explanation && response.result.activity?.length === 0) {
      output.appendLine(response.result.responseText);
    }
    showResultPanel(extensionContext, response.result);
  } else if (response.status?.lastResult) {
    showResultPanel(extensionContext, response.status.lastResult);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Stressed Duck");
  context.subscriptions.push(output);
  let pendingRun: PendingRun | undefined;
  let stopInFlight = false;
  const windowId = randomUUID();
  let lastCapture: string | undefined;
  let pollInFlight = false;
  let lastShownGeneration: number | undefined;
  let lastSpeechState: string | undefined;
  let clarificationContext: EditorContext | undefined;
  let capturing = false;

  const stopForEditorChange = (filePath: string, version: number, reason: string) => {
    const relative = pendingRun ? path.relative(pendingRun.workspaceRoot, filePath) : "..";
    const inRoot = relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    if (!pendingRun || pendingRun.stopped || !inRoot || (pendingRun.filePath === filePath && version <= pendingRun.documentVersion) || stopInFlight) {
      return;
    }
    pendingRun.stopped = true;
    stopInFlight = true;
    output.appendLine(`Run aborted: ${reason}`);
    void requestBroker("stop")
      .catch((error) => output.appendLine(`Abort request failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        stopInFlight = false;
      });
  };

  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
    stopForEditorChange(event.document.uri.fsPath, event.document.version, "Document modified during diagnosis");
    if (clarificationContext?.filePath === event.document.uri.fsPath && event.document.version !== clarificationContext.documentVersion) {
      clarificationContext = undefined;
      output.appendLine("Speech clarification cancelled: Document modified during diagnosis");
      void requestBroker("stop").catch(() => {});
    }
  }));

  const runTrigger = async (captureId?: string) => {
    if (pendingRun || capturing) {
      return;
    }
    capturing = true;
    let submitted = false;
    try {
      await requestBroker("poll", { windowId, focused: vscode.window.state.focused, trusted: vscode.workspace.isTrusted });
      const editorContext = await captureEditorContext();
      pendingRun = {
        filePath: editorContext.filePath!,
        workspaceRoot: editorContext.workspaceRoot!,
        documentVersion: editorContext.documentVersion!,
        stopped: false,
      };
      submitted = true;
      const response = await requestBroker("trigger", { context: editorContext, windowId, ...(captureId ? { captureId } : {}) });
      lastShownGeneration = response.result?.generation;
      clarificationContext = response.result?.status === "needs_clarification" ? editorContext : undefined;
      await showBrokerResult(output, context, response);
    } catch (error) {
      if (submitted) {
        void requestBroker("stop").catch(() => {});
      }
      output.appendLine(`Trigger failed: ${error instanceof Error ? error.message : String(error)}`);
      void vscode.window.showErrorMessage(`Stressed Duck: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      pendingRun = undefined;
      capturing = false;
    }
    output.show(true);
  };
  const trigger = vscode.commands.registerCommand("stressedDuck.trigger", () => runTrigger());
  context.subscriptions.push(trigger);

  const poll = async () => {
    if (pollInFlight) {
      return;
    }
    pollInFlight = true;
    try {
      const response = await requestBroker("poll", { windowId, focused: vscode.window.state.focused, trusted: vscode.workspace.isTrusted });
      if (response.captureId && response.captureId !== lastCapture && !pendingRun) {
        lastCapture = response.captureId;
        void runTrigger(response.captureId);
      }
      const result = response.status?.lastResult;
      if (!pendingRun && result && result.generation !== lastShownGeneration) {
        lastShownGeneration = result.generation;
        showResultPanel(context, result);
      }
      if (response.speech?.state !== lastSpeechState) {
        lastSpeechState = response.speech?.state;
        if (lastSpeechState) {
          output.appendLine(`Speech clarification: ${lastSpeechState}`);
        }
      }
      if (response.error) {
        output.appendLine(response.error);
      }
    } catch {
      if (pendingRun) {
        pendingRun.stopped = true;
      }
    } finally {
      pollInFlight = false;
    }
  };
  const heartbeat = setInterval(() => void poll(), 1_000);
  context.subscriptions.push({ dispose: () => clearInterval(heartbeat) });
  context.subscriptions.push(vscode.window.onDidChangeWindowState(() => void poll()));
  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument((document) => {
    if (pendingRun?.filePath === document.uri.fsPath) {
      void requestBroker("stop").catch(() => {});
    }
    if (clarificationContext?.filePath === document.uri.fsPath) {
      clarificationContext = undefined;
      void requestBroker("stop").catch(() => {});
    }
  }));
  void poll();

  const status = vscode.commands.registerCommand("stressedDuck.status", async () => {
    try {
      await showBrokerResult(output, context, await requestBroker("status"));
    } catch (error) {
      output.appendLine(`Status failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    output.show(true);
  });
  context.subscriptions.push(status);

  const stop = vscode.commands.registerCommand("stressedDuck.stop", async () => {
    pendingRun = undefined;
    try {
      await showBrokerResult(output, context, await requestBroker("stop"));
    } catch (error) {
      output.appendLine(`Stop failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    output.show(true);
  });
  context.subscriptions.push(stop);

  const clarify = vscode.commands.registerCommand("stressedDuck.clarify", async () => {
    try {
      await showBrokerResult(output, context, await requestBroker("clarify", { microphone: true }));
    } catch (error) {
      output.appendLine(`Clarification failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    output.show(true);
  });
  context.subscriptions.push(clarify);
}

export function deactivate(): void {
}