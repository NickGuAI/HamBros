# Troubleshooting

Use this page when a fresh Herd install or first commander run fails before a
useful response.

## Installer Fails

Check:

```bash
command -v git
command -v curl
command -v tar
```

Recovery:

- Install the missing tool.
- Confirm outbound HTTPS works.
- Rerun the installer.

## Browser Cannot Reach Herd

Check:

```bash
curl -fsS http://localhost:20001/api/health
```

Recovery:

- Restart the Herd process.
- Confirm the printed URL and port.
- Check reverse proxy or private-network routing if you are not using local
  access.

## SQLite Runtime-Session Store Is Not Ready

Herd stores agent runtime session lifecycle state and provider resume handles in
the local SQLite runtime-session database. Commander and conversation metadata
stay in their owning stores. The installer prints the active data directory and
database path in its receipt; advanced operators can override the database path
before launch when needed.

Boot fails closed when legacy JSON/JSONL state exists but the SQLite database is
missing, stale, corrupt, or unwritable:

```text
╔══════════════╗      ╔═══════════════╗      ╔══════════════╗
║ JSON stores  ║  →   ║ migrate:sqlite ║  →   ║ SQLite ready ║
╚══════════════╝      ╚═══════════════╝      ╚══════════════╝
        │                      │                      │
        └── backup manifest ───┴── validation marker ─┘
```

Check:

```bash
curl -fsS http://localhost:20001/api/health | jq '.database'
pnpm run db:ready -- --source-root "$HERD_DATA_DIR" --db "$HERD_DATA_DIR/herd.sqlite"
```

Recovery:

- If `db:ready` prints a migration command, run that exact command.
- Keep `--backup` enabled for legacy migrations unless you have a separate
  snapshot.
- Restart Herd after the migration succeeds.

Manual migration:

```bash
pnpm run migrate:sqlite -- \
  --source-root "$HERD_DATA_DIR" \
  --db "$HERD_DATA_DIR/herd.sqlite" \
  --backup
```

## API Key Is Stale

Recovery:

- Clear the stored browser key from the landing page or browser storage.
- Use a preserved permanent admin key, or the original bootstrap value only if
  this is the same never-initialized store and that bootstrap key is still
  active. The server never prints or regenerates bootstrap secrets.
- If Auth0 is configured, complete the hosted sign-in path instead.
- If every permanent admin key is lost, restore a known-good data-volume backup
  together with its preserved key. Otherwise, stop and obtain explicit
  operator authorization before resetting the deployment's durable identity.

## Provider Auth Is Missing

Run the provider's native status command on the same host that will run work:

```bash
codex login status
claude auth status
gemini auth status
opencode auth status
```

Recovery:

- Log in through the provider CLI on that host.
- Refresh the Provider Auth panel.
- Do not authenticate against a parallel Herd OAuth flow unless the provider
  implementation explicitly supports it.

## Machine Routing Is Missing

Check:

```bash
ssh <machine>
```

Recovery:

- Fix SSH or Tailscale first.
- Re-register or bootstrap the machine.
- If dispatch reports `host: null`, do not assume the worker ran on that host.

## Docs Or README Links Are Missing

Recovery:

- Ensure the public docs index and `llms.txt` exist.
- Ensure release sync copies the public docs subset to root `docs/`.
- Re-run the public release sync before publishing.

## Uninstall Or Credential Cleanup

If you are removing Herd from a host, do not delete files before revoking
credentials. Follow [Uninstall](operate/uninstall.md) to stop the service,
revoke keys, rotate provider and machine credentials, and then remove local
state.
