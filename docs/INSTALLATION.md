# WWWK Installation

## 状態

本書は、確定した導入方針と現時点で判明している手順を記録する。
Phase 1 では、clone した CFOS のローカル開発サーバーへ symbolic link で接続する。
クラウドへの deploy は行わない。

## 対応順序

1. clone した CFOS へ組み込み、ローカルで開発と検証を行う。
2. 検証後に、`cloudflare-os-starter` を使う本番環境へ対応する。

両環境で `gatekeeper-wwwk` の中核実装を共通化する。本番対応に必要な処理を、
ローカル検証より先に実装しない。

## Package 構成

WWWK リポジトリ直下を単一の `gatekeeper-wwwk` package とする。独自の `packages/`
階層や monorepo は作らない。

```text
wwwk/
├── README.md
├── AGENTS.md
├── DEVELOPMENT.md
├── .gitignore
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── vitest.config.ts
├── wrangler.jsonc
├── worker-configuration.d.ts
├── skills/
│   └── wwwk/
│       └── SKILL.md
├── docs/
│   ├── ARCHITECTURE.md
│   ├── INSTALLATION.md
│   └── PRINCIPLES.md
├── plans/
│   └── IMPLEMENTATION_PHASES.md
├── src/
│   ├── index.ts
│   ├── env.d.ts
│   ├── text-modules.d.ts
│   ├── types.d.ts
│   └── types.txt -> types.d.ts
└── __tests__/
    ├── worker.ts
    └── wwwk.test.ts
```

- `types.d.ts` は Agent へ公開する Session API を定義する。
- `plans/` は実装中だけ必要な計画を置き、完了後に削除できる。
- `.tmp/` はローカルで必要時に作成する追跡対象外の一時領域とする。
- `types.txt` は `types.d.ts` への symbolic link とする。
- `index.ts` は最初は分割せず、実際に責務が増えた場合だけ分割する。
- `package.json` の name は `gatekeeper-wwwk` とし、当面は `private: true` とする。
- `wrangler.jsonc` の Worker name は `gatekeeper-wwwk` とする。
- `tsconfig.json` は配置先の相対パスに依存させない。
- テストは自動 provision、singleton、個人専用境界を優先する。
- UI、OAuth、hooks、background worker は初期構成へ含めない。

Agent Skill は `skills/wwwk/SKILL.md` に同梱し、CFOS の Slash Command Provider から
`/wwwk` として読み込む。自動読込みは行わない。

## ローカル導入

### 方式の位置づけ

symbolic link はローカル開発専用の接続方式とする。CFOS は
`packages/gatekeeper-*` を走査して Gatekeeper を検出する。WWWK の依存関係は WWWK
自身へ導入し、CFOS workspace の内部 package へ依存しない。

`pnpm link` は package を `node_modules` へ接続する仕組みであり、CFOS の Gatekeeper
検出条件を満たさないため使用しない。symbolic link を本番配布方式や恒久的な plugin
機構とは見なさない。本番導入と一般配布の方式は、ローカル検証後に決定する。

### 前提

- 対象の CFOS が clone 済みである。
- CFOS を `pnpm run-local` で起動できる。
- 対象の CFOS revision と WWWK の互換性が確認されている。

### 配置

CFOS の開発サーバーは、`packages/gatekeeper-*` にある `wrangler.jsonc` を持つ package
を検出する。WWWK は次の形で認識させる。

```text
cloudflare-os/
└── packages/
    └── gatekeeper-wwwk/
        └── wrangler.jsonc
```

WWWK リポジトリは CFOS から独立して管理し、ローカルでは symbolic link で接続する。
利用者固有の配置を前提にせず、次の変数で各リポジトリのルートを表す。

- `$CFOS_ROOT`: CFOS リポジトリのルート
- `$WWWK_ROOT`: WWWK リポジトリのルート

```sh
ln -s "$WWWK_ROOT" \
  "$CFOS_ROOT/packages/gatekeeper-wwwk"
```

### 手順

1. 対応する CFOS revision を準備し、WWWK を接続する前に `pnpm run-local` で起動を
   確認して停止する。
2. WWWK のルートで `pnpm install`、`pnpm run types:check`、`pnpm test` を実行する。
3. CFOS の `packages/gatekeeper-wwwk` から WWWK へ symbolic link を作る。
4. CFOS のルートで `node run-dev-server.js --serve-frontend-assets` を実行する。
5. `GATEKEEPER_WWWK` binding と `GatekeeperVendor` の自動接続を確認する。
6. `/wwwk` で Agent Skill を読み込み、`ingest()`、`search()`、`read()` を検証する。

CFOS の開発サーバーが Gatekeeper の検出と binding 生成を担うため、ローカル導入では
Cloudflare アカウントへのデプロイを必要としない。WWWK の依存関係は CFOS workspace
ではなく WWWK 自身へ導入する。`WwwkLibrary` は SQLite-backed Durable Object として
動作し、ローカルデータは CFOS の `.wrangler/state` 配下へ保存される。

## アンインストール

アンインストールは、接続解除とデータ消去を分離する。

### ローカルでの接続解除

標準のアンインストールでは WWWK のデータを保持する。

1. CFOS のローカルサーバーを停止する。
2. 対象が symbolic link であることを確認する。
3. `packages/gatekeeper-wwwk` の symbolic link だけを外す。
4. `pnpm run-local` で CFOS を起動する。
5. `GATEKEEPER_WWWK` binding が生成されないことを確認する。

```sh
test -L "$CFOS_ROOT/packages/gatekeeper-wwwk"
unlink "$CFOS_ROOT/packages/gatekeeper-wwwk"
```

WWWK リポジトリ自体の削除はアンインストールに含めない。

### データの完全消去

完全消去は、明示的な破壊操作として標準のアンインストールから分離する。実行前に
ポータブルデータの export を推奨する。

CFOS の `.wrangler/state` 全体は削除しない。CFOS 本体やほかの Gatekeeper のローカル
データも含まれるためである。Phase 1 では CFOS の account revoke 契約を通して WWWK の
文書と生成依存リンクを削除し、再作成を防ぐ永久失効 marker だけを残す。ローカル状態から
WWWK の物理領域だけを削除する運用手順は、本番の接続管理と合わせて後続で決定する。

## 本番対応

ローカル検証後に、`cloudflare-os-starter` の外部 package として WWWK を追加する。
上流の `cloudflare-os` submodule は直接変更しない。

本番導入では、少なくとも次の順序が必要になる。

1. WWWK Worker と必要な保存資源を準備する。
2. WWWK Worker をデプロイする。
3. Workshop へ `GATEKEEPER_WWWK` service binding を追加する。
4. Workshop Worker を再デプロイする。
5. ユーザー単位の分離、Agent からの利用、データ永続化を検証する。

具体的な設定とコマンドは、ローカル検証後に決定する。

## 未決定事項

- 本番用 WWWK package の配布方法
- 対応する CFOS revision の管理方法
- インストールの自動化と再実行時の挙動
- 本番用の設定項目と検証方法
- アップグレード方法
- WWWK データだけを対象とする完全消去の方法
- 本番環境での接続解除と完全消去の手順

## 参照

- [CFOS: Run locally](https://github.com/cloudflare/cloudflare-os#run-locally)
- [CFOS: Gatekeeper discovery](https://github.com/cloudflare/cloudflare-os/blob/main/run-dev-server.js)
- [Cloudflare OS Starter](https://github.com/cloudflare/cloudflare-os-starter)
- [pnpm: pnpm link](https://pnpm.io/cli/link)
- [Cloudflare Workers: Adding local data](https://developers.cloudflare.com/workers/local-development/local-data/)
