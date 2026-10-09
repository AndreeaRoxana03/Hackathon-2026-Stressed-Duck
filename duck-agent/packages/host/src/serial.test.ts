import assert from "node:assert/strict";
import test from "node:test";
import { chooseSerialDevice, ReconnectingSerialTransport, type SerialTransport } from "./serial.js";

test("auto-selects one CoreS3 USB serial device", () => {
  assert.deepEqual(
    chooseSerialDevice([
      { path: "COM4", vendorId: "303a", productId: "1001", serialNumber: "board" },
    ]),
    { path: "COM4", vendorId: "303a", productId: "1001", serialNumber: "board" },
  );
});

test("requires explicit selection when multiple CoreS3 devices exist", () => {
  assert.equal(
    chooseSerialDevice([
      { path: "COM4", vendorId: "303A", productId: "1001" },
      { path: "COM5", vendorId: "303A", productId: "1001" },
    ]),
    null,
  );
  assert.equal(
    chooseSerialDevice(
      [
        { path: "COM4", vendorId: "303A", productId: "1001" },
        { path: "COM5", vendorId: "303A", productId: "1001" },
      ],
      "COM5",
    )?.path,
    "COM5",
  );
});

test("serial reconnect cancels ownership, discards old events, and closes cleanly", async (testContext) => {
  testContext.mock.timers.enable({ apis: ["setTimeout"] });
  class FakePort implements SerialTransport {
    public readonly writes: string[] = [];
    public closed = false;
    private readonly lines = new Set<(line: string) => void>();
    private readonly disconnects = new Set<() => void>();
    public async write(line: string) { this.writes.push(line); }
    public onLine(listener: (line: string) => void) { this.lines.add(listener); return () => this.lines.delete(listener); }
    public onDisconnect(listener: () => void) { this.disconnects.add(listener); return () => this.disconnects.delete(listener); }
    public emit(line: string) { for (const listener of this.lines) { listener(line); } }
    public disconnect() { for (const listener of this.disconnects) { listener(); } }
    public async close() { this.closed = true; }
  }
  const first = new FakePort();
  const second = new FakePort();
  const transport = new ReconnectingSerialTransport(first, async () => second);
  testContext.after(() => transport.close());
  const events: string[] = [];
  let disconnectCount = 0;
  transport.onLine((line) => events.push(line));
  transport.onDisconnect(() => { disconnectCount += 1; });
  first.emit("first");
  first.disconnect();
  first.emit("stale knock");
  await assert.rejects(transport.write("test"), /disconnected/);
  testContext.mock.timers.tick(1_000);
  for (let turn = 0; turn < 5; turn += 1) { await Promise.resolve(); }
  second.emit("fresh knock");
  assert.deepEqual(events, ["first", "fresh knock"]);
  assert.equal(disconnectCount, 1);
  assert.match(second.writes[0] ?? "", /MOOD=HAPPY.*FIX=\|EXPLAIN=/);
  await transport.close();
  assert.equal(second.closed, true);
});
