import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createNotionIntegration,
  createStarterConfigs,
  createWwwkErasureConfig,
  isMissingWorkerError,
  isUnknownWorkerError,
  liveWranglerOptions,
  loadExternalDeploymentConfig,
  parseArgs,
  productionVersionId,
  run,
  runStarterInstaller,
  verifyExistingWorkshopIdentity,
  verifyNotionIdentity,
  verifyWwwkBrokerIdentity,
  verifyWwwkDeletionVersion,
  verifyWwwkDurableObjectIdentity,
  verifyWwwkEraseIdentity,
  validateBootstrapResources,
  validateWwwkWorkerName,
  withTemporaryWranglerConfigs,
  workshopFrontendBuildOptions,
  writeTemporaryWranglerConfig,
} from "./starter-installer.mjs";

const workshopConfig = {
  vars: {
    ADMINS: ["admin@example.invalid"],
    CF_ACCESS_ISS: "https://access.example.invalid",
    CF_ACCESS_AUD: "audience",
  },
  services: [{
    binding: "GATEKEEPER_CONTEXT",
    service: "context",
    entrypoint: "GatekeeperVendor",
    props: {sharingDomain: "example"},
  }, {
    binding: "GATEKEEPER_CUSTOM",
    service: "custom",
    entrypoint: "GatekeeperVendor",
  }],
};
const wwwkConfig = {
  compatibility_flags: ["allow_irrevocable_stub_storage", "nodejs_compat"],
  services: [{
    binding: "CFOS_SOURCE_ACCESS_BROKER",
    service: "workshop-backend",
    entrypoint: "SourceAccessBroker",
  }],
  exports: {
    WwwkLibrary: {type: "durable-object", storage: "sqlite"},
    WwwkGatekeeper: {type: "durable-object", storage: "sqlite"},
  },
};

async function containsValue(directory, value) {
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (await containsValue(path, value)) return true;
    } else if (entry.isFile() && (await readFile(path, "utf8")).includes(value)) {
      return true;
    }
  }
  return false;
}

function temporaryConfigs(value) {
  return {
    starter: {
      workshop: {name: value},
      context: {name: value},
      customGatekeeper: {name: value},
    },
    wwwk: {name: value},
  };
}

test("parses Starter bootstrap, install, Notion, disconnect, and data erasure commands", () => {
  assert.deepEqual(parseArgs([
    "--starter", "/tmp/starter",
    "--wwwk-worker", "my-wwwk",
    "--state-dir", "/tmp/state",
    "--deployment-config", "/tmp/deployment.jsonc",
  ]), {
    command: "install",
    starter: "/tmp/starter",
    wwwkWorker: "my-wwwk",
    stateDir: "/tmp/state",
    deploymentConfig: "/tmp/deployment.jsonc",
  });
  assert.equal(parseArgs([
    "notion",
    "--starter", "/tmp/starter",
    "--wwwk-worker", "my-wwwk",
    "--state-dir", "/tmp/state",
    "--deployment-config", "/tmp/deployment.jsonc",
  ]).command, "notion");
  assert.equal(parseArgs([
    "bootstrap",
    "--starter", "/tmp/starter",
    "--wwwk-worker", "my-wwwk",
    "--state-dir", "/tmp/state",
    "--deployment-config", "/tmp/deployment.jsonc",
  ]).command, "bootstrap");
  assert.equal(parseArgs([
    "disconnect",
    "--starter", "/tmp/starter",
    "--wwwk-worker", "my-wwwk",
    "--state-dir", "/tmp/state",
    "--deployment-config", "/tmp/deployment.jsonc",
  ]).command, "disconnect");
  assert.equal(parseArgs([
    "erase",
    "--starter", "/tmp/starter",
    "--wwwk-worker", "my-wwwk",
    "--state-dir", "/tmp/state",
    "--deployment-config", "/tmp/deployment.jsonc",
    "--apply",
  ]).command, "erase");
  assert.throws(() => parseArgs(["--starter", "/tmp/starter"]), /require values/);
});

test("reads only canonical owner-only external deployment config", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wwwk-starter-config-"));
  const configPath = join(directory, "deployment.jsonc");
  const linkPath = join(directory, "deployment-link.jsonc");
  const config = "{\n  // fixture\n  \"accountId\": \"fixture\"\n}\n";
  await writeFile(configPath, config, {mode: 0o600});
  const paths = {
    managedRoot: join(tmpdir(), "wwwk-managed"),
    integrationPath: join(tmpdir(), "wwwk-managed", "integration"),
  };
  try {
    await assert.doesNotReject(loadExternalDeploymentConfig(
      join(directory, ".", "deployment.jsonc"),
      join(tmpdir(), "starter"),
      paths,
    ));
    await symlink(configPath, linkPath);
    await assert.rejects(
      loadExternalDeploymentConfig(linkPath, join(tmpdir(), "starter"), paths),
      /regular file/,
    );
    await chmod(configPath, 0o644);
    await assert.rejects(
      loadExternalDeploymentConfig(configPath, join(tmpdir(), "starter"), paths),
      /owner-only/,
    );
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test("rejects incomplete live apply options before creating integration state", async () => {
  await assert.rejects(runStarterInstaller({apply: true}), /requires complete parsed installer options/);
});

test("uses owner-only temporary configs and removes sentinels after success", async () => {
  const root = await mkdtemp(join(tmpdir(), "wwwk-starter-sentinel-"));
  const repository = join(root, "repository");
  const managedState = join(root, "managed-state");
  const integration = join(managedState, "integration");
  const temporaryRoot = join(root, "os-temporary");
  const sentinel = "starter-live-sentinel-success";
  let directory;
  try {
    await mkdir(repository);
    await mkdir(integration, {recursive: true});
    await mkdir(temporaryRoot);
    await withTemporaryWranglerConfigs(temporaryConfigs(sentinel), async result => {
      directory = result.directory;
      assert.equal((await lstat(directory)).mode & 0o777, 0o700);
      for (const configPath of Object.values(result.configPaths)) {
        assert.equal((await lstat(configPath)).mode & 0o777, 0o600);
        assert.match(await readFile(configPath, "utf8"), new RegExp(sentinel));
      }
      assert.equal(await containsValue(repository, sentinel), false);
      assert.equal(await containsValue(managedState, sentinel), false);
      assert.equal(await containsValue(integration, sentinel), false);
    }, {temporaryRoot});
    await assert.rejects(lstat(directory), /ENOENT/);
    assert.equal(await containsValue(repository, sentinel), false);
    assert.equal(await containsValue(managedState, sentinel), false);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("removes temporary configs after failure without leaking sentinels", async () => {
  const root = await mkdtemp(join(tmpdir(), "wwwk-starter-sentinel-"));
  const repository = join(root, "repository");
  const managedState = join(root, "managed-state");
  const integration = join(managedState, "integration");
  const temporaryRoot = join(root, "os-temporary");
  const sentinel = "starter-live-sentinel-failure";
  let directory;
  try {
    await mkdir(repository);
    await mkdir(integration, {recursive: true});
    await mkdir(temporaryRoot);
    await assert.rejects(withTemporaryWranglerConfigs(
      temporaryConfigs(sentinel),
      async result => {
        directory = result.directory;
        throw new Error("fixture failure");
      },
      {temporaryRoot},
    ), /fixture failure/);
    await assert.rejects(lstat(directory), /ENOENT/);
    assert.equal(await containsValue(repository, sentinel), false);
    assert.equal(await containsValue(managedState, sentinel), false);
    assert.equal(await containsValue(integration, sentinel), false);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("rejects reuse of existing and symbolic-link temporary config files", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "wwwk-starter-temporary-"));
  try {
    await withTemporaryWranglerConfigs(temporaryConfigs("fixture"), async ({directory}) => {
      const configPath = join(directory, "extra.wrangler.jsonc");
      await writeFile(configPath, "{}\n", {mode: 0o600});
      await assert.rejects(
        writeTemporaryWranglerConfig(directory, "extra", {}),
        /must not reuse an existing file/,
      );
      await rm(configPath);
      await symlink(join(temporaryRoot, "outside.jsonc"), configPath);
      await assert.rejects(
        writeTemporaryWranglerConfig(directory, "extra", {}),
        /must not reuse an existing file/,
      );
    }, {temporaryRoot});
  } finally {
    await rm(temporaryRoot, {recursive: true, force: true});
  }
});

test("resolves live entrypoints from their Worker directory and disables Wrangler disk logs", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "wwwk-starter-paths-"));
  const sourceDirectory = join(temporaryRoot, "worker");
  try {
    await mkdir(sourceDirectory);
    await withTemporaryWranglerConfigs({
      starter: {
        workshop: {
          main: "./worker.mjs",
          assets: {directory: "./assets"},
        },
      },
    }, async ({configPaths}) => {
      const config = JSON.parse(await readFile(configPaths.workshop, "utf8"));
      assert.equal(config.main, join(sourceDirectory, "worker.mjs"));
      assert.equal(config.assets.directory, join(sourceDirectory, "assets"));
    }, {temporaryRoot, sourceDirectories: {workshop: sourceDirectory}});
    assert.deepEqual(liveWranglerOptions("/fixture/worker"), {
      cwd: "/fixture/worker",
      env: {WRANGLER_WRITE_LOGS: "false"},
    });
  } finally {
    await rm(temporaryRoot, {recursive: true, force: true});
  }
});

test("removes temporary configs on SIGTERM when the process can handle it", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "wwwk-starter-signal-"));
  const moduleUrl = new URL("./starter-installer.mjs", import.meta.url).href;
  const source = [
    `import {withTemporaryWranglerConfigs} from ${JSON.stringify(moduleUrl)};`,
    "await withTemporaryWranglerConfigs(",
    "  {starter: {workshop: {name: 'fixture'}}, wwwk: {name: 'fixture'}},",
    "  async ({directory}) => {",
    "    process.stdout.write(`${directory}\\n`);",
    "    await new Promise(() => setInterval(() => {}, 1_000));",
    "  },",
    `  {temporaryRoot: ${JSON.stringify(temporaryRoot)}},`,
    ");",
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  try {
    const directory = await new Promise((resolveDirectory, rejectDirectory) => {
      child.stdout.on("data", chunk => {
        output += chunk.toString("utf8");
        if (output.includes("\n")) resolveDirectory(output.trim());
      });
      child.once("error", rejectDirectory);
      child.stderr.on("data", chunk => rejectDirectory(new Error(chunk.toString("utf8"))));
    });
    child.kill("SIGTERM");
    await new Promise(resolveClose => child.once("close", resolveClose));
    await assert.rejects(lstat(directory), /ENOENT/);
  } finally {
    if (!child.killed) child.kill("SIGKILL");
    await rm(temporaryRoot, {recursive: true, force: true});
  }
});

test("passes the Workshop Frontend Access mode flag to a child process", async () => {
  const options = workshopFrontendBuildOptions("/fixture/cfos");
  assert.deepEqual(options, {
    cwd: "/fixture/cfos",
    stdio: "inherit",
    env: {VITE_CF_ACCESS_MODE: "true"},
  });
  const result = await run(process.execPath, [
    "--input-type=module",
    "--eval",
    "process.stdout.write(process.env.VITE_CF_ACCESS_MODE ?? 'missing')",
  ], {...options, cwd: process.cwd(), stdio: undefined});
  assert.equal(result.stdout, "true");
});

test("creates reciprocal bindings while preserving SQLite Durable Object exports", () => {
  const connected = createStarterConfigs({
    workshopConfig,
    wwwkConfig,
    accountId: "account",
    workshopWorkerName: "workshop",
    wwwkWorkerName: "wwwk",
    connected: true,
  });
  assert.deepEqual(connected.workshop.services.at(-1), {
    binding: "GATEKEEPER_WWWK",
    service: "wwwk",
    entrypoint: "GatekeeperVendor",
  });
  assert.deepEqual(connected.wwwk.services, [{
    binding: "CFOS_SOURCE_ACCESS_BROKER",
    service: "workshop",
    entrypoint: "SourceAccessBroker",
  }]);
  assert.deepEqual(connected.wwwk.exports, wwwkConfig.exports);
  assert.equal(workshopConfig.services.length, 2);
});

test("creates a path-routed Notion Worker and preserves the WWWK connection", () => {
  const connected = createStarterConfigs({
    workshopConfig,
    wwwkConfig,
    accountId: "account",
    workshopWorkerName: "workshop",
    wwwkWorkerName: "wwwk",
    connected: true,
  });
  const notionBase = {
    main: ".wrangler/validate/src/notion.ts",
    migrations: [{tag: "v0", new_sqlite_classes: [
      "UserAccount",
      "NotionItemGatekeeperImpl",
      "NotionWorkspaceGatekeeperImpl",
    ]}],
  };
  const result = createNotionIntegration({
    workshopConfig: connected.workshop,
    notionConfig: notionBase,
    deployment: {
      accountId: "account",
      workers: {
        workshop: {name: "workshop", route: {customDomain: "wiki.example.invalid"}},
        context: {name: "context"},
        customGatekeeper: {name: "custom"},
      },
      wwwk: {notion: {workerName: "notion", zoneName: "example.invalid"}},
    },
    wwwkWorkerName: "wwwk",
  });
  assert.deepEqual(result.notion.routes, [{
    pattern: "wiki.example.invalid/gatekeeper/notion/*",
    zone_name: "example.invalid",
  }]);
  assert.deepEqual(result.notion.vars, {
    BASE_URL: "https://wiki.example.invalid/gatekeeper/notion",
  });
  assert.equal(result.notion.workers_dev, false);
  assert.deepEqual(result.workshop.services.slice(-2).map(service => service.binding), [
    "GATEKEEPER_WWWK",
    "GATEKEEPER_NOTION",
  ]);
  assert.equal(connected.workshop.services.length, 3);
});

test("rejects unsafe Notion routing and Worker identities", () => {
  const notionConfig = {migrations: [{tag: "v0", new_sqlite_classes: [
    "UserAccount",
    "NotionItemGatekeeperImpl",
    "NotionWorkspaceGatekeeperImpl",
  ]}]};
  const deployment = {
    accountId: "account",
    workers: {
      workshop: {name: "workshop", route: {customDomain: "wiki.example.invalid"}},
      context: {name: "context"},
      customGatekeeper: {name: "custom"},
    },
    wwwk: {notion: {workerName: "notion", zoneName: "other.invalid"}},
  };
  assert.throws(() => createNotionIntegration({
    workshopConfig,
    notionConfig,
    deployment,
    wwwkWorkerName: "wwwk",
  }), /must belong/);
  deployment.wwwk.notion.zoneName = "example.invalid";
  deployment.wwwk.notion.workerName = "wwwk";
  assert.throws(() => createNotionIntegration({
    workshopConfig,
    notionConfig,
    deployment,
    wwwkWorkerName: "wwwk",
  }), /must differ/);
});

test("requires a dedicated WWWK Worker name", () => {
  const deployment = {workers: {
    workshop: {name: "workshop"},
    context: {name: "context"},
    customGatekeeper: {name: "custom"},
  }};
  assert.doesNotThrow(() => validateWwwkWorkerName(deployment, "wwwk"));
  assert.throws(
    () => validateWwwkWorkerName(deployment, "context"),
    /must differ from every Starter Worker/,
  );
});

test("requires explicit storage identities for Starter bootstrap", () => {
  const deployment = {
    context: {kvNamespaceId: "context-kv"},
    resources: {
      blueprintsKvNamespaceId: "blueprints-kv",
      avatarsKvNamespaceId: "avatars-kv",
      blueprintContentBucket: "blueprint-content",
    },
  };
  assert.doesNotThrow(() => validateBootstrapResources(deployment));
  deployment.resources.avatarsKvNamespaceId = null;
  assert.throws(
    () => validateBootstrapResources(deployment),
    /explicit resources\.avatarsKvNamespaceId/,
  );
});

test("disconnect removes only the reciprocal service bindings", () => {
  const disconnected = createStarterConfigs({
    workshopConfig,
    wwwkConfig,
    accountId: "account",
    workshopWorkerName: "workshop",
    wwwkWorkerName: "wwwk",
    connected: false,
  });
  assert.deepEqual(disconnected.workshop.services, workshopConfig.services);
  assert.deepEqual(disconnected.wwwk.services, []);
  assert.deepEqual(disconnected.wwwk.exports, wwwkConfig.exports);
});

test("creates a deletion-only WWWK Worker config", () => {
  assert.deepEqual(createWwwkErasureConfig({
    accountId: "account",
    workerName: "wwwk",
  }), {
    account_id: "account",
    name: "wwwk",
    main: "scripts/wwwk-erasure-worker.mjs",
    compatibility_date: "2026-02-02",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: false,
    exports: {
      WwwkLibrary: {type: "durable-object", state: "deleted"},
      WwwkGatekeeper: {type: "durable-object", state: "deleted"},
    },
  });
});

test("rejects invalid Durable Object identity and conflicting Workshop bindings", () => {
  assert.throws(() => createStarterConfigs({
    workshopConfig,
    wwwkConfig: {...wwwkConfig, compatibility_flags: ["nodejs_compat"]},
    accountId: "account",
    workshopWorkerName: "workshop",
    wwwkWorkerName: "wwwk",
    connected: true,
  }), /persistent RPC stub storage/);
  const invalidExports = structuredClone(wwwkConfig);
  invalidExports.exports.WwwkLibrary.storage = "legacy-kv";
  assert.throws(() => createStarterConfigs({
    workshopConfig,
    wwwkConfig: invalidExports,
    accountId: "account",
    workshopWorkerName: "workshop",
    wwwkWorkerName: "wwwk",
    connected: true,
  }), /Durable Object identity/);
  assert.throws(() => createStarterConfigs({
    workshopConfig: {services: [{binding: "GATEKEEPER_WWWK", service: "other"}]},
    wwwkConfig,
    accountId: "account",
    workshopWorkerName: "workshop",
    wwwkWorkerName: "wwwk",
    connected: true,
  }), /already contains/);
});

test("accepts live service bindings without config-only props", () => {
  const connected = createStarterConfigs({
    workshopConfig,
    wwwkConfig,
    accountId: "account",
    workshopWorkerName: "workshop",
    wwwkWorkerName: "wwwk",
    connected: true,
  }).workshop;
  connected.kv_namespaces = [{binding: "BLUEPRINTS", id: "kv-1"}];
  connected.r2_buckets = [{binding: "BLUEPRINT_CONTENT", bucket_name: "bucket-1"}];
  const version = {resources: {bindings: [
    {name: "ADMINS", type: "json", json: ["admin@example.invalid"]},
    {name: "CF_ACCESS_ISS", type: "plain_text", text: "https://access.example.invalid"},
    {name: "CF_ACCESS_AUD", type: "plain_text", text: "audience"},
    {
      name: "GATEKEEPER_CONTEXT",
      type: "service",
      service: "context",
      entrypoint: "GatekeeperVendor",
      environment: "production",
    },
    {
      name: "GATEKEEPER_CUSTOM",
      type: "service",
      service: "custom",
      entrypoint: "GatekeeperVendor",
      environment: "production",
    },
    {name: "BLUEPRINTS", type: "kv_namespace", namespace_id: "kv-1"},
    {name: "BLUEPRINT_CONTENT", type: "r2_bucket", bucket_name: "bucket-1"},
  ]}};
  assert.doesNotThrow(() => verifyExistingWorkshopIdentity(version, connected));
  version.resources.bindings[5].namespace_id = "other";
  assert.throws(() => verifyExistingWorkshopIdentity(version, connected), /identity does not match/);
  connected.kv_namespaces[0] = {binding: "BLUEPRINTS"};
  assert.throws(() => verifyExistingWorkshopIdentity(version, connected), /explicit/);
});

test("uses only the current production deployment version", () => {
  const deploymentHistory = [
    {id: "old-deployment", versions: [{version_id: "old-version", percentage: 100}]},
    {id: "current-deployment", versions: [{version_id: "current-version", percentage: 100}]},
  ];
  const status = deploymentHistory[1];
  assert.equal(productionVersionId(status), "current-version");
  assert.throws(() => productionVersionId({
    versions: [
      {version_id: "old-version", percentage: 50},
      {version_id: "new-version", percentage: 50},
    ],
  }), /cannot be identified uniquely/);
  assert.throws(() => productionVersionId({deployments: deploymentHistory}), /cannot be identified uniquely/);
});

test("recognizes current and legacy missing Worker responses", () => {
  const unknownWorker = {
    stderr: "This Worker does not exist on your account. [code: 10007]",
  };
  assert.equal(isMissingWorkerError(unknownWorker), true);
  assert.equal(isUnknownWorkerError(unknownWorker), true);
  assert.equal(isMissingWorkerError({
    stdout: "The Worker has no deployments.",
  }), true);
  assert.equal(isUnknownWorkerError({
    stdout: "The Worker has no deployments.",
  }), false);
  assert.equal(isMissingWorkerError({
    stderr: "A request to the Cloudflare API failed. [code: 10000]",
  }), false);
});

test("rejects changed access variables and service identities before live deploy", () => {
  const version = {resources: {bindings: [
    {name: "ADMINS", type: "json", json: ["admin@example.invalid"]},
    {name: "CF_ACCESS_ISS", type: "plain_text", text: "https://access.example.invalid"},
    {name: "CF_ACCESS_AUD", type: "plain_text", text: "audience"},
    {
      name: "GATEKEEPER_CONTEXT",
      type: "service",
      service: "context",
      entrypoint: "GatekeeperVendor",
    },
    {
      name: "GATEKEEPER_CUSTOM",
      type: "service",
      service: "custom",
      entrypoint: "GatekeeperVendor",
    },
  ]}};
  assert.doesNotThrow(() => verifyExistingWorkshopIdentity(version, workshopConfig));
  version.resources.bindings[1].text = "changed";
  assert.throws(
    () => verifyExistingWorkshopIdentity(version, workshopConfig),
    /variable identity does not match/,
  );
  version.resources.bindings[1].text = "https://access.example.invalid";
  version.resources.bindings[4].service = "other";
  assert.throws(
    () => verifyExistingWorkshopIdentity(version, workshopConfig),
    /service identity does not match/,
  );
  version.resources.bindings[4].service = "custom";
  version.resources.bindings[4].environment = "staging";
  assert.throws(
    () => verifyExistingWorkshopIdentity(version, workshopConfig),
    /service identity does not match/,
  );
});

test("verifies the latest Workshop legacy Durable Object migration", () => {
  const config = {
    ...workshopConfig,
    migrations: [
      {
        tag: "v0",
        new_sqlite_classes: ["UserDurableObject", "OverseerDurableObject"],
      },
      {
        tag: "v1",
        new_sqlite_classes: ["AdminSettings"],
      },
    ],
  };
  const version = {resources: {
    bindings: [
      {name: "ADMINS", type: "json", json: ["admin@example.invalid"]},
      {name: "CF_ACCESS_ISS", type: "plain_text", text: "https://access.example.invalid"},
      {name: "CF_ACCESS_AUD", type: "plain_text", text: "audience"},
      {
        name: "GATEKEEPER_CONTEXT",
        type: "service",
        service: "context",
        entrypoint: "GatekeeperVendor",
      },
      {
        name: "GATEKEEPER_CUSTOM",
        type: "service",
        service: "custom",
        entrypoint: "GatekeeperVendor",
      },
    ],
    script_runtime: {migration_tag: "v1"},
  }};
  assert.doesNotThrow(() => verifyExistingWorkshopIdentity(version, config));
  version.resources.script_runtime.migration_tag = "v0";
  assert.throws(
    () => verifyExistingWorkshopIdentity(version, config),
    /Durable Object migration identity does not match/,
  );
});

test("verifies WWWK SQLite Durable Object exports from the live version", () => {
  const version = {resources: {script_runtime: {exports: {
    WwwkLibrary: {type: "durable-object", storage: "sqlite"},
    WwwkGatekeeper: {type: "durable-object", storage: "sqlite", state: "created"},
  }}}};
  assert.doesNotThrow(() => verifyWwwkDurableObjectIdentity(version));
  delete version.resources.script_runtime.exports.WwwkGatekeeper;
  assert.throws(() => verifyWwwkDurableObjectIdentity(version), /WwwkGatekeeper/);
  version.resources.script_runtime.exports.WwwkGatekeeper = {
    type: "durable-object",
    storage: "legacy-kv",
  };
  assert.throws(() => verifyWwwkDurableObjectIdentity(version), /WwwkGatekeeper/);
  version.resources.script_runtime.exports = [
    ["WwwkLibrary", {type: "durable-object", storage: "sqlite"}],
    ["WwwkLibrary", {type: "durable-object", storage: "sqlite"}],
  ];
  assert.throws(() => verifyWwwkDurableObjectIdentity(version), /does not expose/);
});

test("verifies Notion identity without exposing OAuth secret values", () => {
  const config = {
    migrations: [{tag: "v0", new_sqlite_classes: [
      "UserAccount",
      "NotionItemGatekeeperImpl",
      "NotionWorkspaceGatekeeperImpl",
    ]}],
    vars: {BASE_URL: "https://wiki.example.invalid/gatekeeper/notion"},
  };
  const version = {resources: {
    bindings: [
      {name: "BASE_URL", type: "plain_text", text: config.vars.BASE_URL},
      {name: "CLIENT_ID", type: "secret_text"},
      {name: "CLIENT_SECRET", type: "secret_text"},
    ],
    script_runtime: {
      migration_tag: "v0",
      exports: {
        default: {type: "worker"},
        UserAccount: {type: "durable-object", storage: "sqlite"},
        NotionItemGatekeeperImpl: {type: "durable-object", storage: "sqlite"},
        NotionWorkspaceGatekeeperImpl: {
          type: "durable-object",
          storage: "sqlite",
          state: "created",
        },
      },
    },
  }};
  assert.deepEqual(verifyNotionIdentity(version, config), []);
  version.resources.bindings.pop();
  assert.deepEqual(
    verifyNotionIdentity(version, config, {requireSecrets: false}),
    ["CLIENT_SECRET"],
  );
  assert.throws(() => verifyNotionIdentity(version, config), /missing required OAuth secrets/);
  version.resources.bindings.push({
    name: "CLIENT_SECRET",
    type: "plain_text",
    text: "not-a-secret-binding",
  });
  assert.throws(() => verifyNotionIdentity(version, config), /must be a secret binding/);
});

test("accepts an absent WWWK broker and rejects unsafe broker identities", () => {
  const version = {resources: {bindings: []}};
  assert.doesNotThrow(() => verifyWwwkBrokerIdentity(version, "workshop"));
  const broker = {
    name: "CFOS_SOURCE_ACCESS_BROKER",
    type: "service",
    service: "workshop",
    entrypoint: "SourceAccessBroker",
    environment: "production",
  };
  version.resources.bindings.push(broker);
  assert.doesNotThrow(() => verifyWwwkBrokerIdentity(version, "workshop"));
  delete broker.service;
  assert.throws(
    () => verifyWwwkBrokerIdentity(version, "workshop"),
    /CFOS_SOURCE_ACCESS_BROKER identity/,
  );
  broker.service = "other";
  assert.throws(
    () => verifyWwwkBrokerIdentity(version, "workshop"),
    /CFOS_SOURCE_ACCESS_BROKER identity/,
  );
  broker.service = "workshop";
  broker.entrypoint = "OtherEntrypoint";
  assert.throws(
    () => verifyWwwkBrokerIdentity(version, "workshop"),
    /CFOS_SOURCE_ACCESS_BROKER identity/,
  );
  broker.entrypoint = "SourceAccessBroker";
  broker.environment = "other";
  assert.throws(
    () => verifyWwwkBrokerIdentity(version, "workshop"),
    /CFOS_SOURCE_ACCESS_BROKER identity/,
  );
  delete broker.environment;
  version.resources.bindings.push({...broker});
  assert.throws(
    () => verifyWwwkBrokerIdentity(version, "workshop"),
    /CFOS_SOURCE_ACCESS_BROKER identity/,
  );
});

test("requires both sides to be disconnected before WWWK data erasure", () => {
  const disconnected = createStarterConfigs({
    workshopConfig,
    wwwkConfig,
    accountId: "account",
    workshopWorkerName: "workshop",
    wwwkWorkerName: "wwwk",
    connected: false,
  });
  const workshopVersion = {resources: {bindings: [
    {name: "ADMINS", type: "json", json: ["admin@example.invalid"]},
    {name: "CF_ACCESS_ISS", type: "plain_text", text: "https://access.example.invalid"},
    {name: "CF_ACCESS_AUD", type: "plain_text", text: "audience"},
    {
      name: "GATEKEEPER_CONTEXT",
      type: "service",
      service: "context",
      entrypoint: "GatekeeperVendor",
    },
    {
      name: "GATEKEEPER_CUSTOM",
      type: "service",
      service: "custom",
      entrypoint: "GatekeeperVendor",
    },
  ]}};
  const wwwkVersion = {resources: {
    bindings: [],
    script_runtime: {exports: {
      WwwkLibrary: {type: "durable-object", storage: "sqlite"},
      WwwkGatekeeper: {type: "durable-object", storage: "sqlite"},
    }},
  }};
  const options = {
    workshopVersion,
    wwwkVersion,
    workshopConfig: disconnected.workshop,
    workshopWorkerName: "workshop",
    wwwkWorkerName: "wwwk",
  };

  assert.doesNotThrow(() => verifyWwwkEraseIdentity(options));
  workshopVersion.resources.bindings.push({
    name: "GATEKEEPER_WWWK",
    type: "service",
    service: "wwwk",
    entrypoint: "GatekeeperVendor",
  });
  assert.throws(() => verifyWwwkEraseIdentity(options), /must be disconnected/);
  workshopVersion.resources.bindings.pop();
  wwwkVersion.resources.bindings.push({
    name: "CFOS_SOURCE_ACCESS_BROKER",
    type: "service",
    service: "workshop",
    entrypoint: "SourceAccessBroker",
  });
  assert.throws(() => verifyWwwkEraseIdentity(options), /must be disconnected/);
  wwwkVersion.resources.bindings.pop();
  wwwkVersion.resources.bindings.push({name: "UNEXPECTED", type: "plain_text", text: "fixture"});
  assert.throws(() => verifyWwwkEraseIdentity(options), /unexpected resource bindings/);
  wwwkVersion.resources.bindings.pop();
  wwwkVersion.resources.script_runtime.exports.Unexpected = {
    type: "durable-object",
    storage: "sqlite",
  };
  assert.throws(() => verifyWwwkEraseIdentity(options), /unexpected Durable Object exports/);
});

test("accepts a deletion version only after live Durable Object exports disappear", () => {
  const version = {resources: {script_runtime: {exports: {
    default: {type: "worker", state: "created"},
  }}}};
  assert.doesNotThrow(() => verifyWwwkDeletionVersion(version));
  version.resources.script_runtime.exports.WwwkGatekeeper = {
    type: "durable-object",
    storage: "sqlite",
  };
  assert.throws(
    () => verifyWwwkDeletionVersion(version),
    /still has a live Durable Object export/,
  );
});

test("accepts only the selected WWWK binding while preparing disconnect", () => {
  const disconnected = createStarterConfigs({
    workshopConfig,
    wwwkConfig,
    accountId: "account",
    workshopWorkerName: "workshop",
    wwwkWorkerName: "wwwk",
    connected: false,
  }).workshop;
  const version = {resources: {bindings: [
    {name: "ADMINS", type: "json", json: ["admin@example.invalid"]},
    {name: "CF_ACCESS_ISS", type: "plain_text", text: "https://access.example.invalid"},
    {name: "CF_ACCESS_AUD", type: "plain_text", text: "audience"},
    {
      name: "GATEKEEPER_CONTEXT",
      type: "service",
      service: "context",
      entrypoint: "GatekeeperVendor",
    },
    {
      name: "GATEKEEPER_CUSTOM",
      type: "service",
      service: "custom",
      entrypoint: "GatekeeperVendor",
    },
    {
      name: "GATEKEEPER_WWWK",
      type: "service",
      service: "wwwk",
      entrypoint: "GatekeeperVendor",
      environment: "production",
    },
  ]}};
  assert.doesNotThrow(() => verifyExistingWorkshopIdentity(version, disconnected, "wwwk"));
  version.resources.bindings[5].service = "other";
  assert.throws(
    () => verifyExistingWorkshopIdentity(version, disconnected, "wwwk"),
    /binding identity does not match/,
  );
  version.resources.bindings[5].service = "wwwk";
  version.resources.bindings[5].environment = "other";
  assert.throws(
    () => verifyExistingWorkshopIdentity(version, disconnected, "wwwk"),
    /binding identity does not match/,
  );
});
