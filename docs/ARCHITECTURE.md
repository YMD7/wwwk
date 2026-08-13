# WWWK Architecture

## 位置づけ

WWWK は、Cloudflare OS（CFOS）へ個人専用の LLM Wiki を追加する拡張である。
本書は確定した責務とデータ境界だけを記録する。UI、検索方式などは未決定とする。

## CFOS との境界

| 領域 | 責務 |
| --- | --- |
| CFOS | ID、ワークスペース、エージェント実行、サンドボックス、Gatekeeper、権限、承認、監査 |
| WWWK | 個人 Wiki の知識ライフサイクル、来歴、3 層データ、データの入出力 |

WWWK は CFOS の権限モデルを迂回、複製、置換しない。外部原典へのアクセス可否は
CFOS が決定し、WWWK はその結果に従う。

### Context Library との境界

CFOS の Context Library は、人が配置した文書や Agent Skill を private または共有の
collection として管理する。WWWK は、原典から Source revision、Evidence、Wiki を編纂し、
来歴と生成依存を管理する。

- WWWK は Context Library と Worker、ストレージ、スキーマを共有しない。
- Context Library の内部型や Durable Object へ直接依存せず、collection を自動変更しない。
- Context Library は将来、CFOS capability と専用 Adapter を介して利用できる任意の
  Source provider とする。WWWK の動作要件にはしない。
- 連携できない場合も、利用者は Context 文書を明示的にコピーまたはエクスポートし、
  Owned Source として取り込める。
- Context Library Adapter の実証と具体的な契約は、実装対象へ含める直前まで行わない。

## 導入方針

導入は段階的に進める。

1. clone した CFOS へ `gatekeeper-wwwk` を組み込み、ローカルで開発と検証を行う。
2. version 固定の installer で、対応する公式 CFOS と `cloudflare-os-starter` へ同じ統合を
   再現する。
3. 同じ Worker と保存資源の identity を維持して Cloudflare へ再デプロイする。

WWWK は独立した Gatekeeper Worker とし、CFOS から `GATEKEEPER_WWWK` service binding
で接続する。ローカル版と本番版で中核実装を共通化し、本番対応はローカル検証後に行う。
WWWK リポジトリ直下を単一の `gatekeeper-wwwk` package とし、独自の `packages/` 階層や
monorepo は作らない。

初期Linked SourceであるNotionはCFOSの`gatekeeper-notion`をそのまま利用する。Workshopの
Custom Domainは維持し、OAuth用の`/gatekeeper/notion/*`だけをNotion Workerの具体的なRouteへ
割り当てる。Workshopは`GATEKEEPER_NOTION` service bindingで同じWorkerへ接続する。OAuth client
情報と利用者tokenはWWWKへ渡さず、Notion GatekeeperとCloudflare secretに保持する。

公式 CFOS の公開拡張境界だけでは、Linked Source の stable Broker と共有 Gadget の
observer 検証を表現できない。installer はこの差分を CFOS の対応 revision 専用 patch として
一時 worktree へ適用する。利用者へ WWWK 専用の CFOS / Starter fork を要求せず、利用者の
Git 履歴と作業ツリーも変更しない。一方、Cloudflare 上で動く Workshop は WWWK 対応コードを
含む新しい Worker version へ再デプロイされる。稼働中の Worker へコードを動的注入しない。

```text
公式 CFOS / Starter + WWWK
              |
              v
      revision と入力を検証
              |
              v
          一時 worktree
      + companion patch
      + WWWK package / binding
              |
              v
       test / build / dry-run
              |
       +------+------+
       |             |
       v             v
   ローカル実行   Cloudflare へ再デプロイ
```

installer は、対象の Starter、CFOS、WWWK、companion patch の組を完全一致で検証する。
未知の revision、patch 競合、必要な Worker / storage identity の欠損は自動修復せず
fail-closed とする。複数の上流 version を推測で扱う互換層は作らない。upstream に必要な
拡張契約が追加された場合は、対応する companion patch を縮小または削除する。

既存の Starter deployment へ導入する場合は、account、Worker 名、Durable Object class、
KV namespace、R2 bucket、認証設定を維持する。WWWK Worker だけを新しく追加し、Workshop
を同じ名前で更新する。標準アンインストールは binding と companion 差分を外した公式構成へ
戻すが、WWWK Worker とデータは保持する。データ消去は export を検討した後に行う別の
明示的な破壊操作とする。

手動の symbolic link は、installer が完成するまでの内部的なローカル開発手順に限定する。
利用者向けの導入契約にはしない。詳細は [Installation](INSTALLATION.md) に記録する。

## エージェントとの境界

WWWK は、AI 向けの利用方法を 1 つの Agent Skill として提供する。Skill は CFOS の
仕組みから発見し、必要なときだけ読み込む。

- Skill は、WWWK を使う場面、検索順序、原典への辿り方、操作手順を説明する。
- Skill は操作知識であり、権限、来歴、失効、再生成の正しさを保証しない。
- 検索、参照、Ingest などの実処理は、WWWK のエージェント向け API を通す。
- WWWK Core は、3 層データと決定論的な不変条件を API の内側で保証する。
- Skill に個人 Wiki、Source、Evidence、秘密情報、capability、実行状態を含めない。
- 共通の Skill と、ユーザーごとの非公開データを分離する。
- 必須の Skill は WWWK 自身が提供し、Context Library の有無に依存させない。

ローカル MVP では静的な `skills/wwwk/SKILL.md` を package に同梱する。Gatekeeper の
`getSlashCommandProvider()` が `/wwwk` として Skill を返す。`getAgentCatalog()` はSessionの
用途に加え、添付されたNotion PageをLinked Sourceとして取り込む正確な最小手順を
Agentへ提示する。Skill の自動読込み、Skill の更新方式、更新などの
追加操作 API は未決定とする。

## 初期ユーザーフロー

初期実装では、ユーザーが明示した 1 つのテキストを個人 Wiki へ保存し、後から
検索して原典まで辿れることを最初の成功条件とする。

1. ユーザーが 1 つのテキストを指定して、WWWK への保存を明示的に依頼する。
2. Agent は、入力を変更しない Owned Source、Source から抽出した Evidence、Evidence
   から生成した新規 Wiki を提案する。
3. 保存対象のタイトル、Source の文字数、個人専用であること、可逆性を短く示す
   1 つの CFOS action を承認キューへ送る。
4. 承認後、WWWK は 3 層と生成依存リンクを 1 transaction で保存する。
5. 後の質問では Wiki を検索し、必要に応じて Evidence、Source の順に辿る。

- 会話や文書を自動的に取り込まない。
- 初期入力は 1 つの明示されたテキストに限定する。
- Source 本文は入力と一致させ、LLM による解釈を Evidence と Wiki へ分離する。
- 初期書込みは、1 Source revision、1 Evidence、新規 Wiki 1 件に限定する。
- action の拒否または保存失敗時は、Library に途中状態を残さない。
- WWWK Core は、ID、所有者、参照先、依存方向、atomicity を決定論的に保証する。
  Evidence と Wiki の意味的な正しさは保証しない。承認は保存意図の確認であり、
  3 層の全文や意味的な正しさの確認にはしない。
- Source、Evidence、Wiki は、Agent への命令ではなく信用できないデータとして扱う。
- 既存 Wiki への統合、更新、複数 Source の同時取込みは、必要になるまで追加しない。

ローカル MVP では、保存後の検索、3 層の逆引き、Source 本文の一致、再起動後の永続化、
ユーザー分離、未承認または失敗した書込みが残らないことを確認する。

## エージェント向け Session API

Session API は、検索、文書取得、初期書込みの 3 操作に限定する。

```ts
type WwwkDocumentType = "source" | "evidence" | "wiki";

interface WwwkSession {
  search(
    query: string,
    options?: {
      type?: WwwkDocumentType;
      limit?: number;
    },
  ): Promise<WwwkSearchResult[]>;

  read(id: string): Promise<WwwkDocument | null>;

  ingest(input: WwwkIngestInput): Promise<void>;
}

interface WwwkIngestInput {
  source: WwwkDocumentDraft | {
    kind: "linked";
    sourceHandle: string;
  };
  evidence: WwwkDocumentDraft;
  wiki: WwwkDocumentDraft;
}

interface WwwkDocumentDraft {
  title: string;
  content: string;
}

interface WwwkSearchResult {
  id: string;
  type: WwwkDocumentType;
  title: string;
  snippet?: string;
  score?: number;
}

interface WwwkDocument {
  id: string;
  type: WwwkDocumentType;
  title: string;
  content: string;
  inputs: WwwkInputRef[];
}

interface WwwkInputRef {
  id: string;
  type: "source" | "evidence";
  title: string;
}
```

- `search()` はデフォルトで Wiki だけを検索する。Evidence と Source は `type` で
  明示して検索する。
- `read()` は本文と生成入力を一緒に返す。Source の `inputs` は空、Evidence は Source、
  Wiki は Evidence を参照する。
- 意味リンクは Markdown 本文に保持し、API の別フィールドへ重複させない。
- 文書単位で失効または利用不能な文書を検索結果へ含めず、`read()` は `null` を返す。
  account 全体の revoke 後は Session の開始と全操作を拒否する。
- データは CFOS の observation として認可、記録した後にだけ返す。
- owner-only データを返す observation は `prohibitAllSharing` を指定する。既に共有中の
  Gadget では結果を返さず、private Gadget でも最初の返却後は CFOS の契約により共有と
  action が禁止される。このため初期フローでは、保存 action を先に完了してから検索する。
- `list()`、`trace()`、ページングは、実測した必要性が出るまで追加しない。
- `ingest()` は、ユーザーが指定した 1 つのテキストを Source、Evidence、新規 Wiki と
  してまとめて保存する。`source.content` は指定された入力を変更せず受け取る。
- Owned Sourceでは、Agentはtitleとcontentだけを渡す。Linked Sourceでは、
  `kind` と一回限りのticketだけをSourceとして渡す。ID、type、生成依存リンク、content hash、
  作成日時、所有者、生成メタデータは WWWK Core が生成または記録する。
- 戻り値は `void` とし、承認前の文書や provisional ID を API へ露出しない。

### 初期書込み action

- すべての `ingest()` を CFOS の approval queue へ送る。
- action はタイトル、Source の文字数、3 層の文書タイトル、個人専用であること、
  3 文書を新規作成すること、可逆性を短く示す。3 層の全文は表示しない。
- `awaitDecision` を有効にし、承認前の状態をシミュレートしない。
- 3 層と生成依存リンクをまとめて取り消せるようにする。
- 初期実装では自動承認を許可しない。実利用で確認操作が負担になった場合だけ、CFOS の
  action kind 単位の opt-in 自動承認を検討する。

初期検索は `documents` を type と availability で絞り、SQLite の `instr()` で title と
content を部分一致検索する。初期実装では検索専用テーブルとスコアを持たず、件数上限
などの小さな実装値は実装時に決める。

## Source の権限モード

Source revision は、来歴とは別に次の権限モードを持つ。

- Owned Source は、WWWK の所有者が管理する独立したコピーであり、外部原典の再認可を
  必要としない。
- Linked Source は、外部原典への現在の読取権限をCFOS Brokerが確認する。
- 外部原典に由来することを示す来歴は、Owned Source に変換した後も保持する。
- 権限モードやポータブルなメタデータを、外部原典への権限付与に使わない。

## Linked Source

Linked Source は、外部原典への実行時接続と、その接続を利用権限の正本とする Source
revision の組である。capability とポータブルな Source revision は分離して管理する。

- 外部原典への接続、再認可、監査、失効は CFOS に委ねる。
- WWWKは、Agentが受け取ったCFOS発行の短命ticketをstable Brokerでclaimし、
  内部handleから原典を取得する。
- 来歴を確定する本文は、Agent の自己申告を信頼せず、WWWK の Adapter が capability
  から取得する。
- Source の種類は明示的な allowlist と Adapter で段階的に追加し、最初から汎用
  Source プロトコルを作らない。
- 初期対応はNotion Pageだけとする。
- ticket、内部handle、接続状態はポータブルデータに含めない。reference-onlyの
  Linked Sourceは、
  インポート後に再リンクするまで利用不能とする。
- 有効なhandleをCFOS Brokerで確認できない Linked Source とその派生データは、fail-closed
  で利用不能とする。

### Linked Source ticket、内部handle、Broker

```ts
interface SourceAccessBroker {
  claim(ticket: string): Promise<{
    sourceHandle: string;
    sourceAccessId: string;
  } | null>;
  describe(handle: string): Promise<LinkedSourceDescription | null>;
  openReadSession(handle: string): Promise<unknown | null>;
}
```

- Agentは接続済みNotion bindingの`$cfosLinkedSourceHandle()`からticketを取得し、
  同じ実行内で`ingest()`の`sourceHandle`へ直接渡す。ticketを返値、会話、
  Evidence、Wiki、metadata、ログへ出さない。
- ticketは推測不能、非ポータブル、発行から5分で失効、1回限りである。同じ接続から
  新しいticketを発行すると、未使用の旧ticketは失効する。
- `claim(ticket)`はticketを消費し、Agentへ露出しない内部handleと、observer検証に
  使う非bearer `sourceAccessId`を返す。失効、再利用、不明は`null`でfail-closedにする。
- WWWKが永続化する実行時接続は内部handleだけとし、ticket、外部原典のbinding、
  Fetcher、一時Sessionは保存しない。
- `describe(handle)`はAdapter選択と来歴記録に必要な非秘密情報だけを返す。
- `openReadSession(handle)`はCFOSでhandleを検証してから、呼び出すたび新しい一時Sessionを
  返す。失効、不明、障害は`null`でfail-closedにする。
- `sourceAccessId`の信頼済み対応表はCFOS側だけで保持し、共有時のobserver検証に
  だけ使う。
- Session は observation-only の承認キューで開く。`authorizeObservation()` は CFOS の
  監査へ記録し、`submitAction()` と `bindHook()` は常に拒否する。
- Source 参照は、元の Agent セッションではなく `linked-source` として監査する。
- WWWK の Adapter は allowlist された既存の読取メソッドだけを呼び出す。共通の
  `readSource()` は定義しない。

## 共有 Gadget の observer 検証

`WwwkLibrary` は所有者専用のままとし、共同利用者へ検索や直接参照を許可しない。一方、
WWWK の情報を使った Gadget は、実際に返す文書の生成元を共同利用者が現在参照できる
場合に限り共有できる。

- `search()` は結果集合、`read()` は返す文書から、Wiki -> Evidence -> Source revision の
  閉包をSQLで求め、Linked Sourceの和集合を重複なく使う。`ingest()`だけでは共有要件を
  追加しない。
- CFOSはticketのclaim時に非bearerのopaque `sourceAccessId`を発行し、Source Gatekeeperとの対応を
  Source側Overseerのembedded KVだけに保持する。WWWKはopaque IDを実行時KVにだけ保存する。
- WWWKは`sourceAccessId`をSQL、frontmatter、export、Agent結果、action/observationの
  descriptionへ含めない。verifier、認証情報、外部capability、Sessionも保持しない。
- 観測時、CFOSは既存observerの選択済み同vendor accountからVerifierを取得し、全Source
  Gatekeeperの`addObserver()`を検証してから認可する。1件でも拒否、失効、障害、未登録、
  vendor不一致、不明な依存ならfail-closedにする。
- 認可後かつ返却前に、WWWK GatekeeperはSourceAccess IDを観測済み集合へKV保存する。
  失敗時の過剰記録は許容するが、返却後に未記録となる順序は許可しない。
- observerのopenごとに、CFOSはこの観測済み集合からSource Gatekeeperを追加して再検証する。
  新しいSourceを観測できないobserverは`excludeObservers`で遮断し、現行CFOSが分離できない
  場合は観測を拒否する。
- Owned Sourceや壊れた閉包はsource-aware認可に進めず、既存の`prohibitAllSharing`で共有を
  拒否する。`WwwkLibrary`やbundleを直接共有しない。
- 初期実装は同一Overseer/workspaceだけを対象にする。別workspace由来の`sourceAccessId`は
  解決せず、明示的にfail-closedとする。

## 実行時ストレージ

ユーザーごとに 1 つの SQLite-backed `WwwkLibrary` Durable Object を割り当てる。

- SQL は、Source、Evidence、Wiki と生成依存リンクを保存する。
- 同じ Durable Object の embedded KV は、Linked Sourceのopaque handleなどの実行時状態を
  保存する。外部の Workers KV は使用しない。
- 検索と逆引きのインデックスは、保存データから再生成できる実行データとする。
- D1、R2、Vectorize は初期依存にせず、実測した必要性が出た場合だけ追加を検討する。

SQLite のスキーマは非公開の実装詳細であり、ポータブル形式にはしない。所有者は
`WwwkLibrary` の分離と CFOS の account 境界で保証し、文書ごとに重複保存しない。

### 最小 SQL スキーマ

```sql
CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL
    CHECK (type IN ('source', 'evidence', 'wiki')),
  title TEXT NOT NULL
    CHECK (length(title) > 0),
  content TEXT NOT NULL
    CHECK (length(content) > 0),
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

CREATE TABLE _schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
```

- Source、Evidence、Wiki は共通の `documents` に保存し、層ごとの重複テーブルを作らない。
- Evidence から Source、Wiki から Evidence への生成依存だけを `document_inputs` に保存する。
- ID は `crypto.randomUUID()` で生成し、SQLite の `rowid` に依存させない。
- `content_hash` は content を正規化せず、UTF-8 の SHA-256 とする。
- `metadata_json` は正規化したポータブルメタデータに使う。権限や capability の判定には
  使わない。
- 文書は不変とし、`updated_at`、soft delete、層別テーブルは初期スキーマへ追加しない。
- `_schema_migrations` を constructor の初期化時だけ更新する。`PRAGMA user_version` は
  使用しない。

### 初期書込み transaction

承認前の draft は WWWK Gatekeeper Durable Object の embedded KV に pending action
として保持し、Library へ保存しない。approval queue への登録に失敗した場合と action
が拒否された場合は削除し、適用後は全文を残さず 3 文書の ID だけを保持する。

承認後、`WwwkLibrary` は同期 SQL だけを `transactionSync()` 内で実行する。

1. action が持つ 3 文書の ID と生成依存リンクの既存状態を確認する。
2. 何も存在しなければ Source、Evidence、Wiki と 2 つの生成依存リンクを挿入する。
3. 3 文書と 2 リンクが完全に一致する場合は、再試行を成功として扱う。
4. 一部だけ存在する場合や値が異なる場合は例外を投げ、全体を rollback する。

LLM 生成、hash 計算、外部 I/O、approval 処理は transaction の外で行う。CFOS の action
状態と `WwwkLibrary` は分散 transaction にせず、同じ action の再実行を冪等にすることで
境界上の失敗を処理する。

### Revert

revert も同期 SQL だけを 1 transaction で実行する。

1. action が作成した 3 文書と 2 リンクが完全に一致することを確認する。
2. action 外の文書が対象を生成入力として参照していないことを確認する。
3. 生成依存リンクを削除してから、3 文書を削除する。
4. 3 文書と 2 リンクがすべて存在しない場合だけ、既に revert 済みとして成功する。

部分一致や外部依存がある場合は fail-closed とする。初期 Ingest は独立した新規 3 層だけを
作るため、通常は外部依存を持たない。将来の更新 API は、この revert 契約を壊さないように
別途設計する。

### Account revoke

account の revoke は、同じ SQLite-backed Durable Object の transaction で生成依存リンクと
文書を削除し、embedded KV に永久失効 marker を保存する。再起動後も `search()`、`read()`、
`ingest()`、pending action の適用、revert を拒否する。失効済み account は再作成せず、再接続
が必要になった場合は別 account として扱う。

## ポータブルデータ

Phase 2 の Bundle v1 は、archive や filesystem に依存しない plain data として扱う。

```ts
type WwwkPortableBundle = {
  files: Array<{
    path: string;
    content: string;
  }>;
};
```

構造は次に固定する。

```text
bundle/
├── manifest.yaml
├── sources/<id>.md
├── evidence/<id>.md
└── wiki/<id>.md
```

`manifest.yaml` は次の 2 項目だけを持つ。

```yaml
format: wwwk
version: 1
```

各文書は UTF-8 Markdown と YAML frontmatter で表現する。

```yaml
---
id: 00000000-0000-4000-8000-000000000000
type: evidence
title: 文書タイトル
content_hash: <本文UTF-8のSHA-256>
created_at: 2026-08-11T00:00:00.123Z
sources:
  - id: 00000000-0000-4000-8000-000000000001
    resource: /sources/00000000-0000-4000-8000-000000000001.md
---
Markdown本文
```

- SQLite ファイルやテーブル構造をエクスポート形式にしない。
- `id` は `crypto.randomUUID()` 由来の lowercase UUID v4 とし、path の ID と一致させる。
- `type` は `source`、`evidence`、`wiki` に限定し、type ごとの directory と一致させる。
- 本文は `content` と完全一致させ、`content_hash` は本文 UTF-8 の SHA-256 と一致させる。
- `created_at` はミリ秒を持つ ISO 8601 とし、export 時は UTC 表記に正規化する。
- Source は `sources` を持たない。Evidence は Source 1 件、Wiki は Evidence 1 件を
  `id` と bundle-root からの絶対 resource path で参照する。
- `metadata_json` の未知の JSON 互換値は frontmatter で保持する。`id`、`type`、`title`、
  `content_hash`、`created_at`、`sources` は予約し、metadata による上書きを拒否する。
- `generated` は保存済み metadata に存在するときだけ保持し、export 時に生成者情報を
  推測または追加しない。
- YAML のコメント、key 順、引用形式は保持せず、正規化した論理値を保持する。
- import 時は、インデックスなどの実行データを bundle から再構築する。
- `export -> 空の WwwkLibrary へ import` の往復で、論理データと生成依存リンクが
  一致することをテストする。

### Import/export transaction

export は live な Library の `documents` と `document_inputs` だけを読み、文書、hash、
依存方向、利用可能性を検証して決定的な path 順で返す。embedded KV、capability、失効
marker、`is_available`、SQL schema、index は含めない。

import は manifest、path、frontmatter、hash、依存を解析し、JSON 互換 metadata へ
正規化してから storage transaction を開始する。transaction 内では live 状態と
`documents`、`document_inputs` が空であることを再確認し、全文書を `is_available = 1`
として保存してから全生成依存リンクを保存する。YAML 解析、hash 計算、外部 I/O は
transaction 内で実行しない。検証または保存に失敗した場合は部分状態を残さない。

### エクスポート境界

- Owned Source とその派生データは、self-contained bundle としてエクスポートできる。
- Phase 3では、Linked Sourceとその派生データを含むself-contained exportを拒否する。
- Linked Sourceの全文出力とreference-only bundleは、出力許可を含むCFOS契約を確定して
  から扱う。
- 自動または定期エクスポートは初期スコープに含めない。

### OKF との対応

ポータブルな Concept 文書は、OKF v0.2 の YAML frontmatter、Markdown、`sources`、
bundle-root 相対 path、未知 key の保持という考え方を参考にする。Bundle v1 は WWWK の
3 層と厳格な依存規則に限定した独自 profile であり、OKF 完全準拠や任意の OKF bundle
との互換性を表明しない。OKF を実行時ストレージや権限モデルにはしない。

| ポータブル形式 | 実行時表現 |
| --- | --- |
| `id`、`type`、`title` | 検索可能な文書フィールド |
| Markdown 本文 | 文書本文 |
| `generated`、`resource`、revision など | 正規化したメタデータ |
| `sources` | 生成依存リンク |

- import 時は frontmatter を解析し、JSON 互換の値へ正規化して保存する。
- export 時は正規化した値と生成依存リンクから frontmatter を再構成する。
- Evidence の `sources` は Source revision、Wiki の `sources` は Evidence を参照する。
- 未知の frontmatter 項目は値を保持する。コメント、項目順、引用符などの表記は
  往復一致の対象にしない。
- `sources` はポータブルな来歴であり、アクセス権限の正本にはしない。
- `is_available`、capability、接続状態などの実行時情報は frontmatter に含めない。

Bundle v1 の厳密なスキーマは上記のとおり確定している。OKF v0.2 の全機能を採用する
ことや、任意の OKF bundle を取り込めることは保証しない。OKF との追加互換性や完全な
適合方針は、利用要件が固まってから決める。

依存方向は一方向に固定する。

```text
Source revision -> Evidence -> Wiki
```

### Sources

- LLM が実際に参照した原典を保持する。
- Linked Source から取得した内容は、その時点の不変な Source revision として保持する。
- 原典は変更せず、更新時は新しい revision として扱う。
- 原文を同梱できない場合は reference-only とし、参照先、revision、content hash を
  保持する。
- WWWK による解釈や横断的な考察は含めない。

### Evidence

- Source から抽出した事実、観察、引用位置を保持する。
- 原則として、1 つの Evidence は 1 つの Source revision に由来する。
- 複数 Source を横断する統合や考察は Wiki の責務とする。
- 通常は Source revision ごとに 1 つとし、実測したサイズ制約がある場合だけ分割する。

### Wiki

- 1 つ以上の Evidence を整理、比較、統合した概念ページを保持する。
- 要約、矛盾、仮説、関連リンクを含められる。
- Evidence から再生成可能な派生データとして扱う。
- Wiki 間リンクはナビゲーションであり、来歴を表す依存関係ではない。

## データ間リンク

### 生成依存リンク

- Evidence は、入力となった Source revision を参照する。
- Wiki は、実際に入力したすべての Evidence を参照する。
- 1 つの Wiki は複数の Evidence を統合でき、1 つの Evidence は複数の Wiki から参照できる。
- 入力一覧はシステムが文書単位で記録し、失効判定と再生成に使う。
- Wiki 内の個別記述から Evidence への引用は補助情報とし、権限判定には使わない。
- 別の Wiki は事実の生成入力にせず、その背後にある Evidence まで辿る。

### 意味リンク

- Wiki 間の関連は、本文中の通常の Markdown リンクで表す。
- 意味リンクは循環を許容し、検索とナビゲーションに利用する。
- 意味リンクを生成依存、来歴、権限判定の根拠にしない。

ID の参照先、検索、リンクと被リンクのインデックスは、元データから再生成できる
実行データとする。初期検索は上記の部分一致とし、高度な検索方式は未決定とする。

## 来歴と権限失効

- 各データは安定した ID を持つ。
- 派生データには、生成時に実際に使われた入力を記録する。
- 来歴は LLM の自己申告や引用だけに依存せず、システムが記録する。
- Source の権限失効時は、対応する Evidence と Wiki を決定論的に特定する。
- 影響するデータは先に利用不能とし、LLM による再生成は非同期で行える。
- 逆引きインデックスは派生可能な実行データとし、ポータブルデータへ含めない。

「直ちに利用不能」とは、失効または再認可不能を検知した後の処理を指す。検知する時期と
方法は未決定とする。

## Source 更新と再生成

- Source の内容を上書きせず、新しい Source revision として追加する。
- 新しい revision から Evidence を生成し、それに依存する Wiki だけを再生成する。
- 変更されていない Source revision と Evidence は再利用する。
- 内容更新時は古い派生データを stale として扱い、再生成後に置き換えられる。
- 権限失効時は stale として残さず、影響するデータを直ちに利用不能とする。

更新を検知する時期と方法は、必要になるまで決定しない。

## 最小フォーマット

- `manifest.yaml` はフォーマット名とバージョンを持つ。
- 各データは少なくとも `id` と `type` を持つ。
- 派生データは、OKF の `sources` で入力元を参照する。
- Source は revision または content hash で参照時点を識別できる。
- `generated` は保存済みの場合だけ保持し、export 時に生成者情報を推測または追加しない。
- Concept 文書は Markdown と YAML frontmatter を基本とする。

Bundle v1 の厳密な YAML スキーマは「ポータブルデータ」に定義する。OKF との追加互換性や
完全な適合方針は、利用要件が固まってから決める。

## ポータブルにしないもの

- OAuth トークン、秘密情報、Gatekeeper capability
- Linked Source の接続状態
- ACL と実行時の権限状態
- Embedding、検索インデックス、逆引きインデックス
- ジョブ、キャッシュ、セッション、Durable Object などの実行状態
- 特定の LLM、ストレージ、UI に依存する実装

インデックスや履歴ファイルを提供する場合も、再生成可能な補助データとして扱う。

## データ消去境界

- 標準の接続解除はWWWK dataを保持し、完全消去は独立した破壊操作とする。
- 完全消去は接続解除、対象identity、exportの要否、不可逆性を確認してから実行する。
- ローカルではWWWKの2つのDurable Object namespaceだけを削除する。
- Cloudflareでは2つのclassの`deleted` tombstoneを同じWWWK Workerへdeployしてから、
  依存関係保護を有効にしたままWorkerを削除する。
- CFOS、ほかのGatekeeper、共有KV / R2、ローカルstate全体は削除しない。

## 未決定事項

- Agent Skill の自動読込みと更新方式、更新などの追加操作 API
- installer の最小 CLI、複数 revision への対応、upgrade 自動化
- 検索件数の上限、高度な検索方式、UI、LLM、バックグラウンド処理
- Source 更新を検知する時期と方法
- Context Library と連携する専用 Adapter
- Linked Source の全文出力を許可する具体的な契約と reference-only bundle の詳細
- Owned Source の明示的な共有ポリシーと Wiki の直接共有機能

初期スコープでは `WwwkLibrary` の直接利用は個人専用かつ非公開とする。共有 Gadget
からの派生 observation だけを、上記の observer 検証に従って許可する。
