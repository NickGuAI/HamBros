---
name: create-automation
description: Create a Herd automation from a conversation while preserving sourceConversationId provenance.
user-invocable: true
argument-hint: "<automation name, trigger, and instruction>"
---

# Create Automation

Use this skill when the user asks Gaia to create a schedule, quest, or manual automation.

Steps:

- Ask for missing fields using choices for trigger, provider, status, and parent commander when options are known.
- Build a request for `${API_BASE_URL}/api/automations`.
- Include `sourceConversationId` with `HERD_SOURCE_CONVERSATION_ID` when the environment variable is present.
- Use `x-herd-api-key: ${HERD_API_KEY}` for the request.
- Report the created automation id, name, trigger, status, and next scheduled time if the API returns one.
- Never print, persist, or summarize the API key value.
