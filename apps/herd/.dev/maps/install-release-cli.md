# Install, Release, And CLI

## Purpose

Keep local install, EC2 install, managed launch, foreground CLI launch, doctor,
and public Herd release in agreement.

## Source Files

- `apps/herd/install.sh`
- `operations/deploy/ec2/install-ec2.sh`
- `operations/scripts/launch_herd.sh`
- `apps/herd/server/index.ts`
- `apps/herd/server/routes/install-script.ts`
- `apps/herd/package.json`
- `apps/herd/herd-cli.mjs`
- `packages/herd-cli/src/index.ts`
- `packages/herd-cli/src/up.ts`
- `packages/herd-cli/src/doctor.ts`
- `packages/herd-cli/src/session.ts`
- `packages/herd-cli/src/workers.ts`
- `operations/sops/SOP-15-release-herd.md`
- `operations/sops/scripts/sop-15-sync-herd.sh`
- `operations/sops/scripts/check-herd-cleanliness.sh`
- `operations/deploy/ec2/README.md`
- `operations/deploy/ec2/herd.service`

## Owned State/Data

- Installer writes app path, bootstrap key setup, local env, and SQLite DB under
  the configured data directory.
- Installer writes `install-started-at.json` in the data root. Onboarding reads
  that stamp and records the elapsed curl-to-first-commander-reply metric in
  status, receipt UI, and telemetry once Gaia produces a successful reply.
- CLI config lives under the user's Herd config path.
- Public release output lives under `releases/herd` during SOP-15 sync.

## External Surfaces

- `apps/herd/install.sh`
- `herd up`
- `herd doctor`
- `herd sessions *`
- `herd workers *`
- `pnpm run db:ready`
- `pnpm run migrate:sqlite`
- public Herd `install.sh`
- public `/install.sh`

## Coupled Modules

- Runtime sessions: DB readiness and migration.
- Provider auth: install/onboarding readiness.
- Public docs: release sync and naming.
- CLI package: operator commands and docs.

## Verification Bundle

```bash
pnpm --filter @gehirn/herd-cli test
node --test operations/scripts/__tests__/launch_herd.test.mjs
pnpm --filter herd exec vitest run \
  server/routes/__tests__/install-script.test.ts \
  server/__tests__/release-runtime-contract.test.ts \
  server/__tests__/sqlite-readiness.test.ts
bash operations/sops/scripts/check-herd-cleanliness.sh public
```

## Known Risks / Open Questions

- Managed launch already runs `db:ready`; foreground `herd up` must not
  skip it.
- SOP-15 mirrors specific source paths; update the SOP/scripts when a required
  install/CLI/release source moves.
- EC2 endpoint behavior spans the installer, service unit, launch scripts, and
  tests; keep production/ALB/CLI `20001` and loopback development `20009`
  assumptions in sync.
