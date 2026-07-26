# Herd Quickstart

This guide takes a clean machine from install to the first useful commander
interaction. The endpoint is not "the app built"; the endpoint is a commander
chat or worker action that proves Herd can operate on your machine.

## 1. Install

Run the installer on the machine that will host the control plane:

```bash
curl -fsSL https://herd.gehirn.ai/install.sh | bash
```

The installer prepares a hermetic Node/pnpm toolchain, clones the public
Herd repo, writes the local env file, installs dependencies, builds the app,
checks the SQLite runtime-session database, starts the shell once, creates a
24-hour bootstrap API key, and prints the local sign-in URL.

Verification:

- The command exits successfully.
- The output includes a local URL and bootstrap key or sign-in instructions.
  Treat the bootstrap key as one-time first-sign-in material: create and
  preserve a non-expiring permanent admin API key in Settings, then revoke the
  bootstrap key before its 24-hour expiry.
- The Herd process exposes `/api/health`.
- `/api/health` reports `database.ready: true`.

## 2. Open Herd

Open the URL printed by the installer. On first boot, Herd may use the
zero-config API-key path if Auth0 is not configured. Hosted or production
deployments may redirect through Auth0.

Verification:

- The browser reaches the Herd shell.
- The first-run screen appears, or the main Command Room appears if setup was
  already completed.
- If the browser reports a stale API key, clear the stored key from the landing
  page and use a preserved permanent admin key. The original installer
  bootstrap value works only while that same first-boot key remains active.

## 3. Complete First Run

Follow the First Run flow:

1. Confirm the database step is ready.
2. Confirm the founder and organization profile.
3. Seed Gaia when prompted. Gaia is the built-in onboarding commander that
   helps the operator finish first-run setup and starter workforce creation.
4. Install or intentionally skip the starter workforce.
5. Review provider readiness.
6. Review machine readiness.

Partial setup is valid. Unchecked providers and machines remain unavailable
until you return and verify them.

Verification:

- The First Run screen marks setup complete or intentionally skipped.
- At least one commander is visible in the Command Room or Org view.
- Provider and machine warnings are explicit instead of silent failures.

## 4. Connect Provider Auth

Herd uses provider CLIs on the host where the provider runs. Authenticate the
original provider tool, then refresh Herd provider status.

Common paths:

```bash
codex login status
claude auth status
gemini auth status
opencode auth status
```

If a provider is not authenticated, run that provider's native login command on
the same host. For example, Claude Code authentication belongs to Claude Code;
Herd only reports and uses that local status.

Verification:

- The Provider Auth panel shows at least one provider as ready, or the missing
  provider has explicit login steps.
- The connected provider is available when starting a commander or worker.

See [provider auth](../operate/provider-auth.md) for the detailed contract.

## 5. Attach Or Verify A Machine

For local work, the host that runs Herd can also run workers. For remote work,
attach a machine over SSH or Tailscale after ordinary SSH works.

Verification:

- The Machines view shows the intended host.
- The machine is reachable over SSH before it is used for worker dispatch.
- Worker logs show commands executing on the expected host.

See [machines and workers](../operate/machines.md) for host routing details.
Review [platform support](../reference/platforms.md) before choosing a host.

## 6. Start The First Useful Commander Run

Open Command Room, select a commander, and send a small, verifiable task:

```text
Read the current workspace README and summarize the setup command.
```

For worker orchestration, dispatch a bounded task that can report a concrete
artifact, such as a file path, issue URL, or test command result.

Verification:

- The chat receives a response from the selected commander.
- If a worker is used, its output is visible under the correct worker block.
- Workspace context, file links, or command results match the selected target.

## Recovery Map

| Symptom | Check | Recovery |
|---|---|---|
| Installer cannot run | `git`, `curl`, `tar`, outbound HTTPS | Install the missing tool and rerun the installer. |
| Browser cannot reach app | `/api/health`, process logs, port `20001` | Restart Herd and confirm the printed URL. |
| Database not ready | `/api/health.database`, local SQLite file | Run the printed migration command from the app workspace, then restart Herd. |
| API key rejected | local browser storage, latest installer output | Clear the stale key and use a current bootstrap key, or create a permanent key from Settings before the bootstrap key expires. |
| Provider unavailable | native provider auth status on that host | Run the provider login command on the provider host. |
| Machine unavailable | ordinary SSH, Tailscale status, machine registry | Fix SSH/Tailscale first, then bootstrap the machine. |
| Docs link missing | Docs index, `llms.txt`, `docs:check` | Sync the public docs tree and run the docs guard before publishing. |
| Removing Herd | API keys, mobile pairing, provider auth, local data | Follow the [uninstall guide](../operate/uninstall.md) so credentials are revoked before files are deleted. |

Next: read [Commanders](../concepts/commanders.md), [Command Room](../concepts/command-room.md),
and [Workspace](../operate/workspace.md). Before public exposure, complete
[Hardening](../operate/hardening.md).
