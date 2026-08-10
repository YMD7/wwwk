import {
  DurableObject,
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
  description: { awaitDecision?: boolean };
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
