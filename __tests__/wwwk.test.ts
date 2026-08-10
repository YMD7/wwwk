import { env } from "cloudflare:workers";
import {
  abortAllDurableObjects,
  reset,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { WwwkGatekeeper, WwwkLibrary } from "../src/index.js";
import type { WwwkTestParent } from "./worker.js";

type Batch = Parameters<WwwkLibrary["applyIngest"]>[0];
type IngestInput = Parameters<WwwkTestParent["ingest"]>[1];

const testEnv = env as unknown as {
  WWWK_LIBRARY: DurableObjectNamespace<WwwkLibrary>;
  WWWK_GATEKEEPER: DurableObjectNamespace<WwwkGatekeeper>;
  WWWK_TEST_PARENT: DurableObjectNamespace<WwwkTestParent>;
};

function makeBatch(prefix = "first"): Batch {
  const createdAt = 1_786_384_800_000;
  return {
    source: {
      id: `${prefix}-source`,
      type: "source",
      title: "入力テキスト",
      content: "これは検証用の明示された入力テキストです。",
      contentHash: "1".repeat(64),
      metadataJson: "{}",
      isAvailable: 1,
      createdAt,
    },
    evidence: {
      id: `${prefix}-evidence`,
      type: "evidence",
      title: "入力から得た根拠",
      content: "入力テキストには検証用であると記載されています。",
      contentHash: "2".repeat(64),
      metadataJson: "{}",
      isAvailable: 1,
      createdAt,
    },
    wiki: {
      id: `${prefix}-wiki`,
      type: "wiki",
      title: "検証用Wiki",
      content: "検証用の入力と根拠を保存したWikiです。",
      contentHash: "3".repeat(64),
      metadataJson: "{}",
      isAvailable: 1,
      createdAt,
    },
  };
}

function makeInput(batch: Batch): IngestInput {
  return {
    source: { title: batch.source.title, content: batch.source.content },
    evidence: { title: batch.evidence.title, content: batch.evidence.content },
    wiki: { title: batch.wiki.title, content: batch.wiki.content },
  };
}

afterEach(async () => {
  await reset();
});

describe("WwwkLibrary", () => {
  it("3層と2リンクを保存し、WikiからSourceまで辿れる", async () => {
    const library = testEnv.WWWK_LIBRARY.getByName("owner-a");
    const batch = makeBatch();

    await library.applyIngest(batch);
    await expect(library.applyIngest(batch)).resolves.toBeUndefined();

    const results = await library.search("検証用", "wiki", 20);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: batch.wiki.id, type: "wiki" });

    const wiki = await library.read(batch.wiki.id);
    expect(wiki?.inputs).toEqual([{
      id: batch.evidence.id,
      type: "evidence",
      title: batch.evidence.title,
    }]);
    const evidence = await library.read(wiki!.inputs[0].id);
    expect(evidence?.inputs).toEqual([{
      id: batch.source.id,
      type: "source",
      title: batch.source.title,
    }]);
    const source = await library.read(evidence!.inputs[0].id);
    expect(source?.content).toBe(batch.source.content);
  });

  it("transaction失敗時に途中状態を残さない", async () => {
    const library = testEnv.WWWK_LIBRARY.getByName("owner-a");
    const batch = makeBatch();
    batch.wiki.content = "";

    await runInDurableObject(library, (instance) => {
      expect(() => instance.applyIngest(batch)).toThrow();
    });
    await expect(library.read(batch.source.id)).resolves.toBeNull();
    await expect(library.read(batch.evidence.id)).resolves.toBeNull();
    await expect(library.read(batch.wiki.id)).resolves.toBeNull();
  });

  it("不一致の再試行を拒否して既存データを保持する", async () => {
    const library = testEnv.WWWK_LIBRARY.getByName("owner-a");
    const batch = makeBatch();
    await library.applyIngest(batch);

    const mismatch = makeBatch();
    mismatch.source.content = "異なる本文";
    await runInDurableObject(library, (instance) => {
      expect(() => instance.applyIngest(mismatch)).toThrow(
        "does not exactly match",
      );
    });
    await expect(library.read(batch.source.id)).resolves.toMatchObject({
      content: batch.source.content,
    });
  });

  it("Libraryをユーザーごとに分離する", async () => {
    const ownerA = testEnv.WWWK_LIBRARY.getByName("owner-a");
    const ownerB = testEnv.WWWK_LIBRARY.getByName("owner-b");
    const batch = makeBatch();
    await ownerA.applyIngest(batch);

    await expect(ownerA.search("検証用", "wiki", 20)).resolves.toHaveLength(1);
    await expect(ownerB.search("検証用", "wiki", 20)).resolves.toEqual([]);
    await expect(ownerB.read(batch.wiki.id)).resolves.toBeNull();
  });

  it("Durable Object再起動後も保存内容を返す", async () => {
    const batch = makeBatch();
    await testEnv.WWWK_LIBRARY.getByName("owner-a").applyIngest(batch);

    await abortAllDurableObjects();

    const restarted = testEnv.WWWK_LIBRARY.getByName("owner-a");
    await expect(restarted.read(batch.source.id)).resolves.toMatchObject({
      content: batch.source.content,
    });
  });

  it("3層と2リンクをまとめてrevertする", async () => {
    const library = testEnv.WWWK_LIBRARY.getByName("owner-a");
    const batch = makeBatch();
    await library.applyIngest(batch);

    await library.revertIngest({
      sourceId: batch.source.id,
      evidenceId: batch.evidence.id,
      wikiId: batch.wiki.id,
    });

    await expect(library.read(batch.source.id)).resolves.toBeNull();
    await expect(library.read(batch.evidence.id)).resolves.toBeNull();
    await expect(library.read(batch.wiki.id)).resolves.toBeNull();
  });
});

describe("WwwkGatekeeper", () => {
  it("catalogと/wwwkからSessionのAgent Skillを発見できる", async () => {
    const parent = testEnv.WWWK_TEST_PARENT.getByName("parent-a");
    const discovery = await parent.discover("owner-a");

    expect(discovery.catalog.entries).toHaveLength(1);
    expect(discovery.catalog.entries[0].id).toBe("wwwk-session");
    expect(discovery.commands).toEqual([expect.objectContaining({
      id: "wwwk",
      name: "wwwk",
    })]);
    expect(discovery.expansion).toMatchObject({ skillName: "wwwk" });
    expect(discovery.expansion.message).toContain("<agent_skill>");
    expect(discovery.expansion.message).toContain("WwwkSession.search");
    expect(discovery.expansion.message).toContain("保存方法を確認");
  });

  it("privateでは保存と参照ができ、共有中は参照を拒否する", async () => {
    const parent = testEnv.WWWK_TEST_PARENT.getByName("parent-a");
    await parent.configureSharing(false);
    const batch = makeBatch();
    const action = await parent.ingest("owner-a", {
      source: { title: batch.source.title, content: batch.source.content },
      evidence: { title: batch.evidence.title, content: batch.evidence.content },
      wiki: { title: batch.wiki.title, content: batch.wiki.content },
    });

    expect(action.description.awaitDecision).toBe(true);
    await expect(parent.search("owner-a", "検証用")).resolves.toEqual([]);

    await parent.approve("owner-a", action.actionId);
    const results = await parent.search("owner-a", "検証用");
    expect(results).toHaveLength(1);
    const wiki = await parent.read("owner-a", results[0].id);
    const evidence = await parent.read("owner-a", wiki!.inputs[0].id);
    const source = await parent.read("owner-a", evidence!.inputs[0].id);
    expect(source?.content).toBe(batch.source.content);
    await expect(parent.search("owner-b", "検証用")).resolves.toEqual([]);

    await parent.configureSharing(true);
    await expect(
      parent.searchOutcome("owner-a", "検証用"),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("shared"),
    });
    await expect(
      parent.readOutcome("owner-a", results[0].id),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("shared"),
    });
  });

  it("拒否したactionの文書を保存しない", async () => {
    const parent = testEnv.WWWK_TEST_PARENT.getByName("parent-a");
    await parent.configureSharing(false);
    const batch = makeBatch("rejected");
    const action = await parent.ingest("owner-a", makeInput(batch));

    await parent.reject("owner-a", action.actionId);
    await expect(parent.search("owner-a", "検証用")).resolves.toEqual([]);
  });

  it("revoke後は再起動しても旧Facetとpending actionを拒否する", async () => {
    const parent = testEnv.WWWK_TEST_PARENT.getByName("parent-a");
    await parent.configureSharing(false);
    const stored = makeBatch("stored");
    const storedAction = await parent.ingest("owner-a", makeInput(stored));
    await parent.approve("owner-a", storedAction.actionId);

    const pending = makeBatch("pending");
    const pendingAction = await parent.ingest("owner-a", makeInput(pending));
    const results = await parent.search("owner-a", "検証用");
    const wikiId = results[0].id;

    await parent.revoke("owner-a");
    await abortAllDurableObjects();

    const restartedParent = testEnv.WWWK_TEST_PARENT.getByName("parent-a");
    await expect(
      restartedParent.searchOutcome("owner-a", "検証用"),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("permanently revoked"),
    });
    await expect(
      restartedParent.readOutcome("owner-a", wikiId),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("permanently revoked"),
    });
    await expect(
      restartedParent.approveOutcome("owner-a", pendingAction.actionId),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("permanently revoked"),
    });
    await expect(
      restartedParent.approveOutcome("owner-a", pendingAction.actionId),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("does not exist"),
    });
    await expect(
      restartedParent.ingestOutcome("owner-a", makeInput(pending)),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("permanently revoked"),
    });

    const restartedLibrary = testEnv.WWWK_LIBRARY.getByName("owner-a");
    await runInDurableObject(restartedLibrary, (_instance, state) => {
      const documentCount = state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM documents",
      ).one().count;
      const inputCount = state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM document_inputs",
      ).one().count;
      expect({ documentCount, inputCount }).toEqual({
        documentCount: 0,
        inputCount: 0,
      });
      expect(state.storage.kv.get("libraryRevoked")).toBe(true);
    });
  });

  it("拒否したpending actionを削除する", async () => {
    const gatekeeper = testEnv.WWWK_GATEKEEPER.getByName("gatekeeper-a");
    const batch = makeBatch();
    await runInDurableObject(gatekeeper, async (instance, state) => {
      state.storage.kv.put("action:1", { status: "pending", batch });
      await instance.rejectAction(1);
      expect(state.storage.kv.get("action:1")).toBeUndefined();
    });
  });
});
