import assert from "node:assert/strict";
import test from "node:test";
import {
  compatibility,
  createIntegrationConfigs,
  serializeIntegrationConfigs,
  verifyCompatibility,
} from "./installer-poc.mjs";

const workshopConfig = {services: [{binding: "OTHER", service: "other"}]};
const wwwkConfig = {
  services: [{
    binding: "CFOS_SOURCE_ACCESS_BROKER",
    service: "workshop-backend",
    entrypoint: "SourceAccessBroker",
  }],
};

test("records exactly one supported revision tuple", () => {
  assert.doesNotThrow(() => verifyCompatibility({
    starter: compatibility.starter.revision,
    cfos: compatibility.cfos.baseRevision,
  }));
  assert.throws(
    () => verifyCompatibility({starter: "other", cfos: compatibility.cfos.baseRevision}),
    /Unsupported Cloudflare OS Starter revision/,
  );
  assert.throws(
    () => verifyCompatibility({starter: compatibility.starter.revision, cfos: "other"}),
    /Unsupported Cloudflare OS revision/,
  );
});

test("creates reciprocal service bindings without mutating inputs", () => {
  const result = createIntegrationConfigs({
    workshopConfig,
    wwwkConfig,
    workshopWorkerName: "actual-workshop-name",
    wwwkWorkerName: "actual-wwwk-name",
  });

  assert.deepEqual(result.workshop.services.at(-1), {
    binding: "GATEKEEPER_WWWK",
    service: "actual-wwwk-name",
    entrypoint: "WwwkGatekeeper",
  });
  assert.equal(result.wwwk.services[0].service, "actual-workshop-name");
  assert.equal(workshopConfig.services.length, 1);
  assert.equal(wwwkConfig.services[0].service, "workshop-backend");
});

test("rejects incomplete or conflicting binding configs before generation", () => {
  assert.throws(
    () => createIntegrationConfigs({
      workshopConfig: {services: []},
      wwwkConfig: {services: []},
      workshopWorkerName: "workshop",
      wwwkWorkerName: "wwwk",
    }),
    /exactly one CFOS_SOURCE_ACCESS_BROKER/,
  );
  assert.throws(
    () => createIntegrationConfigs({
      workshopConfig: {services: [{binding: "GATEKEEPER_WWWK"}]},
      wwwkConfig,
      workshopWorkerName: "workshop",
      wwwkWorkerName: "wwwk",
    }),
    /already contains GATEKEEPER_WWWK/,
  );
});

test("serializes identical inputs deterministically", () => {
  const options = {
    workshopConfig,
    wwwkConfig,
    workshopWorkerName: "actual-workshop-name",
    wwwkWorkerName: "actual-wwwk-name",
  };
  assert.equal(
    serializeIntegrationConfigs(createIntegrationConfigs(options)),
    serializeIntegrationConfigs(createIntegrationConfigs(options)),
  );
});
