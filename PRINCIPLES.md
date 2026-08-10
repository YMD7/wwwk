# WWWK Principles

## 1. KISS と YAGNI

- 現在の目的に必要な最小構成を選ぶ。
- 将来要件だけを理由に、抽象化、状態、ファイル、仕組みを追加しない。
- 一度に全体を決めず、境界を一つずつ合意して進める。
- 新しい複雑性は、現在の要件または実測したリスクで正当化する。
- 追加より削除、汎用化より既存責務内の局所的な解決を優先する。

## 2. CFOS の拡張として設計する

- WWWK は独立した認証基盤やエージェント基盤を作らない。
- CFOS のサンドボックス、capability、Gatekeeper、承認、監査に従う。
- 外部サービスへのアクセスは CFOS の境界を通す。
- Linked Source は、CFOS が管理する読取専用 capability を通して再認可する。
- OAuth トークンなどの認証情報を WWWK に保存しない。
- WWWK の形式やメタデータをアクセス制御の根拠にしない。
- 初期スコープでは、Wiki は所有者本人だけが利用できる。

## 3. 責務を混ぜない

- CFOS は実行とセキュリティを担う。
- WWWK は個人 Wiki の知識ライフサイクルを担う。
- Agent Skill は利用方法を教え、WWWK の API と Core が実処理を担う。
- Skill の指示を権限や正しさの保証として扱わない。
- WWWK の保存基盤や必須機能を CFOS の Context Library に依存させない。
- Context Library は、公開された CFOS capability を介する任意の Source provider として
  のみ連携する。
- ポータブル形式はデータを表現するが、権限を付与しない。
- システム固有の状態とポータブルデータを分離する。

## 4. データだけをポータブルにする

- エクスポートを許可された Sources、Evidence、Wiki と生成依存リンクを損失なく
  書き出し、再度取り込めるようにする。
- 人間とエージェントの両方が読める、単純で公開された形式を優先する。
- 秘密情報、実行状態、インデックス、特定ベンダーの仕組みは持ち運ばない。
- Owned Source は独立したコピー、Linked Source は外部原典の capability に依存する
  データとして区別する。
- Linked Source の capability と接続状態は持ち運ばず、reference-only のデータは
  移行先で再リンクする。
- 全文エクスポートは独立した Owned Source snapshot の作成として扱い、外部へ出た
  コピーを将来の権限失効で回収できるとはみなさない。
- 実行時ストレージの形式を公開データ形式にせず、安定 ID を保存基盤から独立させる。
- export と空環境への import の往復で、論理データの一致を検証する。
- ポータビリティのために、実行環境まで標準化しない。

## 5. 知識を原典へ結び付ける

- 原典を不変の Source revision として扱う。
- Source の本文は WWWK が CFOS capability から取得し、Agent の自己申告だけに依存しない。
- Evidence と Wiki の実際の入力をシステムが記録する。
- LLM は知識を生成できるが、権限や失効範囲を決定しない。
- 権限が確認できないデータは fail-closed で扱う。
- 信頼度の単一スコアより、出典、生成者、検証、鮮度などの事実を残す。

## 6. Karpathy の LLM Wiki から学ぶ

[LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
が示す、原典から知識を継続的にコンパイルする考え方を採用する。

- 毎回ゼロから検索するだけでなく、永続的に成長する Wiki を維持する。
- 原典を変更せず、LLM が Wiki の整理と保守を担う。
- Ingest、Query、Lint という運用上の分離を参考にする。
- Evidence 層など、企業利用に必要な境界は WWWK 側で追加する。

## 7. OKF から学ぶ

[Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
が示す、形式とプラットフォームを分ける考え方を採用する。

- Producer と Consumer を分離する。
- Markdown、YAML frontmatter、通常のリンクを基本とする。
- 来歴、生成、検証、鮮度を機械的に判断できる形で表す。
- OKF は交換形式として利用し、CFOS の権限モデルの代わりにはしない。

Karpathy の提案と OKF は原典として尊重するが、盲目的には従わない。WWWK の目的、
CFOS の制約、現在の要件に照らし、優れた概念だけを最小限取り入れる。
