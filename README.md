# WWWK

`WWWK`（読み: うーく、発音: `/u:k/`）は、Cloudflare OS（CFOS）へ
個人専用の LLM Wiki を追加する拡張である。

## 概要

- 原典に紐付いた知識を `Source revision -> Evidence -> Wiki` の3層で管理する。
- Sources、Evidence、Wiki をポータブルなデータとして扱う。
- 外部原典は CFOS capability でリンクし、接続状態とポータブルデータを分離する。
- 認証、権限、承認、監査は CFOS に委ね、そのセキュリティ境界に従う。

現在はローカル版 CFOS での MVP 実装を進める段階である。その後
`cloudflare-os-starter` を使う本番環境へ対応する。

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
