# Compatibility artifacts

`compatibility.json` は検証済みの 1 組の Starter、CFOS、WWWK 基底 revision を記録する。
`scripts/local-installer.mjs` はこの値だけを受け付け、公式 CFOS clone の外に integration
worktree と Wrangler state を置く。

- `patches/cfos-8b08672-7964294.patch` は CFOS `8b08672` と companion revision
  `7964294` のraw diffである。
- `patches/starter-93f14df-cfos-cwd.patch` は Starter `93f14df` がCFOSをCFOS自身の
  project cwdでbuildするための最小互換patchである。Starterのpnpm 11.9とCFOSのpnpm
  11.17を混在させず、各projectの指定を使う。
- `compatibility/starter-93f14df-cfos-8b08672.pnpm-lock.yaml` はこの組を一時worktreeで
  `pnpm@11.9.0 install --lockfile-only`した結果である。実際のintegrationではこの値を
  適用してから`pnpm install --frozen-lockfile`する。
- `patches/cfos-8b08672-local-persist.patch` は固定 CFOS runner に絶対
  `--persist-to` を渡す最小の local-only patchである。
- `compatibility/cfos-8b08672-wwwk.pnpm-lock.yaml` はCFOSへWWWK packageを追加した統合後の
  lockfileであり、local installerはこれを使ってfrozen installする。

両patchは公式repositoryのraw diffから作成したためcommit author metadataを含まない。出典の
CFOSとStarterはいずれもApache-2.0であり、artifactとlockfileをsecret、capability、個人情報、
利用者固有pathについて確認した。

`scripts/installer-poc.mjs` は値を書き込まず、revisionと双方向service bindingを検証・生成する。
actual Workshop Worker名を入力として`GATEKEEPER_WWWK`と
`CFOS_SOURCE_ACCESS_BROKER`を含む一時config値を返す。設定不足、重複binding、未対応revisionは
生成前に拒否する。

Phase 6では、同じ絶対state pathをCFOS runnerから複数Workerの`wrangler dev`へ渡すことを
確認した。Phase 7の`starter-installer.mjs`はStarter checkoutを変更せず、同じ固定tupleを
integration worktreeへ再現して、接続と接続解除の生成設定、build、Wrangler dry-runを行う。
外部`deployment.jsonc`はcanonical pathと0600相当を検証してread-onlyで読み、実値を含まない
tracked fixtureだけをgenerated configへ書く。`--apply`では実値をOSの専用0700 directory内の
0600一時configへだけ書き、成功・失敗時の`finally`とSIGINT / SIGTERMで回収する。symlinkまたは
既存fileは再利用せず、repository、integration worktree、managed state、永続・配布・追跡される
artifact、ログへ実値を残さない。live runnerはWranglerのdisk logも無効化する。強制終了または電源断での
削除は保証できない。
