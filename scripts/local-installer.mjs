import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { access, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";

import compatibility from "../installer/compatibility.json" with {type: "json"};

const scriptDir = dirname(fileURLToPath(import.meta.url));
const wwwkRoot = resolve(scriptDir, "..");
const officialCfosRemotes = new Set([
  "https://github.com/cloudflare/cloudflare-os.git",
  "git@github.com:cloudflare/cloudflare-os.git",
  "ssh://git@github.com/cloudflare/cloudflare-os.git",
]);
const metadataFile = "local-installer.json";
const runnerFile = "local-runner.json";
const localWwwkWorker = "gatekeeper-wwwk";
const localWwwkClasses = ["WwwkLibrary", "WwwkGatekeeper"];

function fail(message) {
  throw new Error(`Local installer: ${message}`);
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    if (child.stdout) child.stdout.on("data", chunk => stdout.push(chunk));
    if (child.stderr) child.stderr.on("data", chunk => stderr.push(chunk));
    child.on("error", error => rejectRun(error));
    child.on("close", code => {
      const result = {
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (result.code === 0) resolveRun(result);
      else rejectRun(Object.assign(new Error(`${command} exited with ${result.code}.`), result));
    });
  });
}

async function git(cwd, args) {
  try {
    return await run("git", args, {cwd});
  } catch (error) {
    fail(`Git verification failed (${args[0]}).`);
  }
}

async function gitText(cwd, args) {
  return (await git(cwd, args)).stdout.trim();
}

function isWithin(child, parent) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function requireSafeDirectory(path, label) {
  const resolved = resolve(path);
  if (resolved === resolve("/") || resolved === homedir()) {
    fail(`${label} is too broad.`);
  }
  return resolved;
}

async function canonicalPath(path, label) {
  const resolved = requireSafeDirectory(path, label);
  let ancestor = resolved;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) fail(`${label} cannot be resolved.`);
    ancestor = parent;
  }
  let canonicalAncestor;
  try {
    canonicalAncestor = await realpath(ancestor);
  } catch {
    fail(`${label} cannot be resolved.`);
  }
  return requireSafeDirectory(
    resolve(canonicalAncestor, relative(ancestor, resolved)),
    label,
  );
}

async function canonicalExistingDirectory(path, label) {
  try {
    return await realpath(path);
  } catch {
    fail(`${label} does not exist.`);
  }
}

function defaultStateDir(environment = process.env) {
  const stateHome = environment.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(stateHome, "wwwk", "local");
}

export function parseArgs(argv) {
  const options = {command: "run", stateDir: defaultStateDir()};
  const values = [...argv];
  if (["disconnect", "erase"].includes(values[0])) options.command = values.shift();
  if (values[0] === "--") values.shift();
  while (values.length > 0) {
    const value = values.shift();
    if (value === "--cfos") options.cfos = values.shift();
    else if (value === "--state-dir") options.stateDir = values.shift();
    else if (value === "--dry-run") options.dryRun = true;
    else if (value === "--apply") options.apply = true;
    else fail(`Unknown argument ${value}.`);
  }
  if (!options.cfos || !options.stateDir) fail("--cfos and --state-dir require values.");
  if (options.apply && options.command !== "erase") {
    fail("--apply is only valid for data erasure.");
  }
  return options;
}

export async function integrationPaths(cfosRoot, stateDir) {
  const safeStateDir = await canonicalPath(stateDir, "State directory");
  const managedRoot = await canonicalPath(`${safeStateDir}.wwwk`, "Managed state directory");
  const key = createHash("sha256").update(cfosRoot).digest("hex").slice(0, 16);
  const integrationPath = await canonicalPath(
    join(managedRoot, "integrations", `cfos-${key}`),
    "Integration path",
  );
  if (
    isWithin(safeStateDir, cfosRoot) ||
    isWithin(managedRoot, cfosRoot) ||
    isWithin(integrationPath, cfosRoot)
  ) {
    fail("State must be outside the CFOS checkout.");
  }
  return {
    stateDir: safeStateDir,
    managedRoot,
    metadataPath: join(managedRoot, metadataFile),
    runnerPath: join(managedRoot, runnerFile),
    integrationPath,
  };
}

async function hasFiles(path) {
  try {
    return (await readdir(path)).length > 0;
  } catch {
    return false;
  }
}

async function loadMetadata(path) {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    fail("Managed state metadata is invalid.");
  }
}

function expectedMetadata(cfosRoot, paths) {
  return {
    format: 1,
    cfosRoot,
    cfosRevision: compatibility.cfos.baseRevision,
    wwwkRevision: compatibility.wwwk.baseRevision,
    stateDir: paths.stateDir,
  };
}

function matchesMetadata(actual, expected) {
  return actual && Object.entries(expected).every(([key, value]) => actual[key] === value);
}

async function verifyCfos(cfosPath) {
  const input = await canonicalExistingDirectory(cfosPath, "CFOS checkout");
  const root = await gitText(input, ["rev-parse", "--show-toplevel"]);
  if (root !== input) fail("--cfos must name the CFOS repository root.");
  if (!officialCfosRemotes.has(await gitText(root, ["remote", "get-url", "origin"]))) {
    fail("CFOS origin is not the supported official repository.");
  }
  if ((await gitText(root, ["rev-parse", "HEAD"])) !== compatibility.cfos.baseRevision) {
    fail("Unsupported CFOS revision.");
  }
  if ((await gitText(root, ["status", "--porcelain=v1", "--untracked-files=all"])) !== "") {
    fail("CFOS checkout is not clean.");
  }
  return root;
}

async function verifyWwwkRuntime() {
  await gitText(wwwkRoot, ["cat-file", "-e", `${compatibility.wwwk.baseRevision}^{commit}`]);
}

async function verifyState(cfosRoot, paths, dryRun) {
  if (
    isWithin(paths.stateDir, cfosRoot) ||
    isWithin(paths.managedRoot, cfosRoot) ||
    isWithin(paths.integrationPath, cfosRoot)
  ) {
    fail("State must be outside the CFOS checkout.");
  }
  const expected = expectedMetadata(cfosRoot, paths);
  const metadata = await loadMetadata(paths.metadataPath);
  if (metadata && !matchesMetadata(metadata, expected)) {
    fail("Managed state belongs to a different integration.");
  }
  if (!metadata && await hasFiles(paths.stateDir)) {
    fail("State ownership is unknown.");
  }
  if (!metadata && !dryRun) {
    await mkdir(paths.managedRoot, {recursive: true});
    await writeFile(paths.metadataPath, `${JSON.stringify(expected, null, 2)}\n`);
  }
  return expected;
}

async function registeredWorktrees(cfosRoot) {
  const output = await gitText(cfosRoot, ["worktree", "list", "--porcelain"]);
  return output.split("\n")
    .filter(line => line.startsWith("worktree "))
    .map(line => line.slice("worktree ".length));
}

async function loadStateLease(path) {
  if (!existsSync(path)) return undefined;
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0) {
    fail("Local runner marker is not an owner-only regular file.");
  }
  let marker;
  try {
    marker = JSON.parse(await readFile(path, "utf8"));
  } catch {
    fail("Local runner marker is invalid.");
  }
  if (
    marker?.format !== 1 ||
    !["run", "erase"].includes(marker.operation) ||
    !Number.isSafeInteger(marker.pid) ||
    marker.pid <= 0
  ) {
    fail("Local runner marker is invalid.");
  }
  return marker;
}

export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

export async function assertLocalRunnerStopped(paths) {
  const lease = await loadStateLease(paths.runnerPath);
  if (lease !== undefined && isProcessAlive(lease.pid)) {
    fail("Local state is already in use.");
  }
}

export async function withLocalStateLease(paths, operation, callback) {
  if (!["run", "erase"].includes(operation)) fail("Local state operation is invalid.");
  const staleLease = await loadStateLease(paths.runnerPath);
  if (staleLease !== undefined) {
    if (isProcessAlive(staleLease.pid)) fail("Local state is already in use.");
    await rm(paths.runnerPath);
  }
  try {
    await writeFile(
      paths.runnerPath,
      `${JSON.stringify({format: 1, operation, pid: process.pid})}\n`,
      {mode: 0o600, flag: "wx"},
    );
  } catch (error) {
    if (error?.code === "EEXIST") fail("Local state is already in use.");
    throw error;
  }
  try {
    return await callback();
  } finally {
    await rm(paths.runnerPath, {force: true});
  }
}

async function assertLocalDisconnected(cfosRoot, paths) {
  if (
    existsSync(paths.integrationPath) ||
    (await registeredWorktrees(cfosRoot)).includes(paths.integrationPath)
  ) {
    fail("Disconnect WWWK and stop local CFOS before data erasure.");
  }
}

export function localWwwkNamespacePaths(stateDir) {
  // 対応対象のWrangler 4.119.0では、DO namespace keyはWorker名とclass名から決まる。
  const root = resolve(stateDir, "v3", "do");
  return localWwwkClasses.map(className =>
    join(root, `${localWwwkWorker}-${className}`));
}

async function realDirectoryOrAbsent(path, label) {
  let entry;
  try {
    entry = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    fail(`${label} must be a real directory.`);
  }
  return true;
}

export async function removeLocalWwwkData(stateDir) {
  const root = requireSafeDirectory(
    await canonicalExistingDirectory(stateDir, "State directory"),
    "State directory",
  );
  const versionRoot = join(root, "v3");
  const durableObjectRoot = join(versionRoot, "do");
  if (!await realDirectoryOrAbsent(versionRoot, "Wrangler v3 state")) return [];
  if (!await realDirectoryOrAbsent(durableObjectRoot, "Durable Object state")) return [];

  const removed = [];
  for (const target of localWwwkNamespacePaths(root)) {
    if (!isWithin(target, durableObjectRoot)) fail("Local WWWK namespace is outside state.");
    if (!await realDirectoryOrAbsent(target, "Local WWWK namespace")) continue;
    await rm(target, {recursive: true});
    removed.push(target);
  }
  return removed;
}

async function confirmLocalErase(input = process.stdin, output = process.stdout) {
  if (!input.isTTY || !output.isTTY) {
    fail("Data erasure requires an interactive confirmation.");
  }
  const expected = "erase local WWWK";
  const readline = createInterface({input, output});
  try {
    const answer = await readline.question(`Type \"${expected}\" to continue: `);
    if (answer.trim() !== expected) fail("Data erasure was not confirmed.");
  } finally {
    readline.close();
  }
}

function printLocalErasePlan(paths) {
  console.log("Local WWWK data erasure plan");
  console.log("- export is not performed; export required data before continuing");
  console.log("- all local CFOS processes must be stopped");
  for (const target of localWwwkNamespacePaths(paths.stateDir)) {
    console.log(`- delete Durable Object namespace: ${target}`);
  }
  console.log("- preserve CFOS, other Gatekeepers, KV, R2, and the rest of local state");
  console.log("- deleted SQLite data cannot be recovered by WWWK");
}

export async function eraseLocal({cfos, stateDir, dryRun = false, apply = false}) {
  const cfosRoot = await verifyCfos(cfos);
  const paths = await integrationPaths(cfosRoot, stateDir);
  const metadata = await loadMetadata(paths.metadataPath);
  if (!matchesMetadata(metadata, expectedMetadata(cfosRoot, paths))) {
    fail("Managed state ownership cannot be verified.");
  }
  await assertLocalRunnerStopped(paths);
  await assertLocalDisconnected(cfosRoot, paths);
  printLocalErasePlan(paths);
  if (dryRun || !apply) return {cfosRoot, paths, dryRun: true};
  await confirmLocalErase();
  const removed = await withLocalStateLease(paths, "erase", async () => {
    await assertLocalDisconnected(cfosRoot, paths);
    return removeLocalWwwkData(paths.stateDir);
  });
  return {cfosRoot, paths, applied: true, removed};
}

async function removeManagedWorktree(cfosRoot, paths) {
  if (!existsSync(paths.integrationPath)) return;
  if (!isWithin(paths.integrationPath, paths.managedRoot)) {
    fail("Integration path is outside the managed directory.");
  }
  if (!(await registeredWorktrees(cfosRoot)).includes(paths.integrationPath)) {
    fail("Existing integration path is not a registered Git worktree.");
  }
  await git(cfosRoot, ["worktree", "remove", "--force", paths.integrationPath]);
}

async function applyPatch(cfosRoot, integrationPath, patch) {
  const patchPath = join(wwwkRoot, "installer", patch);
  await access(patchPath);
  await git(integrationPath, ["apply", "--unidiff-zero", "--check", patchPath]);
  await git(integrationPath, ["apply", "--unidiff-zero", patchPath]);
}

async function materializeRuntime(integrationPath) {
  const paths = (await gitText(wwwkRoot, [
    "ls-tree", "-r", "--name-only", compatibility.wwwk.baseRevision,
  ])).split("\n").filter(Boolean).filter(path =>
    path === "package.json" ||
    path === "pnpm-lock.yaml" ||
    path === "tsconfig.json" ||
    path === "wrangler.jsonc" ||
    path === "worker-configuration.d.ts" ||
    path.startsWith("src/") ||
    path.startsWith("skills/"),
  );
  const destination = join(integrationPath, "packages", "gatekeeper-wwwk");
  for (const path of paths) {
    const target = join(destination, path);
    await mkdir(dirname(target), {recursive: true});
    const content = await run("git", ["show", `${compatibility.wwwk.baseRevision}:${path}`], {
      cwd: wwwkRoot,
    });
    await writeFile(target, content.stdout);
  }
}

async function verifyBindings(integrationPath) {
  const workshopConfig = await readFile(
    join(integrationPath, "packages", "workshop-backend", "wrangler.jsonc"), "utf8",
  );
  const wwwkConfig = await readFile(
    join(integrationPath, "packages", "gatekeeper-wwwk", "wrangler.jsonc"), "utf8",
  );
  const workerName = workshopConfig.match(/"name"\s*:\s*"([^"]+)"/)?.[1];
  const broker = wwwkConfig.match(
    /"binding"\s*:\s*"CFOS_SOURCE_ACCESS_BROKER"[\s\S]*?"service"\s*:\s*"([^"]+)"[\s\S]*?"entrypoint"\s*:\s*"SourceAccessBroker"/,
  )?.[1];
  if (!workerName || broker !== workerName) fail("Generated service bindings are inconsistent.");
  await writeFile(join(integrationPath, ".wwwk-local-integration.json"), `${JSON.stringify({
    format: 1,
    workshopWorkerName: workerName,
    workshopBinding: "GATEKEEPER_WWWK",
    workshopEntrypoint: "GatekeeperVendor",
    wwwkBinding: "CFOS_SOURCE_ACCESS_BROKER",
    wwwkEntrypoint: "SourceAccessBroker",
  }, null, 2)}\n`);
}

async function installDependencies(integrationPath) {
  const lockfile = join(wwwkRoot, "installer", compatibility.cfos.lockfile);
  await access(lockfile);
  await writeFile(join(integrationPath, "pnpm-lock.yaml"), await readFile(lockfile));
  await run("pnpm", ["install", "--frozen-lockfile"], {cwd: integrationPath, stdio: "inherit"});
}

export async function prepareIntegration({cfos, stateDir, dryRun = false}) {
  const cfosRoot = await verifyCfos(cfos);
  await verifyWwwkRuntime();
  const paths = await integrationPaths(cfosRoot, stateDir);
  await verifyState(cfosRoot, paths, dryRun);
  if (dryRun) return {cfosRoot, paths, dryRun: true};

  await removeManagedWorktree(cfosRoot, paths);
  await mkdir(dirname(paths.integrationPath), {recursive: true});
  await git(cfosRoot, [
    "worktree", "add", "--detach", paths.integrationPath, compatibility.cfos.baseRevision,
  ]);
  await applyPatch(cfosRoot, paths.integrationPath, compatibility.cfos.patch);
  await applyPatch(cfosRoot, paths.integrationPath, compatibility.cfos.localPatch);
  await materializeRuntime(paths.integrationPath);
  await verifyBindings(paths.integrationPath);
  await installDependencies(paths.integrationPath);
  return {cfosRoot, paths, dryRun: false};
}

export async function disconnectLocal({cfos, stateDir, dryRun = false}) {
  const cfosRoot = await verifyCfos(cfos);
  const paths = await integrationPaths(cfosRoot, stateDir);
  const metadata = await loadMetadata(paths.metadataPath);
  if (!matchesMetadata(metadata, expectedMetadata(cfosRoot, paths))) {
    fail("Managed state ownership cannot be verified.");
  }
  await assertLocalRunnerStopped(paths);
  if (!dryRun) await removeManagedWorktree(cfosRoot, paths);
  return {cfosRoot, paths, dryRun};
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = options.command === "disconnect"
    ? await disconnectLocal(options)
    : options.command === "erase"
      ? await eraseLocal(options)
      : await prepareIntegration(options);
  if (result.dryRun || options.command !== "run") return;
  await withLocalStateLease(result.paths, "run", () =>
    run("pnpm", ["run", "dev-server", "--", "--persist-to", result.paths.stateDir], {
      cwd: result.paths.integrationPath,
      stdio: "inherit",
    }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
