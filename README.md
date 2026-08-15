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
採用する。ローカルの対応 CFOS clone は、次の入口で起動できる。

```sh
pnpm run install:local -- --cfos "$CFOS_ROOT"
```

installer は checkout 外の state と専用 integration worktree を使い、元の clone を変更しない。
停止後の再起動、state場所の変更、非破壊 disconnect は
[Installation](docs/INSTALLATION.md) を参照する。対応する Starter checkout では、同じ方式で
install / disconnect の build と Wrangler dry-run を実行できる。本番 deploy は `--apply` を
明示し、対象の Cloudflare 資源を確認した直後のCLI確認を要する。実値はOSのowner-onlyな
一時Wrangler configだけへ短時間書き、永続・配布・追跡されるartifactには残さない。bundleを
運ぶUI、archive、Linked Sourceのexportはまだ対象外とする。

通常のdisconnectはWWWK dataを保持する。接続解除後にWWWKの2つのDurable Object namespace
だけを消去する明示的な`erase:local` / `erase:starter`も提供する。既定はplan / dry-runであり、
実行には`--apply`と完全一致の対話確認が必要である。

導入契約と現在の実装状況は [Installation](docs/INSTALLATION.md) を参照する。

初期スコープの実装は完了している。検証済みの対応組では、ローカル環境での保存、検索、
原典追跡、再起動後の永続化に加え、Starter環境への導入、Notion PageのLinked Source取込み、
承認までを確認済みである。複数revision対応や自動upgradeは未対応とする。

## 独立性と商標

WWWK は独立したオープンソースプロジェクトであり、Cloudflare, Inc. の公式製品では
なく、同社との提携、同社による承認または支援を示すものではない。

Cloudflare および関連する名称とロゴは、Cloudflare, Inc. の商標または登録商標である。

## ドキュメント

- [Development](DEVELOPMENT.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Installation](docs/INSTALLATION.md)
- [Principles](docs/PRINCIPLES.md)
- [Agent guide](AGENTS.md)

## ライセンス

[Apache License 2.0](LICENSE)
