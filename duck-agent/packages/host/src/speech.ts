import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fitComment } from "./protocol.js";
import type { SerialTransport } from "./serial.js";

const MAX_AUDIO_BYTES = 1_048_576;
const MAX_AUDIO_SECONDS = 20;
const EXPECTED_SAMPLE_RATE = 16_000;
const EXPECTED_CHANNELS = 1;
const EXPECTED_BITS_PER_SAMPLE = 16;
const AUDIO_CHUNK_BYTES = 256;
// Chunks in flight before waiting for an ack; ~13 KB of hex on the wire must stay under the firmware's 16 KB serial RX buffer.
const AUDIO_WINDOW_CHUNKS = 24;
// Matches the Edge TTS voice tools/speech_to_clips.py renders the embedded touch/stressed/happy clips with.
const DUCK_SPEECH_SCRIPT = fileURLToPath(new URL("../../../../tools/synthesize_speech.py", import.meta.url));

export interface SpeechOutput {
  speak(text: string, signal?: AbortSignal, onReady?: () => void | Promise<void>): Promise<void>;
}

export interface SpeechTranscriber {
  transcribe(audio: Uint8Array, signal?: AbortSignal): Promise<string>;
}

export interface SpeechTranscriberOptions {
  readonly endpoint: string;
  readonly model: string;
  readonly apiKey: string;
  readonly language?: string;
  readonly timeoutMs?: number;
}

function abortError(): Error {
  return new DOMException("The speech operation was aborted.", "AbortError");
}

function runPowerShell(script: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      shell: false,
      windowsHide: true,
    });
    let output = "";
    let errorOutput = "";
    const abort = () => child.kill();
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer | string) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      errorOutput += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) {
        reject(abortError());
      } else if (code !== 0) {
        reject(new Error(errorOutput.trim() || `PowerShell exited with code ${code}.`));
      } else {
        resolve(output.trim());
      }
    });
  });
}

export class WindowsSpeechOutput implements SpeechOutput {
  public async speak(text: string, signal?: AbortSignal): Promise<void> {
    if (process.platform !== "win32") {
      throw new Error("Windows speech output is only available on Windows.");
    }
    if (signal?.aborted) {
      throw abortError();
    }
    const encodedText = Buffer.from(text, "utf8").toString("base64");
    await runPowerShell(
      `$text=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedText}')); Add-Type -AssemblyName System.Speech; $speaker=New-Object System.Speech.Synthesis.SpeechSynthesizer; $speaker.Speak($text); $speaker.Dispose()`,
      signal,
    );
  }
}

export function createSpeechOutput(environment: NodeJS.ProcessEnv = process.env): SpeechOutput | undefined {
  return environment.DUCK_SPEECH === "1" ? new WindowsSpeechOutput() : undefined;
}

function runPython(scriptPath: string, stdin: string, signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("python", [scriptPath], { shell: false, windowsHide: true });
    const chunks: Buffer[] = [];
    let errorOutput = "";
    const abort = () => child.kill();
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer | string) => {
      errorOutput += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) {
        reject(abortError());
      } else if (code !== 0) {
        reject(new Error(errorOutput.trim() || `Speech synthesis exited with code ${code}.`));
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
    child.stdin.write(stdin, "utf8");
    child.stdin.end();
  });
}

export async function synthesizeDuckSpeech(text: string, signal?: AbortSignal): Promise<Buffer> {
  const boundedSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]);
  boundedSignal.throwIfAborted();
  const audio = await runPython(DUCK_SPEECH_SCRIPT, fitComment(text), boundedSignal);
  if (audio.length === 0 || audio.length % 2 !== 0 || audio.length > 22050 * 12 * 2) {
    throw new Error("Synthesized duck speech exceeds the device PCM buffer or is empty.");
  }
  return audio;
}

export class SerialSpeechOutput implements SpeechOutput {
  public constructor(
    private readonly transport: Pick<SerialTransport, "write" | "onLine" | "onDisconnect">,
    private readonly synthesize = synthesizeDuckSpeech,
  ) {}

  public async speak(text: string, signal?: AbortSignal, onReady?: () => void | Promise<void>): Promise<void> {
    signal?.throwIfAborted();
    const audio = await this.synthesize(text, signal);
    if (audio.length === 0 || audio.length % 2 !== 0 || audio.length > 22050 * 12 * 2) {
      throw new Error("Invalid duck PCM audio length.");
    }
    signal?.throwIfAborted();
    try {
      await this.exchange(`AUDIO|BEGIN=${audio.length}\n`, "0", 3_000, signal);
      await this.sendChunks(audio, signal);
      signal?.throwIfAborted();
      await onReady?.();
      signal?.throwIfAborted();
      await this.exchange("AUDIO|END\n", "DONE", audio.length / 32 + 5_000, signal);
    } catch (error) {
      await this.transport.write("AUDIO|CANCEL\n").catch(() => {});
      throw error;
    }
  }

  private sendChunks(audio: Buffer, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      let sent = 0;
      let acked = 0;
      let settled = false;
      let unsubscribe = () => {};
      let unsubscribeDisconnect = () => {};
      let timer: NodeJS.Timeout | undefined;
      const finish = (error?: Error) => {
        if (settled) { return; }
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        unsubscribeDisconnect();
        signal?.removeEventListener("abort", abort);
        if (error) { reject(error); } else { resolve(); }
      };
      const abort = () => finish(abortError());
      const armTimer = () => {
        clearTimeout(timer);
        timer = setTimeout(() => finish(new Error("Timed out waiting for duck audio acknowledgement.")), 3_000);
      };
      const pump = () => {
        while (!settled && sent < audio.length && sent - acked < AUDIO_CHUNK_BYTES * AUDIO_WINDOW_CHUNKS) {
          const chunk = audio.subarray(sent, sent + AUDIO_CHUNK_BYTES);
          sent += chunk.length;
          void this.transport.write(`AUDIO|DATA=${chunk.toString("hex")}\n`).catch((error: Error) => finish(error));
        }
      };
      unsubscribe = this.transport.onLine((response) => {
        const ack = response.replace(/[\r\n]+$/g, "");
        if (ack === "ACK|AUDIO=ERROR") {
          finish(new Error(`The duck rejected the audio transfer after ${acked} bytes.`));
          return;
        }
        const match = /^ACK\|AUDIO=(\d+)$/.exec(ack);
        const received = match ? Number(match[1]) : -1;
        if (received > acked && received <= sent) {
          acked = received;
          if (acked === audio.length) { finish(); return; }
          armTimer();
          pump();
        }
      });
      unsubscribeDisconnect = this.transport.onDisconnect?.(() => finish(new Error("Duck disconnected during speech."))) ?? (() => {});
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      armTimer();
      pump();
    });
  }

  private exchange(line: string, expected: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      let settled = false;
      let unsubscribe = () => {};
      let unsubscribeDisconnect = () => {};
      const finish = (error?: Error) => {
        if (settled) { return; }
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        unsubscribeDisconnect();
        signal?.removeEventListener("abort", abort);
        if (error) { reject(error); } else { resolve(); }
      };
      const abort = () => finish(abortError());
      const timer = setTimeout(() => finish(new Error("Timed out waiting for duck audio acknowledgement.")), timeoutMs);
      unsubscribe = this.transport.onLine((response) => {
        const ack = response.replace(/[\r\n]+$/g, "");
        if (ack === `ACK|AUDIO=${expected}`) { finish(); }
        else if (ack === "ACK|AUDIO=ERROR") { finish(new Error(`The duck rejected the audio transfer while awaiting ${expected}.`)); }
      });
      unsubscribeDisconnect = this.transport.onDisconnect?.(() => finish(new Error("Duck disconnected during speech."))) ?? (() => {});
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      void this.transport.write(line).catch((error: Error) => finish(error));
    });
  }
}

function uint16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function uint32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

export interface WavInfo {
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitsPerSample: number;
  readonly dataBytes: number;
  readonly durationSeconds: number;
}

export function validateWav(audio: Uint8Array): WavInfo {
  if (audio.byteLength > MAX_AUDIO_BYTES) {
    throw new Error(`Audio exceeds the ${MAX_AUDIO_BYTES}-byte limit.`);
  }
  if (audio.byteLength < 44 || new TextDecoder().decode(audio.slice(0, 4)) !== "RIFF" || new TextDecoder().decode(audio.slice(8, 12)) !== "WAVE") {
    throw new Error("Audio must be a RIFF/WAVE file.");
  }

  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  if (uint32(view, 4) + 8 !== view.byteLength) {
    throw new Error("Audio contains a truncated or inconsistent RIFF length.");
  }
  let offset = 12;
  let sampleRate: number | undefined;
  let channels: number | undefined;
  let bitsPerSample: number | undefined;
  let byteRate: number | undefined;
  let blockAlignment: number | undefined;
  let hasData = false;
  let dataBytes = 0;
  while (offset + 8 <= view.byteLength) {
    const chunk = new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset + offset, 4));
    const size = uint32(view, offset + 4);
    const content = offset + 8;
    if (content + size > view.byteLength) {
      throw new Error("Audio contains a truncated WAV chunk.");
    }
    if (chunk === "fmt ") {
      if (sampleRate !== undefined || size < 16) {
        throw new Error("Audio contains a duplicate or malformed PCM format chunk.");
      }
      if (uint16(view, content) !== 1) {
        throw new Error("Audio must use uncompressed PCM.");
      }
      channels = uint16(view, content + 2);
      sampleRate = uint32(view, content + 4);
      byteRate = uint32(view, content + 8);
      blockAlignment = uint16(view, content + 12);
      bitsPerSample = uint16(view, content + 14);
    } else if (chunk === "data") {
      if (hasData) {
        throw new Error("Audio contains duplicate sample chunks.");
      }
      hasData = true;
      dataBytes = size;
    }
    offset = content + size + (size % 2);
  }

  if (sampleRate !== EXPECTED_SAMPLE_RATE || channels !== EXPECTED_CHANNELS || bitsPerSample !== EXPECTED_BITS_PER_SAMPLE) {
    throw new Error("Audio must be mono 16 kHz, 16-bit PCM.");
  }
  if (dataBytes <= 0) {
    throw new Error("Audio contains no samples.");
  }
  const bytesPerSecond = EXPECTED_SAMPLE_RATE * EXPECTED_CHANNELS * (EXPECTED_BITS_PER_SAMPLE / 8);
  if (offset !== view.byteLength || byteRate !== bytesPerSecond || blockAlignment !== 2 || dataBytes % 2 !== 0) {
    throw new Error("Audio contains invalid PCM chunk or sample alignment.");
  }
  const durationSeconds = dataBytes / bytesPerSecond;
  if (durationSeconds > MAX_AUDIO_SECONDS) {
    throw new Error(`Audio exceeds the ${MAX_AUDIO_SECONDS}-second limit.`);
  }
  return { sampleRate, channels, bitsPerSample, dataBytes, durationSeconds };
}

function responseText(value: unknown): string | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const text = (value as Record<string, unknown>).text;
    return typeof text === "string" && text.trim() ? text.trim() : undefined;
  }
  return undefined;
}

export class OpenAICompatibleTranscriber implements SpeechTranscriber {
  public constructor(private readonly options: SpeechTranscriberOptions) {
    if (!options.endpoint.trim() || !options.model.trim() || !options.apiKey.trim()) {
      throw new Error("Speech transcription requires an endpoint, model, and API key.");
    }
  }

  public async transcribe(audio: Uint8Array, signal?: AbortSignal): Promise<string> {
    validateWav(audio);
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    signal?.addEventListener("abort", forwardAbort, { once: true });
    if (signal?.aborted) {
      controller.abort();
    }
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 30_000);
    try {
      const form = new FormData();
      form.append("file", new Blob([Uint8Array.from(audio)], { type: "audio/wav" }), "clarification.wav");
      form.append("model", this.options.model);
      if (this.options.language) {
        form.append("language", this.options.language);
      }
      const response = await fetch(this.options.endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.options.apiKey}` },
        body: form,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Speech transcription failed with HTTP ${response.status}.`);
      }
      const text = responseText(await response.json());
      if (!text) {
        throw new Error("Speech transcription returned no text.");
      }
      return text;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", forwardAbort);
    }
  }
}