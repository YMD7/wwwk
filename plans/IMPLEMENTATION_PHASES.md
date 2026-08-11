# WWWK Implementation Phases

## 方針

各フェーズは、ローカル利用へ近づく観測可能なゴールを 1 つ持つ。現在のフェーズが
完了するまで次を実装しない。受入条件に直接関係しない網羅的なテストや将来向けの
仕組みは後回しにする。

現在地: Phase 0、Phase 1、Phase 2 は完了。次は Phase 3。

## Phase 0: 開発準備

**ゴール:** 同じ手順で小さなフェーズを安全に開発、レビュー、統合できる。

完了条件:

- `main <- develop <- 作業ブランチ` の役割と PR フローが文書化されている。
- `.worktrees/` が標準の作業場所として用意され、Git の追跡対象外になっている。
- 設計文書が `docs/` に整理され、参照切れがない。
- 後続フェーズのゴールと順序が定義されている。

## Phase 1: ローカル Owned Source MVP

**ゴール:** ローカル版 CFOS の Agent が、明示された 1 つのテキストを個人 Wiki へ
保存し、後から検索して Source まで辿れる。

完了条件:

- CFOS が WWWK Gatekeeper を検出し、クラウドへの deploy なしで接続できる。
- Agent Skill から `ingest()`、`search()`、`read()` を利用できる。
- 承認後だけ 3 層と 2 つの生成依存リンクが 1 transaction で保存される。
- Wiki の検索結果から Evidence、Source を辿れ、Source 本文が入力と一致する。
- 再起動後も保存内容が残り、ユーザー間で Library が分離される。
- 拒否または失敗した書込みが残らないことを、最小の自動確認とローカル操作で確認する。

対象外: Linked Source、import/export、高度な検索、UI、本番 deploy。

## Phase 2: ポータブルな import/export

**ゴール:** Owned Source、Evidence、Wiki、生成依存リンクを、実行環境に依存しない
bundle として持ち運べる。

完了条件:

- Markdown、YAML frontmatter、`manifest.yaml` で bundle を export できる。
- 空の `WwwkLibrary` へ import し、論理データと生成依存リンクが一致する。
- capability、権限状態、SQLite、index、secret が bundle に含まれない。

対象外: 任意の OKF bundle との完全互換、定期 export、Linked Source の全文 export。

## Phase 3: 最初の Linked Source

**ゴール:** allowlist した 1 種類の外部原典を、CFOS の読取 capability に従って
Source revision として取り込める。

完了条件:

- WWWK が認証情報を保持せず、`SourceAccess` から本文と来歴を取得する。
- 再起動後に接続を再利用でき、失効または再認可失敗時は派生データも fail-closed になる。
- 参照と失効が CFOS の監査境界を通る。

対象外: 汎用 Source protocol、複数 provider、更新の自動検知。

## Phase 4: 共有 Gadget の安全な参照

**ゴール:** 共同利用者が全 Linked Source を現在参照できる場合だけ、WWWK 由来の
Gadget observation を利用できる。

完了条件:

- 生成依存を Source revision まで決定論的に辿る。
- CFOS の Broker による全件検証が成功した場合だけ observation を許可する。
- Owned Source、拒否、障害、不明な依存を fail-closed で扱う。

対象外: Wiki の直接共有、Owned Source の共有ポリシー。

## Phase 5: Cloudflare OS Starter 対応

**ゴール:** ローカル MVP と同じ中核実装を、`cloudflare-os-starter` 構成へ導入して
Cloudflare 上で利用できる。

完了条件:

- WWWK Worker と service binding を再現可能な手順で deploy できる。
- 接続解除とデータ消去を分離した install/uninstall 手順がある。
- ユーザー分離、承認、永続化を本番構成で確認する。

対象外: 配布の自動化、upgrade 機構、運用上不要な追加サービス。

## 未計画

高度な検索、UI、Source 更新の自動検知、複数 Source の同時取込み、既存 Wiki の自動統合、
background worker は、実利用から必要性が確認された時点でフェーズを追加する。
