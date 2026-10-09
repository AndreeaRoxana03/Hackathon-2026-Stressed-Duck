import { readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { StudioToolDefinition } from "./studio-client.js";

const MAX_RESULT_LENGTH = 48_000;
const MAX_FILE_LENGTH = 100_000;
const MAX_SEARCH_FILES = 2_000;
const MAX_SEARCH_MATCHES = 100;
const IGNORED_DIRECTORIES = new Set([".git", "node_modules", ".pio", "dist", "build", "coverage"]);
const SENSITIVE_ENVIRONMENT_KEYS = new Set([
  "DUCK_STUDIO_ACCESS_TOKEN",
  "DUCK_OAUTH_CLIENT_SECRET",
  "DUCK_BROKER_TOKEN",
  "DUCK_STT_API_KEY",
  "DUCK_AUDIO_DEVICE_TOKEN",
]);

export interface EditProposal {
  readonly path: string;
  readonly oldText: string;
  readonly newText: string;
  readonly diff: string;
  readonly baseText?: string;
}

export interface ToolExecutionResult {
  readonly content: string;
  readonly error?: string;
  readonly proposal?: EditProposal;
}

export interface WorkspaceToolExecutor {
  readonly definitions: readonly StudioToolDefinition[];
  execute(name: string, args: unknown, signal?: AbortSignal): Promise<ToolExecutionResult>;
  getLastProposal(): EditProposal | undefined;
  getProposals?(): readonly EditProposal[];
  applyLastProposal(): Promise<EditProposal>;
  applyProposal?(path: string): Promise<EditProposal>;
  clearLastProposal(): void;
  clearProposals?(): void;
}

function objectArgs(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Tool arguments must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function stringArg(args: Record<string, unknown>, name: string, fallback?: string): string {
  const value = args[name];
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (fallback !== undefined) {
    return fallback;
  }
  throw new Error(`Argument '${name}' must be a non-empty string.`);
}

function integerArg(args: Record<string, unknown>, name: string, fallback: number): number {
  const value = args[name];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function booleanArg(args: Record<string, unknown>, name: string, fallback: boolean): boolean {
  return typeof args[name] === "boolean" ? args[name] as boolean : fallback;
}

function bounded(value: string): string {
  return value.length <= MAX_RESULT_LENGTH ? value : `${value.slice(0, MAX_RESULT_LENGTH)}\n...[truncated]`;
}

function jsonResult(value: unknown): ToolExecutionResult {
  return { content: bounded(JSON.stringify(value, null, 2)) };
}

function errorResult(error: unknown): ToolExecutionResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: JSON.stringify({ error: message }), error: message };
}

export function commandEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(([key]) => !SENSITIVE_ENVIRONMENT_KEYS.has(key.toUpperCase()) && !/(?:TOKEN|SECRET|PASSWORD|API_?KEY|CREDENTIAL)/i.test(key)),
  );
}

function normalizeRelativePath(root: string, requestedPath: string): { absolute: string; relative: string } {
  const absoluteRoot = path.resolve(root);
  const absolute = path.resolve(absoluteRoot, requestedPath);
  const relative = path.relative(absoluteRoot, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("The requested path is outside the trusted workspace.");
  }
  return { absolute, relative: relative || "." };
}

export function isSensitivePath(requestedPath: string): boolean {
  return requestedPath.split(/[\\/]/).some((part) =>
    /^\.env(?:\.|$)/i.test(part) || /^(?:\.git|\.ssh|\.aws|\.azure)$/i.test(part) ||
    /(?:credentials|secrets?|tokens?)(?:\.|$)/i.test(part) || /\.(?:pem|key|pfx|p12)$/i.test(part),
  );
}

async function canonicalPath(root: string, requestedPath: string): Promise<{ absolute: string; relative: string }> {
  if (isSensitivePath(requestedPath)) {
    throw new Error("Secret and credential paths are excluded from workspace tools.");
  }
  const canonicalRoot = await realpath(root);
  const lexical = normalizeRelativePath(canonicalRoot, requestedPath);
  return normalizeRelativePath(canonicalRoot, await realpath(lexical.absolute));
}

async function readWorkspaceFile(root: string, requestedPath: string): Promise<string> {
  const { absolute } = await canonicalPath(root, requestedPath);
  if ((await stat(absolute)).size > MAX_FILE_LENGTH) {
    throw new Error("File exceeds the bounded workspace read limit.");
  }
  const content = await readFile(absolute, "utf8");
  if (content.length > MAX_FILE_LENGTH) {
    return `${content.slice(0, MAX_FILE_LENGTH)}\n...[file truncated]`;
  }
  return content;
}

async function listFiles(directory: string, files: string[]): Promise<void> {
  if (files.length >= MAX_SEARCH_FILES) {
    return;
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || isSensitivePath(entry.name)) {
      continue;
    }
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) {
        await listFiles(path.join(directory, entry.name), files);
      }
      continue;
    }
    if (entry.isFile()) {
      files.push(path.join(directory, entry.name));
      if (files.length >= MAX_SEARCH_FILES) {
        return;
      }
    }
  }
}

async function searchWorkspace(root: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
  const query = stringArg(args, "query");
  const requestedPath = stringArg(args, "path", ".");
  const { absolute: searchRoot } = await canonicalPath(root, requestedPath);
  const useRegex = booleanArg(args, "regex", false);
  if (useRegex) {
    throw new Error("Only literal searches are enabled to avoid unbounded regular-expression execution.");
  }
  const files: string[] = [];
  const matches: Array<{ path: string; line: number; text: string }> = [];
  await listFiles(searchRoot, files);

  for (const file of files) {
    if (matches.length >= MAX_SEARCH_MATCHES) {
      break;
    }
    let content: string;
    try {
      if ((await stat(file)).size > MAX_FILE_LENGTH) {
        continue;
      }
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }
    if (content.includes("\u0000")) {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const found = line.toLowerCase().includes(query.toLowerCase());
      if (found) {
        matches.push({
          path: path.relative(root, file),
          line: index + 1,
          text: line.slice(0, 500),
        });
        if (matches.length >= MAX_SEARCH_MATCHES) {
          break;
        }
      }
    }
  }
  return jsonResult({ query, matches, truncated: files.length >= MAX_SEARCH_FILES || matches.length >= MAX_SEARCH_MATCHES });
}

function runProcess(
  executable: string,
  args: readonly string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<{ exitCode: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const child = spawn(executable, args, {
      cwd,
      shell: false,
      windowsHide: true,
      env: commandEnvironment(),
    });
    let output = "";
    const append = (chunk: Buffer | string) => {
      output += chunk.toString();
      if (output.length > MAX_RESULT_LENGTH * 2) {
        output = output.slice(-MAX_RESULT_LENGTH * 2);
      }
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const abort = () => {
      if (process.platform === "win32" && child.pid) {
        const terminate = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          shell: false, windowsHide: true, stdio: "ignore", env: commandEnvironment(),
        });
        terminate.once("error", () => child.kill());
      } else {
        child.kill();
      }
    };
    const timeout = setTimeout(abort, 60_000);
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      resolve({ exitCode, output: bounded(output) });
    });
  });
}

async function runAllowedCommand(root: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolExecutionResult> {
  const command = stringArg(args, "command").trim();
  const configured: unknown = JSON.parse(process.env.DUCK_ALLOWED_COMMANDS || "[]");
  if (!Array.isArray(configured) || !configured.every((item) => typeof item === "string")) {
    throw new Error("DUCK_ALLOWED_COMMANDS must be a JSON array of exact trusted commands.");
  }
  if (!configured.includes(command)) {
    throw new Error("Command is not in the user-configured exact command allowlist.");
  }

  const parts = command.split(/\s+/);
  let executable = parts[0] ?? "";
  let commandArgs = parts.slice(1);
  if (executable === "npm") {
    const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    executable = process.execPath;
    commandArgs = [npmCli, ...commandArgs];
  } else if (executable === "python") {
    executable = process.platform === "win32" ? "python.exe" : "python3";
  } else {
    throw new Error("Only npm and python test/build executables are supported.");
  }
  const result = await runProcess(executable, commandArgs, root, signal);
  return {
    content: bounded(JSON.stringify({ command, exitCode: result.exitCode, output: result.output }, null, 2)),
    ...(result.exitCode === 0 ? {} : { error: `Command exited with code ${result.exitCode}.` }),
  };
}

function makeDiff(relativePath: string, oldText: string, newText: string): string {
  const oldLines = oldText.replace(/\r\n/g, "\n").split("\n");
  const newLines = newText.replace(/\r\n/g, "\n").split("\n");
  return [
    `--- a/${relativePath}`,
    `+++ b/${relativePath}`,
    `@@ replace ${oldLines.length} line(s) with ${newLines.length} line(s) @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join("\n");
}

export const WORKSPACE_TOOL_DEFINITIONS: readonly StudioToolDefinition[] = [
  {
    name: "read_file",
    description: "Read a bounded line range from a file inside the trusted workspace.",
    parameters: { type: "object", properties: { path: { type: "string" }, startLine: { type: "integer" }, endLine: { type: "integer" } }, required: ["path"] },
  },
  {
    name: "search_files",
    description: "Search literal text across bounded text files inside the trusted workspace. Regular expressions are disabled.",
    parameters: { type: "object", properties: { query: { type: "string" }, path: { type: "string" }, regex: { type: "boolean" } }, required: ["query"] },
  },
  {
    name: "git_diff",
    description: "Inspect the current Git diff or status inside the trusted workspace.",
    parameters: { type: "object", properties: { path: { type: "string" }, staged: { type: "boolean" }, status: { type: "boolean" } } },
  },
  {
    name: "run_tests",
    description: "Run an allowlisted project test, typecheck, build, pytest, or PlatformIO command.",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  },
  {
    name: "propose_edit",
    description: "Stage an exact-text fix for automatic application in VS Code after the run. Consecutive edits to a file are cumulative; reads return staged content. Line endings are normalized for matching. Use empty newText to delete text.",
    parameters: { type: "object", properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } }, required: ["path", "oldText", "newText"] },
  },
];

export class WorkspaceToolHost implements WorkspaceToolExecutor {
  public readonly definitions = WORKSPACE_TOOL_DEFINITIONS;
  private lastProposal: EditProposal | undefined;
  private proposals: EditProposal[] = [];
  private readonly proposalSnapshots = new Map<string, string>();

  public constructor(private readonly root: string) {}

  public getLastProposal(): EditProposal | undefined {
    return this.lastProposal;
  }

  public getProposals(): readonly EditProposal[] {
    return [...this.proposals];
  }

  public clearLastProposal(): void {
    this.lastProposal = undefined;
  }

  public clearProposals(): void {
    this.lastProposal = undefined;
    this.proposals = [];
    this.proposalSnapshots.clear();
  }

  private async stagedContent(requestedPath: string): Promise<string> {
    const current = await readWorkspaceFile(this.root, requestedPath);
    const relative = normalizeRelativePath(this.root, requestedPath).relative;
    const proposal = this.proposals.find((item) => item.path === relative);
    if (!proposal) {
      return current;
    }
    if (current !== proposal.baseText) {
      throw new Error("The file changed during diagnosis; staged edits are stale.");
    }
    return proposal.newText;
  }

  public async execute(name: string, rawArgs: unknown, signal?: AbortSignal): Promise<ToolExecutionResult> {
    try {
      signal?.throwIfAborted();
      const args = objectArgs(rawArgs);
      switch (name) {
        case "read_file": {
          const requestedPath = stringArg(args, "path");
          const content = await this.stagedContent(requestedPath);
          const lines = content.split(/\r?\n/);
          const startLine = integerArg(args, "startLine", 1);
          const endLine = Math.min(lines.length, integerArg(args, "endLine", Math.min(lines.length, startLine + 199)));
          return jsonResult({ path: requestedPath, startLine, endLine, content: lines.slice(startLine - 1, endLine).map((line, index) => `${startLine + index}: ${line}`).join("\n") });
        }
        case "search_files":
          return await searchWorkspace(this.root, args);
        case "git_diff": {
          const status = booleanArg(args, "status", false);
          const staged = booleanArg(args, "staged", false);
          const requestedPath = typeof args.path === "string" && args.path.trim() ? args.path : undefined;
          const relative = requestedPath ? (await canonicalPath(this.root, requestedPath)).relative : ".";
          const exclusions = ["**/.env*", "**/*secret*", "**/*credential*", "**/*token*", "**/*.pem", "**/*.key", "**/*.pfx", "**/*.p12"].map((pattern) => `:(exclude,glob,icase)${pattern}`);
          const commandArgs = status ? ["status", "--short"] : ["diff", "--no-ext-diff", "--no-textconv", ...(staged ? ["--cached"] : []), "--", relative, ...exclusions];
          const result = await runProcess("git", commandArgs, this.root, signal);
          return { content: bounded(result.output), ...(result.exitCode === 0 ? {} : { error: `git exited with code ${result.exitCode}.` }) };
        }
        case "run_tests":
          return await runAllowedCommand(this.root, args, signal);
        case "propose_edit": {
          const requestedPath = stringArg(args, "path");
          const oldText = stringArg(args, "oldText").replace(/\r\n/g, "\n");
          if (typeof args.newText !== "string") {
            throw new Error("Argument 'newText' must be a string.");
          }
          const newText = args.newText.replace(/\r\n/g, "\n");
          const current = await readWorkspaceFile(this.root, requestedPath);
          const staged = await this.stagedContent(requestedPath);
          signal?.throwIfAborted();
          const normalized = staged.replace(/\r\n/g, "\n");
          const occurrences = normalized.split(oldText).length - 1;
          if (occurrences !== 1) {
            throw new Error(`oldText must match exactly once; found ${occurrences} matches.`);
          }
          const relative = normalizeRelativePath(this.root, requestedPath).relative;
          const replacement = normalized.replace(oldText, () => newText);
          const updated = current.includes("\r\n") ? replacement.replace(/\n/g, "\r\n") : replacement;
          const proposal: EditProposal = { path: relative, oldText: current, newText: updated, diff: makeDiff(relative, current, updated), baseText: current };
          this.proposals = [...this.proposals.filter((item) => item.path !== relative), proposal];
          this.lastProposal = proposal;
          this.proposalSnapshots.set(relative, current);
          return { ...jsonResult({ path: relative, staged: true, message: "Fix staged. Subsequent reads include this change; not yet applied or verified." }), proposal };
        }
        default:
          return errorResult(`Unknown local tool: ${name}`);
      }
    } catch (error) {
      return errorResult(error);
    }
  }

  public async applyLastProposal(): Promise<EditProposal> {
    return this.applyProposal(this.lastProposal?.path);
  }

  public async applyProposal(requestedPath?: string): Promise<EditProposal> {
    const proposal = requestedPath
      ? this.proposals.find((item) => item.path === requestedPath)
      : this.lastProposal;
    if (!proposal) {
      throw new Error("There is no pending edit proposal.");
    }
    const { absolute } = await canonicalPath(this.root, proposal.path);
    const current = await readFile(absolute, "utf8");
    const occurrences = current.split(proposal.oldText).length - 1;
    if (occurrences !== 1 || current !== this.proposalSnapshots.get(proposal.path)) {
      throw new Error("The file changed since the proposal was created; the edit was not applied.");
    }
    await writeFile(absolute, current.replace(proposal.oldText, () => proposal.newText), "utf8");
    this.proposals = this.proposals.filter((item) => item !== proposal);
    this.lastProposal = this.proposals.at(-1);
    this.proposalSnapshots.delete(proposal.path);
    return proposal;
  }
}