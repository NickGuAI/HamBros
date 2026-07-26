# Agents And Providers

## Purpose

Map provider registry metadata, provider adapter runtime, machine auth, service
secrets, session creation, and UI/commander provider selection.

## Source Files

- `apps/herd/modules/agents/providers/registry.ts`
- `apps/herd/modules/agents/providers/provider-adapter.ts`
- `apps/herd/modules/agents/providers/provider-context-normalization.ts`
- `apps/herd/modules/agents/providers/provider-session-context.ts`
- `apps/herd/modules/agents/providers/generate-registry.mjs`
- `apps/herd/modules/agents/adapters/claude/`
- `apps/herd/modules/agents/adapters/codex/`
- `apps/herd/modules/agents/adapters/gemini/`
- `apps/herd/modules/agents/adapters/opencode/`
- `apps/herd/modules/agents/provider-auth.ts`
- `apps/herd/modules/agents/machine-auth.ts`
- `apps/herd/modules/agents/machine-credentials.ts`
- `apps/herd/modules/agents/routes/provider-auth-routes.ts`
- `apps/herd/modules/agents/routes/machine-world-routes.ts`
- `apps/herd/modules/agents/components/NewSessionForm.tsx`
- `apps/herd/modules/commanders/components/ProviderModelSelect.tsx`

## Owned State/Data

- Provider registry owns metadata and capability descriptors.
- Agents runtime owns live sessions, queues, websocket replay, provider context,
  and teardown.
- Machine auth owns per-machine CLI auth setup.
- Settings/API keys own service provider secrets.

## External Surfaces

- `/api/providers`
- `/api/agents/sessions`
- `/api/agents/machines/:id/auth-status`
- `/api/agents/machines/:id/auth-setup`
- `/api/auth/transcription/openai`
- `/api/auth/image-generation/gemini`

## Coupled Modules

- Command Room and Agents UI provider/model selectors.
- Commander creation/edit/conversation provider defaults.
- Runtime session persistence and provider context normalization.
- API keys/settings for service secrets.

## Verification Bundle

```bash
pnpm --filter herd run generate:provider-registry
pnpm --filter herd exec vitest run \
  server/__tests__/provider-context-normalization.test.ts \
  modules/agents/providers/__tests__/http-router.test.ts \
  modules/agents/providers/__tests__/validate-model.test.ts \
  modules/agents/__tests__/provider-auth.test.ts \
  modules/agents/__tests__/routes-provider-auth.test.ts \
  modules/agents/__tests__/machine-auth.test.ts \
  modules/agents/__tests__/machine-credentials.test.ts \
  modules/agents/__tests__/routes-create-session-creator.test.ts \
  modules/agents/__tests__/routes-stream-claude.test.ts \
  modules/agents/__tests__/routes-stream-codex.test.ts \
  modules/agents/components/__tests__/NewSessionForm.test.ts \
  modules/agents/components/__tests__/useNewSessionConstraints.test.ts
```

## Known Risks / Open Questions

- Registry metadata is not proof that provider launch works; verify adapter
  session create/stream paths.
- Service secrets and per-machine CLI auth are separate credential planes.
- Provider CLI protocol drift can break launch under stable method names. For
  Codex app-server changes, compare `codex app-server generate-ts --out <tmp>`
  against `modules/agents/adapters/codex/runtime.ts` and lock required
  initialize capabilities in `routes-stream-codex.test.ts`.
