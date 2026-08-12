import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import test from "node:test";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  integrationPaths,
  assertLocalRunnerStopped,
  isProcessAlive,
  withLocalStateLease,
  localWwwkNamespacePaths,
  parseArgs,
  removeLocalWwwkData,
} from "./local-installer.mjs";

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

test("parses explicit local data erasure", () => {
  const options = parseArgs([
    "erase",
    "--cfos", "/tmp/cfos",
    "--state-dir", "/tmp/wwwk-state",
    "--apply",
  ]);

  assert.equal(options.command, "erase");
  assert.equal(options.apply, true);
  assert.throws(
    () => parseArgs(["--cfos", "/tmp/cfos", "--state-dir", "/tmp/state", "--apply"]),
    /only valid for data erasure/,
  );
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

test("removes only the two local WWWK Durable Object namespaces", async t => {
  const stateDir = await mkdtemp(join(tmpdir(), "wwwk-local-data-"));
  t.after(() => rm(stateDir, {recursive: true, force: true}));
  const canonicalStateDir = await realpath(stateDir);
  const [library, gatekeeper] = localWwwkNamespacePaths(canonicalStateDir);
  const otherDurableObject = join(canonicalStateDir, "v3", "do", "other-worker-Object");
  const kv = join(canonicalStateDir, "v3", "kv", "shared");
  for (const directory of [library, gatekeeper, otherDurableObject, kv]) {
    await mkdir(directory, {recursive: true});
    await writeFile(join(directory, "sentinel"), "fixture");
  }

  assert.deepEqual(await removeLocalWwwkData(stateDir), [library, gatekeeper]);
  await assert.rejects(lstat(library), /ENOENT/);
  await assert.rejects(lstat(gatekeeper), /ENOENT/);
  await assert.doesNotReject(lstat(otherDurableObject));
  await assert.doesNotReject(lstat(kv));
});

test("rejects symlinked local WWWK namespace state", async t => {
  const root = await mkdtemp(join(tmpdir(), "wwwk-local-data-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const stateDir = join(root, "state");
  const outside = join(root, "outside");
  const [library] = localWwwkNamespacePaths(stateDir);
  await mkdir(join(stateDir, "v3", "do"), {recursive: true});
  await mkdir(outside);
  await symlink(outside, library);

  await assert.rejects(removeLocalWwwkData(stateDir), /must be a real directory/);
  await assert.doesNotReject(lstat(outside));
});

test("rejects data erasure while the managed local runner is alive", async t => {
  const root = await mkdtemp(join(tmpdir(), "wwwk-local-runner-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const marker = join(root, "local-runner.json");
  await writeFile(marker, `${JSON.stringify({
    format: 1,
    operation: "run",
    pid: process.pid,
  })}\n`, {
    mode: 0o600,
  });

  assert.equal(isProcessAlive(process.pid), true);
  await assert.rejects(
    assertLocalRunnerStopped({runnerPath: marker}),
    /already in use/,
  );
});

test("accepts a stale owner-only local runner marker", async t => {
  const root = await mkdtemp(join(tmpdir(), "wwwk-local-runner-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const marker = join(root, "local-runner.json");
  await writeFile(marker, `${JSON.stringify({
    format: 1,
    operation: "run",
    pid: 2_147_483_647,
  })}\n`, {
    mode: 0o600,
  });

  await assert.doesNotReject(assertLocalRunnerStopped({runnerPath: marker}));
});

test("serializes local run and data erasure with one state lease", async t => {
  const root = await mkdtemp(join(tmpdir(), "wwwk-local-runner-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const paths = {runnerPath: join(root, "local-runner.json")};

  await withLocalStateLease(paths, "erase", async () => {
    await assert.rejects(
      withLocalStateLease(paths, "run", async () => {}),
      /already in use/,
    );
  });
  await assert.rejects(lstat(paths.runnerPath), /ENOENT/);
});
