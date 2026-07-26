# Railway Hosted Control Plane

Railway can host Herd's web application, APIs, durable control-plane state,
schedulers, channels, and background runtimes. Provider CLIs should execute on
a machine you control through a connected Herd daemon. The hosted container is
not a provider worker.

```text
╔════════════════════════ Railway ════════════════════════╗
║ Herd web + API + SQLite + schedulers + channels         ║
║ HERD_PROVIDER_EXECUTION_MODE=daemon-only           ║
╚══════════════════════╤══════════════════════════════════╝
                       │ authenticated daemon WebSocket
                       ▼
╔════════════ Operator-controlled machine ═══════════════╗
║ Herd daemon → installed provider CLI                    ║
╚═════════════════════════════════════════════════════════╝
```

## Required Railway Configuration

1. Deploy the repository using its checked-in `apps/herd/railway.json` and
   Dockerfile. For a service connected to the shared monorepo, set Railway's
   **Root Directory** to `/` and **Config as Code path** to
   `/apps/herd/railway.json`. The Docker build requires the monorepo root
   as its context. Do not add a Railway start-command override.
2. Attach a persistent volume at `/data/.herd`. The image sets
   `HERD_DATA_DIR=/data/.herd`; the volume preserves the SQLite database,
   machine registry, transcripts, and hashed API-key records across deploys.
   Keep the checked deployment lifecycle unchanged: one replica,
   `overlapSeconds: 0`, and `drainingSeconds: 30`. Zero overlap records that the
   service must not run old and new deployments concurrently; Railway's volume
   lifecycle provides the exclusive mount. The drain window gives SIGTERM
   shutdown time to flush state and release the store lock.
3. Generate the first-boot key on your own machine:

   ```bash
   openssl rand -base64 48
   ```

4. Before the first boot, set the generated value as
   `HERD_BOOTSTRAP_MASTER_KEY`. The public alias
   `HERD_BOOTSTRAP_MASTER_KEY` is equivalent. The value must contain at least
   32 bytes. If both names are set, their values must match.
5. Set the public origin and any optional hosted-auth variables required by
   your deployment. Railway supplies `PORT`; do not hard-code a competing
   listener port.

The hosted runtime must use:

```dotenv
HERD_DATA_DIR=/data/.herd
HERD_PROVIDER_EXECUTION_MODE=daemon-only
HERD_BOOTSTRAP_MASTER_KEY=<operator-generated-secret-of-at-least-32-bytes>
```

`HERD_PROVIDER_EXECUTION_MODE=daemon-only` is an equivalent public alias. Use
the canonical `HERD_` name in the template so one source owns the value.

## First-Boot Key Lifecycle

The configured bootstrap key is accepted only for a genuinely fresh API-key
store. Herd stores its hash in the persistent keystore; it does not log the
secret or write the plaintext value to a server-side file. A later restart
does not re-seed the key, even if the environment variable remains present.

After the first sign-in:

1. Complete founder, organization, Gaia, workforce, and readiness onboarding.
2. In the credential step, create a permanent admin API key and save the
   one-time plaintext value.
3. Verify and switch the browser to the permanent key.
4. Revoke every active bootstrap key. Herd blocks onboarding finish until at
   least one active permanent key exists and no active bootstrap key remains.
5. Finish onboarding, delete `HERD_BOOTSTRAP_MASTER_KEY` (or its `HERD_`
   alias) from Railway, and redeploy.

Never paste either key into deploy logs, issue comments, screenshots, or shell
history shared with other users.

## Connect The Execution Machine

With `daemon-only`, Herd rejects explicit `local` and SSH provider launches. An
omitted machine target auto-selects the daemon only when exactly one connected,
provider-ready daemon is eligible. Zero eligible daemons returns enrollment
guidance; multiple eligible daemons require an explicit machine choice. Herd
keeps command scheduling and channel ingest active while provider work waits.

1. Open Settings → Machines on the Railway-hosted Herd instance.
2. Mint an enrollment token.
3. Run the displayed command on the machine that owns the provider CLIs:

   ```bash
   <installed-cli> connect https://<your-railway-domain> --token <enrollment-token>
   ```

4. Wait until the machine is connected and at least one provider reports
   installed and authenticated.
5. When more than one daemon is ready, pass `machineId` for an individual
   launch or persist `executionMachineId` on the commander. Commander `host`
   is its identity slug and is never an execution target.

The onboarding status endpoint reports the active execution mode, registered
and connected daemon counts, provider-ready daemon count, and ready provider
IDs. A paired but disconnected daemon is not ready. A connected daemon without
provider authentication is also not ready.

Persisted local or SSH sessions are retained but do not auto-resume while the
server is in `daemon-only` mode. Persisted daemon sessions remain eligible for
restore when their daemon and provider are ready.

## Backup And Restore

Enable Railway volume backups as soon as the service is stable. Use at least a
daily schedule and take a manual backup immediately before every upgrade or
other change that could rewrite durable state. Railway's service **Backups**
tab owns both operations:

1. Select the Herd service and open **Backups**.
2. Confirm the backup belongs to the volume mounted at `/data/.herd`.
3. Create a manual backup and wait for it to complete before deploying an
   upgrade.
4. To restore, select the dated backup and choose **Restore**. Review the staged
   volume replacement, then deploy it. Railway retains the old volume but
   unmounts it.
5. Wait for `/api/health` to report `status: ok`, then verify a permanent key,
   organization state, machine records, and one stored conversation before
   resuming work.

Do not wipe the volume: Railway deletes its backups when the volume is wiped.
Volume backups can only be restored into the same project and environment.
Herd also creates a consistent sibling SQLite backup before a supported schema
migration (`herd.sqlite.bak.<timestamp>.<id>`), but that file is a final
recovery aid, not a replacement for Railway's volume-level backup.

## Upgrade And Rollback

An upgrade is a control-plane and data change, not only a container change:

1. Confirm the current deployment is healthy and a permanent API key works.
2. Create and verify a manual volume backup.
3. Deploy the reviewed release without changing the volume mount or overriding
   the image entrypoint.
4. Watch deployment logs without printing secret variables. Herd applies only
   supported schema migrations before readiness; unknown, corrupt, or failed
   schemas keep `/api/health` unready and fail startup closed.
5. After health succeeds, verify permanent-key access, durable state, daemon
   reconnection, and one provider-backed worker action.

If Railway stops an old container before its shutdown handler removes
`.store-writer.lock`, the next deployment may recover that foreign-container
lock only when Railway supplies the complete project, environment, service,
deployment, volume-name, and volume-mount identity; the mount must resolve to
Herd's effective data directory. A replacement container, including an
on-failure restart of the same deployment, may reclaim a foreign-host lock only
in that exact stable volume scope. Outside that checked single-replica,
exclusive-volume contract, a foreign-host lock fails startup closed. Do not
delete the lock by hand or enable overlapping replicas to bypass the guard.

Railway's deployment rollback restores the prior image and service variables;
it does not roll the volume back. If an upgrade changed persistent state and
must be reversed, restore the matching pre-upgrade volume backup as well as the
prior deployment. Never point an older image at a newer schema and assume it is
compatible.

## Credential And Store Recovery

- Losing the bootstrap value after rotation is expected. It cannot be seeded
  again on an initialized store. Use another valid permanent key or restore a
  volume backup containing the API-key store; never delete the store to force a
  new bootstrap key.
- If every permanent key is lost, restore the most recent known-good volume
  backup and use a key preserved outside Railway. If neither exists, recovery
  requires an explicit operator-authorized reset of the deployment's durable
  identity, not a normal restart.
- If startup reports an unsupported or corrupt SQLite/JSON schema, leave the
  failed volume intact, preserve its logs, and restore a known-good backup.
  Do not manually edit the live database or remove migration markers.
- After a service or volume restore, reconnect the provider daemon if needed
  and verify provider readiness separately from `/api/health`.

Related docs:

- [Machines and workers](machines.md)
- [Provider auth](provider-auth.md)
- [Hardening](hardening.md)
- [Troubleshooting](../troubleshoot.md)
- [Railway volume backups](https://docs.railway.com/volumes/backups)
- [Railway deployment rollback](https://docs.railway.com/deployments/deployment-actions)
