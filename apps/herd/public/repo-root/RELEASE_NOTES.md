# Herd v0.0.10-beta

Herd `v0.0.10-beta` is a runtime-durability patch that supersedes
`v0.0.9-beta`. It preserves the operator features from that release while
closing a first-boot race in persisted agent-session restoration.

## License

- Herd `v0.0.10-beta` is open source under GNU AGPLv3 (`AGPL-3.0-only`).
- No license purchase is required for commercial use that complies with the
  AGPL.
- A separate paid commercial agreement is available for proprietary or other
  non-AGPL use; see
  [COMMERCIAL-LICENSE.md](https://github.com/NickGuAI/Herd/blob/v0.0.10-beta/COMMERCIAL-LICENSE.md).
- Earlier tagged releases retain the license terms included with those
  releases.

## Highlights

- Server readiness now includes persisted agent-session restoration. The
  health endpoint returns a non-ready response until the restore barrier
  settles, preventing installer and deployment handoffs from stopping a
  partially restored first boot.
- SQLite snapshots preserve durable rows that have not yet been claimed by an
  in-memory runtime. This covers sessions waiting on provider startup,
  intentionally dormant for the current execution mode, or temporarily unable
  to resume.
- Hydrated sessions remain under the normal authoritative lifecycle, including
  explicit archive and pruning behavior.
- Graceful shutdown waits for startup restoration and flushes a complete final
  runtime snapshot before provider teardown.
- The release retains the session composer, automation workspace, quest
  artifacts, self-contained onboarding, hosted Railway lane, credential
  placement model, provider catalogue, and public skill additions introduced
  in `v0.0.9-beta`.

## Upgrade and compatibility

Git checkouts can upgrade in place:

```bash
herd update --tag v0.0.10-beta
```

Fresh installs continue to use:

```bash
curl -fsSL https://herd.gehirn.ai/install.sh | bash
```

- Back up the configured Herd data directory before upgrading. JSON-store and
  SQLite readiness checks run before the upgraded service is allowed to start.
- Installer-created archive checkouts can be refreshed by rerunning the pinned
  installer; durable state remains outside the application checkout.
- Persisted sessions that cannot resume on the current machine or execution
  mode remain durable instead of being interpreted as deleted.
- Railway deployments must retain their configured durable volume. Hosted
  images default to daemon-only provider execution unless the host is
  intentionally provider-ready.

## Verification

- Full application and CLI suites plus targeted persistence, installer,
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
