import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { access, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import compatibility from "../installer/compatibility.json" with {type: "json"};

const scriptDir = dirname(fileURLToPath(import.meta.url));
const wwwkRoot = resolve(scriptDir, "..");
const officialCfosRemotes = new Set([
  "https://github.com/cloudflare/cloudflare-os.git",
  "git@github.com:cloudflare/cloudflare-os.git",
  "ssh://git@github.com/cloudflare/cloudflare-os.git",
]);
const metadataFile = "local-installer.json";

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
  if (values[0] === "disconnect") options.command = values.shift();
  if (values[0] === "--") values.shift();
  while (values.length > 0) {
    const value = values.shift();
    if (value === "--cfos") options.cfos = values.shift();
    else if (value === "--state-dir") options.stateDir = values.shift();
    else if (value === "--dry-run") options.dryRun = true;
    else fail(`Unknown argument ${value}.`);
  }
  if (!options.cfos || !options.stateDir) fail("--cfos and --state-dir require values.");
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
  if (!dryRun) await removeManagedWorktree(cfosRoot, paths);
  return {cfosRoot, paths, dryRun};
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = options.command === "disconnect"
    ? await disconnectLocal(options)
    : await prepareIntegration(options);
  if (result.dryRun || options.command === "disconnect") return;
  await run("pnpm", ["run", "dev-server", "--", "--persist-to", result.paths.stateDir], {
    cwd: result.paths.integrationPath,
    stdio: "inherit",
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
