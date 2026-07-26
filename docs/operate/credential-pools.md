# Credential Pools

Credential pools let Herd keep separate provider credential directories for the
operator's own Codex or Claude Code accounts. They are a failover and recovery
tool for provider auth interruptions, not a way to bypass provider policy.

## What A Pool Contains

A pool belongs to one provider. Each credential has:

- a label,
- a directory under the Herd data directory,
- provider-native login material,
- status: active, available, auth required, exhausted, or cooling down.

Current public support:

| Provider | Login command shown by Herd |
|---|---|
| Codex | `CODEX_HOME=<credential-dir> codex login --device-auth` |
| Claude Code | `CLAUDE_CONFIG_DIR=<credential-dir> claude auth login` |

Herd records pool state in the provider auth store and keeps provider login
files inside the generated credential directory.

For local Claude Code, the pool is the source of truth and has one host-global
selection. Herd atomically installs that account's `claudeAiOauth` section in
the native `~/.claude/.credentials.json` at startup, explicit global selection,
active-account login completion, or quota rotation. Normal conversation spawn
and restore only read that selection; they never rewrite it. Unrelated global
sections such as `mcpOAuth` are preserved. Remote Claude launches use a
session-selected remote token instead of copying credential files to the target
machine.

## Add A Credential

From the Herd UI:

1. Open Settings.
2. Open Credential pools.
3. Choose Add credential for Codex or Claude Code.
4. Copy the displayed provider-native login command.
5. Run that command on the Herd host.
6. For Claude Code credentials, paste the `CLAUDE_CODE_OAUTH_TOKEN=...` setup
   token into the credential card if Herd cannot mint and capture it
   automatically.
7. Return to Settings and confirm the credential status is active or available.

Claude credential rows also show provider-polled 5-hour, overall weekly, and
model-scoped weekly usage when Anthropic supplies those windows. Every window
includes its utilization and reset time. Fresh, cached, refresh-throttled,
auth-required, failed, and never-fetched states are labeled; stale numbers are
never presented as live.

`Refresh quota` checks one account and `Refresh all` checks every account with
the same server-side pacing. Both actions wait for the remote checks to finish,
return the completed secret-free pool view, and update the visible Settings
cache immediately. A browser reload is not part of the refresh contract.

When a provider-auth interruption or temporary provider error appears in a
session, Codex may offer a session-scoped switch and either provider may offer
Add credential when no ready account exists. Local Claude instead reports that
global failover is automatic; it never offers a per-conversation switch.

## Choose The Global Local-Claude Credential

Settings is the only selection surface for local Claude. Its **Global Claude
credential** dropdown lists the ready accounts and marks exactly one account
`GLOBAL ACTIVE`. Selecting another account changes the host-global account for
all local Claude conversations. Local conversation create/runtime payloads do
not accept `credentialPoolId`; legacy stored values are ignored as selectors.
Conversation clients enforce this through the backend-projected
`credentialSelectionModes` contract and never classify commander identity
`host` as execution placement.

Codex and remote Claude remain isolated execution lanes. Their applicable
conversation/session credential selection is preserved because those runtimes
have their own home or remote token.

```text
╔══════════════════════════╗    ╔══════════════════════╗    ╔════════════════════╗
║ Claude pool accounts     ║ →  ║ One global active    ║ →  ║ Every local Claude ║
║ configured data storage ║    ║ account in Settings  ║    ║ conversation       ║
╚══════════════════════════╝    ╚══════════════════════╝    ╚════════════════════╝
```

Before changing the global account, Herd gates new local Claude process starts,
keeps new sends queued, waits for live turns to reach a safe boundary, and stops
the old processes. It then synchronizes any newer global OAuth refresh back to
the outgoing pool account, installs the selected account once, and resumes every
affected native Claude session. Queued work remains queued throughout the
transition.

The activation transaction validates token contents, resolves account identity,
and distinguishes a linked/newer refresh lineage from a diverged or foreign
global login. It removes stale `.claude.json.oauthAccount`, ignores Claude auth
override environment variables for the managed local process, and proves the
installed login with `claude auth status --json`. Failed validation rolls the
global files back atomically and quarantines the target as auth-broken instead
of mislabeling it quota-exhausted. A successful guided login is required to
clear that quarantine. Guided pool login and setup-token commands keep their
`.credentials.json` and `.claude.json` state under the pool-specific
`CLAUDE_CONFIG_DIR`, so an inactive account cannot poison the live home identity
cache. Intentionally remote or isolated runtimes retain their own auth boundary;
they do not participate in this global transaction.

## Rotation And Recovery

Herd polls Claude quota server-side about every 90 seconds and spaces Anthropic
requests across accounts. Only fresh 100% utilization initiates a proactive
global switch; 99% remains available. A fresh overall or scoped weekly window
at 100% blocks that account. Cached or failed inspection data never initiates a
switch away from the active account.

An HTTP 429 from the usage endpoint means only that the quota-inspection
request was throttled. It is not evidence that the account exhausted Claude
quota. When a last-good remote snapshot exists, Herd retains it as cached,
shows `refresh throttled` separately, and leaves the credential available. A
manual refresh performs a new remote check even during local backoff; automatic
polling continues to honor the recorded retry time. Authentication failures,
inspection failures, and actual 100% quota windows remain separate states.
Successful secret-free quota windows are persisted under the configured Herd
data directory at `credential-pools/claude/quota-cache.json`, so a server
restart followed by inspection throttling can still render and use the last
successful remote result. Each cache entry also records the source credential
file revision (timestamps, size, and inode). A login rewrite invalidates the
old account's quota even when the replacement preserves its modification time.

The prior credential remains registered and becomes eligible as soon as a
fresh provider snapshot reports headroom, even when an older inferred cooldown
has not elapsed. Polling uses access tokens only and never races Claude Code by
refreshing OAuth itself.

Recovery behavior:

- If another fresh, ready credential exists, Herd installs it globally once.
  A cached last-good credential with known headroom is the next recovery choice.
  During a real runtime/auth failure, an otherwise ready, non-exhausted account
  remains a last-resort candidate when quota inspection itself is unavailable;
  observability failure must not strand the conversation.
- If activating one reactive target fails, Herd excludes that failed target
  from the current recovery chain and immediately tries the next cached or
  unknown-ready candidate. This reactive retry does not fall back to the
  fresh-only proactive polling policy.
- For local Claude Code sessions in global-continuity mode, Herd materializes
  the replacement credential into the native `~/.claude` location and resumes
  the existing Claude native session id with the replacement process.
- If the session can recover in place, Herd continues the conversation without
  rerunning completed side effects. When the interrupted turn has no replayable
  user message, Herd sends a guarded continuation instruction instead of
  starting an idle replacement.
- If recovery cannot happen immediately, Herd keeps recovery queued and the
  quota loop wakes it when an account becomes freshly eligible.
- If no ready credential exists, the UI shows the earliest known reset time or
  asks the operator to refresh provider login. A successful switch is
  informational; it does not leave a stale manual per-conversation switch.

Remove a credential from Settings when the account is no longer owned by the
operator, no longer needed, or suspected to be exposed.

## macOS Daemon Policy

Mac daemon machines must use one of two Claude Code auth lanes:

```text
╔════════════════════╗      ╔════════════════════╗      ╔════════════════════╗
║ Herd host pool     ║  →   ║ WS spawn env       ║  →   ║ macOS daemon proc  ║
║ remote token ready ║      ║ CLAUDE_CODE_...    ║      ║ no file persisted  ║
╚════════════════════╝      ╚════════════════════╝      ╚════════════════════╝

Alternative: per-Mac native Claude Code login on the daemon machine.
```

- Use the env-token lane for host-managed Mac daemon sessions. Herd sends the
  ready pool credential as `CLAUDE_CODE_OAUTH_TOKEN` in the daemon spawn env for
  that process only.
- Keep per-Mac native login available as the fallback lane. In that mode the
  daemon reports native provider health and Herd does not send pool credential
  material.
- Do not materialize Claude credential files onto Macs for pool propagation.
  macOS Claude Code storage is Keychain-primary with a plaintext fallback; once
  Keychain migration succeeds, `.credentials.json` can be deleted and refreshed
  credential lineage moves into a machine-local, config-dir-hashed Keychain
  service. That strands the pool away from the Herd host and is not supported.
- Tokens from `claude setup-token` can lack the `user:profile` scope. This is
  relevant only when org-UUID enforcement is enabled; current Herd deployments
  do not enforce org UUIDs for this lane.

Related docs:

- [Provider auth](provider-auth.md)
- [Hardening](hardening.md)
- [Troubleshooting](../troubleshoot.md)
