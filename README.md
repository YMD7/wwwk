# WWWK

`WWWK`（読み: うーく、発音: `/u:k/`）は、Cloudflare OS（CFOS）へ
個人専用の LLM Wiki を追加する拡張である。

## 概要

- 原典に紐付いた知識を `Source revision -> Evidence -> Wiki` の3層で管理する。
- Sources、Evidence、Wiki をポータブルなデータとして扱う。
- 外部原典は CFOS capability でリンクし、接続状態とポータブルデータを分離する。
- 認証、権限、承認、監査は CFOS に委ね、そのセキュリティ境界に従う。

ローカル版 CFOS から `search()`、`read()`、`ingest()` を利用できる。静的 Agent Skill は
`/wwwk` から読み込む。3 層と生成依存は Markdown と YAML frontmatter の Bundle v1 で
往復できる。Linked Notion Page は CFOS の stable Broker を通して取り込み、共有 Gadget
では生成元の現在の参照権限を CFOS が検証する。handle は実行時状態として保存するが
export せず、外部 binding と一時 Session も保存しない。

利用者へ特定の CFOS fork を要求せず、対応する公式 CFOS と
`cloudflare-os-starter`へ、version 固定の installer が必要な差分を一時的に適用する方針を
採用する。Phase 5では固定revision向けのpatch、互換lockfile、binding生成PoCを追跡している。
利用者向けinstallerとCloudflare上での本番導入は未実装である。bundleを運ぶUI、CLI、archive、
Linked Sourceのexportもまだ対象外とする。

導入契約と現在の実装状況は [Installation](docs/INSTALLATION.md) を参照する。

## 独立性と商標

WWWK は独立したオープンソースプロジェクトであり、Cloudflare, Inc. の公式製品では
なく、同社との提携、同社による承認または支援を示すものではない。

Cloudflare および関連する名称とロゴは、Cloudflare, Inc. の商標または登録商標である。

## ドキュメント

- [Development](DEVELOPMENT.md)
- [Implementation phases](plans/IMPLEMENTATION_PHASES.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Installation](docs/INSTALLATION.md)
- [Principles](docs/PRINCIPLES.md)
- [Agent guide](AGENTS.md)

## ライセンス

[Apache License 2.0](LICENSE)
