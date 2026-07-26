# Security Policy

Herd is open-source software distributed under the GNU Affero General Public License
version 3 (`AGPL-3.0-only`). It is built for self-hosted,
single-operator use where the operator controls the host, provider accounts,
reverse proxy, and worker machines.

## Supported Versions

Security fixes are accepted for the current public release line only.

| Version | Supported |
|---|---|
| v0.0.4 and later public prereleases | Yes |
| Earlier public snapshots | No |

If you run a fork, apply fixes from the newest public release before reporting
a vulnerability.

## Reporting A Vulnerability

Report security issues privately by opening a GitHub security advisory on the
Herd repository or by emailing the maintainer listed in the repository owner
profile. Do not publish exploit details until the issue is triaged.

Include:

- The affected version or commit.
- Deployment shape: Linux web host, reverse proxy, iOS client, and worker
  machine type.
- Exact routes, commands, or files involved.
- Whether credentials, API keys, provider tokens, or machine env files may have
  been exposed.

## Threat Model Summary

Herd coordinates agents that can execute shell commands. Treat the Herd host
and every registered worker as trusted operator infrastructure, not as a
multi-tenant sandbox.

```text
operator browser / iOS
        |
        v
authenticated Herd API
        |
        +--> approval gate --> allow / review / block
        |
        v
provider CLI process
        |
        v
local or registered worker machine
```

Legend:
- Authenticated Herd API: API-key or hosted-auth entry point.
- Approval gate: policy layer that decides whether proposed actions auto-run,
  wait for operator review, or block.
- Provider CLI process: Codex, Claude Code, Gemini CLI, OpenCode, or another
  configured provider runtime running under the operator's account.

### Bootstrap Key

The bootstrap key protects first sign-in for a never-initialized key store. It
is a full-scope temporary API key, expires after 24 hours, and is intended only
to let the operator finish onboarding and create a non-expiring permanent
admin key. A restart, an empty active-key list, or a lost credential never
creates another bootstrap key after the store has been initialized.

After first sign-in:

1. Create and preserve a non-expiring permanent admin API key in Settings.
2. Revoke or rotate the bootstrap key.
3. Remove the bootstrap key from shell history, notes, screenshots, and shared
   logs.

Anyone with a live bootstrap key can act as the operator until the key expires
or is revoked.

If every permanent admin key is lost, restore a known-good persistent-volume
backup together with its preserved key. Without either, recovery requires an
explicit operator-authorized reset of the deployment's durable identity; do
not delete the key store to force bootstrap access.

### Agent Execution

Agents run through provider CLIs and may request shell, filesystem, network,
GitHub, email, calendar, or other tool actions depending on the configured
providers and skills. Herd records conversations, worker routing, approvals,
and runtime state, but it does not make arbitrary shell execution safe on an
untrusted host.

Run Herd only on hosts you administer. Keep provider auth scoped to accounts
you own, and register worker machines only after ordinary SSH, Tailscale, or
daemon pairing is trusted.

### Approval Gating

Approval policies separate provider-proposed actions from operator decisions.
Sensitive actions can be configured to:

- auto-allow when they match internal safe rules,
- queue for explicit operator review, or
- block.

Approval gating reduces accidental side effects; it is not a replacement for
host isolation, provider-account hygiene, TLS, network policy, or least-scope
API keys.

## Hardening Checklist

- Put Herd behind TLS and a reverse proxy. See
  [Hardening](./docs/operate/hardening.md).
- Bind the Herd process to loopback when the proxy runs on the same host.
- Do not expose the raw application port to the public internet.
- Rotate bootstrap, mobile, provider, and machine credentials on a schedule.
- Use provider credential pools only for failover among your own authenticated
  provider accounts. See [Credential pools](./docs/operate/credential-pools.md).
- Review the [platform matrix](./docs/reference/platforms.md) before
  deploying.
