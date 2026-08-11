import {
  DurableObject,
  RpcStub as NativeRpcStub,
  RpcTarget,
  WorkerEntrypoint,
} from "cloudflare:workers";
import {
  WwwkAccount,
  WwwkGatekeeper,
  type WwwkSessionImpl,
} from "../src/index.js";

export {
  default,
  WwwkAccount,
  WwwkGatekeeper,
  WwwkLibrary,
} from "../src/index.js";

type IngestInput = Parameters<WwwkSessionImpl["ingest"]>[0];
type TestExports = {
  WwwkAccount(options: {
    props: { accountId: string };
  }): Fetcher<WwwkAccount>;
  WwwkGatekeeper(options: {
    props: { accountId: string };
  }): DurableObjectClass<WwwkGatekeeper>;
};
type SubmittedAction = {
  actionId: number;
  description: { awaitDecision?: boolean; description?: string };
};

let submittedAction: SubmittedAction | null = null;
let workspaceShared = false;
let sharingProhibited = false;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function capture<T>(operation: () => Promise<T>) {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

class TestApprovalQueueTarget extends RpcTarget {
  async authorizeObservation(
    description: { prohibitAllSharing?: boolean },
  ): Promise<void> {
    if (!description.prohibitAllSharing) return;
    if (workspaceShared) {
      throw new Error("The test workspace is already shared.");
    }
    sharingProhibited = true;
  }

  async submitAction(
    actionId: number,
    description: { awaitDecision?: boolean },
  ): Promise<void> {
    if (sharingProhibited) {
      throw new Error("Actions are prohibited after a private observation.");
    }
    submittedAction = { actionId, description };
  }

  [Symbol.dispose](): void {}
}

/** 承認queue capabilityを発行するテスト専用entrypoint。 */
export class TestApprovalQueue extends WorkerEntrypoint {
  create(): TestApprovalQueueTarget {
    return new TestApprovalQueueTarget();
  }
}

let brokerHandle: string | undefined;
let brokerRevoked = false;
let brokerSessionCount = 0;
let brokerVendorId = "notion";
let brokerTsType = "NotionPage";

class TestBrokerReadSession extends RpcTarget {
  constructor(private readonly sessionId: number) {
    super();
  }

  async getMetadata() {
    if (brokerRevoked) throw new Error("Source access was revoked.");
    return {
      title: "連携テストページ",
      url: "https://www.notion.so/example/linked-page",
      lastEditedAt: new Date("2026-08-11T00:00:00.123Z"),
    };
  }

  async getContent(): Promise<string> {
    if (brokerRevoked) throw new Error("Source access was revoked.");
    return `fresh-session-${this.sessionId}`;
  }

  [Symbol.dispose](): void {}
}

/** CFOS の stable Broker service binding を模倣する、test-only entrypoint。 */
export class TestSourceBroker extends WorkerEntrypoint {
  issue(): string {
    brokerHandle = crypto.randomUUID();
    brokerRevoked = false;
    return brokerHandle;
  }

  revoke(handle: string): void {
    if (handle === brokerHandle) brokerRevoked = true;
  }

  async describe(handle: string) {
    if (handle !== brokerHandle || brokerRevoked) {
      return null;
    }
    return {
      vendorId: brokerVendorId,
      url: "https://www.notion.so/example/linked-page",
      title: "連携テストページ",
      tsType: brokerTsType,
    };
  }

  async openReadSession(handle: string): Promise<RpcStub<TestBrokerReadSession>> {
    if (!await this.describe(handle)) throw new Error("Source handle is unavailable.");
    return new NativeRpcStub(new TestBrokerReadSession(++brokerSessionCount));
  }
}

/** WWWK 側で handle だけを永続化するための test-only Durable Object。 */
export class OpaqueHandlePoc extends DurableObject<Cloudflare.Env> {
  private broker(): Fetcher<TestSourceBroker> {
    const exports = this.ctx.exports as unknown as {
      TestSourceBroker(options: object): Fetcher<TestSourceBroker>;
    };
    return exports.TestSourceBroker({});
  }

  async ingest(handle: string): Promise<void> {
    if (!await this.broker().describe(handle)) {
      throw new Error("Source handle is unavailable.");
    }
    this.ctx.storage.kv.put("linkedSourceHandle", handle);
  }

  async read(): Promise<string | null> {
    const handle = this.ctx.storage.kv.get<string>("linkedSourceHandle");
    if (!handle) return null;
    try {
      if (!await this.broker().describe(handle)) return null;
      const session = await this.broker().openReadSession(handle);
      try {
        return await session.getContent();
      } finally {
        session[Symbol.dispose]();
      }
    } catch {
      return null;
    }
  }

  storedHandle(): string | undefined {
    return this.ctx.storage.kv.get<string>("linkedSourceHandle");
  }
}

/** 実際のFacet propsとSession RPCを通すテスト専用parent。 */
export class WwwkTestParent extends DurableObject<Cloudflare.Env> {
  private gatekeeper(accountId: string): DurableObjectStub<WwwkGatekeeper> {
    const exports = this.ctx.exports as unknown as TestExports;
    const gatekeeperClass = exports.WwwkGatekeeper({ props: { accountId } });
    return this.ctx.facets.get(`wwwk-${accountId}`, () => ({
      class: gatekeeperClass,
    }));
  }

  private async queue(): Promise<RpcStub<TestApprovalQueueTarget>> {
    const exports = this.ctx.exports as unknown as {
      TestApprovalQueue(options: object): Fetcher<TestApprovalQueue>;
    };
    return exports.TestApprovalQueue({}).create();
  }

  async ingest(accountId: string, input: IngestInput): Promise<SubmittedAction> {
    submittedAction = null;
    const session = await this.gatekeeper(accountId).startSession(
      await this.queue() as never,
    );
    await session.ingest(input);
    if (!submittedAction) throw new Error("The action was not submitted.");
    return submittedAction;
  }

  async ingestLinked(accountId: string): Promise<SubmittedAction> {
    const broker = (this.env as Cloudflare.Env & {
      CFOS_SOURCE_ACCESS_BROKER: Fetcher<TestSourceBroker>;
    }).CFOS_SOURCE_ACCESS_BROKER;
    return this.ingest(accountId, {
      source: {
        kind: "linked",
        sourceHandle: await broker.issue(),
      },
      evidence: {
        title: "連携ページから得た根拠",
        content: "連携された本文を根拠として扱います。",
      },
      wiki: {
        title: "連携ページのWiki",
        content: "連携ページの内容を整理したWikiです。",
      },
    });
  }

  async ingestLinkedOutcome(accountId: string) {
    return capture(() => this.ingestLinked(accountId));
  }

  setLinkedSourceRevoked(revoked: boolean): void {
    brokerRevoked = revoked;
  }

  setLinkedSourceKind(vendorId: string, tsType: string): void {
    brokerVendorId = vendorId;
    brokerTsType = tsType;
  }

  configureSharing(shared: boolean): void {
    workspaceShared = shared;
    sharingProhibited = false;
  }

  async ingestOutcome(accountId: string, input: IngestInput) {
    return capture(() => this.ingest(accountId, input));
  }

  approve(accountId: string, actionId: number): Promise<void> {
    return this.gatekeeper(accountId).applyAction(actionId);
  }

  async approveOutcome(accountId: string, actionId: number) {
    return capture(() => this.approve(accountId, actionId));
  }

  reject(accountId: string, actionId: number): Promise<void> {
    return this.gatekeeper(accountId).rejectAction(actionId);
  }

  async search(accountId: string, query: string) {
    const session = await this.gatekeeper(accountId).startSession(
      await this.queue() as never,
    );
    return session.search(query);
  }

  async searchOutcome(accountId: string, query: string) {
    return capture(() => this.search(accountId, query));
  }

  async read(accountId: string, id: string) {
    const session = await this.gatekeeper(accountId).startSession(
      await this.queue() as never,
    );
    return session.read(id);
  }

  async readOutcome(accountId: string, id: string) {
    return capture(() => this.read(accountId, id));
  }

  async revoke(accountId: string): Promise<void> {
    const exports = this.ctx.exports as unknown as TestExports;
    await exports.WwwkAccount({ props: { accountId } }).revoke();
  }

  async discover(accountId: string) {
    const gatekeeper = this.gatekeeper(accountId);
    const authorizer = await this.queue();
    const catalog = await gatekeeper.getAgentCatalog(
      { limit: 1 },
      authorizer as never,
    );
    const provider = await gatekeeper.getSlashCommandProvider();
    const commands = await provider.list();
    const expansion = await provider.invoke(
      "wwwk",
      "保存方法を確認",
      authorizer as never,
    );
    return { catalog, commands, expansion };
  }
}
