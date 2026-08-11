import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import test from "node:test";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

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

test("derives a stable managed worktree outside the state directory", async t => {
  const root = await mkdtemp(join(tmpdir(), "wwwk-local-installer-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const cfosRoot = join(root, "cfos");
  const stateDir = join(root, "state");
  await mkdir(cfosRoot);
  await mkdir(stateDir);
  const canonicalCfosRoot = await realpath(cfosRoot);
  const canonicalStateDir = await realpath(stateDir);
  const first = await integrationPaths(canonicalCfosRoot, stateDir);
  const second = await integrationPaths(canonicalCfosRoot, stateDir);

  assert.deepEqual(first, second);
  assert.equal(first.stateDir, canonicalStateDir);
  assert.equal(
    first.integrationPath.startsWith(`${canonicalStateDir}.wwwk/integrations/cfos-`),
    true,
  );
  assert.equal(first.metadataPath, `${canonicalStateDir}.wwwk/local-installer.json`);
});

test("rejects unsafe state directories and incomplete arguments", async () => {
  await assert.rejects(integrationPaths("/tmp/cfos", "/"), /too broad/);
  await assert.rejects(integrationPaths("/tmp/cfos", homedir()), /too broad/);
  assert.throws(() => parseArgs(["--cfos"]), /require values/);
  assert.throws(() => parseArgs(["--unknown"]), /Unknown argument/);
});

test("rejects a state symlink that resolves into the CFOS checkout", async t => {
  const root = await mkdtemp(join(tmpdir(), "wwwk-local-installer-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const cfosRoot = join(root, "cfos");
  const stateParent = join(root, "state");
  const stateLink = join(stateParent, "link");
  await mkdir(cfosRoot);
  await mkdir(stateParent);
  await symlink(cfosRoot, stateLink);

  await assert.rejects(
    integrationPaths(await realpath(cfosRoot), stateLink),
    /State must be outside the CFOS checkout/,
  );
});
