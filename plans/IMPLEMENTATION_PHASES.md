# WWWK Implementation Phases

## 方針

各フェーズは観測可能なゴールを 1 つ持ち、作業ブランチと PR を分ける。受入条件に直接
関係しない抽象化、複数 version 対応、網羅的なテストは後回しにする。現在のフェーズが
完了するまで次を実装しない。

現在地: Phase 0 から Phase 6 は完了。Phase 7 は Starter installer の dry-run 実装を完了し、
Cloudflare 実環境での受入確認を残している。

## 導入方式の決定

- 利用者へ WWWK プロジェクト版の CFOS / Starter fork を要求しない。
- 検証済みの公式 Starter、CFOS、WWWK、companion patch の組を完全一致で扱う。
- installer は利用者の checkout を変更せず、一時 worktree へ差分を適用する。
- Cloudflare 上では、同じ Worker と保存資源の identity を保って WWWK 対応 version を
  再デプロイする。
- 標準アンインストールは接続だけを外し、データ消去は別フェーズにする。
- upstream upgrade の自動追従と複数 version 対応は初期実装へ含めない。

## 既存実装への影響

Phase 1 から Phase 4 の WWWK Core、SQLite schema、Bundle v1、Linked Source、observer
検証は維持する。データ移行や Session API の変更は不要である。

導入境界では次を変更する。

- ローカル CFOS にだけ存在する companion commit 群を、対応する公式 CFOS revision 専用の
  review 可能な patch として WWWK repository で追跡する。
- `wrangler.jsonc` の固定されたローカル Worker 名を本番契約にせず、installer が実際の
  Workshop Worker 名を使う一時設定を生成する。
- 手動 symbolic link は内部開発手順へ降格し、利用者向け手順を installer に置き換える。
- 既存の CFOS focused test を patch の検証に再利用し、同じ契約のテストを WWWK 側へ
  重複実装しない。
- 現在の CFOS companion worktree は、patch の出典を確定して WWWK で再現できるまで
  削除しない。

Phase 5 開始時点の既知の基準は次のとおりである。

- 公式 Starter `93f14df` は CFOS `bf7f762` を submodule に固定している。
- companion差分は公式CFOS `8b08672`をbase、ローカル`7964294`をheadとしている。
- Starter の固定 revision と companion base は一致しない。installer はどちらかへ推測で
  合わせず、Starter を `8b08672` で検証できるかを最初に実証する。
- WWWK の基底 `wrangler.jsonc` は Broker の service 名をローカル用
  `workshop-backend` に固定している。本番では実際の Workshop Worker 名へ置き換えた
  一時設定が必要である。

## 完了済み

### Phase 0: 開発準備

**ゴール:** 小さなフェーズを worktree、PR、review で安全に統合できる。

### Phase 1: ローカル Owned Source MVP

**ゴール:** 明示されたテキストを 3 層で保存し、Wiki から Source まで辿れる。

### Phase 2: ポータブルな import/export

**ゴール:** Owned Source、Evidence、Wiki、生成依存を Bundle v1 で往復できる。

### Phase 3: 最初の Linked Source

**ゴール:** Notion Page を CFOS の読取権限と stable Broker を通して取り込める。

### Phase 4: 共有 Gadget の安全な参照

**ゴール:** 共同利用者が全 Linked Source を現在参照できる場合だけ WWWK observation を
利用できる。

## Phase 5: Version 固定 installer PoC

**ゴール:** 公式 CFOS / Starter を直接変更せず、現在の WWWK 統合を一時 worktree で
決定論的に再現できることを実証する。

完了条件:

- 対応する Starter、CFOS、WWWK、companion patch の revision を 1 組だけ記録する。
- 現在の CFOS companion差分を、対応 revisionに完全一致で適用できるtracked patchへする。
- patch の出典、license、secret、個人情報、利用者固有 path を確認し、commit metadata を
  配布物へ混ぜない。
- 一時 worktree へ patch、WWWK package、双方向 service binding を再現できる。
- Starter `93f14df` の deployment generator が CFOS `8b08672` と互換であることを
  test と dry-run で確認する。成立しない場合は実装を広げず計画を見直す。
- WWWK と CFOS の既存 focused test、build、Wrangler dry-run が統合後の構成で成功する。
- 同じ入力で再実行した統合差分が一致し、利用者の checkout に変更が残らない。
- 未対応 revision、patch 競合、設定不足を変更前に fail-closed で拒否する。
- ローカル状態の永続化方法と Starter の既存資源再利用方法を、実測結果として次フェーズへ
  記録する。

対象外: Cloudflare への実 deploy、完成した利用者向け CLI、複数 version 対応、upgrade、
データ消去。

**結果:** Starter `93f14df`、CFOS `8b08672`、WWWK `8ba113e`と2つの固定patchを
`installer/`で追跡した。Starter用互換lockfileを隔離worktreeで再生成し、frozen install、
CFOS patchのclean apply、focused test、build、Starter generatorのtest / dry-runを確認した。
StarterとCFOSはそれぞれpnpm 11.9と11.17を指定するため、Starter patchはCFOS buildを
CFOS project cwdで起動する。local persistenceと既存resource再利用の実操作はdeployを伴うため、
Phase 6以降で確認する。

## Phase 6: ローカル installer MVP

**ゴール:** 公式 CFOS clone を変更せず、1 つの文書化された入口から WWWK 対応の
ローカル CFOS を起動できる。

完了条件:

- installer が Phase 5 の統合処理を再利用し、専用の一時 worktree で CFOS を起動する。
- 再起動と installer の再実行後も、同じ CFOS / WWWK ローカルデータを利用できる。
- `ingest()`、`search()`、`read()`、Linked Notion、共有 observer の既存確認が通る。
- 接続解除後も WWWK データを保持し、再接続時に利用できる。
- 利用者の checkout、Git履歴、CFOS全体の`.wrangler` stateを破壊しない。

対象外: Cloudflare deploy、GUI installer、完全消去、複数 version 対応。

**結果:** `pnpm run install:local -- --cfos "$CFOS_ROOT"`を入口として追加した。installerは
固定tuple、official origin、cleanなCFOS checkout、管理stateの所有を検証してから、checkout外の
integration worktreeを作る。companion patch、local persistence patch、固定WWWK runtime、
統合lockfileを適用し、frozen install後に既存runnerを起動する。Wranglerの複数Worker起動で
`GATEKEEPER_WWWK`と`CFOS_SOURCE_ACCESS_BROKER`、同一絶対`--persist-to`を確認した。local
disconnectは管理worktreeだけを外し、stateとWWWK dataを保持する。Owned Source、Linked Notion、
共有observerは既存focused testで回帰を確認する。Cloudflare deploy、Starter接続解除、完全消去、
複数versionは対象外とする。

## Phase 7: Starter への install / disconnect

**ゴール:** 新規または既存の公式 Starter deploymentへWWWKを追加し、データを残したまま
安全に接続解除できる。

完了条件:

- installer は既存の account、Worker、Durable Object、KV、R2、Access の identity を
  確認し、変更予定を secret なしで提示する。
- WWWK Worker、Workshop の順で同じ対応組を再現可能にデプロイする。
- ユーザー分離、approval、永続化、Linked Source、共有 observer を本番構成で確認する。
- 同じ対応組への再実行が不要な資源を増やさず成功する。
- disconnect は双方向 binding を安全な順序で外し、公式構成を同じ Workshop Worker へ
  戻す。WWWK Worker は broker binding を外すが、Durable Object class とデータを保持する。
- 再接続後に保持した WWWK データを利用できる。
- 失敗時に利用者のcheckoutを変更せず、既存の有効なWorkshop versionを失わない。

**現在の実装:** `pnpm run install:starter` と `pnpm run disconnect:starter` は、固定tupleを
専用 integration worktreeへ再現し、外部`deployment.jsonc`をread-onlyで検証する。実値を含まない
fixtureで生成設定、build、Wrangler dry-runを行う。`--apply`は実値をOSのowner-only一時configへ
だけ書き、identity確認とCLIの明示確認後に、接続ではWWWKからWorkshop、接続解除ではWorkshopから
WWWKの順でdeployする。強制終了または電源断で一時configの削除は保証できない。実環境の受入確認は
完了条件として残す。

対象外: 公式 hosted deploy、完全消去、自動 upgrade、複数 version 対応、配布 UI。

## Phase 8: WWWK データの完全消去

**ゴール:** 接続解除済みの環境から、利用者が明示した WWWK データだけを消去できる。

完了条件:

- export の要否、対象 Worker、対象 Durable Object namespace、不可逆性を実行前に示す。
- 明示確認後だけ WWWK Worker とデータを削除する。
- CFOS 本体、ほかの Gatekeeper、共有 KV / R2、ローカル state 全体を削除しない。
- ローカルと Cloudflare の削除対象、確認方法、回復可能性を文書化する。

対象外: 一般的なデータ保持ポリシー、定期削除、組織向け retention automation。

**結果:** `erase:local`と`erase:starter`を、通常の接続解除から分離した入口として追加した。
両方とも既定はplan / dry-runだけを行い、`--apply`と完全一致の対話確認がある場合だけ削除する。
ローカルはWranglerの固定versionで導出したWWWKの2つのDO namespace directoryだけを削除し、
symbolic linkと接続中の環境を拒否し、run / disconnect / eraseを自動回収しないowner-only
PID leaseで排他する。Cloudflareは双方向bindingが外れたlive identityを確認し、
2つのSQLite classの`deleted` tombstoneをdeployした後、依存関係保護付きでWWWK Workerだけを
削除する。どちらもexportを自動実行せず、CFOS、ほかのGatekeeper、KV、R2、state全体を保持する。

## 未計画

高度な検索、UI、Source 更新の自動検知、複数 Source の同時取込み、既存 Wiki の自動統合、
background worker、公式 hosted deploy、複数 revision 対応、upgrade 自動化は、実利用から
必要性が確認された時点でフェーズを追加する。
