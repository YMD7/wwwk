# WWWK Architecture


## 位置づけ

WWWK は、Cloudflare OS（CFOS）へ個人専用の LLM Wiki を追加する拡張である。
本書は確定した責務とデータ境界だけを記録する。保存基盤、UI、検索方式などは未決定とする。

## CFOS との境界

| 領域 | 責務 |
| --- | --- |
| CFOS | ID、ワークスペース、エージェント実行、サンドボックス、Gatekeeper、権限、承認、監査 |
| WWWK | 個人 Wiki の知識ライフサイクル、来歴、3 層データ、データの入出力 |

WWWK は CFOS の権限モデルを迂回、複製、置換しない。外部原典へのアクセス可否は
CFOS が決定し、WWWK はその結果に従う。

## 導入方針

導入は段階的に進める。

1. clone した CFOS へ `gatekeeper-wwwk` を組み込み、ローカルで開発と検証を行う。
2. 検証後に、`cloudflare-os-starter` から Cloudflare へデプロイする構成へ対応する。

WWWK は独立した Gatekeeper Worker とし、CFOS から `GATEKEEPER_WWWK` service binding
で接続する。ローカル版と本番版で中核実装を共通化し、本番対応はローカル検証後に行う。
WWWK リポジトリ直下を単一の `gatekeeper-wwwk` package とし、独自の `packages/` 階層や
monorepo は作らない。ローカルでは CFOS の `packages/gatekeeper-wwwk` から WWWK へ
link する。詳細は `INSTALLATION.md` に記録する。

## エージェントとの境界

WWWK は、AI 向けの利用方法を 1 つの Agent Skill として提供する。Skill は CFOS の
仕組みから発見し、必要なときだけ読み込む。

- Skill は、WWWK を使う場面、検索順序、原典への辿り方、操作手順を説明する。
- Skill は操作知識であり、権限、来歴、失効、再生成の正しさを保証しない。
- 検索、参照、Ingest などの実処理は、WWWK のエージェント向け API を通す。
- WWWK Core は、3 層データと決定論的な不変条件を API の内側で保証する。
- Skill に個人 Wiki、Source、Evidence、秘密情報、capability、実行状態を含めない。
- 共通の Skill と、ユーザーごとの非公開データを分離する。

Skill と API の具体的な内容は未決定とする。

## Linked Source

Linked Source は、外部原典への実行時接続である。ポータブルな Source revision とは
分離して管理する。

- 外部原典への接続、再認可、監査、失効は CFOS に委ねる。
- WWWK は、永続的、読取専用、監査可能な CFOS capability を介して原典を取得する。
- 来歴を確定する本文は、Agent の自己申告を信頼せず、WWWK の Adapter が capability
  から取得する。
- Source の種類は明示的な allowlist と Adapter で段階的に追加し、最初から汎用
  Source プロトコルを作らない。
- 初期対応は、Google Doc、Notion Page、Confluence Content などの文書単位の
  Gatekeeper を優先する。
- capability と接続状態はポータブルデータに含めない。インポート後は再リンクするまで
  保存済み Source revision のみを利用できる。
- 再認可できない Source とその派生データは fail-closed で利用不能とする。

Workers RPC と現在の CFOS の Gatekeeper binding を用いたローカル PoC で、別 Worker
への capability 保存、プロセス再起動後の再読、失効後の遮断を確認した。ただし現在の
`GatekeeperLoopback` は CFOS の内部実装であり、公開版が直接依存してはならない。
公開可能な実装では、次の安定した契約を CFOS 側に定義する。

### SourceAccess 契約

```ts
interface SourceAccess {
  describe(): Promise<SourceAccessDescription>;
  openReadSession(): Promise<unknown>;
}

interface SourceAccessDescription {
  vendorId: string;
  url: string;
  title: string;
  tsType: string;
}
```

- WWWK が永続化する接続は `SourceAccess` だけとし、外部原典の binding や一時的な
  Gatekeeper Session は保存しない。
- `describe()` は Adapter の選択と来歴の記録に必要な非秘密情報だけを返す。
- `openReadSession()` は呼び出すたびに新しい一時 Session を返す。
- CFOS は、外部原典の binding に対する予約操作で `SourceAccess` を発行する。その
  binding は発行時だけ使用し、WWWK の実行状態には保存しない。
- Session は observation-only の承認キューで開く。`authorizeObservation()` は CFOS の
  監査へ記録し、`submitAction()` と `bindHook()` は常に拒否する。
- Source 参照は、元の Agent セッションではなく `linked-source` として監査する。
- WWWK の Adapter は allowlist された既存の読取メソッドだけを呼び出す。共通の
  `readSource()` は定義しない。

予約操作の名称と Adapter の初期対応範囲は未決定とする。

## ポータブルデータ

ポータブルにする対象はシステムではなく、次のデータである。

```text
bundle/
├── manifest.yaml
├── sources/
├── evidence/
└── wiki/
```

依存方向は一方向に固定する。

```text
Source revision -> Evidence -> Wiki
```

### Sources

- LLM が実際に参照した原典を保持する。
- Linked Source から取得した内容は、その時点の不変な Source revision として保持する。
- 原典は変更せず、更新時は新しい revision として扱う。
- 原文を同梱できない場合は、参照先、revision、content hash を保持する。
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

ID の参照先、全文検索、リンクと被リンクのインデックスは、元データから再生成できる
実行データとする。具体的な検索エンジンや高度な検索方式は未決定とする。

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
- 派生データは入力元を参照する。
- Source は revision または content hash で参照時点を識別できる。
- 生成物は生成者と生成日時を保持する。
- Concept 文書は Markdown と YAML frontmatter を基本とし、OKF との互換性を目標とする。

厳密な YAML スキーマと OKF 適合プロファイルは、利用要件が固まってから決める。

## ポータブルにしないもの

- OAuth トークン、秘密情報、Gatekeeper capability
- Linked Source の接続状態
- ACL と実行時の権限状態
- Embedding、検索インデックス、逆引きインデックス
- ジョブ、キャッシュ、セッション、Durable Object などの実行状態
- 特定の LLM、ストレージ、UI に依存する実装

インデックスや履歴ファイルを提供する場合も、再生成可能な補助データとして扱う。

## 未決定事項

- Agent Skill とエージェント向け API の具体的な内容
- 本番用 WWWK package の配布方法
- インストールスクリプト、アップグレード、アンインストールの詳細
- 物理ストレージと同期方法
- Ingest、Query、Lint の実行設計
- 検索インデックスの実装、高度な検索方式、UI、LLM、バックグラウンド処理
- Source 更新を検知する時期と方法
- `SourceAccess` を発行する CFOS 予約操作の名称と Adapter の初期対応範囲
- インポート、エクスポート時の詳細な権限ポリシー
- Wiki の共有機能

初期スコープでは Wiki は個人専用かつ非公開とする。
