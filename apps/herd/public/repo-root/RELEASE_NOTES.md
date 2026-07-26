# Herd v0.0.12-beta

Herd `v0.0.12-beta` is a runtime-durability patch that supersedes
`v0.0.11-beta`. It closes the active-turn edge case in a restored
credential-recovery transition.

## License

- Herd `v0.0.12-beta` is open source under GNU AGPLv3 (`AGPL-3.0-only`).
- No license purchase is required for commercial use that complies with the
  AGPL.
- A separate paid commercial agreement is available for proprietary or other
  non-AGPL use; see
  [COMMERCIAL-LICENSE.md](https://github.com/NickGuAI/Herd/blob/v0.0.12-beta/COMMERCIAL-LICENSE.md).
- Earlier tagged releases retain the license terms included with those
  releases.

## Highlights

- Runtime-session ownership now transfers only when the provider's own
  persistence snapshot contract produces a resumable snapshot or daemon
  handle. A raw provider session identifier observed during an active turn is
  no longer mistaken for a safe persistence boundary.
- Credential-recovery replacements retain the last known-good SQLite row while
  their continuation turn is active. Once the provider reaches a persistable
  boundary, normal authoritative lifecycle and deletion behavior resumes.
- The release retains the restore-readiness barrier, unclaimed-row protection,
  shutdown flush, and transient recovery protection introduced in
  `v0.0.10-beta` and `v0.0.11-beta`.
- The release retains the session composer, automation workspace, quest
  artifacts, self-contained onboarding, hosted Railway lane, credential
  placement model, provider catalogue, and public skill additions introduced
  in `v0.0.9-beta`.

## Upgrade and compatibility

Git checkouts can upgrade in place:

```bash
herd update --tag v0.0.12-beta
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
  interpreted as deleted. Provider replacements in an active, non-persistable
  turn retain their last resumable snapshot.
- Railway deployments must retain their configured durable volume. Hosted
  images default to daemon-only provider execution unless the host is
  intentionally provider-ready.

## Verification

- Full application and CLI suites plus targeted persistence-transition,
  installer, release-runtime, JSON-store, SQLite-readiness, and launch
  contract tests.
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
