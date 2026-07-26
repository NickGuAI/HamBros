---
name: commander-create-wizard
description: Conversationally collect, validate, preview, and create a new Herd commander through the backend API.
user-invocable: true
argument-hint: "<commander goal or role>"
---

# Commander Create Wizard

Use this skill when the user asks Gaia to create or configure a commander.

Rules:

- Ask one question at a time.
- Offer choices for categorical fields before accepting free text.
- Collect required fields first: host, agentType, effort, heartbeat.
- Validate host against `^[a-zA-Z0-9_-]+$` and heartbeat minutes >= 1.
- Show a concise preview and ask for explicit approval before creating.
- POST to `${API_BASE_URL}/api/commanders` with `x-herd-api-key: ${HERD_API_KEY}`.
- Report exact backend validation errors and ask the next corrective question.
