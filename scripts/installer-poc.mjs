import compatibility from "../installer/compatibility.json" with {type: "json"};

const brokerBinding = "CFOS_SOURCE_ACCESS_BROKER";
const wwwkBinding = "GATEKEEPER_WWWK";

function requireWorkerName(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is required.`);
  }
}

function requireServices(config, label) {
  if (!config || !Array.isArray(config.services)) {
    throw new Error(`${label} must contain services.`);
  }
}

export function verifyCompatibility(revisions) {
  if (revisions.starter !== compatibility.starter.revision) {
    throw new Error("Unsupported Cloudflare OS Starter revision.");
  }
  if (revisions.cfos !== compatibility.cfos.baseRevision) {
    throw new Error("Unsupported Cloudflare OS revision.");
  }
}

export function createIntegrationConfigs({
  workshopConfig,
  wwwkConfig,
  workshopWorkerName,
  wwwkWorkerName,
}) {
  requireWorkerName(workshopWorkerName, "Workshop Worker name");
  requireWorkerName(wwwkWorkerName, "WWWK Worker name");
  requireServices(workshopConfig, "Workshop config");
  requireServices(wwwkConfig, "WWWK config");

  if (workshopConfig.services.some(service => service.binding === wwwkBinding)) {
    throw new Error(`Workshop config already contains ${wwwkBinding}.`);
  }

  const brokerServices = wwwkConfig.services.filter(
    service => service.binding === brokerBinding,
  );
  if (brokerServices.length !== 1) {
    throw new Error(`WWWK config must contain exactly one ${brokerBinding}.`);
  }

  return {
    workshop: {
      ...workshopConfig,
      services: [...workshopConfig.services, {
        binding: wwwkBinding,
        service: wwwkWorkerName,
        entrypoint: "WwwkGatekeeper",
      }],
    },
    wwwk: {
      ...wwwkConfig,
      services: wwwkConfig.services.map(service =>
        service.binding === brokerBinding
          ? {...service, service: workshopWorkerName}
          : service,
      ),
    },
  };
}

export function serializeIntegrationConfigs(configs) {
  return `${JSON.stringify(configs, null, 2)}\n`;
}

export {compatibility};
