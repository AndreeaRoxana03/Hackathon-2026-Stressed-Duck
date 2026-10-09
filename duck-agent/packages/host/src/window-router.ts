import { randomUUID } from "node:crypto";
import type { BrokerWindowPoll } from "./broker.js";

interface RegisteredWindow extends BrokerWindowPoll {
  readonly lastSeen: number;
}

export class FocusedWindowRouter {
  private readonly windows = new Map<string, RegisteredWindow>();
  private capture: { id: string; windowId: string; expiresAt: number } | undefined;

  public constructor(private readonly now = Date.now) {}

  public heartbeat(request: BrokerWindowPoll): void {
    this.windows.set(request.windowId, { ...request, lastSeen: this.now() });
    for (const [id, window] of this.windows) {
      if (this.now() - window.lastSeen >= 6_000) {
        this.windows.delete(id);
      }
    }
  }

  public isAlive(windowId: string): boolean {
    const window = this.windows.get(windowId);
    return !!window?.trusted && this.now() - window.lastSeen < 6_000;
  }

  public isFocused(windowId: string): boolean {
    return this.isAlive(windowId) && this.windows.get(windowId)?.focused === true;
  }

  public requestContext(origin?: string): boolean {
    if (this.capture && this.capture.expiresAt > this.now()) {
      return false;
    }
    const eligible = [...this.windows.values()]
      .filter((window) => this.isFocused(window.windowId) && (!origin || window.windowId === origin))
      .sort((left, right) => right.lastSeen - left.lastSeen);
    const window = eligible[0];
    if (!window) {
      return false;
    }
    this.capture = { id: randomUUID(), windowId: window.windowId, expiresAt: this.now() + 4_000 };
    return true;
  }

  public pendingCapture(windowId: string): string | undefined {
    return this.capture?.windowId === windowId && this.capture.expiresAt > this.now() && this.isFocused(windowId)
      ? this.capture.id
      : undefined;
  }

  public consume(windowId: string, captureId: string): boolean {
    if (this.pendingCapture(windowId) !== captureId) {
      return false;
    }
    this.capture = undefined;
    return true;
  }

  public clear(): void {
    this.capture = undefined;
  }
}