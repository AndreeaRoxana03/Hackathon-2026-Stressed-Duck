import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_COMMENT_LENGTH,
  encodeDuckResponse,
  fitComment,
  parseDuckResponseLine,
  parseFirmwareLine,
  sanitizeComment,
} from "./protocol.js";

test("recognizes only the firmware fist-slam event", () => {
  assert.deepEqual(parseFirmwareLine("EVENT:FIST_SLAM\r\n"), { type: "FIST_SLAM" });
  assert.equal(parseFirmwareLine("accel magnitude: 1.20 g\n"), null);
  assert.equal(parseFirmwareLine("EVENT:FIST_SLAM extra\n"), null);
});

test("sanitizes response comments without leaking wire delimiters", () => {
  assert.equal(sanitizeComment("a|b\n\tc"), "a b c");
  const response = encodeDuckResponse({ mood: "COOL", comment: "a|b\n\tc" });
  assert.equal(response, "RESP|MOOD=COOL|COMMENT=a b c|FIX=|EXPLAIN=\n");
});

test("bounds long comments at a readable boundary", () => {
  const comment = fitComment("This is a complete sentence. " + "details ".repeat(40));
  assert.ok(comment.length <= MAX_COMMENT_LENGTH);
  assert.match(comment, /[.!?]|\.\.\.$/);
});

test("keeps technical response fields empty", () => {
  const response = encodeDuckResponse({ mood: "HAPPY", comment: "Idle" });
  assert.match(response, /\|FIX=\|EXPLAIN=\n$/);
});

test("parses only compatible duck response lines", () => {
  assert.deepEqual(parseDuckResponseLine("RESP|MOOD=COOL|COMMENT=Found it.|FIX=|EXPLAIN=\r\n"), {
    type: "DUCK_RESPONSE",
    mood: "COOL",
    comment: "Found it.",
    fix: "",
    explain: "",
  });
  assert.equal(parseDuckResponseLine("RESP|MOOD=COOL|COMMENT=code|FIX=diff|EXPLAIN="), null);
  assert.equal(parseDuckResponseLine("RESP|MOOD=COOL|COMMENT=bad|FIX=|EXPLAIN=extra"), null);
});
