import { ReadlineParser } from "@serialport/parser-readline";
import { SerialPort } from "serialport";
import type { SerialDeviceInfo, SerialPortSettings, SerialTransport } from "./serial.js";

export async function listSerialDevices(): Promise<SerialDeviceInfo[]> {
  const devices = await SerialPort.list();
  return devices.map((device) => ({
    path: device.path,
    vendorId: device.vendorId,
    productId: device.productId,
    serialNumber: device.serialNumber,
  }));
}

class SerialPortTransport implements SerialTransport {
  private readonly listeners = new Set<(line: string) => void>();
  private readonly disconnectListeners = new Set<() => void>();
  private disconnected = false;

  public constructor(
    private readonly port: SerialPort,
    parser: ReadlineParser,
  ) {
    const disconnect = () => {
      if (!this.disconnected) {
        this.disconnected = true;
        for (const listener of this.disconnectListeners) { listener(); }
      }
    };
    port.on("error", disconnect);
    port.on("close", disconnect);
    parser.on("data", (line: string | Buffer) => {
      const text = typeof line === "string" ? line : line.toString("utf8");
      for (const listener of this.listeners) {
        listener(text);
      }
    });
  }

  public write(line: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.port.isOpen) {
        reject(new Error("Serial port is not open"));
        return;
      }
      this.port.write(line, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  public onLine(listener: (line: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  public close(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.port.isOpen) {
        resolve();
        return;
      }
      this.port.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

export function openSerialTransport(settings: SerialPortSettings): Promise<SerialTransport> {
  const port = new SerialPort({
    path: settings.path,
    baudRate: settings.baudRate,
    autoOpen: false,
  });
  const parser = port.pipe(new ReadlineParser({ delimiter: "\n" }));
  const transport = new SerialPortTransport(port, parser);

  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      port.removeListener("open", onOpen);
      reject(error);
    };
    const onOpen = (): void => {
      port.removeListener("error", onError);
      port.flush((error) => {
        if (error) {
          void transport.close().catch(() => {});
          reject(error);
        } else {
          resolve(transport);
        }
      });
    };

    port.once("error", onError);
    port.once("open", onOpen);
    port.open();
  });
}
