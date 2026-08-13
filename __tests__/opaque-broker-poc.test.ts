import { env } from "cloudflare:workers";
import { abortAllDurableObjects, reset } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import type { OpaqueHandlePoc, TestSourceBroker } from "./worker.js";

const testEnv = env as unknown as {
  OPAQUE_HANDLE_POC: DurableObjectNamespace<OpaqueHandlePoc>;
  CFOS_SOURCE_ACCESS_BROKER: Fetcher<TestSourceBroker>;
};

afterEach(async () => {
  await reset();
});

it("exchanges the ticket, persists only an internal handle, and fails closed", async () => {
  const ticket = await testEnv.CFOS_SOURCE_ACCESS_BROKER.issue();
  const library = testEnv.OPAQUE_HANDLE_POC.getByName("owner-a");

  await library.ingest(ticket);
  const handle = await library.storedHandle();
  expect(handle).toBeDefined();
  expect(handle).not.toBe(ticket);
  expect(await library.read()).toBe("fresh-session-1");
  expect(await library.read()).toBe("fresh-session-2");

  await abortAllDurableObjects();
  const restarted = testEnv.OPAQUE_HANDLE_POC.getByName("owner-a");
  expect(await restarted.storedHandle()).toBe(handle);
  expect(await restarted.read()).toBe("fresh-session-3");

  await testEnv.CFOS_SOURCE_ACCESS_BROKER.revoke(handle!);
  await expect(restarted.read()).resolves.toBeNull();
});
