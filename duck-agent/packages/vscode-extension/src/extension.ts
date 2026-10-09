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

interface BrokerProgress {
  readonly phase: string;
  readonly message: string;
  readonly leg?: number;
  readonly toolCalls?: number;
  readonly activity?: readonly AgentActivity[];
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
  readonly status?: { readonly state: string; readonly cooldownUntilMs: number; readonly deviceMood?: string; readonly progress?: BrokerProgress; readonly lastResult?: AgentResult };
  readonly result?: AgentResult;
  readonly proposal?: AgentEditProposal;
  readonly error?: string;
  readonly captureId?: string;
  readonly speech?: { readonly id: string; readonly state: string };
}

type PanelMode = "idle" | "capturing" | "running" | "success" | "failure" | "needs_clarification" | "aborted";
type PanelActivityStatus = "running" | "completed" | "failed";

interface PanelActivity {
  readonly tool: string;
  readonly status: PanelActivityStatus;
  readonly detail?: string;
}

interface ApplicationOutcome {
  readonly path: string;
  readonly status: "applying" | "applied" | "blocked" | "failed";
  readonly message: string;
}

interface ResultPanelState {
  readonly mode: PanelMode;
  readonly message: string;
  readonly contextFile?: string;
  readonly progress?: BrokerProgress;
  readonly result?: AgentResult;
  readonly activity: readonly PanelActivity[];
  readonly applications: readonly ApplicationOutcome[];
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
    (activeEditor && activeEditor.document.uri.fsPath !== initialPath)
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

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

function activityLabel(tool: string): string {
  return tool.replace(/_/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function resultMode(status: string): PanelMode {
  if (status === "success" || status === "failure" || status === "needs_clarification" || status === "aborted") {
    return status;
  }
  return "failure";
}

function resultMessage(result: AgentResult): string {
  return result.roast ?? result.responseText ?? "The investigation finished.";
}

function resultHtml(state: ResultPanelState): string {
  const nonce = randomUUID();
  const stateJson = JSON.stringify(state).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'"><style nonce="${nonce}">
    :root{color-scheme:light dark}
    *{box-sizing:border-box}
    body{margin:0;padding:28px 24px 48px;color:var(--vscode-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family);font-size:13px;line-height:1.5}
    #app{max-width:1040px;margin:0 auto}
    button{font:inherit;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:1px solid transparent;border-radius:3px;padding:6px 11px;cursor:pointer}
    button:hover{background:var(--vscode-button-hoverBackground)}button.secondary{color:var(--vscode-foreground);background:transparent;border-color:var(--vscode-panel-border)}button.secondary:hover{background:var(--vscode-list-hoverBackground)}
    .hero{border-bottom:1px solid var(--vscode-panel-border);padding-bottom:22px;margin-bottom:20px}
    .eyebrow{margin:0 0 8px;color:var(--vscode-descriptionForeground);font-size:11px;font-weight:700}
    .hero-row{display:flex;align-items:flex-start;gap:14px}.duck-mark{width:34px;height:34px;flex:0 0 34px;border:2px solid var(--vscode-textLink-foreground);border-radius:50%;display:grid;place-items:center;color:var(--vscode-textLink-foreground);font-weight:700;font-size:16px}
    h1{font-size:21px;line-height:1.25;margin:0;font-weight:600}h2{font-size:13px;line-height:1.3;margin:0 0 10px;font-weight:600;color:var(--vscode-foreground)}h3{font-size:12px;margin:0}
    .hero-copy{min-width:0;flex:1}.hero-copy .lead{margin:6px 0 0;color:var(--vscode-descriptionForeground);overflow-wrap:anywhere}
    .status-chip{display:inline-flex;align-items:center;gap:6px;margin-left:8px;padding:2px 7px;border:1px solid var(--vscode-panel-border);border-radius:999px;color:var(--vscode-descriptionForeground);font-size:11px;font-weight:500;vertical-align:middle}
    .status-chip.good{color:var(--vscode-testing-iconPassed)}.status-chip.bad{color:var(--vscode-testing-iconFailed)}.status-chip.active{color:var(--vscode-textLink-foreground)}
    .run-meta{display:flex;flex-wrap:wrap;gap:8px 16px;margin:14px 0 0;color:var(--vscode-descriptionForeground);font-size:11px}.run-meta span{white-space:nowrap}
    .progress-section{border:1px solid var(--vscode-textLink-foreground);background:var(--vscode-textCodeBlock-background);padding:14px 15px;margin:0 0 24px;border-radius:4px}
    .progress-row{display:flex;align-items:center;gap:10px}.progress-copy{min-width:0;flex:1}.progress-copy strong{display:block;font-weight:600;overflow-wrap:anywhere}.progress-copy small{display:block;color:var(--vscode-descriptionForeground);margin-top:2px}
    .spinner{width:15px;height:15px;flex:0 0 15px;border:2px solid var(--vscode-textLink-foreground);border-top-color:transparent;border-radius:50%;animation:spin 900ms linear infinite}.progress-track{height:3px;margin:14px 0 8px;background:var(--vscode-panel-border);overflow:hidden;border-radius:2px}.progress-track span{display:block;width:42%;height:100%;background:var(--vscode-textLink-foreground);animation:sweep 1500ms ease-in-out infinite}.progress-meta{display:flex;gap:15px;color:var(--vscode-descriptionForeground);font-size:11px}
    .section{margin:0 0 24px}.section-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;border-bottom:1px solid var(--vscode-panel-border);padding-bottom:8px;margin-bottom:10px}.section-heading small{color:var(--vscode-descriptionForeground);font-size:11px;font-weight:400}.quote{border-left:3px solid var(--vscode-textLink-foreground);background:var(--vscode-textCodeBlock-background);padding:13px 15px;overflow-wrap:anywhere}.empty{color:var(--vscode-descriptionForeground);padding:10px 0}
    .activity{list-style:none;padding:0;margin:0}.activity-item{display:grid;grid-template-columns:26px minmax(0,1fr) auto;align-items:center;gap:10px;min-height:48px;border-bottom:1px solid var(--vscode-panel-border)}.activity-number{color:var(--vscode-descriptionForeground);font-variant-numeric:tabular-nums;font-size:11px}.activity-main{min-width:0}.activity-main strong{display:block;font-weight:500;overflow-wrap:anywhere}.activity-main small{display:block;color:var(--vscode-descriptionForeground);overflow-wrap:anywhere}.activity-state{display:flex;align-items:center;gap:6px;color:var(--vscode-descriptionForeground);font-size:11px;white-space:nowrap}.activity-mark{width:8px;height:8px;border-radius:50%;background:var(--vscode-testing-iconPassed)}.activity-item.failed .activity-mark{background:var(--vscode-testing-iconFailed)}.activity-item.running .activity-mark{background:var(--vscode-textLink-foreground);animation:pulse 1100ms ease-in-out infinite}
    .copy{overflow-wrap:anywhere}.checks{list-style:none;padding:0;margin:0}.checks li{display:flex;gap:9px;padding:7px 0;border-bottom:1px solid var(--vscode-panel-border);overflow-wrap:anywhere}.checks li:before{content:"";width:7px;height:7px;flex:0 0 7px;margin-top:7px;border-radius:50%;background:var(--vscode-testing-iconPassed)}
    .changes-summary{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}.count{padding:3px 7px;border:1px solid var(--vscode-panel-border);border-radius:999px;color:var(--vscode-descriptionForeground);font-size:11px}.count.good{color:var(--vscode-testing-iconPassed)}.count.bad{color:var(--vscode-testing-iconFailed)}
    .change{border:1px solid var(--vscode-panel-border);margin-top:9px;border-radius:4px;overflow:hidden}.change-head{display:flex;align-items:flex-start;gap:10px;padding:11px 12px}.change-icon{width:8px;height:8px;flex:0 0 8px;margin-top:6px;border-radius:50%;background:var(--vscode-descriptionForeground)}.change.applied .change-icon{background:var(--vscode-testing-iconPassed)}.change.blocked .change-icon,.change.failed .change-icon{background:var(--vscode-testing-iconFailed)}.change-copy{min-width:0;flex:1}.change-copy strong{display:block;font-weight:500;overflow-wrap:anywhere}.change-copy small{display:block;color:var(--vscode-descriptionForeground);margin-top:3px;overflow-wrap:anywhere}.change-action{margin-left:auto;white-space:nowrap}.change details{border-top:1px solid var(--vscode-panel-border)}summary{padding:8px 12px;color:var(--vscode-textLink-foreground);cursor:pointer;font-size:11px}pre{white-space:pre-wrap;word-break:break-word;overflow:auto;padding:12px;margin:0;background:var(--vscode-textCodeBlock-background);font-family:var(--vscode-editor-font-family);font-size:12px}
    .clarification{border:1px solid var(--vscode-charts-yellow);padding:13px 14px;background:var(--vscode-textCodeBlock-background);overflow-wrap:anywhere}.clarification button{margin-top:10px}.notice{color:var(--vscode-descriptionForeground);font-size:12px}
    @keyframes spin{to{transform:rotate(360deg)}}@keyframes sweep{0%{transform:translateX(-120%)}50%{transform:translateX(80%)}100%{transform:translateX(260%)}}@keyframes pulse{0%,100%{opacity:.35}50%{opacity:1}}
    @media(max-width:600px){body{padding:20px 16px 36px}.hero-row{gap:10px}.hero-copy .lead{font-size:12px}.activity-item{grid-template-columns:22px minmax(0,1fr);padding:8px 0}.activity-state{grid-column:2}.change-head{align-items:flex-start}.change-action{white-space:normal}}
  </style></head><body><main id="app"></main>
  <script nonce="${nonce}">
    const vscode=acquireVsCodeApi();
    const initialState=${stateJson};
    const app=document.getElementById('app');
    const escapeHtml=(value)=>String(value??'').replace(/[&<>"']/g,(character)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]??character));
    const text=(value)=>escapeHtml(value).replace(/\\r?\\n/g,'<br>');
    const modeLabel=(mode)=>({capturing:'Preparing context',running:'Investigating',success:'Complete',failure:'Needs attention',needs_clarification:'Waiting for you',aborted:'Stopped',idle:'Ready'}[mode]??'Working');
    const modeClass=(mode)=>mode==='success'?'good':(['failure','aborted'].includes(mode)?'bad':(['capturing','running'].includes(mode)?'active':''));
    const activityState=(status)=>status==='completed'?'Completed':(status==='failed'?'Failed':'Working');
    const activityMark=(status)=>status==='completed'?'OK':(status==='failed'?'!':'');
    const progressMeta=(state)=>{const progress=state.progress??{};const result=state.result??{};const leg=result.legs??progress.leg;const calls=result.toolCalls??progress.toolCalls;return [leg?'Leg '+leg:'',calls?String(calls)+' tool '+(calls===1?'call':'calls'):''].filter(Boolean).join(' / ');};
    const renderActivity=(state)=>{const items=state.activity??[];if(!items.length){return '<div class="empty">Waiting for the first local tool request.</div>';}return '<ol class="activity">'+items.map((item,index)=>'<li class="activity-item '+item.status+'"><span class="activity-number">'+String(index+1).padStart(2,'0')+'</span><span class="activity-main"><strong>'+escapeHtml(item.tool.replace(/_/g,' ').replace(/\\b\\w/g,(character)=>character.toUpperCase()))+'</strong>'+(item.detail?'<small>'+escapeHtml(item.detail)+'</small>':'')+'</span><span class="activity-state"><span class="activity-mark" aria-hidden="true"></span>'+activityState(item.status)+'</span></li>').join('')+'</ol>';};
    const renderVerification=(result)=>{const items=result?.verification??[];return items.length?'<section class="section"><div class="section-heading"><h2>Verification</h2><small>'+items.length+' '+(items.length===1?'check':'checks')+'</small></div><ul class="checks">'+items.map((item)=>'<li>'+text(item)+'</li>').join('')+'</ul></section>':'';};
    const renderChanges=(state)=>{const result=state.result;const proposals=result?.proposedEdits??[];const applications=state.applications??[];if(!proposals.length&&!applications.length){return '<section class="section"><div class="section-heading"><h2>Changes</h2></div><p class="notice">No source changes were proposed.</p></section>';}const applied=applications.filter((item)=>item.status==='applied').length;const blocked=applications.filter((item)=>item.status==='blocked'||item.status==='failed').length;const pending=proposals.filter((proposal)=>!applications.some((item)=>item.path===proposal.path&&['applied','blocked','failed'].includes(item.status))).length;const cards=proposals.map((proposal)=>{const outcome=applications.find((item)=>item.path===proposal.path);const status=outcome?.status??'pending';const label=status==='applied'?'Applied':(status==='blocked'?'Blocked':(status==='failed'?'Failed':(status==='applying'?'Applying':'Ready')));const message=outcome?.message??'This change is ready to apply.';const action=!outcome||status==='failed'?'<button class="secondary change-action" data-action="apply" data-path="'+escapeHtml(proposal.path)+'">Apply</button>':'';return '<article class="change '+status+'"><div class="change-head"><span class="change-icon" aria-hidden="true"></span><span class="change-copy"><strong>'+escapeHtml(proposal.path)+'</strong><small>'+escapeHtml(label)+'. '+escapeHtml(message)+'</small></span>'+action+'</div><details><summary>View proposed diff</summary><pre>'+escapeHtml(proposal.diff)+'</pre></details></article>';}).join('');const summary=(applied?'<span class="count good">'+applied+' applied</span>':'')+(blocked?'<span class="count bad">'+blocked+' not applied</span>':'')+(pending?'<span class="count">'+pending+' awaiting action</span>':'');return '<section class="section"><div class="section-heading"><h2>'+(applied?'Changes applied':'Proposed changes')+'</h2><small>'+proposals.length+' '+(proposals.length===1?'file':'files')+'</small></div><div class="changes-summary">'+summary+'</div>'+cards+'</section>';};
    const renderResult=(state)=>{const result=state.result??{};const active=['capturing','running'].includes(state.mode);const summary=result.roast??(active?'The duck is reading the evidence before it speaks.':state.message);const progress=state.progress??{};const meta=progressMeta(state);const context=state.contextFile?'Focused file: '+escapeHtml(state.contextFile):'';const progressDetail=progress.message&&progress.message!==state.message?'<span>'+escapeHtml(progress.message)+'</span>':'';const progressSection=active?'<section class="progress-section"><div class="progress-row"><span class="spinner" aria-hidden="true"></span><span class="progress-copy"><strong>'+escapeHtml(state.message)+'</strong><small>'+escapeHtml(modeLabel(state.mode))+'</small></span><button class="secondary" data-action="stop">Stop run</button></div><div class="progress-track" aria-hidden="true"><span></span></div><div class="progress-meta">'+(meta?escapeHtml(meta):'Live status')+progressDetail+'</div></section>':'';const clarification=result.clarificationQuestion?'<section class="clarification"><strong>The duck needs a little more context.</strong><div>'+text(result.clarificationQuestion)+'</div><button data-action="microphone">Listen for clarification</button></section>':'';const diagnosis=result.diagnosis?'<section class="section"><div class="section-heading"><h2>Diagnosis</h2></div><div class="copy">'+text(result.diagnosis)+'</div></section>':'';const explanation=result.explanation?'<section class="section"><div class="section-heading"><h2>Explanation</h2></div><div class="copy">'+text(result.explanation)+'</div></section>':'';const activityCount=state.activity.length?state.activity.length+' tool '+(state.activity.length===1?'attempt':'attempts'):'In progress';const metaMarkup=meta?'<span>'+escapeHtml(meta)+'</span>':'';const stepsMarkup=result.activity?.length?'<span>'+result.activity.length+' investigation '+(result.activity.length===1?'step':'steps')+'</span>':'';return '<header class="hero"><p class="eyebrow">STRESSED DUCK'+(context?' / '+context:'')+'</p><div class="hero-row"><span class="duck-mark" aria-hidden="true">D</span><div class="hero-copy"><h1>'+(active?'The duck is on it':'The investigation is '+modeLabel(state.mode).toLowerCase())+'<span class="status-chip '+modeClass(state.mode)+'">'+escapeHtml(modeLabel(state.mode))+'</span></h1><p class="lead">'+text(summary)+'</p><div class="run-meta">'+metaMarkup+stepsMarkup+'</div></div></div></header>'+progressSection+'<section class="section"><div class="section-heading"><h2>Duck says</h2><small>'+(active?'Live':'Final comment')+'</small></div><div class="quote">'+text(summary)+'</div></section><section class="section"><div class="section-heading"><h2>Investigation</h2><small>'+activityCount+'</small></div>'+renderActivity(state)+'</section>'+diagnosis+explanation+renderVerification(result)+clarification+(state.result?renderChanges(state):'');};
    const render=(state)=>{app.innerHTML=renderResult(state);};
    render(initialState);
    document.addEventListener('click',(event)=>{const button=event.target.closest('button[data-action]');if(!button){return;}vscode.postMessage({action:button.dataset.action,path:button.dataset.path});});
    window.addEventListener('message',(event)=>{if(event.data?.type==='state'){render(event.data.state);}});
    vscode.postMessage({action:'ready'});
  </script></body></html>`;
}

class ResultPanelController {
  private readonly panel: vscode.WebviewPanel;
  private state: ResultPanelState;
  private readonly resolved = new Set<string>();
  private applying = false;
  private ready = false;
  private disposed = false;

  public constructor(extensionContext: vscode.ExtensionContext, initialState: ResultPanelState) {
    this.state = initialState;
    this.panel = vscode.window.createWebviewPanel(
      "stressedDuckResult",
      "Stressed Duck Result",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true },
    );
    this.panel.webview.html = resultHtml(this.state);
    this.panel.onDidDispose(() => {
      this.disposed = true;
    }, undefined, extensionContext.subscriptions);
    this.panel.webview.onDidReceiveMessage((message: { action?: string; path?: string }) => void this.handleMessage(message), undefined, extensionContext.subscriptions);
  }

  public update(patch: Partial<ResultPanelState>): void {
    this.state = { ...this.state, ...patch };
    if (this.ready && !this.disposed) {
      this.panel.webview.postMessage({ type: "state", state: this.state });
    }
  }

  public setContextCaptured(filePath: string): void {
    this.update({ mode: "running", contextFile: path.basename(filePath), message: `Context captured for ${path.basename(filePath)}; waiting for Studio.` });
  }

  public setProgress(progress: BrokerProgress): void {
    const requestedTool = progress.message.match(/^Studio requested (.+)\.$/)?.[1];
    let activity = progress.activity ? progress.activity.map((item) => ({ ...item })) : [...this.state.activity];
    if (requestedTool && (activity.length === 0 || activity[activity.length - 1].tool !== requestedTool || activity[activity.length - 1].status !== "running")) {
      activity.push({ tool: requestedTool, status: "running" });
    }
    const mode: PanelMode = progress.phase === "failed" ? "failure" : progress.phase === "aborted" ? "aborted" : "running";
    this.update({ mode, message: progress.message, progress, activity });
  }

  public async complete(result: AgentResult, autoApply: boolean): Promise<void> {
    this.update({ mode: resultMode(result.status), message: resultMessage(result), progress: undefined, result, activity: result.activity ?? [] });
    if (!autoApply) {
      return;
    }
    for (const proposal of result.proposedEdits) {
      await this.applyProposal(proposal.path, true);
    }
    if (!this.ready && !this.disposed) {
      this.panel.webview.html = resultHtml(this.state);
    }
  }

  private setApplication(pathName: string, status: ApplicationOutcome["status"], message: string): void {
    const existing = this.state.applications.filter((item) => item.path !== pathName);
    this.update({ applications: [...existing, { path: pathName, status, message }] });
  }

  private applicationStatus(detail: string): ApplicationOutcome["status"] {
    return /changed|trusted|outside|workspace|snapshot|closed/i.test(detail) ? "blocked" : "failed";
  }

  private async applyProposal(pathName: string, automatic: boolean): Promise<void> {
    try {
      if (this.applying || !pathName || this.resolved.has(pathName)) {
        throw new Error("This proposal is already resolved or being applied.");
      }
      this.applying = true;
      this.setApplication(pathName, "applying", automatic ? "Applying automatically..." : "Applying...");
      const result = this.state.result;
      if (!vscode.workspace.isTrusted || !result?.workspaceRoot) {
        throw new Error("Proposal review requires its original trusted workspace.");
      }
      const proposal = result.proposedEdits.find((item) => item.path === pathName);
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
      this.resolved.add(pathName);
      this.setApplication(pathName, "applied", automatic ? "Applied automatically. Not saved; undo is available in the editor." : "Applied. Not saved; undo is available in the editor.");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.setApplication(pathName, this.applicationStatus(detail), detail);
    } finally {
      this.applying = false;
    }
  }

  private async handleMessage(message: { action?: string; path?: string }): Promise<void> {
    if (message.action === "ready") {
      this.ready = true;
      this.panel.webview.postMessage({ type: "state", state: this.state });
      return;
    }
    if (message.action === "apply" && message.path) {
      await this.applyProposal(message.path, false);
      return;
    }
    if (message.action === "reject") {
      if (message.path) {
        this.resolved.add(message.path);
        this.setApplication(message.path, "blocked", "Rejected.");
      }
      return;
    }
    if (message.action === "stop") {
      try {
        const response = await requestBroker("stop");
        if (!response.ok) {
          throw new Error(response.error ?? "The run could not be stopped.");
        }
        this.update({ mode: "aborted", message: response.status?.progress?.message ?? "Run stopped by the editor.", progress: response.status?.progress });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.update({ message: detail });
      }
      return;
    }
    if (message.action === "microphone") {
      try {
        const response = await requestBroker("clarify", { microphone: true });
        if (!response.ok) {
          throw new Error(response.error ?? "Clarification listening was unavailable.");
        }
        if (response.result) {
          await this.complete(response.result, false);
        }
      } catch (error) {
        this.update({ message: error instanceof Error ? error.message : String(error) });
      }
    }
  }
}

function createPanelState(mode: PanelMode, message: string, result?: AgentResult): ResultPanelState {
  return {
    mode,
    message,
    ...(result ? { result, activity: result.activity ?? [] } : { activity: [] }),
    applications: [],
  };
}

async function showResultPanel(extensionContext: vscode.ExtensionContext, result: AgentResult, autoApply = false): Promise<ResultPanelController> {
  const controller = new ResultPanelController(extensionContext, createPanelState(resultMode(result.status), resultMessage(result), result));
  await controller.complete(result, autoApply);
  return controller;
}

async function showBrokerResult(
  output: vscode.OutputChannel,
  extensionContext: vscode.ExtensionContext,
  response: BrokerResponse,
  autoApply = false,
  existingPanel?: ResultPanelController,
): Promise<void> {
  if (!response.ok) {
    throw new Error(response.error ?? "The Stressed Duck broker rejected the request.");
  }
  output.appendLine(
    `Broker response: ${response.accepted === undefined ? "ok" : response.accepted ? "accepted" : "busy"}${
      response.status ? `, state=${response.status.state}, duck=${response.status.deviceMood ?? "unconfirmed"}` : ""
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
    if (existingPanel) {
      await existingPanel.complete(response.result, autoApply);
    } else {
      await showResultPanel(extensionContext, response.result, autoApply);
    }
  } else if (response.status?.lastResult) {
    await showResultPanel(extensionContext, response.status.lastResult);
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
  let lastProgressKey: string | undefined;
  let lastConnectionError: string | undefined;
  let clarificationContext: EditorContext | undefined;
  let capturing = false;
  let resultPanel: ResultPanelController | undefined;

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
    lastProgressKey = undefined;
    resultPanel = new ResultPanelController(context, createPanelState("capturing", "Capturing the active editor context..."));
    output.appendLine("Stressed Duck: capturing the active editor context...");
    output.show(true);
    try {
      await requestBroker("poll", { windowId, focused: vscode.window.state.focused, trusted: vscode.workspace.isTrusted });
      const editorContext = await captureEditorContext();
      pendingRun = {
        filePath: editorContext.filePath!,
        workspaceRoot: editorContext.workspaceRoot!,
        documentVersion: editorContext.documentVersion!,
        stopped: false,
      };
      resultPanel.setContextCaptured(editorContext.filePath!);
      output.appendLine(`Stressed Duck: context captured for ${path.basename(editorContext.filePath!)}; waiting for Studio.`);
      submitted = true;
      const response = await requestBroker("trigger", { context: editorContext, windowId, ...(captureId ? { captureId } : {}) });
      lastShownGeneration = response.result?.generation;
      clarificationContext = response.result?.status === "needs_clarification" ? editorContext : undefined;
      if (pendingRun.stopped && response.result) {
        throw new Error("Run cancelled; no automatic edits applied.");
      }
      pendingRun = undefined;
      if (response.result) {
        await showBrokerResult(output, context, response, true, resultPanel);
      } else if (response.accepted === false) {
        resultPanel.update({ mode: "failure", message: response.status?.progress?.message ?? "The Stressed Duck was busy and did not start a run.", progress: response.status?.progress });
      }
    } catch (error) {
      if (submitted) {
        void requestBroker("stop").catch(() => {});
      }
      const detail = error instanceof Error ? error.message : String(error);
      resultPanel?.update({ mode: pendingRun?.stopped ? "aborted" : "failure", message: detail });
      output.appendLine(`Trigger failed: ${detail}`);
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
      if (!response.ok) {
        throw new Error(response.error ?? "Broker rejected window registration.");
      }
      if (lastConnectionError) {
        output.appendLine("Broker connection restored; editor window registered.");
        lastConnectionError = undefined;
      }
      const progress = response.status?.progress;
      if ((pendingRun || capturing) && progress) {
        const progressKey = JSON.stringify(progress);
        if (progressKey !== lastProgressKey) {
          lastProgressKey = progressKey;
          resultPanel?.setProgress(progress);
          output.appendLine(`Stressed Duck: ${progress.message}`);
          output.show(true);
        }
      }
      if (response.captureId && response.captureId !== lastCapture && !pendingRun) {
        lastCapture = response.captureId;
        void runTrigger(response.captureId);
      }
      const result = response.status?.lastResult;
      if (!pendingRun && !capturing && result && result.generation !== lastShownGeneration) {
        lastShownGeneration = result.generation;
        await showResultPanel(context, result, true);
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
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (detail !== lastConnectionError) {
        lastConnectionError = detail;
        output.appendLine(`Broker connection failed: ${detail}`);
      }
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