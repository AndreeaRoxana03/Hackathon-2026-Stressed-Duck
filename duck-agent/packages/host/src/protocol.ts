export const SERIAL_BAUD_RATE = 115200;
export const MAX_COMMENT_LENGTH = 160;
export const MAX_SERIAL_LINE_BYTES = 1024;

export const DUCK_MOODS = ["HAPPY", "STRESSED", "COOL"] as const;
export type DuckMood = (typeof DUCK_MOODS)[number];

export interface FistSlamEvent {
  readonly type: "FIST_SLAM";
}

export interface DuckAckEvent {
  readonly type: "DUCK_ACK";
  readonly mood: DuckMood;
}

export interface DuckHostTimeoutEvent {
  readonly type: "HOST_TIMEOUT";
}

export type FirmwareEvent = FistSlamEvent | DuckAckEvent | DuckHostTimeoutEvent;

export interface DuckResponseLine {
  readonly type: "DUCK_RESPONSE";
  readonly mood: DuckMood;
  readonly comment: string;
  readonly fix: "";
  readonly explain: "";
}

export interface DuckResponse {
  readonly mood: DuckMood;
  readonly comment: string;
  readonly fix: "";
  readonly explain: "";
}

const COMMENT_FALLBACK = "Details are in your editor.";

export function parseFirmwareLine(line: string): FirmwareEvent | null {
  const withoutTerminator = line.replace(/[\r\n]+$/g, "");
  if (Buffer.byteLength(withoutTerminator, "utf8") > MAX_SERIAL_LINE_BYTES) {
    return null;
  }
  if (withoutTerminator === "EVENT:FIST_SLAM") {
    return { type: "FIST_SLAM" };
  }
  if (withoutTerminator === "EVENT:HOST_TIMEOUT") {
    return { type: "HOST_TIMEOUT" };
  }
  const ack = withoutTerminator.match(/^ACK\|MOOD=(HAPPY|STRESSED|COOL)$/);
  return ack ? { type: "DUCK_ACK", mood: ack[1] as DuckMood } : null;
}

export function parseDuckResponseLine(line: string): DuckResponseLine | null {
  const withoutTerminator = line.replace(/[\r\n]+$/g, "");
  if (Buffer.byteLength(withoutTerminator, "utf8") > MAX_SERIAL_LINE_BYTES) {
    return null;
  }
  const match = withoutTerminator.match(/^RESP\|MOOD=(HAPPY|STRESSED|COOL)\|COMMENT=([^|]*)\|FIX=\|EXPLAIN=$/);
  if (!match) {
    return null;
  }
  if ((match[2] ?? "").length > MAX_COMMENT_LENGTH) {
    return null;
  }
  return {
    type: "DUCK_RESPONSE",
    mood: match[1] as DuckMood,
    comment: match[2] ?? "",
    fix: "",
    explain: "",
  };
}

export function sanitizeComment(comment: string): string {
  return comment
    .replace(/\|/g, " ")
    .replace(/[^\x20-\x7E]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function fitComment(comment: string): string {
  const sanitized = sanitizeComment(comment);
  if (sanitized.length <= MAX_COMMENT_LENGTH) {
    return sanitized || COMMENT_FALLBACK;
  }

  const sentenceEnd = Math.max(
    sanitized.lastIndexOf(".", MAX_COMMENT_LENGTH - 1),
    sanitized.lastIndexOf("!", MAX_COMMENT_LENGTH - 1),
    sanitized.lastIndexOf("?", MAX_COMMENT_LENGTH - 1),
  );
  if (sentenceEnd >= 1) {
    return sanitized.slice(0, sentenceEnd + 1).trim();
  }

  const wordEnd = sanitized.lastIndexOf(" ", MAX_COMMENT_LENGTH - 4);
  if (wordEnd >= 1) {
    return `${sanitized.slice(0, wordEnd).trim()}...`;
  }

  return COMMENT_FALLBACK;
}

export function encodeDuckResponse(input: {
  readonly mood: DuckMood;
  readonly comment: string;
}): string {
  const response: DuckResponse = {
    mood: input.mood,
    comment: fitComment(input.comment),
    fix: "",
    explain: "",
  };

  return `RESP|MOOD=${response.mood}|COMMENT=${response.comment}|FIX=|EXPLAIN=\n`;
}
