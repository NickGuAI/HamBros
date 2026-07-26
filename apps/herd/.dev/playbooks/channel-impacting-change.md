# Channel-Impacting Change

Use this playbook for any change that can affect WhatsApp, email, Slack,
Discord, Telegram, Google Chat, or any future external channel. This includes
adapter changes, channel config, surface binding, channel conversation routing,
automatic replies, transcript projection, channel management UI, and shared chat
rendering used by channel conversations.

## How The Recent Failure Happened

There were two related misses.

First, the automatic channel reply forwarder was still keyed to the legacy
stream event shape: `message_start` started a reply turn and `result` completed
it. Newer session transcripts use schema-v2 envelopes such as
`ev.type = "message.start"` and `ev.type = "turn.end"`. The assistant reply
existed in the conversation transcript, but the forwarder never recognized the
turn boundary, never extracted the reply, and never called the channel
dispatcher. Tests covered legacy stream events and provider adapter sends, but
not the schema-v2 transcript envelope path that production channel conversations
were using.

Second, after the transport path was fixed, the reply `2026.` exposed a visible
transcript bug. That string is valid Markdown ordered-list syntax, so
`ReactMarkdown` rendered it as an empty ordered list instead of visible
paragraph text. Raw transport success, transcript JSONL success, and copy-button
success did not prove visible Command Room success.

Root cause: channel conversations are a cross-module product path, but the
review treated each symptom as a local bug. The critical path spans adapter
runtime, surface binding, conversation runtime, event schema, transcript
projection, automatic outbound dispatch, delivery status, visible UI, and
provider runtime health after relaunch.

The process failure was not a missing unit test alone. The process allowed a
change to be declared done from isolated evidence:

- the provider adapter could send a message.
- the transcript contained raw assistant text.
- the copy button returned the right raw text.
- the UI loaded without a visible JavaScript error.

Those facts were each true, but none proved the actual channel product path:
the same external peer, same `conversationId`, and same assistant reply text
moving through inbound routing, provider session runtime, transcript envelopes,
automatic outbound dispatch, delivery state, desktop UI, and mobile UI.

The failure should have been caught by reviewing the same response across every
observable layer:

```text
WhatsApp inbound
      |
      v
channel-message route
      |
      v
provider session emits schema-v2 transcript envelopes
      |
      +--> channel reply forwarder
      |       expected: message.start -> turn.end -> dispatch exact text
      |       missed: legacy-only scanner never saw turn completion
      |
      +--> /api/conversations/:id/messages
              expected: projected message text is visible in Command Room
              missed: "2026." copied as raw text but rendered blank as Markdown
```

## Critical Channel Review SOP

This SOP is mandatory before declaring any channel-impacting change done. It is
not enough to run tests or inspect the changed file. The reviewer must prove
the same conversation turn through every critical piece below.

1. Declare the classification in the issue or PR before implementation.
   - `channel-impacting: yes` when any session, queue, transcript, renderer, or
     conversation route used by external channels changes.
   - `channel-impacting: no` only with a written reason.

2. Name a channel review owner in the issue or PR. The owner is accountable for
   the review packet below. Do not split ownership by module unless one person
   still verifies the end-to-end product path.

3. Build a critical-path inventory from source, then mark every row as checked,
   not applicable, or blocked. Do not skip a row because no file in that
   directory changed.

| Piece | Primary source | What to review closely |
|---|---|---|
| Provider adapter/runtime | `modules/channels/<provider>/adapter.ts`, `modules/channels/runtime-manager.ts` | Account startup, inbound normalization, outbound `send`, failure reporting, provider-specific threading/peer identity. |
| Channel binding | `modules/channels/store.ts`, `modules/channels/descriptors.ts`, `modules/channels/page.tsx` | Enabled state, default commander, account config, UI save/read behavior. |
| Surface binding | `modules/channels/resolver.ts`, `modules/channels/surface-binding-store.ts`, `modules/channels/surface-key.ts` | `sessionKey`, peer identity, conversation reuse, `lastRoute`. |
| Channel ingest route | `modules/commanders/routes/register-channels.ts`, `modules/commanders/routes/register-conversations.ts` | Idempotency, conversation creation, resume/start behavior, channel metadata. |
| Conversation runtime | `modules/commanders/routes/conversation-runtime.ts`, `modules/commanders/routes/context.ts` | Create/resume/send, queue behavior, live-session recovery, channel reply forwarders. |
| Runtime session state | `modules/agents/session/*`, `modules/agents/routes/session-*`, `server/db/schema.ts` | Backend-owned state/actions, launch reset, active/no-live recovery, provider context. |
| Provider adapters | `modules/agents/adapters/*`, `modules/agents/providers/*` | Actual event schema emitted by Claude/Codex/etc., auth, model defaults, resume handles. |
| Transcript storage/windowing | `modules/agents/transcript-store.ts`, `modules/agents/messages/canonical-timeline.ts` | Tail windows, mixed legacy/v2 ordering, seq/time resets, dedupe of live vs persisted events. |
| Message projection | `modules/agents/messages/history.ts`, `modules/agents/messages/stream-event-machine.ts` | `mapStreamEventsToMessages`, legacy event names, schema-v2 envelope support, final text extraction. |
| Outbound reply dispatch | `modules/commanders/channel-dispatchers.ts`, `modules/commanders/routes/conversation-runtime.ts` | Exact final assistant text, durable `channelReplyIntents`, missed-forwarder reconciliation, single active delivery claim, delivery failure handling. |
| Read model and websocket | `modules/commanders/routes/conversation-read-model.ts`, `modules/conversation/hooks/use-conversations.ts` | `/api/conversations/:id`, `/messages`, `/ws`, allowed actions, latest-message ordering. |
| Visible transcript UI | `modules/agents/components/session-message-list/blocks.tsx`, `modules/command-room/*` | Desktop/mobile render, Markdown edge cases, blank bubbles, copy/export parity. |
| Delivery status | `modules/commanders/conversation-store.ts`, `modules/commanders/routes/conversation-runtime.ts` | `channelReplyDelivery`, `channelReplyIntents`, pending/delivered/failed state, interrupted-send failure, orphan pending-slot recovery, persistence across reload/resume. |

4. Prove one same-turn thread end to end. The evidence must use one
   `conversationId`, one external peer, and one assistant reply text. Do not
   combine transport evidence from one turn with UI evidence from another.

```text
same external peer
      |
same conversationId
      |
same assistant reply text
      |
+-----+------------------+------------------+------------------+
| API | transcript JSONL | external channel | desktop/mobile UI |
+-----+------------------+------------------+------------------+
```

5. Include a schema review. If any code scans raw event names, prove whether it
   handles both legacy events and schema-v2 transcript envelopes. Search first,
   then add the lowest-layer regression that would have failed in production.

6. Include a renderer review. If any user-visible text changes path through
   `SessionMessageList`, prove visible desktop and mobile rendering with
   Markdown-like plain text. Raw text and copy text are supporting evidence, not
   the user-visible proof.

7. Include a provider-runtime relaunch review for production fixes. After
   relaunch, inspect the current launch log for unhandled rejections, adapter
   startup failures, provider auth failures, reconnect loops, and server crash
   restarts. A healthy `/api/health` response after a supervisor restart does
   not by itself prove the channel runtime survived cleanly.

```text
production relaunch
        |
        v
server health ok? ------------ no --> not done
        |
       yes
        |
        v
channel runtime started? ------ no --> not done
        |
       yes
        |
        v
no crash/restart in log? ------ no --> file/fix separately before done
        |
       yes
        |
        v
same-turn external proof? ----- no --> not done
```

8. Stop when any row is missing. A partially proved channel path is still not
   done, even if the external provider already received a reply.

## Required Channel Review Packet

Every channel-impacting issue or PR must include this packet before merge,
relaunch signoff, or "done":

```text
Channel Critical Review Packet
- Owner:
- Classification: channel-impacting yes/no
- Reason:
- Change type: inbound / outbound / transcript-ui / runtime-session / provider-runtime
- Same-turn external peer:
- Same-turn conversationId:
- Same-turn assistant reply text:
- Critical-path inventory:
  - provider adapter/runtime:
  - channel binding:
  - surface binding/sessionKey:
  - channel ingest route:
  - conversation runtime:
  - runtime session state:
  - provider adapter event schema:
  - transcript storage/windowing:
  - message projection:
  - outbound reply dispatch:
  - read model/websocket:
  - visible desktop transcript:
  - visible mobile transcript:
  - copy/export:
  - delivery status:
- Relaunch/runtime health:
  - /api/health version:
  - launch log inspected:
  - unhandled rejection/crash restart present:
  - channel adapter startup result:
- Tests:
- Manual/live evidence:
- Blocked or not-applicable rows with reason:
```

If the packet cannot be filled with source-backed or live evidence, the change
is not done. Do not replace missing evidence with confidence, screenshots from
another conversation, or logs from a different assistant turn.

## Required Review

0. First decide whether the change is channel-impacting. Do not use directory
   path as the only signal. Treat the change as channel-impacting when it
   touches any of these shared paths used by external conversations:
   - session create/start/resume/pause/stop, provider context, provider auth, or
     session state persistence.
   - conversation message send, queue, read models, websocket replay, or
     `lastMessageAt` ordering.
   - transcript event shape, event scanners, message projection, replay
     projection, or history compaction.
   - shared chat rendering, Markdown rendering, copy/export, desktop chat, or
     mobile chat.
   - channel settings UI, account binding, surface binding, policy gates, or
     provider adapter send/receive.

   If any bullet applies, run this playbook. If the answer is "not channel
   impacting", write the reason in the issue or PR so the skipped gate is
   auditable.

1. Classify the change.
   - inbound: provider event, auth, policy, resolver, surface binding, or
     conversation creation/resume.
   - outbound: automatic reply extraction, delivery status, dispatcher,
     provider adapter `send`, or policy gate.
   - transcript/UI: message projection, `/api/conversations/:id/messages`,
     websocket replay, `SessionMessageList`, markdown rendering, copy/export,
     or mobile/desktop chat surfaces.

2. Inspect the whole affected path, not only the file changed.
   - provider adapter: `apps/herd/modules/channels/<provider>/adapter.ts`
   - shared channel runtime: `apps/herd/modules/channels/runtime.ts`
   - account/surface resolution: `apps/herd/modules/channels/resolver.ts`,
     `apps/herd/modules/channels/surface-binding-store.ts`
   - commander routes: `apps/herd/modules/commanders/routes/register-conversations.ts`,
     `apps/herd/modules/commanders/routes/conversation-runtime.ts`,
     `apps/herd/modules/commanders/routes/context.ts`
   - outbound dispatch: `apps/herd/modules/commanders/channel-dispatchers.ts`
   - projection/rendering: `apps/herd/modules/agents/messages/history.ts`,
     `apps/herd/modules/agents/components/session-message-list/blocks.tsx`
   - channel settings UI: `apps/herd/modules/channels/page.tsx`,
     `apps/herd/modules/channels/hooks/useChannels.ts`

3. Run the critical review inventory. Every channel-impacting change must
   explicitly answer each row before it is declared done.

| Area | Review question | Evidence |
|---|---|---|
| Provider adapter/runtime | Does the provider account start, receive inbound events, normalize payloads, and expose send failures? | Adapter/runtime test or live provider log. |
| Surface resolution | Does account binding choose the commander, and does surface binding choose the exact conversation? | Resolver/surface-binding test with `sessionKey`, `channelMeta`, and `lastRoute`. |
| Conversation runtime | Is the user message sent to the right provider session after create, resume, and reload? | Route/runtime test and `/api/conversations/:id` response. |
| Event schema | Are all raw event scanners compatible with the actual emitted schema? | Search for legacy event names and add tests for schema-v2 transcript envelopes. |
| Provider turn sequencing | Does reply forwarding handle Claude/Codex differences between `clientSendId`, provider `turnId`, and Codex `turn/steer`? | Conversation-runtime tests for no-`turnId` user envelopes, later provider `turnId`, and active-turn steering. |
| Transcript projection | Does `mapStreamEventsToMessages` produce the assistant text from the same events the forwarder sees? | `/api/conversations/:id/messages` or history test. |
| Automatic outbound | Does the assistant reply extraction call `dispatchCommanderChannelReply` once, with the exact final text, after recording a durable intent? | Conversation-runtime test that asserts dispatcher input and `channelReplyIntent` settlement. |
| Delivery status | Do pending, delivered, and failed `channelReplyDelivery` and `channelReplyIntents` persist and render coherently, including missed subscribers, interrupted sends, concurrent replies, and orphan pending slots? | Route/read-model test for success and failure plus conversation-runtime edge-case regressions. |
| External provider | Did the provider receive the exact assistant text, not just any message? | Live provider check or adapter send assertion. |
| Visible UI | Does desktop and mobile Command Room visibly show the same assistant text? | Screenshot/manual check or component regression. |
| Copy/export | Does copied/exported text preserve the raw assistant text? | UI/manual check when rendering is touched. |

4. Search for hidden coupling before editing. This is required whenever the
   change touches transcript shape, event names, channel metadata, or reply
   dispatch.

```bash
rg -n "message_start|message_delta|result|message\\.start|message\\.delta|turn\\.end|isTranscriptEnvelope|mapStreamEventsToMessages|channelReply|dispatchCommanderChannelReply|dispatchChannelReply|channelMeta|lastRoute|surfaceBinding|sessionKey" \
  apps/herd/modules/channels \
  apps/herd/modules/commanders \
  apps/herd/modules/agents \
  apps/herd/src
```

Legacy event names in a channel path are not automatically wrong, but they are
a review trigger. If production emits transcript envelopes, the code must either
support envelopes directly or operate on canonical messages.

Also review provider turn sequencing before touching automatic channel replies.
Claude and Codex both synthesize visible user envelopes with `clientSendId` and
no `turnId`; Codex later emits protocol `turnId` on provider events and may send
via `turn/steer` when `activeTurnId` exists. Do not require the user envelope to
carry provider `turnId`, and do not spend bootstrap skip counters on the
client-send-armed channel turn. See
`apps/herd/.dev/learnings/2026-06-24-claude-codex-channel-turn-sequencing.md`.

5. Prove every observable surface.

```text
                raw text exists?
                      |
                      v
external provider receives it? ---- no --> not done
                      |
                     yes
                      |
                      v
Command Room visibly renders it? -- no --> not done
                      |
                     yes
                      |
                      v
copy/export preserves raw text? --- no --> not done
                      |
                     yes
                      |
                      v
delivery status + route metadata coherent? -- no --> not done
```

6. Include adversarial transcript content in tests or manual checks.
   - short numeric answer with punctuation: `2026.`
   - markdown-like plain text: `1.`, `1)`, `#`, `*`
   - multiline ordered list: `1. item`
   - short final answer after thinking/tool events.

7. Add regression at the lowest layer that failed.
   - transport/adapter bug: channel adapter or route test.
   - routing/state bug: resolver, conversation runtime, or read-model test.
   - projection bug: `modules/agents/messages/__tests__/history.test.ts`.
   - visible rendering bug: `modules/agents/components/session-message-list/__tests__/blocks.test.tsx`.
   - transcript ordering/windowing bug:
     `modules/agents/messages/__tests__/canonical-timeline.test.ts` and a
     route/read-model test when `/api/conversations/:id/messages` is affected.

8. Run the `Channels And External Conversation Surfaces` bundle from
   `apps/herd/.dev/VERIFY.md`. If the change also touches Command Room
   state or responsive layout, run the Command Room or Mobile/Desktop UI bundle
   too.

9. For production relaunches, collect runtime-health evidence from the active
   launch. Check for channel adapter startup and crash loops in the current log
   directory before saying the channel path is healthy. Treat these as separate
   from ordinary API health:

```bash
curl -fsS http://127.0.0.1:20001/api/health
rg -n "Unhandled rejection|\\[CRASH\\]|Baileys|whatsapp|adapter|auth|restart" \
  operations/logs/server/herd/<current-launch> \
  ~/.herd 2>/dev/null
```

The exact log path may differ by deploy. The rule is stable: inspect the log
from the process that is currently serving traffic, not an older successful
run.

## Stop-The-Line Rules

Do not ship or merge a channel-impacting fix when any of these are true:

- The PR/issue does not state whether the change is channel-impacting and why.
- The change touches session resume, queue/send, transcript projection, or
  shared chat rendering but only ran the local module test bundle.
- The fix only proves logs, transcript JSONL, or provider delivery.
- The fix touches event shape, transcript normalization, or message projection
  without a schema-v2 transcript-envelope regression.
- The fix touches automatic reply correlation without testing provider
  sequencing differences: Claude-style no-`turnId` user envelopes, Codex
  later-`turnId` events, and Codex active-turn steering.
- The fix touches automatic replies without asserting
  `dispatchCommanderChannelReply` receives the exact final assistant text.
- The fix touches channel routing without checking `channelMeta`, `lastRoute`,
  surface binding, and `sessionKey` after resume/reload.
- The fix touches shared chat rendering without checking desktop and mobile
  visible transcript behavior.
- The evidence does not distinguish raw text, API projection, external delivery,
  visible rendering, copy/export, and delivery status.
- The evidence does not prove the same `conversationId`, same external peer,
  and same assistant reply text across transcript, API, provider delivery, and
  visible UI.
- A resume/reload path was touched but the review did not check active/no-live
  recovery, latest-message ordering, and delivery status after relaunch.
- Production was relaunched but no one inspected the active launch log for
  unhandled rejections, channel adapter startup failures, provider auth errors,
  or crash restarts.

## Evidence Template

Paste this into the issue or PR before declaring done:

```text
Channel Impact Review
- Owner:
- Classification:
- Reason:
- Provider/account:
- Surface binding/sessionKey:
- Conversation route/read model:
- Session start/resume/send:
- Event schema checked:
- Transcript projection:
- Automatic reply dispatch:
- Delivery status:
- External provider result:
- Desktop visible transcript:
- Mobile visible transcript:
- Copy/export:
- Relaunch/runtime health:
- Same-turn evidence:
- Tests:
- Manual/live checks:
```

## Done Means

- Inbound external message resolves to the expected commander conversation.
- Assistant response is present in transcript storage and projected message API.
- External provider receives the exact reply text.
- Command Room desktop visibly renders the same reply text.
- Mobile Command Room is checked when shared chat rendering or mobile surfaces
  are touched.
- Copy/export preserves raw text.
- `channelMeta`, `lastRoute`, surface binding, and `channelReplyDelivery` remain
  coherent after resume/reload.

Do not declare a channel fix done after only checking logs, transcript JSONL,
or external-provider delivery.
