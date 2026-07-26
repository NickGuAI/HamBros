# Install Or Release Change

1. Identify which path changed:
   - local/public installer: `apps/herd/install.sh`
   - EC2 install: `operations/deploy/ec2/install-ec2.sh`
   - EC2 topology/service: `operations/deploy/ec2/README.md`,
     `operations/deploy/ec2/herd.service`
   - managed launch: `operations/scripts/launch_herd.sh`
   - public release sync: `operations/sops/SOP-15-release-herd.md`

2. Check package scripts:
   - `apps/herd/package.json`
   - root workspace package files if package filters change.

3. Check DB readiness coupling:
   - `apps/herd/tools/db-ready.ts`
   - `apps/herd/server/db/readiness.ts`
   - `packages/herd-cli/src/up.ts`
   - `packages/herd-cli/src/doctor.ts`

4. Verify:

```bash
pnpm --filter @gehirn/herd-cli test
node --test operations/scripts/__tests__/launch_herd.test.mjs
pnpm --filter herd exec vitest run \
  server/routes/__tests__/install-script.test.ts \
  server/__tests__/release-runtime-contract.test.ts \
  server/__tests__/sqlite-readiness.test.ts
bash operations/sops/scripts/check-herd-cleanliness.sh public
```

5. Release mirror check:
   - If install files, public docs, shared packages, launch scripts, or default
     skill bundles move, update `operations/sops/SOP-15-release-herd.md` and
     `operations/sops/scripts/sop-15-sync-herd.sh` together.
