# WWWK


`WWWK`（読み: うーく、発音: `/u:k/`）は、Cloudflare OS（CFOS）へ
個人専用の LLM Wiki を追加する拡張である。

## 概要

- 原典に紐付いた知識を `Source revision -> Evidence -> Wiki` の3層で管理する。
- Sources、Evidence、Wiki をポータブルなデータとして扱う。
- 外部原典は CFOS capability でリンクし、接続状態とポータブルデータを分離する。
- 認証、権限、承認、監査は CFOS に委ね、そのセキュリティ境界に従う。

現在は設計段階である。まずローカル版 CFOS で開発と検証を行い、その後
`cloudflare-os-starter` を使う本番環境へ対応する。

## ドキュメント

- [Architecture](ARCHITECTURE.md)
- [Installation](INSTALLATION.md)
- [Principles](PRINCIPLES.md)
- [Agent guide](AGENTS.md)
