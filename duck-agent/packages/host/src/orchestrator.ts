import { encodeDuckResponse, parseFirmwareLine, type DuckMood } from "./protocol.js";
import type { AgentEditProposal, AgentResult, AgentRunStatus } from "./agent-result.js";
import type { SerialTransport } from "./serial.js";

export type AgentOutcomeStatus = AgentRunStatus;

export interface AgentOutcome {
  readonly status: AgentOutcomeStatus;
  readonly comment: string;
  readonly result?: AgentResult;
}

export interface AgentRunContext {
  readonly generation: number;
  readonly signal: AbortSignal;
}

export interface AgentRunner {
  run(context: AgentRunContext): Promise<AgentOutcome>;
  getLastResult?(): AgentResult | undefined;
  applyProposal?(path?: string): Promise<AgentEditProposal>;
  rejectProposals?(): void;
}

export type OrchestratorState = DuckMood | "COOLDOWN";

export interface OrchestratorScheduler {
  set(delayMs: number, callback: () => void): unknown;
  clear(handle: unknown): void;
}

const realScheduler: OrchestratorScheduler = {
  set: (delayMs, callback) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

const DEFAULT_WORKING_COMMENT = "I am inspecting the evidence.";
const DEFAULT_FAILURE_COMMENT = "I could not complete that run. Details are in your editor.";
const DEFAULT_ABORT_COMMENT = "Run aborted. Details are in your editor.";

export interface DuckOrchestratorOptions {
  readonly transport: Pick<SerialTransport, "write" | "onLine">;
  readonly runner: AgentRunner;
  readonly smartHoldMs: number;
  readonly postRunCooldownMs: number;
  readonly now?: () => number;
  readonly scheduler?: OrchestratorScheduler;
}

export class DuckOrchestrator {
  private readonly now: () => number;
  private readonly scheduler: OrchestratorScheduler;
  private state: OrchestratorState = "HAPPY";
  private busy = false;
  private cooldownUntilMs = 0;
  private generation = 0;
  private activeController: AbortController | null = null;
  private smartTimer: unknown = null;
  private unsubscribe: (() => void) | null = null;
  private lastOutcome: AgentOutcome | undefined;

  public constructor(private readonly options: DuckOrchestratorOptions) {
    this.now = options.now ?? Date.now;
    this.scheduler = options.scheduler ?? realScheduler;
  }

  public getStatus(): {
    readonly state: OrchestratorState;
    readonly cooldownUntilMs: number;
    readonly lastResult?: AgentResult;
  } {
    return {
      state: this.state,
      cooldownUntilMs: this.cooldownUntilMs,
      ...(this.lastOutcome?.result ? { lastResult: this.lastOutcome.result } : {}),
    };
  }

  public getLastOutcome(): AgentOutcome | undefined {
    return this.lastOutcome;
  }

  public canTrigger(): boolean {
    return !this.busy && this.now() >= this.cooldownUntilMs;
  }

  public async start(): Promise<void> {
    if (this.unsubscribe !== null) {
      return;
    }
    this.unsubscribe = this.options.transport.onLine((line) => {
      void this.ingestLine(line);
    });
    await this.send("HAPPY", "Ready.");
  }

  public async stop(): Promise<void> {
    this.generation += 1;
    this.activeController?.abort();
    this.activeController = null;
    if (this.smartTimer !== null) {
      this.scheduler.clear(this.smartTimer);
      this.smartTimer = null;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.busy = false;
    this.state = "HAPPY";
    this.cooldownUntilMs = this.now() + this.options.postRunCooldownMs;
    await this.send("HAPPY", "Stopped.");
  }

  public async cancel(comment = DEFAULT_ABORT_COMMENT): Promise<boolean> {
    if (!this.busy) {
      return false;
    }
    this.generation += 1;
    this.activeController?.abort();
    this.activeController = null;
    if (this.smartTimer !== null) {
      this.scheduler.clear(this.smartTimer);
      this.smartTimer = null;
    }
    await this.finishImmediately(comment);
    return true;
  }

  public async ingestLine(line: string): Promise<boolean> {
    if (parseFirmwareLine(line) === null) {
      return false;
    }
    return this.handleFistSlam();
  }

  public async applyProposal(path?: string): Promise<AgentEditProposal> {
    if (!this.options.runner.applyProposal) {
      throw new Error("The active runner has no reviewable edit proposal.");
    }
    return this.options.runner.applyProposal(path);
  }

  public rejectProposals(): void {
    this.options.runner.rejectProposals?.();
  }

  private async handleFistSlam(): Promise<boolean> {
    if (this.busy || this.now() < this.cooldownUntilMs) {
      return false;
    }

    const generation = ++this.generation;
    const controller = new AbortController();
    this.activeController = controller;
    this.busy = true;
    this.state = "STRESSED";

    try {
      await this.send("STRESSED", DEFAULT_WORKING_COMMENT);
      const outcome = await this.options.runner.run({ generation, signal: controller.signal });
      if (this.activeController?.signal !== controller.signal || generation !== this.generation) {
        return false;
      }
      this.lastOutcome = outcome;

      if (outcome.status === "success") {
        await this.finishSuccessfully(outcome.comment);
      } else {
        await this.finishImmediately(outcome.comment || DEFAULT_FAILURE_COMMENT);
      }
    } catch {
      if (this.activeController?.signal === controller.signal && generation === this.generation) {
        await this.finishImmediately(DEFAULT_FAILURE_COMMENT);
      }
    } finally {
      if (this.activeController?.signal === controller.signal) {
        this.activeController = null;
      }
    }

    return true;
  }

  private async finishSuccessfully(comment: string): Promise<void> {
    this.state = "COOL";
    await this.send("COOL", comment);
    this.activeController = null;
    this.smartTimer = this.scheduler.set(this.options.smartHoldMs, () => {
      void this.returnToHappy();
    });
  }

  private async returnToHappy(): Promise<void> {
    if (!this.busy || this.state !== "COOL") {
      return;
    }
    this.smartTimer = null;
    this.state = "HAPPY";
    try {
      await this.send("HAPPY", "Ready.");
    } finally {
      this.busy = false;
      this.cooldownUntilMs = this.now() + this.options.postRunCooldownMs;
    }
  }

  private async finishImmediately(comment: string): Promise<void> {
    this.state = "HAPPY";
    try {
      await this.send("HAPPY", comment);
    } finally {
      this.busy = false;
      this.cooldownUntilMs = this.now() + this.options.postRunCooldownMs;
      this.activeController = null;
    }
  }

  private async send(mood: DuckMood, comment: string): Promise<void> {
    await this.options.transport.write(encodeDuckResponse({ mood, comment }));
  }
}
