import { encodeDuckResponse } from "./protocol.js";

export interface SerialDeviceInfo {
  readonly path: string;
  readonly vendorId?: string;
  readonly productId?: string;
  readonly serialNumber?: string;
}

export interface SerialPortSettings {
  readonly path: string;
  readonly baudRate: number;
}

export interface SerialTransport {
  write(line: string): Promise<void>;
  onLine(listener: (line: string) => void): () => void;
  onDisconnect?(listener: () => void): () => void;
  close(): Promise<void>;
}

export class ReconnectingSerialTransport implements SerialTransport {
    private readonly lineListeners = new Set<(line: string) => void>();
    private readonly disconnectListeners = new Set<() => void>();
    private current: SerialTransport | undefined;
    private unsubscribe: (() => void)[] = [];
    private timer: ReturnType<typeof setTimeout> | undefined;
    private closed = false;
    private backoffMs = 1_000;

    public constructor(initial: SerialTransport, private readonly connect: () => Promise<SerialTransport>) {
      this.attach(initial);
    }

    private attach(transport: SerialTransport): void {
      this.current = transport;
      this.backoffMs = 1_000;
      this.unsubscribe = [transport.onLine((line) => {
        if (this.current === transport && !this.closed) {
          for (const listener of this.lineListeners) { listener(line); }
        }
      })];
      if (transport.onDisconnect) {
        this.unsubscribe.push(transport.onDisconnect(() => {
          if (this.current !== transport || this.closed) { return; }
          this.current = undefined;
          this.unsubscribe.forEach((remove) => remove());
          void transport.close().catch(() => {});
          for (const listener of this.disconnectListeners) { listener(); }
          this.scheduleReconnect();
        }));
      }
    }

    private scheduleReconnect(): void {
      if (this.closed) { return; }
      this.timer = setTimeout(() => {
        void this.connect().then(async (transport) => {
          if (this.closed) { await transport.close(); return; }
          this.attach(transport);
          try {
            await transport.write(encodeDuckResponse({ mood: "HAPPY", comment: "Reconnected." }));
          } catch (error) {
            this.unsubscribe.forEach((remove) => remove());
            this.unsubscribe = [];
            this.current = undefined;
            await transport.close().catch(() => {});
            throw error;
          }
          if (this.closed) { await transport.close(); return; }
        }).catch(() => {
          this.backoffMs = Math.min(30_000, this.backoffMs * 2);
          this.scheduleReconnect();
        });
      }, this.backoffMs);
    }

    public async write(line: string): Promise<void> {
      if (!this.current || this.closed) { throw new Error("Serial device disconnected."); }
      await this.current.write(line);
    }

    public onLine(listener: (line: string) => void): () => void {
      this.lineListeners.add(listener);
      return () => this.lineListeners.delete(listener);
    }

    public onDisconnect(listener: () => void): () => void {
      this.disconnectListeners.add(listener);
      return () => this.disconnectListeners.delete(listener);
    }

    public async close(): Promise<void> {
      this.closed = true;
      clearTimeout(this.timer);
      this.unsubscribe.forEach((remove) => remove());
      this.lineListeners.clear();
      this.disconnectListeners.clear();
      await this.current?.close();
    }
  }
export const CORE_S3_USB_VENDOR_ID = "303A";
export const CORE_S3_USB_PRODUCT_ID = "1001";

function isCoreS3(device: SerialDeviceInfo): boolean {
  return (
    device.vendorId?.toUpperCase() === CORE_S3_USB_VENDOR_ID &&
    device.productId?.toUpperCase() === CORE_S3_USB_PRODUCT_ID
  );
}

export function chooseSerialDevice(
  devices: readonly SerialDeviceInfo[],
  configuredPort?: string,
): SerialDeviceInfo | null {
  if (configuredPort) {
    return devices.find((device) => device.path === configuredPort) ?? null;
  }

  const coreS3Devices = devices.filter(isCoreS3);
  return coreS3Devices.length === 1 ? coreS3Devices[0] : null;
}
