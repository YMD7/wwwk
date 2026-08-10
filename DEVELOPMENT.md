# WWWK Development

## 最優先

ローカル版 CFOS で使える最小の縦切りを、できるだけ早く届ける。

- 現在のフェーズのゴールに直接必要なものだけを実装する。
- テストは、受入条件、変更した契約、セキュリティ境界を確認する最小範囲に絞る。
- 将来向けの抽象化、網羅的なテスト、未使用の雛形は追加しない。
- 速さを理由に、確定済みの不変条件や fail-closed の境界は弱めない。

実装順と各ゴールは [Implementation phases](docs/IMPLEMENTATION_PHASES.md) を正本とする。

## ブランチ

```text
main <- develop <- <type>/<slug>
```

- `main`: 完了したフェーズを反映する安定ブランチ。
- `develop`: 次に `main` へ昇格する変更の統合ブランチ。
- 作業ブランチ: 1 フェーズのゴールだけを扱う短命ブランチ。
- `<type>` は原則として `feat`、`fix`、`docs`、`chore` のいずれかとする。
- `main` と `develop` へ直接実装を commit または push しない。

## Worktree

作業ブランチは、リポジトリ内の `.worktrees/` に専用 worktree を作って扱う。
`.worktrees/` は Git の追跡対象にしない。

```sh
git worktree add \
  ".worktrees/<slug>" \
  -b "<type>/<slug>" \
  develop
```

- 作成前に `develop` が `origin/develop` と同期していることを確認する。
- 1 worktree に複数の作業ブランチやフェーズを混在させない。
- secret や依存関係をコピーせず、必要なローカル設定だけを安全に参照する。
- PR の merge 後に worktree と作業ブランチを削除する。

利用中の AI ハーネスに安全な worktree 作成機能がある場合は、それを優先する。

## フェーズの進め方

1. `docs/IMPLEMENTATION_PHASES.md` から次の 1 フェーズを選ぶ。
2. ゴール、受入条件、対象外を確認し、未決定事項だけをユーザーへ確認する。
3. 最新の `develop` から作業ブランチと worktree を作る。
4. ゴールを満たす最小のコードと文書を変更する。
5. 受入条件に直結する確認を実行する。
6. 作業ブランチから `develop` へ PR を作成し、確認後に merge する。
7. フェーズ完了時は `develop` から `main` へ PR を作成して昇格する。
8. merge 後に worktree と不要になった作業ブランチを削除する。

PR には、フェーズのゴール、実施した確認、意図的に後回しにした事項を短く記載する。
フェーズをまたぐ変更が必要になった場合は同じ PR へ追加せず、先に計画を見直す。
