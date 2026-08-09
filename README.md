# WWWK


`WWWK`（読み: うーく、発音: `/u:k/`）は、Cloudflare OS（CFOS）へ
個人専用の LLM Wiki を追加する拡張である。

## 概要

- 原典に紐付いた知識を `Source revision -> Evidence -> Wiki` の3層で管理する。
- Sources、Evidence、Wiki をポータブルなデータとして扱う。
- 認証、権限、承認、監査は CFOS に委ね、そのセキュリティ境界に従う。

現在は設計段階であり、実装と具体的な CFOS 統合方法は未決定である。

## ドキュメント

- [Architecture](ARCHITECTURE.md)
- [Principles](PRINCIPLES.md)
- [Agent guide](AGENTS.md)
