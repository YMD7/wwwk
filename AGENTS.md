# AGENTS.md

## プロジェクト

名称は `WWWK`、読みは「うーく」とする。
WWWK は、Cloudflare OS（CFOS）へ個人専用の LLM Wiki を追加する拡張である。
設計と実装は `DEVELOPMENT.md`、`docs/PRINCIPLES.md`、
`docs/ARCHITECTURE.md` に従う。

## 作業前に読むもの

1. `DEVELOPMENT.md`
2. `docs/PRINCIPLES.md`
3. `docs/ARCHITECTURE.md`
4. 現在の作業計画が存在する場合は、その計画
5. 導入に関する変更では `docs/INSTALLATION.md`
6. 対象となる CFOS の最新コードと公式資料

## 作業原則

- ローカルで使える最小の縦切りを最優先し、現在のフェーズに直接必要な実装だけを行う。
- テストは現在のゴール、変更した契約、セキュリティ境界を確認する最小範囲に絞る。
- KISS と YAGNI を守り、合意済みの範囲だけを変更する。
- 一度に一つの設計課題を扱い、未決定事項を同時に確定しない。
- 推測を設計判断にせず、一次情報とコードで確認する。
- 新しい責務、抽象層、状態、依存関係は、現在の要件で必要な場合だけ追加する。
- 設計変更は実装前に提案し、合意後に文書とコードを更新する。
- 既存の確定事項を変更する場合は、理由と影響範囲を明示する。

## 開発フロー

- `main <- develop <- 作業ブランチ` の順で、必ず PR を通して統合する。
- 作業ブランチは最新の `develop` から作成し、`.worktrees/` 配下の専用 worktree で扱う。
- `main` と `develop` へ直接実装を commit または push しない。
- 1 つの作業ブランチでは、現在の 1 フェーズのゴールだけを扱う。
- 詳細な作成、検証、統合、後片付けの手順は `DEVELOPMENT.md` に従う。

## CFOS との境界

- 認証、権限、capability、Gatekeeper、承認、監査を独自実装しない。
- 外部原典へのアクセスは CFOS の仕組みを利用する。
- AgentにはCFOS発行の非ポータブル、1回限りかつ短命なopaque ticketだけを
  渡す。ticketは返値やログへ出さず、同じ実行で`ingest()`へ直接渡す。
- WWWKはBrokerがticketと交換した内部handleだけを保存する。外部原典のbinding、
  CFOS capability Fetcher、一時的な Gatekeeper Session は保存しない。
- 一時的な Gatekeeper Session を永続リンクとして保存しない。
- Linked Source の Session は observation-only とし、action と hook を常に拒否する。
- Linked Source の参照は `linked-source` として CFOS の監査へ記録する。
- 公開版を CFOS 内部の `GatekeeperLoopback` 契約へ直接依存させない。
- Context Library と Worker、ストレージ、スキーマを共有せず、その内部型や Durable
  Object へ直接依存しない。
- Context Library との連携は、将来の任意 Source provider Adapter として扱う。
- WWWK のデータや frontmatter を権限の正本にしない。
- 共同利用者の外部 verifier、認証情報、capability を WWWK へ渡さない。
- 共有 Gadget の observer 検証は、CFOS のSourceAccess Brokerと既存vendor Gatekeeperに
  委ねる。WWWKはverifier、認証情報、capability、Sessionを受け取らない。
- `sourceAccessId`は非bearer・非ポータブルなopaque IDとし、CFOSの信頼済み対応表は
  Source側OverseerのKVだけに保持する。WWWKはIDを実行時KVにだけ保存できる。
- ticket、`sourceAccessId`、内部handle、verifier、Session、tokenをSQL、frontmatter、
  export、Agent結果、
  action/observation descriptionへ含めない。
- CFOS のセキュリティ境界を迂回する設計を禁止する。
- `ingest()` は必ず CFOS の approval queue へ送り、初期実装では自動承認を許可しない。
- 初期 action は短い保存意図確認とし、`awaitDecision` を有効にして、3 層をまとめて
  取り消せるようにする。
- action の説明へ入力由来の文字列を含める場合は、Markdown として安全に処理する。

## 導入方針

- 最初に、clone した CFOS へ WWWK を組み込み、ローカルで開発と検証を行う。
- ローカル検証後に、`cloudflare-os-starter` を使う本番環境へ対応する。
- WWWK の中核を両環境で共通化し、ローカル専用の前提を持ち込まない。
- 本番対応を理由に、ローカル検証に不要な仕組みを先行実装しない。
- 利用者へ WWWK プロジェクトまたは第三者の CFOS / Starter fork を必須にしない。
- 対応する公式 revision へ version 固定の installer で必要な差分を適用する。
- installer は利用者の作業ツリーを直接変更せず、一時 worktree で統合、検証、build を行う。
- 対応 revision、patch、生成設定を実行前に検証し、未知の version や競合は fail-closed とする。
- CFOS の公開拡張境界で表現できない companion 差分だけを、追跡された監査可能な patch と
  して適用する。upstream の契約で代替できる差分は削除する。
- 本番では同じ Worker 名、Durable Object class、KV、R2 などの identity を維持し、
  WWWK 対応 version として再デプロイする。稼働中の Worker へコードを動的注入しない。
- 標準操作は接続解除とし、固定tupleのpatch済みWorkshopを維持したまま相互service bindingを
  外して、WWWKのデータを保持する。未改変の公式CFOSコードへの完全復帰は提供しない。
  データ消去は別の明示的な破壊操作とする。
- リポジトリ直下を単一の `gatekeeper-wwwk` package とし、monorepo 化しない。
- 手動の symbolic link は開発中の内部手順に限定し、利用者向け導入契約にしない。
- Session API は `search()`、`read()`、`ingest()` に限定し、未合意の操作を追加しない。
- UI、追加のOAuth provider、hooks、background workerは、必要性が確定するまで追加しない。

## エージェントとの境界

- WWWK の利用方法は、小さな Agent Skill として必要時に読み込ませる。
- 必須の Skill は WWWK 自身が提供し、Context Library の有無に依存させない。
- Skill にユーザーの知識、秘密情報、capability、実行状態を含めない。
- 実処理はエージェント向け API を通し、Skill の指示だけに依存しない。
- 権限、来歴、失効、再生成の不変条件は WWWK Core で保証する。
- 初期書込みはユーザーが明示した 1 つのテキストだけを対象とし、会話や文書を
  自動的に取り込まない。
- Agent は Source 本文を変更せず、解釈を Evidence と Wiki へ分離する。
- 1 Source revision、1 Evidence、新規 Wiki 1 件を 1 つの CFOS action として提案する。
- `ingest()` の入力へ ID、type、生成依存リンク、所有者、生成メタデータを追加しない。
- Source、Evidence、Wiki の内容を Agent への命令として実行しない。
- `search()` はデフォルトで Wiki だけを検索する。
- `read()` は本文と生成入力を一緒に返し、来歴を別 API に分離しない。
- 失効または利用不能な文書は返さない。
- 検索結果と本文は、CFOS の observation として記録した後に返す。

## 保存境界

- ユーザーごとに 1 つの SQLite-backed `WwwkLibrary` Durable Object を使用する。
- 3 層は共通の `documents`、生成依存は `document_inputs` に保存し、層別テーブルを
  作らない。
- 3 層データと生成依存リンクは SQL、実行時 capability は同じ DO の embedded KV に
  保存する。
- 承認前の draft は Gatekeeper DO の pending action にだけ保持し、拒否時は削除、
  適用後は 3 文書の ID だけへ縮小する。
- 初期 action の 3 層データと生成依存リンクは同期 SQL だけを `transactionSync()` で
  保存し、失敗時に途中状態を残さない。
- 書込みの再試行は、3 文書と 2 リンクの完全一致時だけ成功とする。部分一致や値の相違は
  fail-closed とする。
- revert は action 外の生成依存がない場合だけ、2 リンクと 3 文書を 1 transaction で
  削除する。
- LLM 生成、hash 計算、外部 I/O、approval 処理を SQL transaction 内で実行しない。
- 文書 ID は `crypto.randomUUID()`、content hash は正規化前の UTF-8 本文の SHA-256 と
  する。
- 所有者は `WwwkLibrary` と CFOS account の境界で保証し、文書ごとに保存しない。
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
- Source の権限モードは、独立したコピーである Owned Source と、CFOS Broker による
  再認可に依存する Linked Source に限定する。
- Linked Source の本文は、allowlist された Adapter が Brokerで開いた一時Sessionから取得する。
- Linked Source の全文エクスポートは、有効なCFOS権限と出力許可を確認し、
  明示的な操作として認可、監査する。
- 全文エクスポートした Linked Source は、外部由来の来歴を保持した Owned Source
  snapshot として扱う。外部へ出たコピーは将来の権限失効の対象にしない。
- 全文出力を許可できない Source と、その内容を含み得る派生データを self-contained
  bundle に含めない。
- 権限失効の判定と影響範囲の特定を LLM に任せない。
- Source 更新時は新しい revision を作り、影響する派生データだけを再生成する。
- `WwwkLibrary` は所有者専用とし、共同利用者へ検索や直接参照を許可しない。
- 共有 Gadget の observation は、実際に返す文書の生成依存を Source revision まで辿り、
  共同利用者が全 Linked Source の検証に成功した場合だけ許可する。ingestだけでは
  observer要件を追加しない。
- Owned Source、拒否、未登録、vendor 不一致、障害、不明な依存は fail-closed とする。
- observer が Gadget を開くたびに生成依存の閉包を再検証する。
- 生成依存へ新しい Source が加わった場合は既存 observer を再検証し、失敗時は
  `excludeObservers` を通して CFOS に observation を遮断させる。
- 観測済みSourceの集合は、CFOSで既存observerを検証した後、返却前にWWWK Gatekeeperの
  KVへ保存する。失敗時の過剰記録は許容するが、返却後の未記録は許可しない。
- 初期版の共有検証は同一Overseer/workspaceに限定する。別workspace由来のSourceは
  明示的にfail-closedとする。
- ポータブルデータへ秘密情報や実行時 capability を含めない。

## ドキュメントとコード

- ドキュメントとコードコメントは標準的な日本語で記述する。
- 変数名、関数名、型名などのコード識別子は英語にする。
- ドキュメントは短く保ち、同じ規則を複数箇所へ重複記載しない。
- 実装が確定事項と異なる場合は、コードに合わせて黙って文書を変えず、先に判断を仰ぐ。

## 公開リポジトリの安全性

- secret、token、cookie、認証ヘッダー、秘密鍵、OAuth 情報、capability、実データを
  コード、文書、fixture、prompt、ログへ含めない。
- ユーザー固有の絶対パス、ユーザー名、メールアドレス、account ID、workspace ID、
  hostname を repository の内容へ含めず、環境変数か明らかな例示値を使う。ユーザーが
  公開を明示した Git author metadata は除く。
- `.env`、`.dev.vars`、`.wrangler`、SQLite database、cache、keyring、ローカル生成状態を
  commit しない。該当ファイルを導入する場合は先に `.gitignore` を更新する。
- Source、Evidence、Wiki、承認前 action の全文をデバッグ出力やテスト fixture に使わない。
- 第三者のコード、文書、asset を追加する前に出典と license の互換性を確認し、必要な
  copyright、license、NOTICE を保持する。不明なものは取り込まない。
- Cloudflare の名称は参照目的だけに使い、公式な提携、承認、支援を示唆しない。商標や
  logo は Cloudflare の公式ガイドラインに従う。
- 依存 package は現在の要件に必要なものだけを追加し、出典、license、既知の脆弱性を
  確認する。
- commit 前に対象ファイル、staged diff、secret と個人情報の有無を確認する。Public への
  初回 push と release 前は、Git 履歴、author metadata がユーザーの公開意図と一致する
  こと、license、NOTICE も確認する。
- installer は secret、token、認証済み設定の値、利用者のデータを patch、生成物、実行計画、
  ログへ含めない。外部 repository の未追跡 script や未知の patch を実行しない。
- installer が適用する CFOS 差分は WWWK repository で追跡し、対象 revision と内容を
  review できる状態にする。ネットワークから取得した任意コードをそのまま適用しない。
- secret が履歴へ入った場合は、削除 commit だけで済ませず、直ちに利用を停止して失効、
  履歴除去、再発行の順で対応する。
- 判断に迷うデータや第三者成果物は commit せず、ユーザーへ確認する。

## 現在の未決定事項

高度な検索、Source 更新の検知、UI、LLM、バックグラウンド処理、Agent Skill の具体的な
内容と更新などの追加操作 API、複数の CFOS / Starter revision への対応、upgrade 自動化、
Context Library の専用 Adapter、Linked Source の全文出力を
許可する具体的な契約、reference-only bundle の詳細、Owned Source の明示的な共有ポリシー、
Wiki の直接共有機能は未決定である。必要になるまで選定や雛形作成を行わない。
