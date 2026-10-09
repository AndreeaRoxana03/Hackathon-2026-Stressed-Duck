import assert from "node:assert/strict";
import test from "node:test";
import { validateWav, createSpeechOutput, SerialSpeechOutput } from "./speech.js";
import { ClarificationSessions } from "./audio-server.js";

function wav(samples = 160): Buffer {
  const audio = Buffer.alloc(44 + samples * 2);
  audio.write("RIFF", 0);
  audio.writeUInt32LE(audio.length - 8, 4);
  audio.write("WAVEfmt ", 8);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(16000, 24);
  audio.writeUInt32LE(32000, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write("data", 36);
  audio.writeUInt32LE(samples * 2, 40);
  return audio;
}

test("validates bounded mono PCM speech clips", () => {
  assert.equal(validateWav(wav()).durationSeconds, 0.01);
  assert.throws(() => validateWav(wav(320001)), /20-second/);
  assert.throws(() => validateWav(Buffer.alloc(1048577)), /byte limit/);
  assert.throws(() => validateWav(wav().subarray(0, 45)), /truncated/);
  const stereo = wav();
  stereo.writeUInt16LE(2, 22);
  assert.throws(() => validateWav(stereo), /mono/);
  const wrongLength = wav();
  wrongLength.writeUInt32LE(0, 4);
  assert.throws(() => validateWav(wrongLength), /RIFF length/);
  const wrongAlignment = wav();
  wrongAlignment.writeUInt16LE(1, 32);
  assert.throws(() => validateWav(wrongAlignment), /alignment/);
  const oddSamples = wav();
  oddSamples.writeUInt32LE(319, 40);
  assert.throws(() => validateWav(oddSamples), /alignment/);
  const duplicate = Buffer.concat([wav(), Buffer.from("data"), Buffer.alloc(4)]);
  duplicate.writeUInt32LE(duplicate.length - 8, 4);
  assert.throws(() => validateWav(duplicate), /duplicate sample/);
  assert.equal(createSpeechOutput({}), undefined);
});

test("sends bounded device speech chunks and waits for playback completion", async () => {
  const listeners = new Set<(line: string) => void>();
  const writes: string[] = [];
  let received = 0;
  let ready = false;
  const audio = Buffer.alloc(600);
  const speech = new SerialSpeechOutput({
    async write(line) {
      writes.push(line);
      let ack = "0";
      if (line.startsWith("AUDIO|DATA=")) {
        assert.equal(ready, false);
        received += Buffer.from(line.slice(11).trim(), "hex").length;
        ack = String(received);
      } else if (line === "AUDIO|END\n") {
        assert.equal(ready, true);
        ack = "DONE";
      }
      for (const listener of listeners) { listener(`ACK|AUDIO=${ack}\n`); }
    },
    onLine(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  }, async () => audio);
  await speech.speak("The actual result.", undefined, () => {
    assert.equal(received, audio.length);
    assert.ok(writes.at(-1)?.startsWith("AUDIO|DATA="));
    ready = true;
  });
  assert.equal(writes[0], "AUDIO|BEGIN=600\n");
  assert.equal(writes.at(-1), "AUDIO|END\n");
  assert.equal(received, 600);
  assert.equal(writes.filter((line) => line.startsWith("AUDIO|DATA=")).length, 3);
  assert.ok(writes.every((line) => line.length <= 524));
  assert.equal(listeners.size, 0);
});

test("cancels device audio after a rejected chunk", async () => {
  let listener: ((line: string) => void) | undefined;
  const writes: string[] = [];
  let ready = false;
  const speech = new SerialSpeechOutput({
    async write(line) { writes.push(line); listener?.("ACK|AUDIO=ERROR"); },
    onLine(callback) { listener = callback; return () => { listener = undefined; }; },
  }, async () => Buffer.alloc(32));
  await assert.rejects(speech.speak("Result.", undefined, () => { ready = true; }), /rejected/);
  assert.equal(ready, false);
  assert.equal(writes.at(-1), "AUDIO|CANCEL\n");
});

test("clarification requires playback completion and rejects replayed audio", async () => {
  let now = 0;
  let expired = false;
  let transcript = "";
  const sessions = new ClarificationSessions({ async transcribe(audio) { validateWav(audio); return "Expected the result to be two."; } }, () => now);
  const session = sessions.begin("Speak what failed.", (text) => { transcript = text; }, () => { expired = true; });
  await assert.rejects(sessions.upload(session.id, wav()), /out-of-order/);
  assert.throws(() => sessions.playbackComplete("wrong-id"), /Invalid/);
  sessions.playbackComplete(session.id);
  await sessions.upload(session.id, wav());
  assert.equal(transcript, "Expected the result to be two.");
  await assert.rejects(sessions.upload(session.id, wav()), /replayed/);
  now = 60_001;
  assert.equal(sessions.getStatus()?.state, "cancelled");
  assert.equal(expired, true);
});

test("cancelled or expired clarification cannot deliver a late transcript", async () => {
  let now = 0;
  let delivered = false;
  let finish: ((text: string) => void) | undefined;
  const sessions = new ClarificationSessions({ transcribe: () => new Promise<string>((resolve) => { finish = resolve; }) }, () => now);
  const session = sessions.begin("Speak what failed.", () => { delivered = true; }, () => {});
  sessions.playbackComplete(session.id);
  const upload = sessions.upload(session.id, wav());
  sessions.cancel();
  finish?.("late transcript");
  await assert.rejects(upload, /cancelled/);
  assert.equal(delivered, false);
  const expired = sessions.begin("Speak what failed.", () => {}, () => {});
  now = 60_001;
  assert.throws(() => sessions.playbackComplete(expired.id), /expired/);
});