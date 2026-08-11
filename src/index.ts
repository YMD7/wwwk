import {
  DurableObject,
  RpcStub as NativeRpcStub,
  RpcTarget as NativeRpcTarget,
  WorkerEntrypoint,
} from "cloudflare:workers";
import { RpcTarget } from "capnweb";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import AGENT_SKILL from "../skills/wwwk/SKILL.md";
import {
  parseBundle,
  serializeBundle,
  sha256Text,
  type BundleDocument,
  type WwwkPortableBundle,
} from "./bundle.js";
import type {
  WwwkDocument,
  WwwkDocumentDraft,
  WwwkDocumentType,
  WwwkIngestInput,
  WwwkInputRef,
  WwwkLinkedSourceInput,
  WwwkSearchResult,
} from "./types.js";
import TYPES_CODE from "./types.txt";

// CFOS 外部 package として単独導入できるよう、公開契約の使用部分だけを構造型で表す。
type ActionKind = { tag: string; label: string };
type AgentCatalogEntry = { id: string; title: string; description: string };
type AgentCatalog = { entries: AgentCatalogEntry[]; truncated?: boolean };
type AgentCatalogRequest = { limit: number };
type GatekeeperConnectOptions = {
  scopes?: "auth" | "full";
  resourceUrlPatterns?: string[];
};
type ObservationDescription = {
  title: string;
  description: string;
  excludeObservers?: string[];
  prohibitAllSharing?: boolean;
};
type ActionDescription = {
  title: string;
  description: string;
  implementsRevert: boolean;
  awaitDecision?: boolean;
};
type ResourceDescription = {
  url: string;
  title: string;
  snippet: string;
  suggestedBindingName: string;
  tsType: string;
  hasSlashCommands?: true;
};
type ResourceConfiguratorFrame = {
  iframeHtml: string;
  ui: NativeRpcStub<NativeRpcTarget>;
};
type SlashCommandDescriptor = {
  id: string;
  name: string;
  description: string;
  resourceLabel?: string;
};
type SlashCommandResult = { skillName?: string; message?: string };
type SupportedResource = {
  urlPattern: string;
  title: string;
  description: string;
};

interface ObservationAuthorizer extends NativeRpcTarget {
  authorizeObservation(description: ObservationDescription): Promise<void>;
}

interface ApprovalQueue extends ObservationAuthorizer {
  submitAction(actionId: number, description: ActionDescription): Promise<void>;
}

const AGENT_CATALOG_MAX_ENTRIES = 25;
const AGENT_CATALOG_MAX_ID_LENGTH = 256;
const AGENT_CATALOG_MAX_TITLE_LENGTH = 100;
const AGENT_CATALOG_MAX_DESCRIPTION_LENGTH = 400;
const LIBRARY_REVOKED_KEY = "libraryRevoked";
const LIBRARY_REVOKED_ERROR = "WWWK account is permanently revoked.";

function boundAgentCatalog(
  entries: AgentCatalogEntry[],
  request: AgentCatalogRequest,
): AgentCatalog {
  const requestedLimit = Number.isFinite(request.limit)
    ? Math.max(0, Math.floor(request.limit))
    : 0;
  const limit = Math.min(requestedLimit, AGENT_CATALOG_MAX_ENTRIES);
  return {
    entries: entries.slice(0, limit).map((entry) => ({
      id: entry.id.slice(0, AGENT_CATALOG_MAX_ID_LENGTH),
      title: entry.title.slice(0, AGENT_CATALOG_MAX_TITLE_LENGTH),
      description: entry.description.slice(
        0,
        AGENT_CATALOG_MAX_DESCRIPTION_LENGTH,
      ),
    })),
    truncated: entries.length > limit,
  };
}

type StoredDocument = BundleDocument & {
  isAvailable: number;
};

type StoredInput = {
  documentId: string;
  inputId: string;
};

type InputRow = {
  id: string;
  type: WwwkDocumentType;
  title: string;
};

type IngestBatch = {
  source: StoredDocument;
  evidence: StoredDocument;
  wiki: StoredDocument;
  linked?: LinkedSourceIngest;
};

type LinkedSourceRecord = {
  sourceId: string;
  vendor: string;
  resource: string;
  revision: string;
  tsType: string;
};

type LinkedSourceIngest = LinkedSourceRecord & {
  sourceHandle: string;
};

type SourceAccessDescription = {
  vendorId: string;
  url: string;
  title: string;
  tsType: string;
};

type SourceAccessBroker = {
  describe(handle: string): Promise<SourceAccessDescription | null>;
  openReadSession(handle: string): Promise<unknown | null>;
};

type NotionPageMetadata = {
  title: string;
  url: string;
  lastEditedAt: Date | string;
};

type NotionPageSession = {
  getMetadata(): Promise<NotionPageMetadata>;
  getContent(): Promise<string>;
  [Symbol.dispose]?: () => void;
};

type IngestIds = {
  sourceId: string;
  evidenceId: string;
  wikiId: string;
};

type PendingAction = {
  status: "pending";
  batch: IngestBatch;
};

type AppliedAction = {
  status: "applied" | "reverted";
  ids: IngestIds;
};

type StoredAction = PendingAction | AppliedAction;

type WwwkAccountProps = {
  accountId: string;
};

const WWWK_ICON = {
  url: "data:image/svg+xml," + encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='currentColor'>" +
      "<path d='M32 40h56c18 0 32 14 32 32v144c-8-10-20-16-32-16H32V40zm192 0h-56c-18 0-32 14-32 32v144c8-10 20-16 32-16h56V40z'/></svg>",
  ),
};

const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 50;

function actionKey(actionId: number): string {
  return `action:${actionId}`;
}

function sourceAccessKey(sourceId: string): string {
  return `sourceAccess:${sourceId}`;
}

function validateSourceAccessDescription(
  description: SourceAccessDescription,
): void {
  if (description.vendorId !== "notion" || description.tsType !== "NotionPage") {
    throw new Error("WWWK supports only linked Notion pages.");
  }
  if (!description.url || !description.title) {
    throw new Error("Linked source description is incomplete.");
  }
}

function getNotionPageSession(value: unknown): NotionPageSession {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    throw new Error("Linked source did not open a Notion page session.");
  }
  return value as NotionPageSession;
}

function toRevision(value: Date | string): string {
  try {
    return value instanceof Date
      ? value.toISOString()
      : new Date(value).toISOString();
  } catch {
    throw new Error("Linked source revision is invalid.");
  }
}

async function readLinkedNotionSourceWithBroker(
  input: WwwkLinkedSourceInput,
  broker: SourceAccessBroker,
): Promise<{
  title: string;
  content: string;
  metadataJson: string;
  linked: Omit<LinkedSourceIngest, "sourceId">;
}> {
  if (!input.sourceHandle) throw new Error("Linked source handle is required.");
  const description = await broker.describe(input.sourceHandle);
  if (!description) throw new Error("Linked source handle is unavailable.");
  validateSourceAccessDescription(description);
  const opened = await broker.openReadSession(input.sourceHandle);
  const session = getNotionPageSession(opened);
  try {
    const [metadata, content] = await Promise.all([
      session.getMetadata(),
      session.getContent(),
    ]);
    if (!metadata.title.trim() || !metadata.url || !content.trim()) {
      throw new Error("Linked Notion page is incomplete.");
    }
    if (metadata.url !== description.url) {
      throw new Error("Linked source metadata does not match its description.");
    }
    const revision = toRevision(metadata.lastEditedAt);
    return {
      title: metadata.title,
      content,
      metadataJson: JSON.stringify({
        vendor: description.vendorId,
        resource: metadata.url,
        revision,
      }),
      linked: {
        vendor: description.vendorId,
        resource: description.url,
        revision,
        tsType: description.tsType,
        sourceHandle: input.sourceHandle,
      },
    };
  } finally {
    session[Symbol.dispose]?.();
  }
}

function idsFromBatch(batch: IngestBatch): IngestIds {
  return {
    sourceId: batch.source.id,
    evidenceId: batch.evidence.id,
    wikiId: batch.wiki.id,
  };
}

function documentValuesEqual(left: StoredDocument, right: StoredDocument): boolean {
  return left.id === right.id &&
    left.type === right.type &&
    left.title === right.title &&
    left.content === right.content &&
    left.contentHash === right.contentHash &&
    left.metadataJson === right.metadataJson &&
    left.isAvailable === right.isAvailable &&
    left.createdAt === right.createdAt;
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_SEARCH_LIMIT;
  if (!Number.isFinite(limit)) throw new Error("limit must be a finite number.");
  return Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.floor(limit)));
}

function validateDocumentType(value: WwwkDocumentType): void {
  if (value !== "source" && value !== "evidence" && value !== "wiki") {
    throw new Error("Unknown WWWK document type.");
  }
}

function validateDraft(name: string, draft: WwwkDocumentDraft): void {
  if (!draft.title.trim()) throw new Error(`${name}.title must not be empty.`);
  if (!draft.content.trim()) throw new Error(`${name}.content must not be empty.`);
}

function isLinkedSource(
  source: WwwkIngestInput["source"],
): source is WwwkLinkedSourceInput {
  return "kind" in source && source.kind === "linked";
}

function makeSnippet(content: string, query: string): string {
  const index = content.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  const start = index < 0 ? 0 : Math.max(0, index - 60);
  const prefix = start > 0 ? "…" : "";
  const suffix = start + 180 < content.length ? "…" : "";
  return prefix + content.slice(start, start + 180) + suffix;
}

function escapeMarkdownInline(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, 120)
    .replace(/([\\`*_{}\[\]()<>#+\-.!|])/g, "\\$1");
}

function buildSkillMessage(args: string): string {
  const usesArgument = /\$ARGUMENT(?![A-Za-z0-9_[])/.test(AGENT_SKILL);
  const expanded = AGENT_SKILL.replace(
    /\$ARGUMENT(?![A-Za-z0-9_[])/g,
    () => args,
  );
  const message = `<agent_skill>\n${expanded}\n</agent_skill>`;
  return !usesArgument && args ? `${message}\n\nARGUMENT: ${args}` : message;
}

class WwwkSlashCommandProvider extends NativeRpcTarget {
  list(): Promise<SlashCommandDescriptor[]> {
    return Promise.resolve([{
      id: "wwwk",
      name: "wwwk",
      description: "WWWKを検索し、原典を辿り、明示されたテキストを保存する。",
    }]);
  }

  async invoke(
    id: string,
    args: string,
    authorizer: NativeRpcStub<ObservationAuthorizer>,
  ): Promise<SlashCommandResult> {
    if (id !== "wwwk") throw new Error("Unknown WWWK slash command.");
    await authorizer.authorizeObservation({
      title: "WWWK Agent Skill",
      description: "Loaded the bundled WWWK Agent Skill.",
    });
    return { skillName: "wwwk", message: buildSkillMessage(args) };
  }

  [Symbol.dispose](): void {}
}

@validateRpc()
export class WwwkSessionImpl extends RpcTarget {
  constructor(
    private library: DurableObjectStub<WwwkLibrary>,
    private approvalQueue: NativeRpcStub<ApprovalQueue>,
    private broker: SourceAccessBroker,
    private submitPendingAction: (batch: IngestBatch) => number,
    private dropPendingAction: (actionId: number) => void,
  ) {
    super();
  }

  [Symbol.dispose](): void {
    this.approvalQueue[Symbol.dispose]?.();
  }

  async search(
    query: string,
    options?: { type?: WwwkDocumentType; limit?: number },
  ): Promise<WwwkSearchResult[]> {
    if (!query.trim()) throw new Error("query must not be empty.");
    const type = options?.type ?? "wiki";
    validateDocumentType(type);
    const results = await this.library.search(
      query,
      type,
      normalizeLimit(options?.limit),
    );
    if (results.length > 0) {
      await this.approvalQueue.authorizeObservation({
        title: "WWWK search",
        description: `Returned ${results.length} personal Wiki result(s).`,
        prohibitAllSharing: true,
      });
    }
    return results;
  }

  async read(id: string): Promise<WwwkDocument | null> {
    if (!id) return null;
    const document = await this.library.read(id);
    if (document) {
      await this.approvalQueue.authorizeObservation({
        title: "WWWK read",
        description: "Read one document from the personal Wiki.",
        prohibitAllSharing: true,
      });
    }
    return document;
  }

  async ingest(input: WwwkIngestInput): Promise<void> {
    validateDraft("evidence", input.evidence);
    validateDraft("wiki", input.wiki);
    await this.library.assertLive();

    let linkedSource: Awaited<ReturnType<typeof readLinkedNotionSourceWithBroker>> | undefined;
    let sourceDraft: WwwkDocumentDraft;
    if (isLinkedSource(input.source)) {
      linkedSource = await readLinkedNotionSourceWithBroker(input.source, this.broker);
      sourceDraft = linkedSource;
    } else {
      validateDraft("source", input.source);
      sourceDraft = input.source;
    }

    const createdAt = Date.now();
    const [sourceHash, evidenceHash, wikiHash] = await Promise.all([
      sha256Text(sourceDraft.content),
      sha256Text(input.evidence.content),
      sha256Text(input.wiki.content),
    ]);
    const batch: IngestBatch = {
      source: {
        id: crypto.randomUUID(),
        type: "source",
        title: sourceDraft.title,
        content: sourceDraft.content,
        contentHash: sourceHash,
        metadataJson: linkedSource?.metadataJson ?? "{}",
        isAvailable: 1,
        createdAt,
      },
      evidence: {
        id: crypto.randomUUID(),
        type: "evidence",
        title: input.evidence.title,
        content: input.evidence.content,
        contentHash: evidenceHash,
        metadataJson: "{}",
        isAvailable: 1,
        createdAt,
      },
      wiki: {
        id: crypto.randomUUID(),
        type: "wiki",
        title: input.wiki.title,
        content: input.wiki.content,
        contentHash: wikiHash,
        metadataJson: "{}",
        isAvailable: 1,
        createdAt,
      },
    };
    if (linkedSource) {
      batch.linked = {
        ...linkedSource.linked,
        sourceId: batch.source.id,
      };
    }

    const actionId = this.submitPendingAction(batch);
    try {
      await this.approvalQueue.submitAction(actionId, {
        title: "Save text to WWWK",
        description:
          `Create three private documents in WWWK:\n\n` +
          `- Source: **${escapeMarkdownInline(sourceDraft.title)}** ` +
          (linkedSource
            ? `(${linkedSource.linked.resource}, `
            : "(") +
          `${Array.from(sourceDraft.content).length} characters)\n` +
          `- Evidence: **${escapeMarkdownInline(input.evidence.title)}**\n` +
          `- Wiki: **${escapeMarkdownInline(input.wiki.title)}**\n\n` +
          "The documents are visible only to the owner and can be reverted together.",
        implementsRevert: true,
        awaitDecision: true,
      });
    } catch (error) {
      this.dropPendingAction(actionId);
      throw error;
    }
  }
}

@validateRpc()
export class WwwkLibrary extends DurableObject<Cloudflare.Env> {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.migrate();
  }

  private migrate(): void {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS _schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at INTEGER NOT NULL
        )
      `);
      const version = this.ctx.storage.sql.exec<{ version: number }>(
        "SELECT COALESCE(MAX(version), 0) AS version FROM _schema_migrations",
      ).one().version;
      if (version < 1) {
        this.ctx.storage.sql.exec(`
          CREATE TABLE documents (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL
              CHECK (type IN ('source', 'evidence', 'wiki')),
            title TEXT NOT NULL CHECK (length(title) > 0),
            content TEXT NOT NULL CHECK (length(content) > 0),
            content_hash TEXT NOT NULL,
            metadata_json TEXT NOT NULL DEFAULT '{}'
              CHECK (json_valid(metadata_json)),
            is_available INTEGER NOT NULL DEFAULT 1
              CHECK (is_available IN (0, 1)),
            created_at INTEGER NOT NULL
          );
          CREATE TABLE document_inputs (
            document_id TEXT NOT NULL
              REFERENCES documents(id) ON DELETE CASCADE,
            input_id TEXT NOT NULL
              REFERENCES documents(id) ON DELETE RESTRICT,
            PRIMARY KEY (document_id, input_id),
            CHECK (document_id <> input_id)
          );
          CREATE INDEX documents_by_scope
            ON documents(type, is_available, created_at DESC);
          CREATE INDEX document_inputs_by_input
            ON document_inputs(input_id, document_id);
        `);
        this.ctx.storage.sql.exec(
          "INSERT INTO _schema_migrations (version, applied_at) VALUES (1, ?)",
          Date.now(),
        );
      }
      if (version < 2) {
        this.ctx.storage.sql.exec(`
          CREATE TABLE linked_sources (
            source_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
            vendor TEXT NOT NULL,
            resource TEXT NOT NULL,
            revision TEXT NOT NULL,
            ts_type TEXT NOT NULL
          );
        `);
        this.ctx.storage.sql.exec(
          "INSERT INTO _schema_migrations (version, applied_at) VALUES (2, ?)",
          Date.now(),
        );
      }
    });
  }

  async search(
    query: string,
    type: WwwkDocumentType,
    limit: number,
  ): Promise<WwwkSearchResult[]> {
    this.assertLive();
    validateDocumentType(type);
    const candidates = this.ctx.storage.sql.exec<{
      id: string;
      type: WwwkDocumentType;
      title: string;
      content: string;
    }>(
      `SELECT id, type, title, content
       FROM documents
       WHERE type = ? AND is_available = 1
         AND (instr(lower(title), lower(?)) > 0
           OR instr(lower(content), lower(?)) > 0)
       ORDER BY created_at DESC, id
       LIMIT ?`,
      type,
      query,
      query,
      limit,
    ).toArray();
    const results: WwwkSearchResult[] = [];
    for (const row of candidates) {
      if (!await this.reauthorizeDocument(row.id)) continue;
      results.push({
      id: row.id,
      type: row.type,
      title: row.title,
      snippet: makeSnippet(row.content, query),
      });
    }
    return results;
  }

  async read(id: string): Promise<WwwkDocument | null> {
    this.assertLive();
    if (!await this.reauthorizeDocument(id)) return null;
    const rows = this.ctx.storage.sql.exec<{
      id: string;
      type: WwwkDocumentType;
      title: string;
      content: string;
    }>(
      `SELECT id, type, title, content
       FROM documents
       WHERE id = ? AND is_available = 1`,
      id,
    ).toArray();
    if (rows.length !== 1) return null;
    const row = rows[0];
    const inputRows = this.ctx.storage.sql.exec<InputRow>(
      `SELECT input.id, input.type, input.title
       FROM document_inputs AS links
       JOIN documents AS input ON input.id = links.input_id
       WHERE links.document_id = ? AND input.is_available = 1
       ORDER BY input.id`,
      id,
    ).toArray();
    const inputs: WwwkInputRef[] = [];
    for (const input of inputRows) {
      if (input.type === "wiki") return null;
      inputs.push({ id: input.id, type: input.type, title: input.title });
    }
    const expectedInputs = row.type === "source" ? 0 : 1;
    if (inputs.length !== expectedInputs) return null;
    if (row.type === "evidence" && inputs[0]?.type !== "source") return null;
    if (row.type === "wiki" && inputs[0]?.type !== "evidence") return null;
    return { ...row, inputs };
  }

  applyIngest(batch: IngestBatch): void {
    const documents = [batch.source, batch.evidence, batch.wiki];
    if (new Set(documents.map((document) => document.id)).size !== 3) {
      throw new Error("WWWK ingest document IDs must be unique.");
    }
    if (
      batch.source.type !== "source" ||
      batch.evidence.type !== "evidence" ||
      batch.wiki.type !== "wiki"
    ) {
      throw new Error("WWWK ingest document types are invalid.");
    }

    this.ctx.storage.transactionSync(() => {
      this.assertLive();
      const existing = this.selectDocuments(
        documents.map((document) => document.id),
      );
      const links = this.selectLinks(documents.map((document) => document.id));
      if (existing.length === 0 && links.length === 0) {
        for (const document of documents) this.insertDocument(document);
        this.ctx.storage.sql.exec(
          "INSERT INTO document_inputs (document_id, input_id) VALUES (?, ?)",
          batch.evidence.id,
          batch.source.id,
        );
        this.ctx.storage.sql.exec(
          "INSERT INTO document_inputs (document_id, input_id) VALUES (?, ?)",
          batch.wiki.id,
          batch.evidence.id,
        );
        if (batch.linked) {
          if (batch.linked.sourceId !== batch.source.id) {
            throw new Error("WWWK linked source does not match its Source document.");
          }
          this.ctx.storage.sql.exec(
            `INSERT INTO linked_sources (
               source_id, vendor, resource, revision, ts_type
             ) VALUES (?, ?, ?, ?, ?)`,
            batch.linked.sourceId,
            batch.linked.vendor,
            batch.linked.resource,
            batch.linked.revision,
            batch.linked.tsType,
          );
          this.ctx.storage.kv.put(
            sourceAccessKey(batch.linked.sourceId),
            batch.linked.sourceHandle,
          );
        }
        return;
      }
      if (!this.ingestMatches(batch, existing, links)) {
        throw new Error("WWWK ingest retry does not exactly match stored data.");
      }
    });
  }

  revertIngest(ids: IngestIds): void {
    const documentIds = [ids.sourceId, ids.evidenceId, ids.wikiId];
    this.ctx.storage.transactionSync(() => {
      this.assertLive();
      const existing = this.selectDocuments(documentIds);
      const links = this.selectLinks(documentIds);
      if (existing.length === 0 && links.length === 0) return;
      if (existing.length !== 3 || !this.linksMatch(ids, links)) {
        throw new Error("WWWK revert found partial or mismatched action data.");
      }
      const types = new Map(existing.map((document) => [document.id, document.type]));
      if (
        types.get(ids.sourceId) !== "source" ||
        types.get(ids.evidenceId) !== "evidence" ||
        types.get(ids.wikiId) !== "wiki"
      ) {
        throw new Error("WWWK revert document types do not match the action.");
      }
      const external = this.ctx.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count
         FROM document_inputs
         WHERE input_id IN (?, ?, ?)
           AND document_id NOT IN (?, ?, ?)`,
        ...documentIds,
        ...documentIds,
      ).one().count;
      if (external !== 0) {
        throw new Error("WWWK action documents have external dependents.");
      }
      this.ctx.storage.sql.exec(
        "DELETE FROM document_inputs WHERE document_id IN (?, ?, ?)",
        ...documentIds,
      );
      const linkedSourceIds = this.ctx.storage.sql.exec<{ sourceId: string }>(
        "SELECT source_id AS sourceId FROM linked_sources WHERE source_id IN (?, ?, ?)",
        ...documentIds,
      ).toArray();
      for (const linked of linkedSourceIds) {
        this.ctx.storage.kv.delete(sourceAccessKey(linked.sourceId));
      }
      this.ctx.storage.sql.exec(
        "DELETE FROM documents WHERE id IN (?, ?, ?)",
        ...documentIds,
      );
    });
  }

  async exportBundle(): Promise<WwwkPortableBundle> {
    this.assertLive();
    const linkedCount = this.ctx.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM linked_sources",
    ).one().count;
    if (linkedCount !== 0) {
      throw new Error("WWWK cannot export Linked Sources.");
    }
    const documents = this.ctx.storage.sql.exec<StoredDocument>(
      `SELECT id, type, title, content,
         content_hash AS contentHash,
         metadata_json AS metadataJson,
         is_available AS isAvailable,
         created_at AS createdAt
       FROM documents
       ORDER BY type, id`,
    ).toArray();
    if (documents.some((document) => document.isAvailable !== 1)) {
      throw new Error("WWWK cannot export unavailable documents.");
    }
    const inputs = this.ctx.storage.sql.exec<StoredInput>(
      `SELECT document_id AS documentId, input_id AS inputId
       FROM document_inputs
       ORDER BY document_id, input_id`,
    ).toArray();
    const bundle = await serializeBundle(documents, inputs);
    this.assertLive();
    return bundle;
  }

  async importBundle(bundle: WwwkPortableBundle): Promise<void> {
    this.assertLive();
    const parsed = await parseBundle(bundle);
    this.ctx.storage.transactionSync(() => {
      this.assertLive();
      const documentCount = this.ctx.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM documents",
      ).one().count;
      const inputCount = this.ctx.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM document_inputs",
      ).one().count;
      const linkedCount = this.ctx.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM linked_sources",
      ).one().count;
      if (documentCount !== 0 || inputCount !== 0 || linkedCount !== 0) {
        throw new Error("WWWK bundle import requires an empty Library.");
      }
      for (const document of parsed.documents) {
        this.insertDocument({ ...document, isAvailable: 1 });
      }
      for (const input of parsed.inputs) {
        this.ctx.storage.sql.exec(
          "INSERT INTO document_inputs (document_id, input_id) VALUES (?, ?)",
          input.documentId,
          input.inputId,
        );
      }
    });
  }

  assertLive(): void {
    if (this.ctx.storage.kv.get<boolean>(LIBRARY_REVOKED_KEY) === true) {
      throw new Error(LIBRARY_REVOKED_ERROR);
    }
  }

  revoke(): void {
    this.ctx.storage.transactionSync(() => {
      const linkedSourceIds = this.ctx.storage.sql.exec<{ sourceId: string }>(
        "SELECT source_id AS sourceId FROM linked_sources",
      ).toArray();
      for (const linked of linkedSourceIds) {
        this.ctx.storage.kv.delete(sourceAccessKey(linked.sourceId));
      }
      this.ctx.storage.sql.exec("DELETE FROM document_inputs");
      this.ctx.storage.sql.exec("DELETE FROM documents");
      this.ctx.storage.kv.put(LIBRARY_REVOKED_KEY, true);
    });
  }

  private async reauthorizeDocument(documentId: string): Promise<boolean> {
    const linkedSources = this.ctx.storage.sql.exec<LinkedSourceRecord>(
      `WITH RECURSIVE ancestors(id) AS (
         SELECT ?
         UNION
         SELECT links.input_id
         FROM document_inputs AS links
         JOIN ancestors ON links.document_id = ancestors.id
       )
       SELECT source_id AS sourceId, vendor, resource, revision,
              ts_type AS tsType
       FROM linked_sources
       WHERE source_id IN (SELECT id FROM ancestors)
       ORDER BY source_id`,
      documentId,
    ).toArray();
    for (const linked of linkedSources) {
      if (!await this.reauthorizeLinkedSource(linked)) return false;
    }
    return true;
  }

  private async reauthorizeLinkedSource(linked: LinkedSourceRecord): Promise<boolean> {
    try {
      const sourceHandle = this.ctx.storage.kv.get<string>(
        sourceAccessKey(linked.sourceId),
      );
      if (!sourceHandle) throw new Error("Linked source handle is missing.");
      const description = await this.env.CFOS_SOURCE_ACCESS_BROKER.describe(sourceHandle);
      if (!description) throw new Error("Linked source handle is unavailable.");
      validateSourceAccessDescription(description);
      if (
        description.vendorId !== linked.vendor ||
        description.url !== linked.resource ||
        description.tsType !== linked.tsType
      ) {
        throw new Error("Linked source description has changed.");
      }
      const session = getNotionPageSession(
        await this.env.CFOS_SOURCE_ACCESS_BROKER.openReadSession(sourceHandle),
      );
      try {
        const metadata = await session.getMetadata();
        if (metadata.url !== linked.resource) {
          throw new Error("Linked source metadata has changed.");
        }
      } finally {
        session[Symbol.dispose]?.();
      }
      return true;
    } catch {
      this.invalidateLinkedSource(linked.sourceId);
      return false;
    }
  }

  private invalidateLinkedSource(sourceId: string): void {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `WITH RECURSIVE affected(id) AS (
           SELECT ?
           UNION
           SELECT links.document_id
           FROM document_inputs AS links
           JOIN affected ON links.input_id = affected.id
         )
         UPDATE documents
         SET is_available = 0
         WHERE id IN (SELECT id FROM affected)`,
        sourceId,
      );
      this.ctx.storage.kv.delete(sourceAccessKey(sourceId));
    });
  }

  private selectDocuments(ids: string[]): StoredDocument[] {
    return this.ctx.storage.sql.exec<StoredDocument>(
      `SELECT id, type, title, content,
         content_hash AS contentHash,
         metadata_json AS metadataJson,
         is_available AS isAvailable,
         created_at AS createdAt
       FROM documents WHERE id IN (?, ?, ?)`,
      ...ids,
    ).toArray();
  }

  private selectLinks(ids: string[]): StoredInput[] {
    return this.ctx.storage.sql.exec<StoredInput>(
      `SELECT document_id AS documentId, input_id AS inputId
       FROM document_inputs
       WHERE document_id IN (?, ?, ?)
       ORDER BY document_id, input_id`,
      ...ids,
    ).toArray();
  }

  private insertDocument(document: StoredDocument): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO documents (
         id, type, title, content, content_hash,
         metadata_json, is_available, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      document.id,
      document.type,
      document.title,
      document.content,
      document.contentHash,
      document.metadataJson,
      document.isAvailable,
      document.createdAt,
    );
  }

  private ingestMatches(
    batch: IngestBatch,
    existing: StoredDocument[],
    links: StoredInput[],
  ): boolean {
    if (existing.length !== 3) return false;
    const byId = new Map(existing.map((document) => [document.id, document]));
    for (const expected of [batch.source, batch.evidence, batch.wiki]) {
      const actual = byId.get(expected.id);
      if (!actual || !documentValuesEqual(actual, expected)) return false;
    }
    return this.linksMatch(idsFromBatch(batch), links);
  }

  private linksMatch(ids: IngestIds, links: StoredInput[]): boolean {
    if (links.length !== 2) return false;
    const expected = new Set([
      `${ids.evidenceId}\u0000${ids.sourceId}`,
      `${ids.wikiId}\u0000${ids.evidenceId}`,
    ]);
    return links.every((link) =>
      expected.delete(`${link.documentId}\u0000${link.inputId}`)) &&
      expected.size === 0;
  }
}

@validateRpc()
export class WwwkGatekeeper
  extends DurableObject<Cloudflare.Env, WwwkAccountProps>
{
  private library(): DurableObjectStub<WwwkLibrary> {
    return this.ctx.exports.WwwkLibrary.getByName(this.ctx.props.accountId);
  }

  async describe(): Promise<ResourceDescription> {
    return {
      url: "wwwk://library",
      title: "WWWK",
      snippet: "Search and maintain your private personal Wiki.",
      suggestedBindingName: "WWWK",
      tsType: "WwwkSession",
      hasSlashCommands: true,
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  async startSession(
    approvalQueue: NativeRpcStub<ApprovalQueue>,
  ): Promise<WwwkSessionImpl> {
    await this.library().assertLive();
    return new WwwkSessionImpl(
      this.library(),
      approvalQueue.dup(),
      this.env.CFOS_SOURCE_ACCESS_BROKER,
      (batch) => this.submitPendingAction(batch),
      (actionId) => this.dropPendingAction(actionId),
    );
  }

  async getAgentCatalog(
    request: AgentCatalogRequest,
    authorizer: NativeRpcStub<ObservationAuthorizer>,
  ): Promise<AgentCatalog> {
    const catalog = boundAgentCatalog([{
      id: "wwwk-session",
      title: "WWWK personal Wiki",
      description:
        "Use the WWWK session to search private Wiki pages, read their Evidence and Source " +
        "inputs, or ingest one explicitly requested text.",
    }], request);
    if (catalog.entries.length > 0) {
      await authorizer.authorizeObservation({
        title: "WWWK catalog",
        description: "Discovered the owner's personal Wiki session.",
      });
    }
    return catalog;
  }

  async getSlashCommandProvider(): Promise<WwwkSlashCommandProvider> {
    return new WwwkSlashCommandProvider();
  }

  addObserver(
    _id: string,
    _user: Fetcher<WwwkVerifier>,
  ): Promise<void> {
    throw new Error("WWWK is owner-only and cannot be shared with observers.");
  }

  async removeObserver(_id: string): Promise<void> {}

  private submitPendingAction(batch: IngestBatch): number {
    return this.ctx.storage.transactionSync(() => {
      const current = this.ctx.storage.kv.get<number>("nextActionId") ?? 0;
      const actionId = current + 1;
      this.ctx.storage.kv.put("nextActionId", actionId);
      this.ctx.storage.kv.put<StoredAction>(actionKey(actionId), {
        status: "pending",
        batch,
      });
      return actionId;
    });
  }

  private dropPendingAction(actionId: number): void {
    const action = this.ctx.storage.kv.get<StoredAction>(actionKey(actionId));
    if (action?.status === "pending") {
      this.ctx.storage.kv.delete(actionKey(actionId));
    }
  }

  async applyAction(actionId: number): Promise<void> {
    const key = actionKey(actionId);
    const action = this.ctx.storage.kv.get<StoredAction>(key);
    if (!action) throw new Error("WWWK action does not exist.");
    if (action.status !== "pending") {
      if (action.status === "applied") return;
      throw new Error("WWWK action was already reverted.");
    }
    try {
      await this.library().applyIngest(action.batch);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes(LIBRARY_REVOKED_ERROR)
      ) {
        this.dropPendingAction(actionId);
      }
      throw error;
    }
    this.ctx.storage.kv.put<StoredAction>(key, {
      status: "applied",
      ids: idsFromBatch(action.batch),
    });
  }

  async rejectAction(actionId: number): Promise<void> {
    const key = actionKey(actionId);
    const action = this.ctx.storage.kv.get<StoredAction>(key);
    if (!action) return;
    if (action.status !== "pending") {
      throw new Error("Only a pending WWWK action can be rejected.");
    }
    this.ctx.storage.kv.delete(key);
  }

  async revertAction(actionId: number): Promise<void> {
    const key = actionKey(actionId);
    const action = this.ctx.storage.kv.get<StoredAction>(key);
    if (!action) throw new Error("WWWK action does not exist.");
    if (action.status === "pending") {
      throw new Error("A pending WWWK action cannot be reverted.");
    }
    if (action.status === "reverted") return;
    await this.library().revertIngest(action.ids);
    this.ctx.storage.kv.put<StoredAction>(key, {
      status: "reverted",
      ids: action.ids,
    });
  }
}

@validateRpc()
export class WwwkAccount
  extends WorkerEntrypoint<Cloudflare.Env, WwwkAccountProps>
{
  async describe() {
    return {
      displayName: "WWWK",
      avatar: WWWK_ICON,
      singleton: { tsType: "WwwkSession" },
    };
  }

  async getSingletonGatekeeperClass(): Promise<
    DurableObjectClass<WwwkGatekeeper>
  > {
    return this.ctx.exports.WwwkGatekeeper({ props: this.ctx.props });
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }

  getGatekeeperClassFor(_url: string): Promise<{
    class: DurableObjectClass<WwwkGatekeeper>;
    resource: SupportedResource;
  }> {
    throw new Error("WWWK has no URL-addressed resources.");
  }

  startResourceConfigurator(
    _resourceUrlPattern: string,
  ): Promise<ResourceConfiguratorFrame> {
    throw new Error("WWWK has no resource configurator.");
  }

  async ensureResources(
    _resourceUrlPatterns: string[],
  ): Promise<{ url?: string }> {
    return {};
  }

  async revoke(): Promise<void> {
    await this.ctx.exports.WwwkLibrary
      .getByName(this.ctx.props.accountId)
      .revoke();
  }

  reconnect(): Promise<{ url: string }> {
    throw new Error("WWWK has no connect flow.");
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<WwwkVerifier>> {
    return this.ctx.exports.WwwkVerifier({});
  }
}

@validateRpc()
export class WwwkVerifier
  extends WorkerEntrypoint<Cloudflare.Env>
{
  verify(): void {}
}

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  async describe() {
    return {
      displayName: "WWWK",
      url: "https://github.com/YMD7/wwwk",
      logo: WWWK_ICON,
      tagline: "Compile source text into a private personal Wiki",
      description:
        "WWWK stores an immutable Source, derived Evidence, and a private Wiki page with " +
        "deterministic provenance.",
      autoProvisionsAccount: true,
      providesAuth: false,
    };
  }

  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<WwwkAccount>> {
    return this.ctx.exports.WwwkAccount({
      props: { accountId: crypto.randomUUID() },
    }) as unknown as Fetcher<WwwkAccount>;
  }

  connectAccount(
    _callback: Fetcher,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    throw new Error("WWWK is auto-provisioned and has no connect flow.");
  }

  async getSupportedResources(
    _options?: { userId?: string },
  ): Promise<SupportedResource[]> {
    return [];
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response("WWWK worker is running.", {
      headers: { "content-type": "text/plain" },
    });
  },
};
