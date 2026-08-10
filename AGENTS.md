# AGENTS.md


## プロジェクト

名称は `WWWK`、読みは「うーく」とする。
WWWK は、Cloudflare OS（CFOS）へ個人専用の LLM Wiki を追加する拡張である。
設計と実装は `PRINCIPLES.md` と `ARCHITECTURE.md` に従う。

## 作業前に読むもの

1. `PRINCIPLES.md`
2. `ARCHITECTURE.md`
3. 導入に関する変更では `INSTALLATION.md`
4. 対象となる CFOS の最新コードと公式資料

## 作業原則

- KISS と YAGNI を守り、合意済みの範囲だけを変更する。
- 一度に一つの設計課題を扱い、未決定事項を同時に確定しない。
- 推測を設計判断にせず、一次情報とコードで確認する。
- 新しい責務、抽象層、状態、依存関係は、現在の要件で必要な場合だけ追加する。
- 設計変更は実装前に提案し、合意後に文書とコードを更新する。
- 既存の確定事項を変更する場合は、理由と影響範囲を明示する。

## CFOS との境界

- 認証、権限、capability、Gatekeeper、承認、監査を独自実装しない。
- 外部原典へのアクセスは CFOS の仕組みを利用する。
- Linked Source の永続接続には、CFOS が発行する `SourceAccess` だけを利用する。
- `SourceAccess` は `describe()` と `openReadSession()` 以外の責務を持たせない。
- 外部原典の binding は `SourceAccess` の発行時だけ利用し、永続化しない。
- 一時的な Gatekeeper Session を永続リンクとして保存しない。
- Linked Source の Session は observation-only とし、action と hook を常に拒否する。
- Linked Source の参照は `linked-source` として CFOS の監査へ記録する。
- 公開版を CFOS 内部の `GatekeeperLoopback` 契約へ直接依存させない。
- Context Library と Worker、ストレージ、スキーマを共有せず、その内部型や Durable
  Object へ直接依存しない。
- Context Library との連携は、将来の任意 Source provider Adapter として扱う。
- WWWK のデータや frontmatter を権限の正本にしない。
- CFOS のセキュリティ境界を迂回する設計を禁止する。

## 導入方針

- 最初に、clone した CFOS へ WWWK を組み込み、ローカルで開発と検証を行う。
- ローカル検証後に、`cloudflare-os-starter` を使う本番環境へ対応する。
- WWWK の中核を両環境で共通化し、ローカル専用の前提を持ち込まない。
- 本番対応を理由に、ローカル検証に不要な仕組みを先行実装しない。
- リポジトリ直下を単一の `gatekeeper-wwwk` package とし、monorepo 化しない。
- ローカルでは、CFOS の `packages/gatekeeper-wwwk` から WWWK へ link する。
- 参照系 Session API は `search()` と `read()` に限定し、未合意の操作を追加しない。
- UI、OAuth、hooks、background worker は、必要性が確定するまで追加しない。

## エージェントとの境界

- WWWK の利用方法は、小さな Agent Skill として必要時に読み込ませる。
- 必須の Skill は WWWK 自身が提供し、Context Library の有無に依存させない。
- Skill にユーザーの知識、秘密情報、capability、実行状態を含めない。
- 実処理はエージェント向け API を通し、Skill の指示だけに依存しない。
- 権限、来歴、失効、再生成の不変条件は WWWK Core で保証する。
- `search()` はデフォルトで Wiki だけを検索する。
- `read()` は本文と生成入力を一緒に返し、来歴を別 API に分離しない。
- 失効または利用不能な文書は返さない。
- 検索結果と本文は、CFOS の observation として記録した後に返す。

## 保存境界

- ユーザーごとに 1 つの SQLite-backed `WwwkLibrary` Durable Object を使用する。
- 3 層データと生成依存リンクは SQL、実行時 capability は同じ DO の embedded KV に
  保存する。
- SQLite のファイル、テーブル、`rowid` をポータブル形式へ露出しない。
- ポータブルな Concept 文書は YAML frontmatter と Markdown 本文で表現し、実行時は
  frontmatter を JSON 互換の値へ正規化する。
- import/export は論理値を保持し、YAML のコメントや項目順の一致を要件にしない。
- export と空の `WwwkLibrary` への import の往復で、論理データの一致を検証する。
- D1、R2、Vectorize、外部 Workers KV は、実測した必要性なしに追加しない。

## データ不変条件

- 依存方向は `Source revision -> Evidence -> Wiki` とする。
- Source は不変とし、変更時は新しい revision を作る。
- Evidence は原則として 1 つの Source revision に由来する。
- 複数 Source の統合は Wiki で行う。
- Wiki は Evidence から再生成可能にする。
- Wiki は、実際に入力したすべての Evidence を文書単位で記録する。
- Wiki 内の個別記述から Evidence への引用を権限判定に使わない。
- Wiki 間リンクを来歴や権限依存として扱わない。
- 別の Wiki は事実の生成入力にせず、その背後にある Evidence まで辿る。
- 実際に使用した入力はシステムが記録し、LLM の自己申告だけに依存しない。
- Source の権限モードは、独立したコピーである Owned Source と、外部原典の
  `SourceAccess` に依存する Linked Source に限定する。
- Linked Source の本文は、allowlist された Adapter が capability から取得する。
- Linked Source の全文エクスポートは、有効な `SourceAccess` と出力許可を確認し、
  明示的な操作として認可、監査する。
- 全文エクスポートした Linked Source は、外部由来の来歴を保持した Owned Source
  snapshot として扱う。外部へ出たコピーは将来の権限失効の対象にしない。
- 全文出力を許可できない Source と、その内容を含み得る派生データを self-contained
  bundle に含めない。
- 権限失効の判定と影響範囲の特定を LLM に任せない。
- Source 更新時は新しい revision を作り、影響する派生データだけを再生成する。
- ポータブルデータへ秘密情報や実行時 capability を含めない。

## ドキュメントとコード

- ドキュメントとコードコメントは標準的な日本語で記述する。
- 変数名、関数名、型名などのコード識別子は英語にする。
- ドキュメントは短く保ち、同じ規則を複数箇所へ重複記載しない。
- 実装が確定事項と異なる場合は、コードに合わせて黙って文書を変えず、先に判断を仰ぐ。

## 現在の未決定事項

SQL スキーマ、検索の実装と高度化、Source 更新の検知、UI、LLM、バックグラウンド処理、
Agent Skill と Ingest、更新などの操作 API、本番用 package の配布方法、アップグレード、
アンインストールの詳細、`SourceAccess` を発行する CFOS 予約操作の名称、Adapter の
初期対応範囲、Context Library の専用 Adapter、Linked Source の全文出力を許可する
具体的な契約、reference-only bundle の詳細は未決定である。必要になるまで選定や
雛形作成を行わない。
