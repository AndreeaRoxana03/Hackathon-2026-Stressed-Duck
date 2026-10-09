import assert from "node:assert/strict";
import test from "node:test";
import { StaticTokenProvider } from "./auth.js";

test("returns a configured static bearer token", async () => {
  const provider = new StaticTokenProvider("token-123");
  assert.equal(await provider.getAccessToken(), "token-123");
  await provider.logout();
  assert.equal(await provider.getAccessToken(), "token-123");
});

test("rejects an empty static bearer token", () => {
  assert.throws(() => new StaticTokenProvider("  "), /non-empty access token/);
});