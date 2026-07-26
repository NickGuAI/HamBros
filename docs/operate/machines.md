# Machines And Workers

Machines are the hosts available for worker execution. A machine can be local,
reachable over SSH, or connected by the Herd daemon. New personal machines
should use the printed CLI connect command; SSH registration remains available
for hosts that must be managed over the network.

## Connect A Machine

1. Open Settings → Machines.
2. Click **Connect machine**.
3. Run the printed command on the target machine:

```bash
<installed-cli> connect https://<herd-host> --token <enrollment-token>
```

The CLI exchanges the `hmre_` enrollment token for a daemon machine record and a
hashed-at-rest `hmrd_` pairing token, then starts the daemon runner with the
returned credentials.

```
╔══════════════╗     hmre_ token      ╔════════════════════╗
║ Herd Machines║ ───────────────────▶ ║  target machine CLI ║
╚══════╤═══════╝                       ╚═════════╤══════════╝
       │  stores daemon machine + hmrd_ hash     │
       └────────────────────────────────────────▶│
                         websocket hmrd_ attach  ▼
                         /api/agents/daemons/ws
```

Enrollment tokens are signed, stateless bootstrap credentials. They are
reusable until expiry, are not individually revocable, and must be kept private;
rotating the machine enrollment signing secret invalidates all outstanding
enrollment tokens. Enrollment tokens expire after 24 hours by default, and
expired tokens fail the CLI connect command with re-mint guidance.

Pairing tokens are per-machine daemon credentials. Herd stores only the token
hash, can revoke a machine pairing, and uses a 180-day default TTL. Expired
pairing tokens fail daemon websocket attach, and the machine daemon-status
command shows the expiry so operators can rotate pairing or mint a new connect
command.

## SSH Setup Sequence

1. Verify ordinary SSH to the host.
2. Confirm the host has the provider CLIs needed for the work.
3. Configure remote sshd to accept the Herd machine-env wildcard shown by the
   machine setup flow.
4. Register the host in Herd.
5. Bootstrap the host.
6. Dispatch a small worker and verify the log shows the expected host.

Use the Machines view to add the host, confirm the SSH settings, and run the
bootstrap flow.

Herd sends encrypted machine env entries and remote provider-pool credentials to
SSH targets through `SendEnv`. The remote bootstrap checks that the expected
transport keys arrived before decoding them. If sshd rejects the keys, launch
fails with an environment-receipt error and asks the operator to add the Herd
machine-env wildcard to sshd `AcceptEnv`.

## Credential Hygiene

- Use machine credentials only for accounts and hosts the operator controls.
- Treat machine env entries as expiring material; rotate them when a host,
  provider account, or operator trust boundary changes.
- Prefer encrypted local machine env files for credentials managed by Herd.
- Re-run provider readiness after any machine credential rotation.

## Troubleshooting

- If the host is not listed, registration did not persist or the active server
  is reading a different machine registry.
- If dispatch reports `host: null`, routing was dropped before execution.
  Treat that as a routing bug and do not claim the worker ran on the target
  host.
- If SSH works but provider auth fails, authenticate the provider on the worker
  host.
- If the CLI connect command reports an expired enrollment token, mint a new token in
  Settings → Machines and run the new command.
- If daemon attach fails after a machine was previously paired, check daemon
  status and rotate pairing when the pairing expiry is past.

## Hosted Control-Plane Mode

Set `HERD_PROVIDER_EXECUTION_MODE=daemon-only` when the Herd server should
coordinate work without launching provider CLIs on its own host or over SSH.
In this mode, local and SSH launch requests fail with enrollment guidance; a
connected daemon whose selected provider is installed and authenticated remains
launchable. When a launch omits `machineId`, Herd selects a daemon only if
exactly one daemon is ready for that provider. Multiple ready daemons require an
explicit `machineId`; commander-wide placement is stored as
`executionMachineId`, never inferred from the commander identity `host`.

This mode does not disable schedulers, channels, or other background control
plane runtimes. Persisted local and SSH sessions stay recorded but do not
auto-resume. See [Railway hosted control plane](railway.md) for the full hosted
deployment and first-boot key contract.

Related docs:

- [Workers concept](../concepts/workers.md)
- [Hardening](hardening.md)
- [Railway hosted control plane](railway.md)
- [Troubleshooting](../troubleshoot.md)
