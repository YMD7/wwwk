import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import compatibility from "../installer/compatibility.json" with {type: "json"};

const scriptDir = dirname(fileURLToPath(import.meta.url));
const wwwkRoot = resolve(scriptDir, "..");
const metadataFile = "starter-installer.json";
const fixtureDeploymentPath = join(
  wwwkRoot,
  "installer",
  "fixtures",
  "starter-deployment.jsonc",
);
const officialStarterRemotes = new Set([
  "https://github.com/cloudflare/cloudflare-os-starter.git",
  "git@github.com:cloudflare/cloudflare-os-starter.git",
  "ssh://git@github.com/cloudflare/cloudflare-os-starter.git",
]);
const officialCfosRemotes = new Set([
  "https://github.com/cloudflare/cloudflare-os.git",
  "git@github.com:cloudflare/cloudflare-os.git",
  "ssh://git@github.com/cloudflare/cloudflare-os.git",
]);
const temporaryWranglerDirectories = new Set();
let signalCleanupInstalled = false;

function fail(message) {
  throw new Error(`Starter installer: ${message}`);
}

function removeTemporaryWranglerDirectorySync(directory) {
  try {
    rmSync(directory, {recursive: true, force: true, maxRetries: 2});
  } catch {
    // signal終了時の回収はbest-effortとし、通常時はfinallyで失敗を報告する。
  }
}

function installSignalCleanup() {
  if (signalCleanupInstalled) return;
  signalCleanupInstalled = true;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      for (const directory of temporaryWranglerDirectories) {
        removeTemporaryWranglerDirectorySync(directory);
      }
      temporaryWranglerDirectories.clear();
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }
}

export function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ? {...process.env, ...options.env} : process.env,
      stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    if (child.stdout) child.stdout.on("data", chunk => stdout.push(chunk));
    if (child.stderr) child.stderr.on("data", chunk => stderr.push(chunk));
    child.on("error", rejectRun);
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
  } catch {
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
  if (resolved === resolve("/") || resolved === homedir()) fail(`${label} is too broad.`);
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
  try {
    return requireSafeDirectory(
      resolve(await realpath(ancestor), relative(ancestor, resolved)),
      label,
    );
  } catch {
    fail(`${label} cannot be resolved.`);
  }
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
  return join(stateHome, "wwwk", "starter");
}

function validateWorkerName(value) {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value ?? "")) {
    fail("--wwwk-worker must be a valid Worker name.");
  }
}

export function parseArgs(argv) {
  const values = [...argv];
  const options = {command: "install", stateDir: defaultStateDir()};
  if (values[0] === "disconnect") options.command = values.shift();
  if (values[0] === "--") values.shift();
  while (values.length > 0) {
    const value = values.shift();
    if (value === "--starter") options.starter = values.shift();
    else if (value === "--wwwk-worker") options.wwwkWorker = values.shift();
    else if (value === "--state-dir") options.stateDir = values.shift();
    else if (value === "--deployment-config") options.deploymentConfig = values.shift();
    else if (value === "--apply") options.apply = true;
    else fail(`Unknown argument ${value}.`);
  }
  if (!options.starter || !options.wwwkWorker || !options.stateDir || !options.deploymentConfig) {
    fail("--starter, --wwwk-worker, --state-dir, and --deployment-config require values.");
  }
  validateWorkerName(options.wwwkWorker);
  return options;
}

export async function integrationPaths(starterRoot, stateDir) {
  const safeStateDir = await canonicalPath(stateDir, "State directory");
  const managedRoot = await canonicalPath(`${safeStateDir}.wwwk`, "Managed state directory");
  const key = createHash("sha256").update(starterRoot).digest("hex").slice(0, 16);
  const integrationPath = await canonicalPath(
    join(managedRoot, "integrations", `starter-${key}`),
    "Integration path",
  );
  if (
    isWithin(safeStateDir, starterRoot) ||
    isWithin(managedRoot, starterRoot) ||
    isWithin(integrationPath, starterRoot)
  ) {
    fail("State must be outside the Starter checkout.");
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

function expectedMetadata(starterRoot, paths) {
  return {
    format: 1,
    starterRoot,
    starterRevision: compatibility.starter.revision,
    cfosRevision: compatibility.cfos.baseRevision,
    wwwkRevision: compatibility.wwwk.baseRevision,
    stateDir: paths.stateDir,
  };
}

function matchesMetadata(actual, expected) {
  return actual && Object.entries(expected).every(([key, value]) => actual[key] === value);
}

async function verifyStarter(starterPath) {
  const input = await canonicalExistingDirectory(starterPath, "Starter checkout");
  const root = await gitText(input, ["rev-parse", "--show-toplevel"]);
  if (root !== input) fail("--starter must name the Starter repository root.");
  if (!officialStarterRemotes.has(await gitText(root, ["remote", "get-url", "origin"]))) {
    fail("Starter origin is not the supported official repository.");
  }
  if ((await gitText(root, ["rev-parse", "HEAD"])) !== compatibility.starter.revision) {
    fail("Unsupported Starter revision.");
  }
  if ((await gitText(root, ["status", "--porcelain=v1", "--untracked-files=all"])) !== "") {
    fail("Starter checkout is not clean.");
  }
  return root;
}

async function verifyWwwkRuntime() {
  await gitText(wwwkRoot, ["cat-file", "-e", `${compatibility.wwwk.baseRevision}^{commit}`]);
}

async function verifyState(starterRoot, paths) {
  if (
    isWithin(paths.stateDir, starterRoot) ||
    isWithin(paths.managedRoot, starterRoot) ||
    isWithin(paths.integrationPath, starterRoot)
  ) {
    fail("State must be outside the Starter checkout.");
  }
  const expected = expectedMetadata(starterRoot, paths);
  const metadata = await loadMetadata(paths.metadataPath);
  if (metadata && !matchesMetadata(metadata, expected)) {
    fail("Managed state belongs to a different integration.");
  }
  if (!metadata && await hasFiles(paths.stateDir)) fail("State ownership is unknown.");
  if (!metadata) {
    await mkdir(paths.managedRoot, {recursive: true});
    await writeFile(paths.metadataPath, `${JSON.stringify(expected, null, 2)}\n`);
  }
}

async function registeredWorktrees(starterRoot) {
  const output = await gitText(starterRoot, ["worktree", "list", "--porcelain"]);
  return output.split("\n")
    .filter(line => line.startsWith("worktree "))
    .map(line => line.slice("worktree ".length));
}

async function removeManagedWorktree(starterRoot, paths) {
  if (!existsSync(paths.integrationPath)) return;
  if (!isWithin(paths.integrationPath, paths.managedRoot)) {
    fail("Integration path is outside the managed directory.");
  }
  if (!(await registeredWorktrees(starterRoot)).includes(paths.integrationPath)) {
    fail("Existing integration path is not a registered Git worktree.");
  }
  await git(starterRoot, ["worktree", "remove", "--force", paths.integrationPath]);
}

async function applyPatch(cwd, patch) {
  const patchPath = join(wwwkRoot, "installer", patch);
  await access(patchPath);
  await git(cwd, ["apply", "--unidiff-zero", "--check", patchPath]);
  await git(cwd, ["apply", "--unidiff-zero", patchPath]);
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
  const destination = join(integrationPath, "cloudflare-os", "packages", "gatekeeper-wwwk");
  for (const path of paths) {
    const target = join(destination, path);
    await mkdir(dirname(target), {recursive: true});
    const content = await run("git", ["show", `${compatibility.wwwk.baseRevision}:${path}`], {
      cwd: wwwkRoot,
    });
    await writeFile(target, content.stdout);
  }
}

async function readJsonc(path, label = "JSONC file") {
  const input = await readFile(path, "utf8");
  let output = "";
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    const next = input[index + 1];
    if (quoted) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") quoted = false;
      continue;
    }
    if (character === "\"") {
      quoted = true;
      output += character;
    } else if (character === "/" && next === "/") {
      index = input.indexOf("\n", index);
      if (index === -1) break;
      output += "\n";
    } else if (character === "/" && next === "*") {
      index = input.indexOf("*/", index + 2);
      if (index === -1) fail(`${label} contains an unterminated comment.`);
      index += 1;
    } else {
      output += character;
    }
  }
  try {
    return JSON.parse(output.replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    fail(`${label} is invalid JSONC.`);
  }
}

export async function loadExternalDeploymentConfig(configPath, starterRoot, paths) {
  const requested = resolve(configPath ?? "");
  let entry;
  try {
    entry = await lstat(requested);
  } catch {
    fail("External deployment config does not exist.");
  }
  if (!entry.isFile() || entry.isSymbolicLink()) {
    fail("External deployment config must be a regular file.");
  }
  let canonical;
  try {
    canonical = await realpath(requested);
  } catch {
    fail("External deployment config cannot be resolved.");
  }
  if (
    isWithin(canonical, starterRoot) ||
    isWithin(canonical, paths.managedRoot) ||
    isWithin(canonical, paths.integrationPath)
  ) {
    fail("External deployment config must be outside Starter and managed state.");
  }
  if (((await stat(canonical)).mode & 0o077) !== 0) {
    fail("External deployment config must be owner-only (0600 equivalent).");
  }
  return readJsonc(canonical, "External deployment config");
}

function requireExactWwwkExports(config) {
  for (const name of ["WwwkLibrary", "WwwkGatekeeper"]) {
    const entry = config.exports?.[name];
    if (entry?.type !== "durable-object" || entry.storage !== "sqlite" || entry.state) {
      fail(`WWWK ${name} Durable Object identity is invalid.`);
    }
  }
}

export function createStarterConfigs({
  workshopConfig,
  wwwkConfig,
  accountId,
  workshopWorkerName,
  wwwkWorkerName,
  connected,
}) {
  if (!workshopConfig || !Array.isArray(workshopConfig.services)) {
    fail("Workshop config must contain services.");
  }
  if (!wwwkConfig || !Array.isArray(wwwkConfig.services)) {
    fail("WWWK config must contain services.");
  }
  if (typeof accountId !== "string" || !accountId) fail("Starter account is invalid.");
  validateWorkerName(workshopWorkerName);
  validateWorkerName(wwwkWorkerName);
  requireExactWwwkExports(wwwkConfig);
  const hasWwwkBinding = workshopConfig.services.some(
    service => service.binding === "GATEKEEPER_WWWK",
  );
  if (hasWwwkBinding) fail("Workshop base config already contains GATEKEEPER_WWWK.");
  const brokers = wwwkConfig.services.filter(
    service => service.binding === "CFOS_SOURCE_ACCESS_BROKER",
  );
  if (brokers.length !== 1 || brokers[0].entrypoint !== "SourceAccessBroker") {
    fail("WWWK config must contain exactly one SourceAccessBroker binding.");
  }
  const workshop = {
    ...structuredClone(workshopConfig),
    services: connected
      ? [...workshopConfig.services, {
        binding: "GATEKEEPER_WWWK",
        service: wwwkWorkerName,
        entrypoint: "GatekeeperVendor",
      }]
      : structuredClone(workshopConfig.services),
  };
  const wwwk = structuredClone(wwwkConfig);
  wwwk.account_id = accountId;
  wwwk.name = wwwkWorkerName;
  wwwk.workers_dev = false;
  delete wwwk.routes;
  wwwk.services = connected
    ? wwwkConfig.services.map(service => service.binding === "CFOS_SOURCE_ACCESS_BROKER"
      ? {...service, service: workshopWorkerName}
      : service)
    : wwwkConfig.services.filter(service => service.binding !== "CFOS_SOURCE_ACCESS_BROKER");
  requireExactWwwkExports(wwwk);
  return {workshop, wwwk};
}

async function prepareIntegration(starterRoot, paths) {
  await removeManagedWorktree(starterRoot, paths);
  await mkdir(dirname(paths.integrationPath), {recursive: true});
  await git(starterRoot, ["worktree", "add", "--detach", paths.integrationPath, compatibility.starter.revision]);
  await git(paths.integrationPath, ["submodule", "update", "--init"]);
  const cfosRoot = join(paths.integrationPath, "cloudflare-os");
  if (!officialCfosRemotes.has(await gitText(cfosRoot, ["remote", "get-url", "origin"]))) {
    fail("Starter submodule origin is not the supported official CFOS repository.");
  }
  await git(cfosRoot, ["checkout", "--detach", compatibility.cfos.baseRevision]);
  await applyPatch(paths.integrationPath, compatibility.starter.patch);
  await applyPatch(cfosRoot, compatibility.cfos.patch);
  await materializeRuntime(paths.integrationPath);
  await writeFile(
    join(cfosRoot, "pnpm-lock.yaml"),
    await readFile(join(wwwkRoot, "installer", compatibility.cfos.lockfile)),
  );
  await run("pnpm", ["install", "--frozen-lockfile"], {cwd: cfosRoot, stdio: "inherit"});
  await writeFile(
    join(paths.integrationPath, "pnpm-lock.yaml"),
    await readFile(join(wwwkRoot, "installer", compatibility.starter.lockfile)),
  );
  await run("pnpm", ["install", "--frozen-lockfile"], {cwd: paths.integrationPath, stdio: "inherit"});
  return cfosRoot;
}

async function generatedConfigs(integrationPath, cfosRoot, deployment, wwwkWorker, connected) {
  const deploy = await import(pathToFileURL(join(integrationPath, "scripts", "deploy.mjs")).href);
  deploy.validateConfig(deployment);
  const bases = {
    workshop: await readJsonc(join(cfosRoot, "packages", "workshop-backend", "wrangler.jsonc")),
    context: await readJsonc(join(cfosRoot, "packages", "gatekeeper-context", "wrangler.jsonc")),
    customGatekeeper: await readJsonc(join(integrationPath, "packages", "custom-gatekeeper", "wrangler.jsonc")),
    errorReporter: await readJsonc(join(integrationPath, "packages", "error-reporter", "wrangler.jsonc")),
  };
  const starter = deploy.generateConfigs(deployment, bases);
  const wwwkBase = await readJsonc(join(cfosRoot, "packages", "gatekeeper-wwwk", "wrangler.jsonc"));
  const pair = createStarterConfigs({
    workshopConfig: starter.workshop,
    wwwkConfig: wwwkBase,
    accountId: deployment.accountId,
    workshopWorkerName: deployment.workers.workshop.name,
    wwwkWorkerName: wwwkWorker,
    connected,
  });
  return {deployment, starter: {...starter, workshop: pair.workshop}, wwwk: pair.wwwk};
}

function configEntries(configs) {
  const entries = [
    ["workshop", configs.starter?.workshop],
    ["context", configs.starter?.context],
    ["custom-gatekeeper", configs.starter?.customGatekeeper],
    ["wwwk", configs.wwwk],
  ].filter(([, config]) => config !== undefined);
  if (configs.starter?.errorReporter) {
    entries.push(["error-reporter", configs.starter.errorReporter]);
  }
  return entries;
}

function configWithAbsolutePaths(config, sourceDirectory) {
  if (!sourceDirectory) return config;
  const resolved = structuredClone(config);
  if (typeof resolved.main === "string" && !isAbsolute(resolved.main)) {
    resolved.main = resolve(sourceDirectory, resolved.main);
  }
  if (typeof resolved.assets?.directory === "string" && !isAbsolute(resolved.assets.directory)) {
    resolved.assets.directory = resolve(sourceDirectory, resolved.assets.directory);
  }
  return resolved;
}

async function verifyTemporaryWranglerDirectory(directory) {
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    fail("Temporary Wrangler directory must be a real directory.");
  }
  if ((entry.mode & 0o777) !== 0o700) {
    fail("Temporary Wrangler directory must be owner-only (0700).");
  }
}

export async function createTemporaryWranglerDirectory(temporaryRoot = tmpdir()) {
  const root = await canonicalExistingDirectory(temporaryRoot, "Temporary directory");
  let directory;
  try {
    const rootEntry = await lstat(root);
    if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
      fail("Temporary directory must be a real directory.");
    }
    directory = await mkdtemp(join(root, "wwwk-wrangler-"));
    await chmod(directory, 0o700);
    await verifyTemporaryWranglerDirectory(directory);
    temporaryWranglerDirectories.add(directory);
    installSignalCleanup();
    return directory;
  } catch (error) {
    if (directory) await rm(directory, {recursive: true, force: true});
    throw error;
  }
}

export async function writeTemporaryWranglerConfig(directory, name, config, sourceDirectory) {
  if (!/^[a-z0-9-]+$/.test(name)) fail("Temporary Wrangler config name is invalid.");
  await verifyTemporaryWranglerDirectory(directory);
  const configPath = join(directory, `${name}.wrangler.jsonc`);
  try {
    await writeFile(configPath, `${JSON.stringify(
      configWithAbsolutePaths(config, sourceDirectory),
      null,
      2,
    )}\n`, {
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if (error?.code === "EEXIST") {
      fail("Temporary Wrangler config must not reuse an existing file.");
    }
    throw error;
  }
  const entry = await lstat(configPath);
  if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o777) !== 0o600) {
    await rm(configPath, {force: true});
    fail("Temporary Wrangler config must be an owner-only regular file.");
  }
  return configPath;
}

export async function withTemporaryWranglerConfigs(configs, callback, options = {}) {
  let directory;
  try {
    directory = await createTemporaryWranglerDirectory(options.temporaryRoot);
    const configPaths = {};
    for (const [name, config] of configEntries(configs)) {
      configPaths[name] = await writeTemporaryWranglerConfig(
        directory,
        name,
        config,
        options.sourceDirectories?.[name],
      );
    }
    return await callback({directory, configPaths});
  } finally {
    if (directory) {
      temporaryWranglerDirectories.delete(directory);
      await rm(directory, {recursive: true, force: true});
    }
  }
}

function generatedPath(directory) {
  return join(directory, ".wwwk-installer.wrangler.jsonc");
}

async function writeGeneratedConfigs(integrationPath, cfosRoot, configs) {
  const files = [
    [join(cfosRoot, "packages", "workshop-backend"), configs.starter.workshop],
    [join(cfosRoot, "packages", "gatekeeper-context"), configs.starter.context],
    [join(integrationPath, "packages", "custom-gatekeeper"), configs.starter.customGatekeeper],
    [join(cfosRoot, "packages", "gatekeeper-wwwk"), configs.wwwk],
  ];
  if (configs.starter.errorReporter) {
    files.push([join(integrationPath, "packages", "error-reporter"), configs.starter.errorReporter]);
  }
  await Promise.all(files.map(([directory, config]) =>
    writeFile(generatedPath(directory), `${JSON.stringify(config, null, 2)}\n`)));
  return files.map(([directory]) => directory);
}

async function removeGeneratedConfigs(directories) {
  await Promise.all(directories.map(directory => rm(generatedPath(directory), {force: true})));
}

export function workshopFrontendBuildOptions(cfosRoot) {
  return {
    cwd: cfosRoot,
    stdio: "inherit",
    env: {VITE_CF_ACCESS_MODE: "true"},
  };
}

async function buildAndDryRun(integrationPath, cfosRoot, directories) {
  await run("pnpm", ["--filter", "@gadgets/gatekeeper-context", "build"], {cwd: cfosRoot, stdio: "inherit"});
  await run("pnpm", ["--dir", "packages/custom-gatekeeper", "run", "build"], {cwd: integrationPath, stdio: "inherit"});
  await run(
    "pnpm",
    ["--filter", "@gadgets/workshop-frontend", "build"],
    workshopFrontendBuildOptions(cfosRoot),
  );
  await run("pnpm", ["--filter", "@gadgets/workshop-backend", "build"], {cwd: cfosRoot, stdio: "inherit"});
  await run("pnpm", ["run", "build"], {cwd: join(cfosRoot, "packages", "gatekeeper-wwwk"), stdio: "inherit"});
  for (const directory of directories) {
    await run("pnpm", ["exec", "wrangler", "deploy", "--config", generatedPath(directory), "--dry-run"], {
      cwd: directory,
      stdio: "inherit",
    });
  }
}

function resourceBindings(version) {
  const bindings = version?.resources?.bindings;
  if (!Array.isArray(bindings)) fail("Worker version does not expose resource bindings.");
  return bindings;
}

function bindingValue(binding, keys) {
  for (const key of keys) {
    if (typeof binding?.[key] === "string" && binding[key]) return binding[key];
  }
  fail(`Worker version binding ${binding?.name ?? "unknown"} is incomplete.`);
}

function namedBinding(bindings, name) {
  const matches = bindings.filter(binding => binding.name === name);
  if (matches.length !== 1) fail(`Worker version must contain exactly one ${name} binding.`);
  return matches[0];
}

function matchesJson(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => matchesJson(value, right[index]));
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) =>
    key === rightKeys[index] && matchesJson(left[key], right[key]));
}

function verifyWorkshopVars(bindings, workshopConfig) {
  for (const [name, expected] of Object.entries(workshopConfig.vars ?? {})) {
    const actual = namedBinding(bindings, name);
    const valid = typeof expected === "string"
      ? actual.type === "plain_text" && actual.text === expected
      : actual.type === "json" && matchesJson(actual.json, expected);
    if (!valid) fail(`Existing Workshop ${name} variable identity does not match.`);
  }
}

function verifyWorkshopServices(bindings, workshopConfig) {
  for (const expected of workshopConfig.services.filter(
    service => service.binding !== "GATEKEEPER_WWWK",
  )) {
    const actual = namedBinding(bindings, expected.binding);
    if (
      actual.type !== "service" ||
      actual.service !== expected.service ||
      actual.entrypoint !== expected.entrypoint ||
      actual.environment !== expected.environment
    ) {
      fail(`Existing Workshop ${expected.binding} service identity does not match.`);
    }
  }
}

function verifyWorkshopDurableObjects(version, workshopConfig) {
  const expectedClasses = (workshopConfig.migrations ?? []).flatMap(
    migration => migration.new_sqlite_classes ?? [],
  );
  if (expectedClasses.length === 0) return;
  const exports = version?.resources?.script_runtime?.exports;
  if (!exports || typeof exports !== "object" || Array.isArray(exports)) {
    fail("Workshop Worker version does not expose Durable Object exports.");
  }
  for (const name of expectedClasses) {
    const entry = exports[name];
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      entry.type !== "durable-object" ||
      entry.storage !== "sqlite" ||
      (entry.state !== undefined && entry.state !== "created")
    ) {
      fail(`Existing Workshop ${name} Durable Object export identity does not match.`);
    }
  }
}

export function verifyExistingWorkshopIdentity(version, workshopConfig, wwwkWorkerName) {
  const bindings = resourceBindings(version);
  verifyWorkshopVars(bindings, workshopConfig);
  verifyWorkshopServices(bindings, workshopConfig);
  verifyWorkshopDurableObjects(version, workshopConfig);
  for (const resource of workshopConfig.kv_namespaces ?? []) {
    if (!resource.id) fail(`Existing Workshop requires an explicit ${resource.binding} KV identity.`);
    const actual = namedBinding(bindings, resource.binding);
    if (
      actual.type !== "kv_namespace" ||
      bindingValue(actual, ["namespace_id", "namespace"]) !== resource.id
    ) {
      fail(`Existing Workshop ${resource.binding} KV identity does not match.`);
    }
  }
  for (const resource of workshopConfig.r2_buckets ?? []) {
    if (!resource.bucket_name) fail(`Existing Workshop requires an explicit ${resource.binding} R2 identity.`);
    const actual = namedBinding(bindings, resource.binding);
    if (
      actual.type !== "r2_bucket" ||
      bindingValue(actual, ["bucket_name", "bucket"]) !== resource.bucket_name
    ) {
      fail(`Existing Workshop ${resource.binding} R2 identity does not match.`);
    }
  }
  const wwwk = bindings.filter(binding => binding.name === "GATEKEEPER_WWWK");
  if (wwwk.length > 1) fail("Existing Workshop has duplicate GATEKEEPER_WWWK bindings.");
  const configuredWwwk = workshopConfig.services.find(
    binding => binding.binding === "GATEKEEPER_WWWK",
  )?.service;
  if (
    wwwk.length === 1 && (
      wwwk[0].type !== "service" ||
      wwwk[0].service !== (configuredWwwk ?? wwwkWorkerName) ||
      wwwk[0].entrypoint !== "GatekeeperVendor" ||
      wwwk[0].environment !== undefined
    )
  ) {
    fail("Existing Workshop GATEKEEPER_WWWK binding identity does not match.");
  }
}

export function productionVersionId(deployment) {
  if (!deployment || typeof deployment !== "object" || Array.isArray(deployment)) {
    fail("Wrangler production deployment response is invalid.");
  }
  const versions = deployment.versions;
  if (!Array.isArray(versions) || versions.length !== 1 || typeof versions[0]?.version_id !== "string") {
    fail("Current production Worker version cannot be identified uniquely.");
  }
  return versions[0].version_id;
}

export function liveWranglerOptions(directory) {
  return {cwd: directory, env: {WRANGLER_WRITE_LOGS: "false"}};
}

async function wranglerJson(directory, args, configPath) {
  const result = await run("pnpm", [
    "exec",
    "wrangler",
    ...args,
    "--config",
    configPath,
    "--json",
  ], liveWranglerOptions(directory));
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail("Wrangler did not return valid JSON.");
  }
}

async function currentWorkerVersion(directory, workerName, configPath) {
  let deployment;
  try {
    deployment = await wranglerJson(directory, [
      "deployments", "status", "--name", workerName,
    ], configPath);
  } catch (error) {
    if (/has no deployments\./.test(`${error?.stdout ?? ""}\n${error?.stderr ?? ""}`)) {
      return undefined;
    }
    throw error;
  }
  const versionId = productionVersionId(deployment);
  return wranglerJson(directory, [
    "versions",
    "view",
    versionId,
    "--name",
    workerName,
  ], configPath);
}

export function verifyWwwkDurableObjectIdentity(version) {
  const exports = version?.resources?.script_runtime?.exports;
  if (!exports || typeof exports !== "object" || Array.isArray(exports)) {
    fail("WWWK Worker version does not expose Durable Object exports.");
  }
  for (const name of ["WwwkLibrary", "WwwkGatekeeper"]) {
    const entry = exports[name];
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      entry.type !== "durable-object" ||
      entry.storage !== "sqlite" ||
      (entry.state !== undefined && entry.state !== "created")
    ) {
      fail(`Existing WWWK ${name} Durable Object export identity does not match.`);
    }
  }
}

export function verifyWwwkBrokerIdentity(version, workshopWorkerName) {
  const brokers = resourceBindings(version).filter(
    binding => binding.name === "CFOS_SOURCE_ACCESS_BROKER",
  );
  if (brokers.length === 0) return;
  if (
    brokers.length !== 1 ||
    brokers[0].type !== "service" ||
    brokers[0].service !== workshopWorkerName ||
    brokers[0].entrypoint !== "SourceAccessBroker" ||
    brokers[0].environment !== undefined
  ) {
    fail("Existing WWWK CFOS_SOURCE_ACCESS_BROKER identity does not match.");
  }
}

async function verifyApplyIdentity(configs, cfosRoot, configPaths, command) {
  const workshopDirectory = join(cfosRoot, "packages", "workshop-backend");
  const workshop = await currentWorkerVersion(
    workshopDirectory,
    configs.deployment.workers.workshop.name,
    configPaths.workshop,
  );
  if (!workshop) {
    fail("Baseline Starter deploy is required and must be separately approved.");
  }
  verifyExistingWorkshopIdentity(workshop, configs.starter.workshop, configs.wwwk.name);
  const wwwkDirectory = join(cfosRoot, "packages", "gatekeeper-wwwk");
  const wwwk = await currentWorkerVersion(wwwkDirectory, configs.wwwk.name, configPaths.wwwk);
  if (!wwwk && command === "disconnect") {
    fail("Existing WWWK Worker cannot be identified for disconnect.");
  }
  if (wwwk) {
    verifyWwwkDurableObjectIdentity(wwwk);
    verifyWwwkBrokerIdentity(
      wwwk,
      configs.deployment.workers.workshop.name,
    );
  }
}

async function deploy(directory, configPath) {
  await run(
    "pnpm",
    ["exec", "wrangler", "deploy", "--config", configPath],
    liveWranglerOptions(directory),
  );
}

async function confirmLiveDeploy(command, input = process.stdin, output = process.stdout) {
  if (!input.isTTY || !output.isTTY) {
    fail("Live deploy requires an interactive confirmation.");
  }
  const readline = createInterface({input, output});
  try {
    const answer = await readline.question(
      command === "install"
        ? "Deploy WWWK, then connect Workshop? [y/N] "
        : "Disconnect Workshop, then deploy WWWK without its broker? [y/N] ",
    );
    if (answer.trim().toLowerCase() !== "y") fail("Live deploy was not confirmed.");
  } finally {
    readline.close();
  }
}

async function deployLive(configs, cfosRoot, command) {
  const directories = {
    workshop: join(cfosRoot, "packages", "workshop-backend"),
    wwwk: join(cfosRoot, "packages", "gatekeeper-wwwk"),
  };
  return withTemporaryWranglerConfigs({
    starter: {workshop: configs.starter.workshop},
    wwwk: configs.wwwk,
  }, async ({configPaths}) => {
    await verifyApplyIdentity(configs, cfosRoot, configPaths, command);
    console.log(command === "install"
      ? "Live deploy plan: WWWK, then Workshop connection."
      : "Live deploy plan: Workshop disconnect, then WWWK broker removal.");
    console.log("Cloudflare will receive Worker version updates; no resource is deleted.");
    console.log("Existing Worker names, Durable Object classes, KV, and R2 identities are verified first.");
    await confirmLiveDeploy(command);
    if (command === "install") {
      await deploy(directories.wwwk, configPaths.wwwk);
      await deploy(directories.workshop, configPaths.workshop);
      return;
    }
    await deploy(directories.workshop, configPaths.workshop);
    await deploy(directories.wwwk, configPaths.wwwk);
  }, {sourceDirectories: directories});
}

function printPlan(command, apply) {
  const phase = command === "install" ? "connect" : "disconnect";
  console.log(`Starter installer plan (${phase})`);
  console.log("- external deployment config validated without copying its values");
  console.log("- generated dry-run config uses only tracked fixture values");
  console.log(command === "install"
    ? "- deploy order: WWWK, then Workshop with GATEKEEPER_WWWK"
    : "- deploy order: Workshop without GATEKEEPER_WWWK, then WWWK without broker binding");
  if (apply) {
    console.log("- live identity verification and deploy require a later interactive confirmation");
  } else {
    console.log("- no Cloudflare API read, resource provisioning, or deploy is performed");
  }
}

export async function runStarterInstaller(options) {
  if (options.apply && (!options.starter || !options.wwwkWorker || !options.stateDir || !options.deploymentConfig)) {
    fail("Live deploy requires complete parsed installer options.");
  }
  const starterRoot = await verifyStarter(options.starter);
  await verifyWwwkRuntime();
  const paths = await integrationPaths(starterRoot, options.stateDir);
  const deployment = await loadExternalDeploymentConfig(
    options.deploymentConfig,
    starterRoot,
    paths,
  );
  await verifyState(starterRoot, paths);
  const cfosRoot = await prepareIntegration(starterRoot, paths);
  const connected = options.command === "install";
  let directories = [];
  try {
    const liveConfigs = await generatedConfigs(
      paths.integrationPath,
      cfosRoot,
      deployment,
      options.wwwkWorker,
      connected,
    );
    const fixtureDeployment = await readJsonc(
      fixtureDeploymentPath,
      "Starter dry-run fixture",
    );
    const fixtureConfigs = await generatedConfigs(
      paths.integrationPath,
      cfosRoot,
      fixtureDeployment,
      "wwwk-fixture",
      connected,
    );
    printPlan(options.command, options.apply);
    directories = await writeGeneratedConfigs(paths.integrationPath, cfosRoot, fixtureConfigs);
    await buildAndDryRun(paths.integrationPath, cfosRoot, directories);
    if (options.apply) {
      await deployLive(liveConfigs, cfosRoot, options.command);
      return {paths, applied: true};
    }
    return {paths, dryRun: true};
  } finally {
    await removeGeneratedConfigs(directories);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await runStarterInstaller(options);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
