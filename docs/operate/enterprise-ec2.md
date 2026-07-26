# Enterprise EC2

Use this page when running Herd as an enterprise-managed EC2 service behind an
AWS Application Load Balancer. The production Node server owns both the browser
application and API on the ALB target port.

## Architecture

```
╔══════════════╗      ╔══════════════════════╗      ╔════════════════════╗
║ Browser/iOS  ║ ───▶ ║ AWS ALB HTTPS :443  ║ ───▶ ║ Herd Node :20001   ║
║              ║      ║ host-based routing  ║      ║ UI + API + WS      ║
╚══════════════╝      ╚══════════════════════╝      ╚════════════════════╝
```

Production binds `0.0.0.0:20001` so the ALB can reach it. Restrict EC2 ingress
on that port to the ALB security group. Port `20009` is reserved for a local
development API and must not be an ALB target.

## Provision

1. Launch an Ubuntu 22+ or Amazon Linux 2023 EC2 host with durable storage.
2. Choose an app checkout path such as `/opt/herd`.
3. Choose a data directory such as `/var/lib/herd`; keep it stable across
   upgrades.
4. Point DNS at the ALB and forward the Herd host rule to target port `20001`.
5. Run the EC2 installer from the deploy assets:

```bash
sudo bash operations/deploy/ec2/install-ec2.sh \
  --domain herd.example.com \
  --app-user <linux-user> \
  --install-dir /opt/herd \
  --data-dir /var/lib/herd
```

The installer resolves the public release layout at `apps/herd` and
`packages/herd-cli`, installs `herd.service`, binds the application to
`0.0.0.0:20001`, builds the app, and verifies the direct application listener.

### Upgrading From Herd

Hosts installed before the rename may still have `hervald.service` bound to a
legacy port. The EC2 installer disables that legacy unit, removes
`/etc/systemd/system/hervald.service`, reloads systemd, starts `herd.service`,
and refuses to pass local health if the old unit is still active.

## TLS And Load Balancers

- Terminate TLS at the ALB and send traffic directly to Herd on `20001`.
- Use `/api/health` for the target-group health check.
- Allow port `20001` only from the ALB security group. Do not register or expose
  the development port `20009`.

## Verify

Run these checks on the host after install:

```bash
curl -fsS http://127.0.0.1:20001/api/health
curl -fsS http://127.0.0.1:20001/org
sudo systemctl status herd --no-pager
```

Reboot once and repeat:

```bash
sudo reboot
# reconnect after the host returns
curl -fsS http://127.0.0.1:20001/api/health
sudo systemctl is-active herd
```

## Upgrade

Use the Herd update command:

```bash
herd update --tag v0.0.14-beta
```

Omit `--tag` only when the host can reach the release remote and should choose
the latest `v*` release tag automatically. The command fetches the target tag,
rebuilds the checkout, runs JSON-store and SQLite readiness checks against the
configured data directory, and restarts `herd.service`.

After the update, confirm the service is healthy locally on port `20001` and
through the public ALB endpoint.

Rollback uses the previous git revision printed by `herd update`:

```bash
sudo systemctl stop herd
cd /opt/herd
sudo -u <linux-user> git reset --hard <previous-commit>
sudo -u <linux-user> pnpm install --frozen-lockfile
sudo -u <linux-user> pnpm --filter herd run build
sudo systemctl start herd
curl -fsS http://127.0.0.1:20001/api/health
```

## Backup

Back up the data directory before upgrades:

```bash
sudo systemctl stop herd
sudo tar -C /var/lib -czf "/var/backups/herd-data-$(date -u +%Y%m%dT%H%M%SZ).tgz" herd
sudo systemctl start herd
curl -fsS http://127.0.0.1:20001/api/health
```

The data directory stores commander memory, API keys, machine records, runtime
session state, local database files, and operational logs. Keep backups outside
the EC2 root volume for production instances.
