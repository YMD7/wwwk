# Phase 5 compatibility artifacts

`compatibility.json` は Phase 5 で検証した 1 組の Starter、CFOS、WWWK 基底 revision を記録する。
installer 本体ではなく、次フェーズが一時 worktree を作る前に照合するPoCの入力である。

- `patches/cfos-8b08672-7964294.patch` は CFOS `8b08672` と companion revision
  `7964294` のraw diffである。
- `patches/starter-93f14df-cfos-cwd.patch` は Starter `93f14df` がCFOSをCFOS自身の
  project cwdでbuildするための最小互換patchである。Starterのpnpm 11.9とCFOSのpnpm
  11.17を混在させず、各projectの指定を使う。
- `compatibility/starter-93f14df-cfos-8b08672.pnpm-lock.yaml` はこの組を一時worktreeで
  `pnpm@11.9.0 install --lockfile-only`した結果である。実際のintegrationではこの値を
  適用してから`pnpm install --frozen-lockfile`する。

両patchは公式repositoryのraw diffから作成したためcommit author metadataを含まない。出典の
CFOSとStarterはいずれもApache-2.0であり、artifactとlockfileをsecret、capability、個人情報、
利用者固有pathについて確認した。

`scripts/installer-poc.mjs` は値を書き込まず、revisionと双方向service bindingを検証・生成する。
actual Workshop Worker名を入力として`GATEKEEPER_WWWK`と
`CFOS_SOURCE_ACCESS_BROKER`を含む一時config値を返す。設定不足、重複binding、未対応revisionは
生成前に拒否する。

Phase 6の観測: local persistenceの保存先と既存Starter資源の再利用は、実際に`wrangler dev`を
起動して確認してから確定する。Phase 5ではCloudflare deployや資源作成を実行していない。
