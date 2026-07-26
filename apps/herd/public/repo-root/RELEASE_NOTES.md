# Herd v0.0.14-beta

Herd `v0.0.14-beta` is a shutdown-durability patch that supersedes
`v0.0.13-beta`. It makes process shutdown an explicit persistence checkpoint
instead of treating provider teardown as an authoritative session deletion.

## License

- Herd `v0.0.14-beta` is open source under GNU AGPLv3 (`AGPL-3.0-only`).
- No license purchase is required for commercial use that complies with the
  AGPL.
- A separate paid commercial agreement is available for proprietary or other
  non-AGPL use; see
  [COMMERCIAL-LICENSE.md](https://github.com/NickGuAI/Herd/blob/v0.0.14-beta/COMMERCIAL-LICENSE.md).
- Earlier tagged releases retain the license terms included with those
  releases.

## Highlights

- Graceful shutdown freezes every existing durable runtime-session row before
  provider teardown. Pending and final shutdown writes can update rows but
  cannot delete them merely because a provider process exited.
- The shutdown checkpoint starts before Herd waits for provider restoration to
  settle. This closes the real systemd race where the service and its provider
  children receive SIGTERM together.
- Normal runtime persistence and explicit archive operations remain
  authoritative outside shutdown; the checkpoint changes only the
  process-lifecycle boundary.
- A stop-boundary regression queues an authoritative replacement snapshot,
  removes the provider runtime at SIGTERM, drains persistence, and verifies the
  next service process still reads the protected fallback row.
- The release retains the restore-readiness barrier, unclaimed-row protection,
  transient recovery protection, provider safe-boundary ownership checks, and
  recovery-placeholder ownership guard introduced in `v0.0.10-beta` through
  `v0.0.13-beta`.
- The release retains the session composer, automation workspace, quest
  artifacts, self-contained onboarding, hosted Railway lane, credential
  placement model, provider catalogue, and public skill additions introduced
  in `v0.0.9-beta`.

## Upgrade and compatibility

Git checkouts can upgrade in place:

```bash
herd update --tag v0.0.14-beta
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
  snapshot across startup, active recovery, graceful stop, and replacement
  service startup.
- Railway deployments must retain their configured durable volume. Hosted
  images default to daemon-only provider execution unless the host is
  intentionally provider-ready.

## Verification

- Full application and CLI suites plus recovery-placeholder and concurrent
  SIGTERM shutdown regressions, targeted persistence-transition, installer,
  release-runtime, JSON-store, SQLite-readiness, and launch contract tests.
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
