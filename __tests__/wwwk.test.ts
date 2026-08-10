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

  it("承認前は保存せず、承認後だけ検索可能にする", async () => {
    const parent = testEnv.WWWK_TEST_PARENT.getByName("parent-a");
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
  });

  it("拒否したactionの文書を保存しない", async () => {
    const parent = testEnv.WWWK_TEST_PARENT.getByName("parent-a");
    const batch = makeBatch("rejected");
    const action = await parent.ingest("owner-a", {
      source: { title: batch.source.title, content: batch.source.content },
      evidence: { title: batch.evidence.title, content: batch.evidence.content },
      wiki: { title: batch.wiki.title, content: batch.wiki.content },
    });

    await parent.reject("owner-a", action.actionId);
    await expect(parent.search("owner-a", "検証用")).resolves.toEqual([]);
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
