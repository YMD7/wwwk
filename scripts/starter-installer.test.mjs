import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createStarterConfigs,
  loadExternalDeploymentConfig,
  parseArgs,
  runStarterInstaller,
  verifyExistingWorkshopIdentity,
} from "./starter-installer.mjs";

const workshopConfig = {services: [{binding: "GATEKEEPER_CONTEXT", service: "context"}]};
const wwwkConfig = {
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

test("parses Starter install and disconnect commands", () => {
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
    "disconnect",
    "--starter", "/tmp/starter",
    "--wwwk-worker", "my-wwwk",
    "--state-dir", "/tmp/state",
    "--deployment-config", "/tmp/deployment.jsonc",
  ]).command, "disconnect");
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

test("rejects live apply before reading or creating integration state", async () => {
  await assert.rejects(runStarterInstaller({apply: true}), /Live deploy is disabled/);
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
  assert.equal(workshopConfig.services.length, 1);
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

test("rejects invalid Durable Object identity and conflicting Workshop bindings", () => {
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

test("requires explicit existing resource identities before apply", () => {
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
    {name: "BLUEPRINTS", namespace_id: "kv-1"},
    {name: "BLUEPRINT_CONTENT", bucket_name: "bucket-1"},
  ]}};
  assert.doesNotThrow(() => verifyExistingWorkshopIdentity(version, connected));
  version.resources.bindings[0].namespace_id = "other";
  assert.throws(() => verifyExistingWorkshopIdentity(version, connected), /identity does not match/);
  connected.kv_namespaces[0] = {binding: "BLUEPRINTS"};
  assert.throws(() => verifyExistingWorkshopIdentity(version, connected), /explicit/);
});
