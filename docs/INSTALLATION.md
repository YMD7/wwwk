# WWWK Installation

## 状態

WWWK の利用者向け導入方式は、version 固定の installer とする。特定の CFOS または
`cloudflare-os-starter` fork は要求しない。Phase 6では対応する公式 CFOS clone をローカルで
起動する入口を提供する。Phase 7では対応する Starter checkout に対する build、Wrangler
dry-run、および明示確認付きのlive runnerを提供する。Cloudflare deployは、実行直前の
明示承認が必要である。

現在の symbolic link 手順は内部的なローカル開発専用である。利用者向けの install / uninstall
契約にはしない。

## 対象

installer は、次の 2 つの環境へ同じ `gatekeeper-wwwk` を導入する。

- clone した公式 CFOS を使うローカル環境
- 公式 `cloudflare-os-starter` を使う Cloudflare deployment

初期版は、検証済みの Starter、CFOS、WWWK、companion patch の 1 組だけを対応対象にする。
任意 version への自動適用、競合解決、upgrade 自動化は行わない。

Phase 5の対応組とraw patchは[installer/](../installer/)で追跡する。StarterはCFOSを自身の
project cwdでbuildする最小互換patchも必要とする。両repositoryの公式checkoutは変更せず、
次フェーズで一時worktreeへだけ適用する。

## 導入モデル

WWWK は独立した Gatekeeper Worker であり、Workshop の `GATEKEEPER_WWWK` service binding
から `GatekeeperVendor` entrypoint へ接続する。Linked Source には逆方向の
`CFOS_SOURCE_ACCESS_BROKER` binding も必要になる。

公式 CFOS の現行契約だけでは、stable Broker と共有 Gadget の observer 検証を表現できない。
そのため、installer は WWWK repository で追跡された companion patch を一時 worktree の
公式 CFOS へ適用する。

```text
利用者の公式 checkout
        |
        | 読取り
        v
  installer の一時 worktree
  - 対応 revision を検証
  - companion patch を適用
  - WWWK package と binding を追加
  - test / build / dry-run
        |
        +--> ローカル実行
        |
        `--> 同じ Workshop Worker へ再デプロイ
```

利用者の Git 履歴と作業ツリーには変更を残さない。Cloudflare 上の Workshop は、WWWK 対応
コードを含む新しい Worker version へ再デプロイする。これは実行コードの更新であり、稼働中の
Worker への動的な plugin 注入ではない。

## Installer の責務

installer は次の範囲だけを担う。

1. 対象 repository、revision、設定、必要な tool を検証する。
2. 一時 worktree を作り、追跡された対応 patch だけを適用する。
3. WWWK Worker と双方向の service binding を組み込む。
4. 適用差分、Worker identity、保存資源、実行予定を秘密情報なしで示す。
5. test、build、Wrangler dry-run が成功した場合だけローカル実行または deploy へ進む。
6. 失敗時は既存 deployment と利用者の checkout を変更せず終了する。
7. 完了後に一時生成物を削除する。

次の場合は fail-closed で停止する。

- 対象 revision が対応表と一致しない。
- patch が完全一致で適用できない。
- 既存 deployment の Worker または保存資源を一意に確認できない。
- test、build、dry-run のいずれかが失敗する。
- secret や capability を設定、差分、ログへ出力する必要がある。

installer は認証、権限、capability、approval、監査を実装しない。これらは統合後も CFOS の
責務とする。

## WWWK Package

WWWK repository 直下を単一の `gatekeeper-wwwk` package とする。独自の monorepo や
CFOS package のコピーは作らない。

- `src/` はローカルと本番で共通の Worker 実装を持つ。
- `skills/wwwk/SKILL.md` は `/wwwk` から読み込む Agent Skill である。
- `wrangler.jsonc` は WWWK の基底設定であり、installer が実際の Workshop Worker 名を使う
  一時的な本番設定を生成する。
- companion patch は対象 CFOS revision と対応付け、WWWK repository で review できる形で
  追跡する。
- secret、token、account ID、hostname、実データを package や patch に含めない。

## ローカル導入

対応する公式 CFOS clone を固定 revisionでcheckoutし、cleanな状態で次を実行する。

```sh
pnpm run install:local -- --cfos "$CFOS_ROOT"
```

既定ではstateを`$XDG_STATE_HOME/wwwk/local`、未設定時は
`~/.local/state/wwwk/local`へ保存する。別の場所を使う場合は、再起動とdisconnectでも同じ
絶対pathを指定する。

```sh
pnpm run install:local -- \
  --cfos "$CFOS_ROOT" \
  --state-dir "$STATE_DIR"
```

installer は state の隣に管理用 integration worktreeを作り、そこだけへ companion patch、
local persistence patch、固定 WWWK runtime、統合 lockfileを適用して`pnpm install
--frozen-lockfile`後に既存のCFOS dev runnerを起動する。CFOS checkoutとその`.wrangler` stateは
変更しない。runner は同じ state path を全Workerの`wrangler dev --persist-to`へ渡す。

停止後は同じコマンドを実行して再起動できる。stateとWWWKのSQLite dataは保持される。

```sh
pnpm run disconnect:local -- \
  --cfos "$CFOS_ROOT" \
  --state-dir "$STATE_DIR"
```

local disconnectは、所有を確認したintegration worktreeだけを外す。state、SQLite data、
portable data、CFOS checkout、Git履歴、CFOS全体の`.wrangler` stateは削除しない。再接続では
同じstate pathを指定する。

次の場合は変更前にfail-closedで停止する。

- official CFOS origin、固定revision、cleanなworking treeのいずれかが一致しない
- managed stateまたはintegration worktreeの所有を確認できない
- patch、固定runtime、統合lockfile、service bindingが一致しない

installer の実装前は、開発者だけが CFOS の `packages/gatekeeper-wwwk` から WWWK へ
symbolic link を作成して検証できる。この手順は互換契約ではなく、対応 revision の確認なしに
一般利用者へ案内しない。

## Cloudflare OS Starter への導入

Starter 対応では、既存の deployment identity を維持する。

- Cloudflare account
- Workshop、Context、その他既存 Worker の名前
- Durable Object class と namespace
- KV namespace ID
- R2 bucket 名
- Access と管理者の設定

installer は、WWWK Worker を先にデプロイし、成功後に `GATEKEEPER_WWWK` を持つ Workshop
version を同じ Worker 名へデプロイする。WWWK の
`CFOS_SOURCE_ACCESS_BROKER` は、その Workshop の `SourceAccessBroker` entrypoint を参照する。

新規 installation と既存 Starter deployment への追加は、同じ統合処理を使う。既存環境では
自動 provision に任せず、利用中の保存資源を一意に確認して再利用する。確認できない場合は
新しい資源を作らず停止する。

公式 hosted deploy など、対応する Starter checkout と設定を確認できない deployment は、
初期対象に含めない。

### Starter の plan / dry-run

次のコマンドは Starter checkout を変更せず、管理 state の integration worktree で固定 tuple、
patch、設定を検証した後に build と Wrangler dry-run を行う。既定では Cloudflare の状態を読まず、
deploy しない。

```sh
pnpm run install:starter -- \
  --starter "$STARTER_ROOT" \
  --wwwk-worker "$WWWK_WORKER" \
  --deployment-config "$DEPLOYMENT_CONFIG"
```

接続解除の plan / dry-run は次のとおりである。

```sh
pnpm run disconnect:starter -- \
  --starter "$STARTER_ROOT" \
  --wwwk-worker "$WWWK_WORKER" \
  --deployment-config "$DEPLOYMENT_CONFIG"
```

`$DEPLOYMENT_CONFIG` は Starter checkout と installer managed state の外に置く通常ファイルで、
group / other の権限を持たない0600相当でなければならない。installer はcanonical pathを確認し、
このファイルをread-onlyでメモリにだけ読み込む。実値はrepository、integration worktree、managed
state、ログ、PRへ書かず、dry-runには追跡されたfixtureだけを使う。

`--apply`では、Wrangler実行に必要な設定だけをOSの一時領域に作る。directoryは推測困難な専用の
0700、configは0600であり、symlinkまたは既存fileの再利用を拒否する。この一時configは成功・失敗とも
`finally`で削除し、SIGINT / SIGTERMでも可能な範囲で回収する。強制終了または電源断では削除を完全には
保証できないため、復旧後にOSの一時領域を確認する。この一時configは永続、配布、追跡されるartifactでは
ない。live runnerはWranglerのdisk logも無効化する。live実行ではidentity確認後にCLIがsecret-freeな
実行計画を表示し、`y`で明示確認されるまでCloudflareを変更しない。

新規 Starter は先に基底deploymentを別の明示承認で完了している必要がある。

基底deploymentがない新規環境では、同じ外部configと固定tupleからplan / dry-runを実行する。

```sh
pnpm run bootstrap:starter -- \
  --starter "$STARTER_ROOT" \
  --wwwk-worker "$WWWK_WORKER" \
  --deployment-config "$DEPLOYMENT_CONFIG"
```

`--apply`では、Context KV、Blueprints KV、Avatars KV、Blueprint Content R2のIDまたは名前を
外部configへ明示する。自動provisionは後続のidentity照合へ引き継げないため使用しない。すべての
対象Worker名にversionが存在しないことをlive確認し、Workshop名を含む完全一致の対話確認後にだけ
Error Reporter、Context、Custom Gatekeeper、Workshopの順でstrict deployする。実値は既存live
runnerと同じowner-only一時configだけに置く。この操作はWWWKをdeployまたは接続しない。

途中で失敗した場合、成功済みの新規Workerは残る。自動rollbackは行わず、live状態を確認してから
残ったWorkerを明示的に整理し、未使用名で再実行する。

## アンインストール

アンインストールは接続解除とデータ消去を分離する。

### 接続解除

標準のアンインストールは、test、build、dry-run が成功した構成だけをデプロイし、次の
状態へ戻す。

- Workshop は `GATEKEEPER_WWWK` と companion patch を含まない公式構成である。
- WWWK Worker は `CFOS_SOURCE_ACCESS_BROKER` を外すが、同じ Durable Object class と
  データを保持する。
- CFOS から WWWK へ新しい Session を開始できない。

live runnerの実装後、disconnect は Workshop から `GATEKEEPER_WWWK` を外して先に deploy し、
その後 WWWK から `CFOS_SOURCE_ACCESS_BROKER` を外して deploy する。どちらの deploy も事前の
identity 検証と実行直前の明示承認が必要である。

WWWK Worker、`WwwkLibrary`、portable bundle、WWWK repository は削除しない。再接続時は、
同じ WWWK Worker とデータを利用できるようにする。

### データの完全消去

完全消去は接続解除後にだけ実行できる。コマンドは export を行わないため、必要なデータは
先に別途 export する。削除後の SQLite データを WWWK から回復することはできない。

ローカルでは、CFOS を停止して `disconnect:local` を完了した後に計画を確認する。

```sh
pnpm run erase:local -- \
  --cfos "$CFOS_ROOT" \
  --state-dir "$STATE_DIR"
```

削除を実行する場合だけ `--apply` を追加する。CLI は対象path、export、不可逆性を表示し、
`erase local WWWK` の完全一致を要求する。削除対象は次の2つに限定する。

- `gatekeeper-wwwk-WwwkLibrary` のローカル Durable Object namespace
- `gatekeeper-wwwk-WwwkGatekeeper` のローカル Durable Object namespace

CFOS、ほかの Gatekeeper、KV、R2、管理metadata、`v3` state全体は保持する。対象または親が
symbolic linkの場合は削除せず停止する。local runnerとeraseはmanaged stateのowner-onlyな
PID leaseを排他的に取得し、同じstateを別processが使用中の場合も削除せず停止する。eraseは
lease取得後にdisconnect状態を再検証してから削除する。強制終了や電源断で
`local-state-lease.json`が残った場合は自動回収しない。すべてのlocal processが停止したことを
確認してから、managed state内のこのfileだけを手動で削除する。

Cloudflareでは、`disconnect:starter --apply`を完了した後に計画とWrangler dry-runを確認する。

```sh
pnpm run erase:starter -- \
  --starter "$STARTER_ROOT" \
  --wwwk-worker "$WWWK_WORKER" \
  --deployment-config "$DEPLOYMENT_CONFIG"
```

削除を実行する場合だけ `--apply` を追加する。installerは現在のWorkshopに
`GATEKEEPER_WWWK`がなく、WWWKに`CFOS_SOURCE_ACCESS_BROKER`がないことと、対象WWWKが
`WwwkLibrary`、`WwwkGatekeeper`のSQLite namespaceを所有することを確認する。その後、対象と
不可逆性を表示し、`erase $WWWK_WORKER`の完全一致を要求する。

確認後は、2つのclassをコードから外した`deleted` tombstone versionを同じWWWK Workerへ
deployし、namespaceとデータを削除してからWorkerを削除する。Wranglerの依存関係保護を有効な
まま使い、`--force`は使用しない。Workshop、ほかのGatekeeper、KV、R2は削除しない。

ローカルは対象directoryがなくなったこと、Cloudflareは対象Workerが存在しないことを確認する。
どちらも元データの復元機能は提供しない。必要なbundleがある場合に限り、後で再導入してimport
できる。

## Upgrade

初期版は対応 revision を 1 組に固定する。同じ組への再実行は安全にできるようにするが、
新しい公式 CFOS / Starter への自動 upgrade は行わない。

対応 version を増やす場合は、上流差分、CFOS 契約、companion patch、Starter の基底設定を
review し、既存の受入条件を通した新しい対応組として追加する。patch が適用できるという理由
だけで互換性を判断しない。

## 参照

- [CFOS](https://github.com/cloudflare/cloudflare-os)
- [Cloudflare OS Starter](https://github.com/cloudflare/cloudflare-os-starter)
- [Workers versions and deployments](https://developers.cloudflare.com/workers/versions-and-deployments/)
- [Durable Object class exports](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)
