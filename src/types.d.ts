/** WWWK が扱う文書のデータ層。 */
export type WwwkDocumentType = "source" | "evidence" | "wiki";

/**
 * 個人 Wiki を検索し、文書の参照と初期書込みを行う。
 */
export interface WwwkSession {
  /**
   * 文書を全文検索する。
   *
   * `type` を省略した場合は Wiki だけを検索する。Evidence または Source を
   * 検索する場合は、対象のデータ層を明示する。
   */
  search(
    query: string,
    options?: {
      /** 検索対象のデータ層。省略時は `wiki`。 */
      type?: WwwkDocumentType;
      /** 返却を希望する最大件数。 */
      limit?: number;
    },
  ): Promise<WwwkSearchResult[]>;

  /**
   * ID で文書を取得する。
   *
   * 文書が存在しない、または現在利用できない場合は `null` を返す。
   */
  read(id: string): Promise<WwwkDocument | null>;

  /**
   * 1 つの明示された入力を Source、Evidence、Wiki としてまとめて保存する。
   *
   * ID、データ層、生成依存、hash、時刻、所有者、生成メタデータは WWWK が記録する。
   */
  ingest(input: WwwkIngestInput): Promise<void>;
}

/** 初期書込みでまとめて保存する 3 層の draft。 */
export interface WwwkIngestInput {
  source: WwwkDocumentDraft | WwwkLinkedSourceInput;
  evidence: WwwkDocumentDraft;
  wiki: WwwkDocumentDraft;
}

/** Agent が提案する文書の可変部分。 */
export interface WwwkDocumentDraft {
  title: string;
  content: string;
}

/** CFOS が発行する、外部原典への永続可能な読取 capability。 */
/** Agent が本文を作らず、CFOS handle から取り込む外部原典。 */
export interface WwwkLinkedSourceInput {
  /** Linked Source を示す固定値。 */
  kind: "linked";
  /** CFOS が発行した非ポータブルかつ失効可能な opaque handle。 */
  sourceHandle: string;
}

/** 検索に一致した文書の概要。 */
export interface WwwkSearchResult {
  /** 文書を `read()` するための安定した ID。 */
  id: string;
  /** 文書のデータ層。 */
  type: WwwkDocumentType;
  /** 文書のタイトル。 */
  title: string;
  /** 一致箇所を含む抜粋。 */
  snippet?: string;
  /** 関連度。値が大きいほど関連性が高い。 */
  score?: number;
}

/** 本文と生成元を含む WWWK 文書。 */
export interface WwwkDocument {
  /** 安定した文書 ID。 */
  id: string;
  /** 文書のデータ層。 */
  type: WwwkDocumentType;
  /** 文書のタイトル。 */
  title: string;
  /** 文書の本文。 */
  content: string;
  /** この文書の生成に実際に使われた入力。 */
  inputs: WwwkInputRef[];
}

/** 派生文書から生成入力への参照。 */
export interface WwwkInputRef {
  /** 入力文書の安定した ID。 */
  id: string;
  /** Source または Evidence。 */
  type: "source" | "evidence";
  /** 入力文書のタイトル。 */
  title: string;
}
