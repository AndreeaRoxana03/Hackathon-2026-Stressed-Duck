import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkspaceToolHost, commandEnvironment } from "./workspace-tools.js";

test("workspace tools reject traversal, junction escapes, and secrets", async (testContext) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "duck-tools-"));
  testContext.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "root");
  const outside = path.join(parent, "outside");
  await mkdir(root);
  await mkdir(outside);
  await writeFile(path.join(outside, "data.txt"), "private");
  await writeFile(path.join(root, ".env"), "secret");
  await symlink(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
  const host = new WorkspaceToolHost(root);
  for (const requestedPath of ["../outside/data.txt", "escape/data.txt", ".env"]) {
    const result = await host.execute("read_file", { path: requestedPath });
    assert.ok(result.error, requestedPath);
    assert.doesNotMatch(result.content, /private/);
  }
  const search = await host.execute("search_files", { query: "secret" });
  assert.equal(JSON.parse(search.content).matches.length, 0);
});

test("proposals never write until accepted and reject any changed file", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "duck-proposal-"));
  testContext.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "code.txt");
  await writeFile(file, "before\nkeep");
  const host = new WorkspaceToolHost(root);
  const result = await host.execute("propose_edit", { path: "code.txt", oldText: "before", newText: "after" });
  assert.ok(result.proposal);
  await writeFile(file, "before\nuser changed another line");
  await assert.rejects(host.applyLastProposal(), /file changed/i);
});

test("pre-aborted tools never execute and child credentials are removed", async () => {
  const controller = new AbortController();
  controller.abort();
  const host = new WorkspaceToolHost(process.cwd());
  assert.ok((await host.execute("run_tests", { command: "npm test" }, controller.signal)).error);
  assert.deepEqual(commandEnvironment({ PATH: "safe", DUCK_STT_API_KEY: "secret", DUCK_BROKER_TOKEN: "secret" }), { PATH: "safe" });
});