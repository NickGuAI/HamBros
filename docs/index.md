# Herd Docs

Herd is the meta-harness for a personal agent fleet: it coordinates
commanders, workers, channels, workspace context, approvals, provider
credentials, and memory above agent harnesses such as Codex, Claude Code,
Gemini CLI, and OpenCode.

Herd v1 is single-operator software. One trusted operator controls the instance,
provider credentials, machines, and approvals; it is not a multi-user workspace
or tenant boundary.

Use these docs in this order when you are setting up or operating the product.

## Start Here

1. [Quickstart](getting-started/quickstart.md): install Herd and reach the
   first useful commander chat.
2. [Provider auth](operate/provider-auth.md): connect Codex, Claude Code,
   Gemini CLI, or OpenCode on the host that runs the provider.
3. [Machines and workers](operate/machines.md): attach local or remote machines
   for worker execution.
4. [Hardening](operate/hardening.md): put Herd behind TLS, keep the raw app
   port private, and rotate credentials.
5. [Railway](operate/railway.md): run Herd as a hosted control plane with
   provider execution delegated to connected daemons.
6. [Enterprise EC2](operate/enterprise-ec2.md): run the direct-ALB systemd
   deployment path on port `20001`.
7. [Troubleshooting](troubleshoot.md): recover from missing CLIs, stale API
   keys, unavailable machines, and docs/install drift.
8. [llms.txt](llms.txt): compact agent-readable map of the public docs.

## Core Concepts

- [Commanders](concepts/commanders.md): durable agent identities, memory,
  conversations, quests, and worker ownership.
- [Organization](concepts/org.md): single-operator v1 scope and org identity.
- [Workers](concepts/workers.md): delegated execution sessions on local or
  remote machines.
- [Command Room](concepts/command-room.md): the main operating surface for
  chat, queue, workspace, quests, and approvals.
- [Approvals](concepts/approvals.md): human-gated action policy and pending
  tool decisions.

## Operate Herd

- [Provider auth](operate/provider-auth.md)
- [Credential pools](operate/credential-pools.md)
- [Machines and workers](operate/machines.md)
- [Hardening](operate/hardening.md)
- [Railway hosted control plane](operate/railway.md)
- [Enterprise EC2](operate/enterprise-ec2.md)
- [Uninstall](operate/uninstall.md)
- [Workspace](operate/workspace.md)
- [Channels](operate/channels.md)

## Guides

- [Commander bundles](guides/commander-bundles.md): export/import a portable
  commander file with memory, automations, and bundled skill directories.
- [Commander packages](guides/commander-packages.md): inspectable built-in
  marketplace package layout and install behavior.

## Reference

- [CLI reference](reference/cli.md)
- [API reference](reference/api.md)
- [Platform support](reference/platforms.md)
- [Naming policy](reference/naming.md)
