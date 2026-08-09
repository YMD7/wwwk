# WWWK Installation


## 状態

本書は、確定した導入方針と現時点で判明している手順を記録する。
WWWK package は未実装のため、実行可能なインストール手順はまだ提供しない。

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
├── ARCHITECTURE.md
├── PRINCIPLES.md
├── INSTALLATION.md
├── AGENTS.md
├── .gitignore
├── package.json
├── tsconfig.json
├── wrangler.jsonc
├── src/
│   ├── index.ts
│   ├── types.d.ts
│   └── types.txt -> types.d.ts
├── __tests__/
│   └── wwwk.test.ts
└── vitest.config.ts
```

- `types.d.ts` は Agent へ公開する Session API を定義する。
- `types.txt` は `types.d.ts` への symbolic link とする。
- `index.ts` は最初は分割せず、実際に責務が増えた場合だけ分割する。
- `package.json` の name は `gatekeeper-wwwk` とし、当面は `private: true` とする。
- `wrangler.jsonc` の Worker name は `gatekeeper-wwwk` とする。
- `tsconfig.json` は配置先の相対パスに依存させない。
- テストは自動 provision、singleton、個人専用境界を優先する。
- UI、OAuth、hooks、background worker は初期構成へ含めない。

CFOS の公式手順に従い、Session API を提案して合意を得た後に実装する。

## ローカル導入

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

### 現時点で判明している手順

1. 対応する CFOS revision を準備し、変更前にローカル起動を確認する。
2. CFOS の `packages/gatekeeper-wwwk` から WWWK へ symbolic link を作る。
3. CFOS のルートで `pnpm install` を実行し、workspace の依存関係を更新する。
4. `pnpm run-local` で CFOS を起動または再起動する。
5. `GATEKEEPER_WWWK` binding と `GatekeeperVendor` の接続を確認する。
6. WWWK の API、個人データの分離、Agent Skill の発見を検証する。

CFOS の開発サーバーが Gatekeeper の検出と binding 生成を担うため、ローカル導入では
Cloudflare アカウントへのデプロイを必要としない。ローカル状態は CFOS の
`.wrangler` 配下に保存されるが、WWWK の物理ストレージは未決定とする。

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
- 物理ストレージと必要な binding
- インストールの自動化と再実行時の挙動
- 本番用の設定項目と検証方法
- アップグレードとアンインストールの詳細

## 参照

- [CFOS: Run locally](https://github.com/cloudflare/cloudflare-os#run-locally)
- [CFOS: Gatekeeper discovery](https://github.com/cloudflare/cloudflare-os/blob/main/run-dev-server.js)
- [Cloudflare OS Starter](https://github.com/cloudflare/cloudflare-os-starter)
