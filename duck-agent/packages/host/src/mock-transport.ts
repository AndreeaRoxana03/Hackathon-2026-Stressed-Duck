import type { SerialTransport } from "./serial.js";
import { parseDuckResponseLine } from "./protocol.js";

export class MockSerialTransport implements SerialTransport {
  public readonly writes: string[] = [];
  private readonly listeners = new Set<(line: string) => void>();

  public async write(line: string): Promise<void> {
    this.writes.push(line);
    console.log(`MOCK_DUCK_RECEIVED ${line.trim()}`);
    const response = parseDuckResponseLine(line);
    if (response) {
      queueMicrotask(() => this.emit(`ACK|MOOD=${response.mood}\n`));
    }
  }

  public onLine(listener: (line: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public emit(line: string): void {
    for (const listener of this.listeners) {
      listener(line);
    }
  }

  public async close(): Promise<void> {
    this.listeners.clear();
  }
}