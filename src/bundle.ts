import { parseDocument, stringify } from "yaml";
import type { WwwkDocumentType } from "./types.js";

export type WwwkPortableBundle = {
  files: Array<{
    path: string;
    content: string;
  }>;
};

export type BundleDocument = {
  id: string;
  type: WwwkDocumentType;
  title: string;
  content: string;
  contentHash: string;
  metadataJson: string;
  createdAt: number;
};

export type BundleInput = {
  documentId: string;
  inputId: string;
};

export type ParsedBundle = {
  documents: BundleDocument[];
  inputs: BundleInput[];
};

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

type SourceReference = {
  id: string;
  resource: string;
};

const MANIFEST_PATH = "manifest.yaml";
const MANIFEST_CONTENT = "format: wwwk\nversion: 1\n";
const RESERVED_FIELDS = new Set([
  "id",
  "type",
  "title",
  "content_hash",
  "created_at",
  "sources",
]);
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const CREATED_AT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:Z|[+-]\d{2}:\d{2})$/;

const DIRECTORY_BY_TYPE: Record<WwwkDocumentType, string> = {
  source: "sources",
  evidence: "evidence",
  wiki: "wiki",
};
const TYPE_ORDER: Record<WwwkDocumentType, number> = {
  source: 0,
  evidence: 1,
  wiki: 2,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function parseYaml(content: string, label: string): unknown {
  const document = parseDocument(content, {
    merge: false,
    resolveKnownTags: false,
    schema: "core",
    stringKeys: true,
    uniqueKeys: true,
    version: "1.2",
  });
  if (document.errors.length > 0) {
    throw new Error(`Invalid YAML in ${label}.`);
  }
  return document.toJS({ maxAliasCount: 0 });
}

function normalizeJson(value: unknown, label: string): JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${label} must contain only JSON-compatible values.`);
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new Error(`${label} contains an unsafe integer.`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeJson(item, label));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalizeJson(value[key], label)]),
    );
  }
  throw new Error(`${label} must contain only JSON-compatible values.`);
}

function normalizeMetadata(value: unknown): Record<string, JsonValue> {
  const normalized = normalizeJson(value, "WWWK metadata");
  if (!isRecord(normalized)) {
    throw new Error("WWWK metadata must be a JSON object.");
  }
  for (const key of Object.keys(normalized)) {
    if (RESERVED_FIELDS.has(key)) {
      throw new Error("WWWK metadata contains a reserved field.");
    }
  }
  return normalized as Record<string, JsonValue>;
}

function parseStoredMetadata(metadataJson: string): Record<string, JsonValue> {
  let value: unknown;
  try {
    value = JSON.parse(metadataJson);
  } catch {
    throw new Error("WWWK stored metadata is not valid JSON.");
  }
  return normalizeMetadata(value);
}

function validateId(value: unknown): string {
  if (typeof value !== "string" || !UUID_V4_PATTERN.test(value)) {
    throw new Error("WWWK bundle contains an invalid document ID.");
  }
  return value;
}

function validateType(value: unknown): WwwkDocumentType {
  if (value !== "source" && value !== "evidence" && value !== "wiki") {
    throw new Error("WWWK bundle contains an invalid document type.");
  }
  return value;
}

function documentPath(type: WwwkDocumentType, id: string): string {
  return `${DIRECTORY_BY_TYPE[type]}/${id}.md`;
}

function sourceResource(type: WwwkDocumentType, id: string): string {
  return `/${documentPath(type, id)}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseCreatedAt(value: unknown): number {
  if (typeof value !== "string" || !CREATED_AT_PATTERN.test(value)) {
    throw new Error("WWWK bundle contains an invalid created_at value.");
  }
  const milliseconds = Date.parse(value);
  if (!Number.isSafeInteger(milliseconds)) {
    throw new Error("WWWK bundle contains an invalid created_at value.");
  }
  const zone = value.slice(23);
  let offsetMinutes = 0;
  if (zone !== "Z") {
    const hours = Number(zone.slice(1, 3));
    const minutes = Number(zone.slice(4, 6));
    if (hours > 23 || minutes > 59) {
      throw new Error("WWWK bundle contains an invalid created_at value.");
    }
    offsetMinutes = (hours * 60 + minutes) * (zone[0] === "+" ? 1 : -1);
  }
  const local = new Date(milliseconds + offsetMinutes * 60_000)
    .toISOString()
    .slice(0, 23);
  if (local !== value.slice(0, 23)) {
    throw new Error("WWWK bundle contains an invalid created_at value.");
  }
  return milliseconds;
}

function formatCreatedAt(value: number): string {
  if (!Number.isSafeInteger(value)) {
    throw new Error("WWWK stored created_at is invalid.");
  }
  const date = new Date(value);
  if (date.getTime() !== value) {
    throw new Error("WWWK stored created_at is invalid.");
  }
  return date.toISOString();
}

function parseSourceReference(value: unknown): SourceReference {
  if (!isRecord(value) || Object.keys(value).length !== 2) {
    throw new Error("WWWK bundle contains an invalid source reference.");
  }
  const id = validateId(value.id);
  if (typeof value.resource !== "string") {
    throw new Error("WWWK bundle contains an invalid source resource.");
  }
  return { id, resource: value.resource };
}

function splitPortableDocument(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  if (!content.startsWith("---\n")) {
    throw new Error("WWWK document must start with YAML frontmatter.");
  }
  const boundary = content.indexOf("\n---\n", 4);
  if (boundary < 0) {
    throw new Error("WWWK document frontmatter is not closed.");
  }
  const frontmatter = parseYaml(content.slice(4, boundary), "frontmatter");
  if (!isRecord(frontmatter)) {
    throw new Error("WWWK document frontmatter must be a mapping.");
  }
  return {
    frontmatter,
    body: content.slice(boundary + 5),
  };
}

async function parsePortableDocument(
  path: string,
  content: string,
): Promise<{ document: BundleDocument; input?: BundleInput }> {
  const { frontmatter, body } = splitPortableDocument(content);
  const id = validateId(frontmatter.id);
  const type = validateType(frontmatter.type);
  if (path !== documentPath(type, id)) {
    throw new Error("WWWK document path does not match its ID and type.");
  }
  if (typeof frontmatter.title !== "string" || !frontmatter.title.trim()) {
    throw new Error("WWWK bundle contains an invalid title.");
  }
  if (typeof frontmatter.content_hash !== "string" ||
      !HASH_PATTERN.test(frontmatter.content_hash)) {
    throw new Error("WWWK bundle contains an invalid content_hash.");
  }
  if (!body.trim()) {
    throw new Error("WWWK bundle contains an empty document body.");
  }
  const actualHash = await sha256Text(body);
  if (actualHash !== frontmatter.content_hash) {
    throw new Error("WWWK bundle content_hash does not match its body.");
  }

  let input: BundleInput | undefined;
  if (type === "source") {
    if (Object.hasOwn(frontmatter, "sources")) {
      throw new Error("WWWK Source documents must not contain sources.");
    }
  } else {
    if (!Array.isArray(frontmatter.sources) || frontmatter.sources.length !== 1) {
      throw new Error("WWWK derived documents require exactly one source.");
    }
    const reference = parseSourceReference(frontmatter.sources[0]);
    const inputType = type === "evidence" ? "source" : "evidence";
    if (reference.resource !== sourceResource(inputType, reference.id)) {
      throw new Error("WWWK source resource does not match its ID and type.");
    }
    input = { documentId: id, inputId: reference.id };
  }

  const metadata = Object.fromEntries(
    Object.entries(frontmatter)
      .filter(([key]) => !RESERVED_FIELDS.has(key)),
  );
  const normalizedMetadata = normalizeMetadata(metadata);
  return {
    document: {
      id,
      type,
      title: frontmatter.title,
      content: body,
      contentHash: frontmatter.content_hash,
      metadataJson: JSON.stringify(normalizedMetadata),
      createdAt: parseCreatedAt(frontmatter.created_at),
    },
    input,
  };
}

function validateGraph(
  documents: BundleDocument[],
  inputs: BundleInput[],
): void {
  const byId = new Map(documents.map((document) => [document.id, document]));
  const inputByDocument = new Map<string, BundleInput>();
  for (const input of inputs) {
    if (inputByDocument.has(input.documentId)) {
      throw new Error("WWWK bundle contains duplicate dependencies.");
    }
    const document = byId.get(input.documentId);
    const source = byId.get(input.inputId);
    if (!document || !source) {
      throw new Error("WWWK bundle contains a dangling dependency.");
    }
    if (
      (document.type === "evidence" && source.type !== "source") ||
      (document.type === "wiki" && source.type !== "evidence") ||
      document.type === "source"
    ) {
      throw new Error("WWWK bundle contains an invalid dependency direction.");
    }
    inputByDocument.set(input.documentId, input);
  }
  for (const document of documents) {
    const hasInput = inputByDocument.has(document.id);
    if ((document.type === "source" && hasInput) ||
        (document.type !== "source" && !hasInput)) {
      throw new Error("WWWK bundle contains an invalid dependency count.");
    }
  }
}

export async function sha256Text(content: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")).join("");
}

export async function serializeBundle(
  documents: BundleDocument[],
  inputs: BundleInput[],
): Promise<WwwkPortableBundle> {
  validateGraph(documents, inputs);
  const inputByDocument = new Map(
    inputs.map((input) => [input.documentId, input]),
  );
  const documentById = new Map(
    documents.map((document) => [document.id, document]),
  );
  const ordered = [...documents].sort((left, right) => {
    const typeDifference = TYPE_ORDER[left.type] - TYPE_ORDER[right.type];
    return typeDifference || compareText(left.id, right.id);
  });
  const files: WwwkPortableBundle["files"] = [{
    path: MANIFEST_PATH,
    content: MANIFEST_CONTENT,
  }];

  for (const document of ordered) {
    validateId(document.id);
    if (!document.title.trim() || !document.content.trim()) {
      throw new Error("WWWK stored document is incomplete.");
    }
    if (!HASH_PATTERN.test(document.contentHash) ||
        await sha256Text(document.content) !== document.contentHash) {
      throw new Error("WWWK stored content_hash does not match its body.");
    }
    const metadata = parseStoredMetadata(document.metadataJson);
    const entries: Array<[string, JsonValue | SourceReference[]]> = [
      ["id", document.id],
      ["type", document.type],
      ["title", document.title],
      ["content_hash", document.contentHash],
      ["created_at", formatCreatedAt(document.createdAt)],
    ];
    const input = inputByDocument.get(document.id);
    if (input) {
      const inputDocument = documentById.get(input.inputId);
      if (!inputDocument) {
        throw new Error("WWWK stored dependency is dangling.");
      }
      entries.push(["sources", [{
        id: input.inputId,
        resource: sourceResource(inputDocument.type, input.inputId),
      }]]);
    }
    entries.push(...Object.entries(metadata));
    const frontmatter = Object.fromEntries(entries);
    const yaml = stringify(frontmatter, {
      aliasDuplicateObjects: false,
      lineWidth: 0,
      version: "1.2",
    });
    files.push({
      path: documentPath(document.type, document.id),
      content: `---\n${yaml}---\n${document.content}`,
    });
  }
  return { files };
}

export async function parseBundle(
  bundle: WwwkPortableBundle,
): Promise<ParsedBundle> {
  if (!isRecord(bundle) || !Array.isArray(bundle.files)) {
    throw new Error("WWWK bundle must contain a files array.");
  }
  const files = new Map<string, string>();
  for (const file of bundle.files) {
    if (!isRecord(file) ||
        typeof file.path !== "string" ||
        typeof file.content !== "string") {
      throw new Error("WWWK bundle contains an invalid file.");
    }
    if (files.has(file.path)) {
      throw new Error("WWWK bundle contains a duplicate path.");
    }
    files.set(file.path, file.content);
  }

  const manifestContent = files.get(MANIFEST_PATH);
  if (manifestContent === undefined) {
    throw new Error("WWWK bundle manifest is missing.");
  }
  const manifest = parseYaml(manifestContent, MANIFEST_PATH);
  if (!isRecord(manifest) ||
      Object.keys(manifest).length !== 2 ||
      manifest.format !== "wwwk" ||
      manifest.version !== 1) {
    throw new Error("WWWK bundle manifest is invalid or unsupported.");
  }
  files.delete(MANIFEST_PATH);

  const documents: BundleDocument[] = [];
  const inputs: BundleInput[] = [];
  const ids = new Set<string>();
  for (const [path, content] of files) {
    if (!/^(?:sources|evidence|wiki)\/[0-9a-f-]+\.md$/.test(path)) {
      throw new Error("WWWK bundle contains an unexpected file path.");
    }
    const parsed = await parsePortableDocument(path, content);
    if (ids.has(parsed.document.id)) {
      throw new Error("WWWK bundle contains a duplicate document ID.");
    }
    ids.add(parsed.document.id);
    documents.push(parsed.document);
    if (parsed.input) inputs.push(parsed.input);
  }
  validateGraph(documents, inputs);
  documents.sort((left, right) => compareText(left.id, right.id));
  inputs.sort((left, right) => compareText(left.documentId, right.documentId));
  return { documents, inputs };
}
