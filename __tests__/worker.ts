import {
  DurableObject,
  RpcTarget,
  WorkerEntrypoint,
} from "cloudflare:workers";
import {
  WwwkGatekeeper,
  type WwwkSessionImpl,
} from "../src/index.js";

export { default, WwwkGatekeeper, WwwkLibrary } from "../src/index.js";

type IngestInput = Parameters<WwwkSessionImpl["ingest"]>[0];
type TestExports = {
  WwwkGatekeeper(options: {
    props: { accountId: string };
  }): DurableObjectClass<WwwkGatekeeper>;
};
type SubmittedAction = {
  actionId: number;
  description: { awaitDecision?: boolean };
};

let submittedAction: SubmittedAction | null = null;

class TestApprovalQueueTarget extends RpcTarget {
  async authorizeObservation(): Promise<void> {}

  async submitAction(
    actionId: number,
    description: { awaitDecision?: boolean },
  ): Promise<void> {
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

  approve(accountId: string, actionId: number): Promise<void> {
    return this.gatekeeper(accountId).applyAction(actionId);
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

  async read(accountId: string, id: string) {
    const session = await this.gatekeeper(accountId).startSession(
      await this.queue() as never,
    );
    return session.read(id);
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
