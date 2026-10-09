import { spawn } from "node:child_process";

const MAX_AUDIO_BYTES = 1_048_576;
const MAX_AUDIO_SECONDS = 20;
const EXPECTED_SAMPLE_RATE = 16_000;
const EXPECTED_CHANNELS = 1;
const EXPECTED_BITS_PER_SAMPLE = 16;

export interface SpeechOutput {
  speak(text: string, signal?: AbortSignal): Promise<void>;
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