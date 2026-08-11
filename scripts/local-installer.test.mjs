import assert from "node:assert/strict";
import test from "node:test";
import { homedir } from "node:os";

import { integrationPaths, parseArgs } from "./local-installer.mjs";

test("parses the documented local run command", () => {
  const options = parseArgs([
    "--cfos", "/tmp/cfos",
    "--state-dir", "/tmp/wwwk-state",
  ]);

  assert.deepEqual(options, {
    command: "run",
    cfos: "/tmp/cfos",
    stateDir: "/tmp/wwwk-state",
  });
});

test("parses disconnect without changing its state location", () => {
  const options = parseArgs([
    "disconnect",
    "--",
    "--cfos", "/tmp/cfos",
    "--state-dir", "/tmp/wwwk-state",
    "--dry-run",
  ]);

  assert.equal(options.command, "disconnect");
  assert.equal(options.dryRun, true);
  assert.equal(options.stateDir, "/tmp/wwwk-state");
});

test("derives a stable managed worktree outside the state directory", () => {
  const first = integrationPaths("/tmp/cfos", "/tmp/wwwk-state");
  const second = integrationPaths("/tmp/cfos", "/tmp/wwwk-state");

  assert.deepEqual(first, second);
  assert.equal(first.stateDir, "/tmp/wwwk-state");
  assert.match(first.integrationPath, /^\/tmp\/wwwk-state\.wwwk\/integrations\/cfos-/);
  assert.equal(first.metadataPath, "/tmp/wwwk-state.wwwk/local-installer.json");
});

test("rejects unsafe state directories and incomplete arguments", () => {
  assert.throws(() => integrationPaths("/tmp/cfos", "/"), /too broad/);
  assert.throws(() => integrationPaths("/tmp/cfos", homedir()), /too broad/);
  assert.throws(() => parseArgs(["--cfos"]), /require values/);
  assert.throws(() => parseArgs(["--unknown"]), /Unknown argument/);
});
