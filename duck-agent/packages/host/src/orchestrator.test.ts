import assert from "node:assert/strict";
import test from "node:test";
import { DuckOrchestrator, type AgentRunner, type OrchestratorScheduler } from "./orchestrator.js";
import type { SerialTransport } from "./serial.js";

class FakeTransport implements Pick<SerialTransport, "write" | "onLine"> {
  public readonly writes: string[] = [];
  private readonly listeners = new Set<(line: string) => void>();

  public async write(line: string): Promise<void> {
    this.writes.push(line);
  }

  public onLine(listener: (line: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

class FakeScheduler implements OrchestratorScheduler {
  public nowMs = 0;
  private nextId = 0;
  private readonly tasks = new Map<number, { readonly dueAt: number; readonly callback: () => void }>();

  public set(delayMs: number, callback: () => void): number {
    const id = ++this.nextId;
    this.tasks.set(id, { dueAt: this.nowMs + delayMs, callback });
    return id;
  }

  public clear(handle: unknown): void {
    this.tasks.delete(handle as number);
  }

  public async advance(delayMs: number): Promise<void> {
    this.nowMs += delayMs;
    const due = [...this.tasks.entries()]
      .filter(([, task]) => task.dueAt <= this.nowMs)
      .sort(([, left], [, right]) => left.dueAt - right.dueAt);
    for (const [id, task] of due) {
      this.tasks.delete(id);
      task.callback();
      await Promise.resolve();
    }
  }
}

function lineFor(mood: string, comment: string): string {
  return `RESP|MOOD=${mood}|COMMENT=${comment}|FIX=|EXPLAIN=\n`;
}

test("runs one event through stressed, cool, happy, and cooldown", async () => {
  const transport = new FakeTransport();
  const scheduler = new FakeScheduler();
  let runCount = 0;
  const runner: AgentRunner = {
    async run() {
      runCount += 1;
      return { status: "success", comment: "The duck found a focused fix." };
    },
  };
  const orchestrator = new DuckOrchestrator({
    transport,
    runner,
    smartHoldMs: 5000,
    postRunCooldownMs: 3000,
    now: () => scheduler.nowMs,
    scheduler,
  });

  await orchestrator.start();
  assert.equal(await orchestrator.ingestLine("accel magnitude: 1.40 g\n"), false);
  assert.equal(await orchestrator.ingestLine("EVENT:FIST_SLAM\n"), true);
  assert.equal(runCount, 1);
  assert.equal(orchestrator.getStatus().state, "COOL");
  assert.equal(await orchestrator.ingestLine("EVENT:FIST_SLAM\n"), false);
  assert.deepEqual(transport.writes, [
    lineFor("HAPPY", "Ready."),
    lineFor("STRESSED", "I am inspecting the evidence."),
    lineFor("COOL", "The duck found a focused fix."),
  ]);

  await scheduler.advance(5000);
  assert.equal(orchestrator.getStatus().state, "HAPPY");
  assert.equal(transport.writes.at(-1), lineFor("HAPPY", "Ready."));
  assert.equal(await orchestrator.ingestLine("EVENT:FIST_SLAM\n"), false);
  await scheduler.advance(3000);
  assert.equal(await orchestrator.ingestLine("EVENT:FIST_SLAM\n"), true);
});

test("returns happy and cooldown on a failed run", async () => {
  const transport = new FakeTransport();
  const scheduler = new FakeScheduler();
  const orchestrator = new DuckOrchestrator({
    transport,
    runner: {
      async run() {
        return { status: "failure", comment: "The run failed honestly." };
      },
    },
    smartHoldMs: 5000,
    postRunCooldownMs: 3000,
    now: () => scheduler.nowMs,
    scheduler,
  });

  await orchestrator.ingestLine("EVENT:FIST_SLAM\n");
  assert.equal(orchestrator.getStatus().state, "HAPPY");
  assert.equal(transport.writes.at(-1), lineFor("HAPPY", "The run failed honestly."));
  assert.equal(await orchestrator.ingestLine("EVENT:FIST_SLAM\n"), false);
});

test("tracks the mood confirmed by the duck and clears it on timeout", async () => {
  const transport = new FakeTransport();
  const orchestrator = new DuckOrchestrator({
    transport,
    runner: { async run() { return { status: "success", comment: "Done." }; } },
    smartHoldMs: 5000,
    postRunCooldownMs: 3000,
  });

  await orchestrator.ingestLine("ACK|MOOD=STRESSED\n");
  assert.equal(orchestrator.getStatus().deviceMood, "STRESSED");
  await orchestrator.ingestLine("EVENT:HOST_TIMEOUT\n");
  assert.equal(orchestrator.getStatus().deviceMood, undefined);
});

test("heartbeats the current mood after the broker handshake", async () => {
  const transport = new FakeTransport();
  const orchestrator = new DuckOrchestrator({
    transport,
    runner: { async run() { return { status: "success", comment: "Done." }; } },
    smartHoldMs: 5000,
    postRunCooldownMs: 3000,
  });

  await orchestrator.start();
  await orchestrator.heartbeat();
  assert.equal(transport.writes.at(-1), lineFor("HAPPY", "Ready."));
});

test("keeps smart mode through speech and starts the hold after playback", async () => {
  const transport = new FakeTransport();
  const scheduler = new FakeScheduler();
  let finishSpeech: (() => void) | undefined;
  let spoken = "";
  const orchestrator = new DuckOrchestrator({
    transport,
    runner: { async run() { return { status: "success", comment: "Read the error next time." }; } },
    speechOutput: { async speak(text) { spoken = text; await new Promise<void>((resolve) => { finishSpeech = resolve; }); } },
    smartHoldMs: 5000,
    postRunCooldownMs: 3000,
    now: () => scheduler.nowMs,
    scheduler,
  });
  const run = orchestrator.ingestLine("EVENT:FIST_SLAM");
  for (let turn = 0; turn < 5; ++turn) { await Promise.resolve(); }
  assert.equal(spoken, "Read the error next time.");
  assert.equal(orchestrator.getStatus().state, "COOL");
  await scheduler.advance(10000);
  assert.equal(orchestrator.getStatus().state, "COOL");
  finishSpeech?.();
  assert.equal(await run, true);
  await scheduler.advance(4999);
  assert.equal(orchestrator.getStatus().state, "COOL");
  await scheduler.advance(1);
  assert.equal(orchestrator.getStatus().state, "HAPPY");
});

test("holds stressed before starting a configured physical investigation", async () => {
  const transport = new FakeTransport();
  const scheduler = new FakeScheduler();
  let investigations = 0;
  const orchestrator = new DuckOrchestrator({
    transport,
    runner: { async run() { investigations += 1; return { status: "success", comment: "Done." }; } },
    stressedHoldMs: 10,
    smartHoldMs: 5000,
    postRunCooldownMs: 3000,
    scheduler,
  });
  const run = orchestrator.ingestLine("EVENT:FIST_SLAM");
  await Promise.resolve();
  assert.equal(orchestrator.getStatus().state, "STRESSED");
  assert.equal(investigations, 0);
  assert.equal(await run, true);
  assert.equal(investigations, 1);
  await scheduler.advance(5000);
});

test("cancelling speech returns happy and does not schedule a late smart hold", async () => {
  const transport = new FakeTransport();
  const scheduler = new FakeScheduler();
  let speechSignal: AbortSignal | undefined;
  const orchestrator = new DuckOrchestrator({
    transport,
    runner: { async run() { return { status: "success", comment: "Result." }; } },
    speechOutput: {
      async speak(_text, signal) {
        speechSignal = signal;
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("Stopped speech")), { once: true });
        });
      },
    },
    smartHoldMs: 5000,
    postRunCooldownMs: 3000,
    now: () => scheduler.nowMs,
    scheduler,
  });
  const run = orchestrator.ingestLine("EVENT:FIST_SLAM");
  for (let turn = 0; turn < 5; ++turn) { await Promise.resolve(); }
  assert.equal(await orchestrator.cancel(), true);
  assert.equal(speechSignal?.aborted, true);
  assert.equal(await run, false);
  await scheduler.advance(10000);
  assert.equal(orchestrator.getStatus().state, "HAPPY");
});

test("cancels immediately, rejects late success, and preserves post-abort cooldown", async () => {
  const transport = new FakeTransport();
  const scheduler = new FakeScheduler();
  let finish: (() => void) | undefined;
  const orchestrator = new DuckOrchestrator({
    transport,
    runner: { async run() { await new Promise<void>((resolve) => { finish = resolve; }); return { status: "success", comment: "Late result" }; } },
    smartHoldMs: 5_000, postRunCooldownMs: 3_000, now: () => scheduler.nowMs, scheduler,
  });
  const run = orchestrator.ingestLine("EVENT:FIST_SLAM");
  await Promise.resolve();
  assert.equal(await orchestrator.cancel("Run aborted: Document modified during diagnosis"), true);
  assert.equal(orchestrator.getStatus().state, "HAPPY");
  finish?.();
  assert.equal(await run, false);
  assert.equal(transport.writes.some((line) => line.includes("MOOD=COOL")), false);
  assert.equal(orchestrator.getLastOutcome(), undefined);
  await scheduler.advance(2_999);
  assert.equal(orchestrator.canTrigger(), false);
  await scheduler.advance(1);
  assert.equal(orchestrator.canTrigger(), true);
});
