---
name: add-machine
description: Add or pair a Herd machine — mint an enrollment token and return the one-line connect command, or re-pair an existing daemon machine.
user-invocable: true
argument-hint: "<machine name, host, and transport>"
---

# Add Machine

Use this skill when the user asks Gaia to add a host, worker machine, daemon machine, or launch target.

Steps:

- Ask for any missing required values: label, transport preference (daemon or ssh), and default cwd.
- For a new daemon machine (the default for a box the user controls), POST to `${API_BASE_URL}/api/agents/machines/enrollment-token` with optional `label` and `cwd`. Return the `enrollment.command` one-liner from the response for the user to run on the new machine; it self-enrolls and comes online. The token expires at `enrollment.expiresAt` (24 hours) — treat it as a secret and share it only with the user.
- For SSH-transport machines (Herd connects out to the box over SSH), POST to `${API_BASE_URL}/api/agents/machines` with the approved machine payload.
- To re-pair or rotate daemon credentials for an existing machine, POST to `${API_BASE_URL}/api/agents/machines/:id/daemon/pair` and return the daemon pairing command from the response.
- Use `x-herd-api-key: ${HERD_API_KEY}` for every request.
- Never print, persist, or summarize the API key value.
