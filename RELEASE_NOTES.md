# Herd v0.0.13-beta

Herd `v0.0.13-beta` is a runtime-durability patch that supersedes
`v0.0.12-beta`. It closes the restored-placeholder edge in a
credential-recovery transition across normal service restarts.

## License

- Herd `v0.0.13-beta` is open source under GNU AGPLv3 (`AGPL-3.0-only`).
- No license purchase is required for commercial use that complies with the
  AGPL.
- A separate paid commercial agreement is available for proprietary or other
  non-AGPL use; see
  [COMMERCIAL-LICENSE.md](https://github.com/NickGuAI/Herd/blob/v0.0.13-beta/COMMERCIAL-LICENSE.md).
- Earlier tagged releases retain the license terms included with those
  releases.

## Highlights

- A restored credential-recovery placeholder can no longer claim authoritative
  deletion ownership with the previous provider's resume identifier. The
  explicit recovery marker keeps the last known-good SQLite row protected.
- Ownership transfers only after credential recovery clears and the
  replacement independently satisfies the provider's persistence snapshot
  contract. Explicit archive operations and ordinary post-recovery lifecycle
  deletion remain authoritative.
- A two-process regression now covers successive service boots where a
  recovery placeholder is removed before its replacement becomes durable.
- The release retains the restore-readiness barrier, unclaimed-row protection,
  shutdown flush, transient recovery protection, and provider safe-boundary
  ownership checks introduced in `v0.0.10-beta` through `v0.0.12-beta`.
- The release retains the session composer, automation workspace, quest
  artifacts, self-contained onboarding, hosted Railway lane, credential
  placement model, provider catalogue, and public skill additions introduced
  in `v0.0.9-beta`.

## Upgrade and compatibility

Git checkouts can upgrade in place:

```bash
herd update --tag v0.0.13-beta
```

Fresh installs continue to use:

```bash
curl -fsSL https://herd.gehirn.ai/install.sh | bash
```

- Back up the configured Herd data directory before upgrading. JSON-store and
  SQLite readiness checks run before the upgraded service is allowed to start.
- Installer-created archive checkouts can be refreshed by rerunning the pinned
  installer; durable state remains outside the application checkout.
- Persisted sessions that cannot resume on the current machine, execution
  mode, or current provider-transition stage remain durable instead of being
  interpreted as deleted. Restored recovery placeholders retain their fallback
  snapshot even when they still expose the prior provider resume identifier.
- Railway deployments must retain their configured durable volume. Hosted
  images default to daemon-only provider execution unless the host is
  intentionally provider-ready.

## Verification

- Full application and CLI suites plus a two-process recovery-placeholder
  regression and targeted persistence-transition, installer, release-runtime,
  JSON-store, SQLite-readiness, and launch contract tests.
- Application build, documentation checks, public artifact cleanliness, and
  documentation-link validation.
- Enterprise EC2 container smoke and exact Railway production-image lifecycle
  smoke.
- Exact GNU AGPLv3 license checksum, installer byte parity, and release-version
  pin checks.

## Source Traceability

- The public artifact is generated from the merged canonical source through
  SOP-15.
- The GitHub release records the exact canonical-source and public-artifact
  commit IDs used for publication.
