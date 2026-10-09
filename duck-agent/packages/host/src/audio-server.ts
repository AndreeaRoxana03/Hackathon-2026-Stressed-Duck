import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SpeechTranscriber } from "./speech.js";

export interface AudioSessionStatus {
  readonly id: string;
  readonly comment: string;
  readonly expiresAt: number;
  readonly state: "awaiting_playback" | "listening" | "transcribing" | "complete" | "cancelled";
}

interface AudioSession {
  status: AudioSessionStatus;
  readonly controller: AbortController;
  readonly onTranscript: (text: string) => void;
  readonly onError: (message: string) => void;
}

export class ClarificationSessions {
  private session: AudioSession | undefined;

  public constructor(private readonly transcriber: SpeechTranscriber, private readonly now = Date.now) {}

  public begin(comment: string, onTranscript: (text: string) => void, onError: (message: string) => void): AudioSessionStatus {
    this.cancel();
    this.session = {
      status: { id: randomUUID(), comment, expiresAt: this.now() + 60_000, state: "awaiting_playback" },
      controller: new AbortController(),
      onTranscript,
      onError,
    };
    return this.session.status;
  }

  public getStatus(): AudioSessionStatus | undefined {
    if (this.session && this.now() >= this.session.status.expiresAt && this.session.status.state !== "cancelled") {
      const session = this.session;
      this.cancel();
      session.onError("Speech clarification timed out.");
    }
    return this.session?.status;
  }

  private require(id: string, state: AudioSessionStatus["state"]): AudioSession {
    const status = this.getStatus();
    if (!this.session || status?.id !== id || status.state !== state) {
      throw new Error("Invalid, expired, replayed, or out-of-order speech session.");
    }
    return this.session;
  }

  public playbackComplete(id: string): void {
    const session = this.require(id, "awaiting_playback");
    session.status = { ...session.status, state: "listening" };
  }

  public async upload(id: string, audio: Uint8Array): Promise<void> {
    const session = this.require(id, "listening");
    session.status = { ...session.status, state: "transcribing" };
    try {
      const text = await this.transcriber.transcribe(audio, session.controller.signal);
      if (this.session !== session || session.controller.signal.aborted || this.now() >= session.status.expiresAt) {
        throw new Error("Speech session expired or was cancelled during transcription.");
      }
      session.status = { ...session.status, state: "complete" };
      session.onTranscript(text.slice(0, 4_000));
    } catch (error) {
      if (!session.controller.signal.aborted) {
        session.status = { ...session.status, state: "cancelled" };
        session.onError(error instanceof Error ? error.message : String(error));
      }
      throw error;
    }
  }

  public cancel(): void {
    if (this.session) {
      this.session.controller.abort();
      this.session.status = { ...this.session.status, state: "cancelled" };
    }
  }
}

export interface AudioServerOptions {
  readonly host: string;
  readonly port: number;
  readonly certificate: string;
  readonly privateKey: string;
  readonly deviceToken: string;
  readonly sessions: ClarificationSessions;
}

async function boundedBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > 1_048_576) {
      throw new Error("Audio exceeds the upload size limit.");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

export class DuckAudioServer {
  private readonly server: Server;

  public constructor(private readonly options: AudioServerOptions) {
    if (options.deviceToken.length < 32 || ["0.0.0.0", "::", ""].includes(options.host)) {
      throw new Error("Audio requires an explicit bind interface and a device token of at least 32 characters.");
    }
    this.server = createServer({ cert: options.certificate, key: options.privateKey }, (request, response) => {
      void this.handle(request, response).catch(() => {
        if (!response.headersSent) {
          response.writeHead(400, { "Content-Type": "application/json" });
        }
        response.end(JSON.stringify({ error: "Invalid audio request or speech session." }));
      });
    });
    this.server.requestTimeout = 30_000;
    this.server.headersTimeout = 10_000;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const expected = Buffer.from(`Bearer ${this.options.deviceToken}`);
    const received = Buffer.from(request.headers.authorization ?? "");
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
      response.writeHead(401);
      response.end();
      return;
    }
    const url = new URL(request.url ?? "/", "https://localhost");
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "no-store");
    if (request.method === "GET" && url.pathname === "/session") {
      response.end(JSON.stringify({ session: this.options.sessions.getStatus() ?? null }));
      return;
    }
    const id = url.searchParams.get("id") ?? "";
    if (request.method === "POST" && url.pathname === "/playback-complete") {
      this.options.sessions.playbackComplete(id);
    } else if (request.method === "POST" && url.pathname === "/audio" && request.headers["content-type"] === "audio/wav") {
      await this.options.sessions.upload(id, await boundedBody(request));
    } else {
      response.writeHead(404);
      response.end();
      return;
    }
    response.end(JSON.stringify({ ok: true }));
  }

  public async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.port, this.options.host, resolve);
    });
  }

  public async stop(): Promise<void> {
    this.options.sessions.cancel();
    this.server.closeAllConnections();
    if (this.server.listening) {
      await new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
    }
  }
}