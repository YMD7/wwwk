import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { readFileSync } from "node:fs";
import { kCurrentWorker } from "miniflare";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    {
      name: "wwwk-skill-text",
      enforce: "pre",
      load(id) {
        if (!id.endsWith("/SKILL.md")) return null;
        return `export default ${JSON.stringify(readFileSync(id, "utf8"))};`;
      },
    },
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/worker.ts",
      miniflare: {
        compatibilityDate: "2026-02-02",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: {
          WWWK_LIBRARY: { className: "WwwkLibrary", useSQLite: true },
          WWWK_GATEKEEPER: {
            className: "WwwkGatekeeper",
            useSQLite: true,
          },
          WWWK_TEST_PARENT: {
            className: "WwwkTestParent",
            useSQLite: true,
          },
          OPAQUE_HANDLE_POC: {
            className: "OpaqueHandlePoc",
            useSQLite: true,
          },
        },
        serviceBindings: {
          TEST_APPROVAL_QUEUE: {
            name: kCurrentWorker,
            entrypoint: "TestApprovalQueue",
          },
          CFOS_SOURCE_ACCESS_BROKER: {
            name: kCurrentWorker,
            entrypoint: "TestSourceBroker",
          },
        },
      },
    }),
  ],
  test: {
    include: ["__tests__/*.test.ts"],
  },
});
