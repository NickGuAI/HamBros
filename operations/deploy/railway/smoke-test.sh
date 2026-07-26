#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
APP_PATH="apps/herd"
IMAGE="${HERD_RAILWAY_SMOKE_IMAGE:-herd-railway-smoke:${GITHUB_SHA:-local}}"
RUN_ID="${GITHUB_RUN_ID:-local}-$$"
VOLUME="herd-railway-smoke-${RUN_ID}"
UPGRADE_VOLUME="herd-railway-upgrade-${RUN_ID}"
FIRST_CONTAINER="herd-railway-smoke-first-${RUN_ID}"
SECOND_CONTAINER="herd-railway-smoke-second-${RUN_ID}"
UPGRADE_CONTAINER="herd-railway-smoke-upgrade-${RUN_ID}"
WORK_DIR=""
BOOTSTRAP_KEY=""
PERMANENT_KEY=""
BUILD_CONTEXT_SENTINEL=""
BUILD_CONTEXT_SENTINEL_RELATIVE_PATH=""
BUILD_CONTEXT_SENTINEL_TOKEN=""
BUILD_CONTEXT_SENTINEL_DATA_DIR_CREATED=0
BUILD_CONTEXT_ENV_SENTINEL=""
BUILD_CONTEXT_ENV_SENTINEL_RELATIVE_PATH=""
BUILD_CONTEXT_ENV_SENTINEL_TOKEN=""
FOUNDER_REQUEST=""

log() {
  printf '[railway-smoke] %s\n' "$*"
}

fail() {
  printf '[railway-smoke] ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}

redacted_logs() {
  local container="$1"
  local logs
  logs="$(docker logs "$container" 2>&1 || true)"
  printf '%s\n' "$logs" \
    | sed \
      -e "s|${BOOTSTRAP_KEY:-__NO_BOOTSTRAP_KEY__}|[REDACTED_BOOTSTRAP_KEY]|g" \
      -e "s|${PERMANENT_KEY:-__NO_PERMANENT_KEY__}|[REDACTED_PERMANENT_KEY]|g" \
      -e "s|${BUILD_CONTEXT_SENTINEL_TOKEN:-__NO_BUILD_CONTEXT_SENTINEL__}|[REDACTED_BUILD_CONTEXT_SENTINEL]|g" \
      -e "s|${BUILD_CONTEXT_ENV_SENTINEL_TOKEN:-__NO_BUILD_CONTEXT_ENV_SENTINEL__}|[REDACTED_BUILD_CONTEXT_ENV_SENTINEL]|g"
}

cleanup() {
  docker rm -f "$FIRST_CONTAINER" "$SECOND_CONTAINER" "$UPGRADE_CONTAINER" >/dev/null 2>&1 || true
  docker volume rm -f "$VOLUME" "$UPGRADE_VOLUME" >/dev/null 2>&1 || true
  if [[ -n "$BUILD_CONTEXT_SENTINEL" ]]; then
    rm -f -- "$BUILD_CONTEXT_SENTINEL"
  fi
  if [[ -n "$BUILD_CONTEXT_ENV_SENTINEL" ]]; then
    rm -f -- "$BUILD_CONTEXT_ENV_SENTINEL"
  fi
  if [[ "$BUILD_CONTEXT_SENTINEL_DATA_DIR_CREATED" == "1" ]]; then
    rmdir -- "$REPO_ROOT/$APP_PATH/data" >/dev/null 2>&1 || true
  fi
  if [[ -n "$WORK_DIR" ]]; then
    rm -r -- "$WORK_DIR"
  fi
}
trap cleanup EXIT

container_port() {
  local container="$1"
  local binding=""
  for _ in $(seq 1 30); do
    binding="$(docker port "$container" 20001/tcp 2>/dev/null | head -n 1 || true)"
    if [[ -n "$binding" ]]; then
      printf '%s' "${binding##*:}"
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_health() {
  local container="$1"
  local health_file="$2"
  local expected_migration_status="$3"
  local port
  port="$(container_port "$container")" || fail "could not resolve host port for $container"

  for _ in $(seq 1 120); do
    if curl -fsS --max-time 2 "http://127.0.0.1:${port}/api/health" -o "$health_file"; then
      if node - "$health_file" "$expected_migration_status" <<'NODE'
const fs = require('node:fs')

const [, , healthPath, expectedMigrationStatus] = process.argv
const health = JSON.parse(fs.readFileSync(healthPath, 'utf8'))
if (health.status !== 'ok' || health.database?.ready !== true || health.jsonStores?.ready !== true) {
  process.exit(1)
}
if (health.database.migrationStatus !== expectedMigrationStatus) {
  process.exit(1)
}
NODE
      then
        return 0
      fi
    fi

    if [[ "$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null || true)" != "true" ]]; then
      redacted_logs "$container" >&2
      fail "$container exited before becoming healthy"
    fi
    sleep 1
  done

  redacted_logs "$container" >&2
  fail "$container did not become healthy"
}

assert_secrets_absent_from_logs() {
  local container="$1"
  local logs
  local secret
  logs="$(docker logs "$container" 2>&1 || true)"
  for secret in "$BOOTSTRAP_KEY" "$PERMANENT_KEY"; do
    if [[ -n "$secret" ]] && grep -Fq -- "$secret" <<< "$logs"; then
      fail "$container logged an API credential"
    fi
  done
}

assert_runtime_failure_signatures_absent() {
  local container="$1"
  local logs
  logs="$(docker logs "$container" 2>&1 || true)"
  if grep -Eiq 'MissingAutomationSkillError|Unhandled rejection' <<< "$logs"; then
    redacted_logs "$container" >&2
    fail "$container logged a missing automation skill or unhandled rejection"
  fi
}

assert_builtin_skills_available() {
  local skill
  local skill_path
  for skill in commander-memory-cleanup context-rot-cleanup; do
    skill_path="/app/apps/herd/runtime/defaults/agent-skills/commander-ops/$skill/SKILL.md"
    docker run --rm --entrypoint sh "$IMAGE" -c 'test -s "$1"' sh "$skill_path" \
      || fail "built-in automation skill $skill is absent from the final image"
  done
}

assert_builtin_skills_resolvable() {
  local container="$1"
  local api_key="$2"
  local response_file="$WORK_DIR/skills.json"
  local port
  port="$(container_port "$container")" || fail "could not resolve host port for $container"
  curl -fsS --max-time 10 \
    -H "x-api-key: $api_key" \
    "http://127.0.0.1:${port}/api/skills" \
    -o "$response_file"
  node - "$response_file" <<'NODE'
const assert = require('node:assert/strict')
const fs = require('node:fs')

const skills = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const available = new Set(skills.map((skill) => skill.dirName))
assert.equal(available.has('commander-memory-cleanup'), true, 'skill resolver omitted commander-memory-cleanup')
assert.equal(available.has('context-rot-cleanup'), true, 'skill resolver omitted context-rot-cleanup')
NODE
}

post_founder_org() {
  local container="$1"
  local api_key="$2"
  local expected_status="$3"
  local response_file="$4"
  local port
  local status
  port="$(container_port "$container")" || fail "could not resolve host port for $container"
  status="$(curl -sS --max-time 10 \
    -o "$response_file" \
    -w '%{http_code}' \
    -X POST \
    -H "x-api-key: $api_key" \
    -H 'content-type: application/json' \
    --data-binary "@$FOUNDER_REQUEST" \
    "http://127.0.0.1:${port}/api/org")"
  if [[ "$status" != "$expected_status" ]]; then
    redacted_logs "$container" >&2
    fail "founder setup returned HTTP $status; expected $expected_status"
  fi
  node - "$response_file" <<'NODE'
const fs = require('node:fs')

const response = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
if (
  response.operator?.kind !== 'founder'
  || response.operator?.displayName !== 'Railway Smoke Founder'
  || response.operator?.email !== 'founder@railway-smoke.invalid'
  || response.orgIdentity?.name !== 'Railway Smoke Org'
  || response.nextRoute !== '/org'
) {
  throw new Error('founder setup response did not match the smoke identity contract')
}
NODE
}

post_gaia() {
  local container="$1"
  local api_key="$2"
  local expected_status="$3"
  local response_file="$4"
  local port
  local status
  port="$(container_port "$container")" || fail "could not resolve host port for $container"
  status="$(curl -sS --max-time 30 \
    -o "$response_file" \
    -w '%{http_code}' \
    -X POST \
    -H "x-api-key: $api_key" \
    -H 'content-type: application/json' \
    --data '{}' \
    "http://127.0.0.1:${port}/api/onboarding/actions/seed-gaia")"
  if [[ "$status" != "$expected_status" ]]; then
    redacted_logs "$container" >&2
    fail "Gaia install returned HTTP $status; expected $expected_status"
  fi
  node - "$response_file" <<'NODE'
const assert = require('node:assert/strict')
const fs = require('node:fs')

const response = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
assert.equal(response.gaia?.exists, true)
assert.equal(response.gaia?.displayName, 'Gaia')
assert.equal(typeof response.gaia?.commanderId, 'string')
assert.notEqual(response.gaia.commanderId.length, 0)
assert.equal(typeof response.gaia?.conversationId, 'string')
assert.notEqual(response.gaia.conversationId.length, 0)
assert.equal(response.status?.gaia?.commanderId, response.gaia.commanderId)
assert.equal(response.status?.gaia?.conversationId, response.gaia.conversationId)
NODE
}

assert_same_gaia() {
  local first_response="$1"
  local next_response="$2"
  node - "$first_response" "$next_response" <<'NODE'
const assert = require('node:assert/strict')
const fs = require('node:fs')

const first = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).gaia
const next = JSON.parse(fs.readFileSync(process.argv[3], 'utf8')).gaia
assert.equal(next.commanderId, first.commanderId, 'Gaia commander identity changed on idempotent seed')
assert.equal(next.conversationId, first.conversationId, 'Gaia conversation identity changed on idempotent seed')
NODE
}

assert_onboarding_stage() {
  local container="$1"
  local api_key="$2"
  local label="$3"
  local expected_current_step="$4"
  local expected_states="$5"
  local response_file="$WORK_DIR/onboarding-stage-${label}.json"
  local port
  port="$(container_port "$container")" || fail "could not resolve host port for $container"
  curl -fsS --max-time 10 \
    -H "x-api-key: $api_key" \
    "http://127.0.0.1:${port}/api/onboarding/status" \
    -o "$response_file"
  node - "$response_file" "$expected_current_step" "$expected_states" <<'NODE'
const assert = require('node:assert/strict')
const fs = require('node:fs')

const status = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const expectedCurrentStep = process.argv[3]
const expectedStates = JSON.parse(process.argv[4])
const expectedStepIds = [
  'instance',
  'founder-org',
  'gaia',
  'starter-workforce',
  'providers-machines',
  'credentials',
  'launch',
]
assert.equal(status.currentStepId, expectedCurrentStep)
assert.deepEqual(status.steps.map((step) => step.id), expectedStepIds)
assert.deepEqual(
  Object.fromEntries(status.steps.map((step) => [step.id, step.state])),
  expectedStates,
)
NODE
}

assert_provider_machine_unready_nonblocking() {
  local status_file="$1"
  node - "$status_file" <<'NODE'
const assert = require('node:assert/strict')
const fs = require('node:fs')

const status = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
assert.equal(status.currentStepId, 'providers-machines')
const providerMachineStep = status.steps?.find((step) => step.id === 'providers-machines')
assert.ok(providerMachineStep, 'provider/machine onboarding step is missing')
assert.equal(providerMachineStep.state, 'current')
assert.match(providerMachineStep.summary, /Connect a daemon/u)
assert.equal(status.providerExecution?.mode, 'daemon-only')
assert.equal(status.providerExecution?.hostExecutionAllowed, false)
assert.equal(status.providerExecution?.daemonRequired, true)
assert.equal(status.providerExecution?.state, 'missing')
assert.equal(status.providerExecution?.registeredDaemonCount, 0)
assert.equal(status.providerExecution?.connectedDaemonCount, 0)
assert.equal(status.providerExecution?.providerReadyDaemonCount, 0)
assert.deepEqual(status.providerExecution?.readyProviderIds, [])
const codex = status.providers?.find((provider) => provider.id === 'codex')
assert.ok(codex, 'Codex provider readiness is missing')
assert.equal(codex.installed, false)
assert.equal(codex.authConfigured, false)
assert.equal(codex.state, 'missing')
assert.equal(codex.envSourceKey, null)
const localMachine = status.machines?.find((machine) => machine.id === 'local')
assert.ok(localMachine, 'local machine readiness is missing')
assert.equal(localMachine.state, 'skipped')
assert.equal(localMachine.transport, 'local')
assert.match(localMachine.summary, /disabled.*daemon-only/u)
assert.equal(status.receipt?.machine, null)
assert.match(status.receipt?.providerSummary ?? '', /No provider ready/u)
NODE
}

assert_verified_permanent_key_pending() {
  local status_file="$1"
  node - "$status_file" <<'NODE'
const assert = require('node:assert/strict')
const fs = require('node:fs')

const status = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
assert.equal(status.credentials?.authenticatedAs, 'permanent')
assert.equal(status.credentials?.activePermanentKeyCount, 1)
assert.equal(status.credentials?.activeBootstrapKeys?.length, 1)
assert.equal(status.credentials?.canRevokeBootstrap, true)
assert.equal(status.credentials?.ready, false)
assert.equal(status.currentStepId, 'providers-machines')
NODE
}

assert_finish_receipt() {
  local finish_response="$1"
  local gaia_response="$2"
  node - "$finish_response" "$gaia_response" <<'NODE'
const assert = require('node:assert/strict')
const fs = require('node:fs')

const response = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const gaia = JSON.parse(fs.readFileSync(process.argv[3], 'utf8')).gaia
assert.equal(response.status?.currentStepId, 'providers-machines')
assert.equal(
  response.status?.steps?.find((step) => step.id === 'providers-machines')?.state,
  'current',
)
assert.equal(
  response.status?.steps?.find((step) => step.id === 'credentials')?.state,
  'complete',
)
assert.equal(
  response.status?.steps?.find((step) => step.id === 'launch')?.state,
  'pending',
)
assert.equal(response.status?.credentials?.ready, true)
assert.equal(response.status?.gaia?.commanderId, gaia.commanderId)
assert.equal(response.status?.gaia?.conversationId, gaia.conversationId)
assert.equal(response.status?.receipt?.account, 'permanent API key')
assert.equal(response.status?.receipt?.organization, 'Railway Smoke Org')
assert.equal(response.status?.receipt?.founder, 'Railway Smoke Founder')
assert.equal(response.status?.receipt?.commander, 'Gaia')
assert.equal(response.status?.receipt?.machine, null)
assert.match(response.status?.receipt?.providerSummary ?? '', /No provider ready/u)
assert.equal(typeof response.status?.receipt?.url, 'string')
assert.match(response.status.receipt.url, /\/org$/u)
const target = new URL(response.launchTarget, 'http://railway-smoke.invalid')
assert.equal(target.pathname, '/command-room')
assert.equal(target.searchParams.get('commander'), gaia.commanderId)
assert.equal(target.searchParams.get('conversation'), gaia.conversationId)
assert.equal(response.status.launchTarget, response.launchTarget)
NODE
}

assert_same_founder() {
  local first_response="$1"
  local next_response="$2"
  node - "$first_response" "$next_response" <<'NODE'
const fs = require('node:fs')

const first = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const next = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'))
if (typeof first.operator?.id !== 'string' || next.operator?.id !== first.operator.id) {
  throw new Error('founder retry changed the durable founder identity')
}
NODE
}

assert_org_readable() {
  local container="$1"
  local api_key="$2"
  local label="$3"
  local response_file="$WORK_DIR/org-${label}.json"
  local port
  port="$(container_port "$container")" || fail "could not resolve host port for $container"
  curl -fsS --max-time 10 \
    -H "x-api-key: $api_key" \
    "http://127.0.0.1:${port}/api/org" \
    -o "$response_file"
  node - "$response_file" <<'NODE'
const fs = require('node:fs')

const response = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
if (
  response.operator?.kind !== 'founder'
  || response.operator?.displayName !== 'Railway Smoke Founder'
  || response.orgIdentity?.name !== 'Railway Smoke Org'
) {
  throw new Error('org read did not preserve the founder setup projection')
}
NODE
}

assert_exact_default_automations() {
  local container="$1"
  local api_key="$2"
  local label="$3"
  local response_file="$WORK_DIR/automations-${label}.json"
  local port
  port="$(container_port "$container")" || fail "could not resolve host port for $container"
  curl -fsS --max-time 10 \
    -H "x-api-key: $api_key" \
    "http://127.0.0.1:${port}/api/automations?parentCommanderId=null" \
    -o "$response_file"
  node - "$response_file" <<'NODE'
const assert = require('node:assert/strict')
const fs = require('node:fs')

const automations = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
assert.equal(automations.length, 2, `expected exactly two operator automations, found ${automations.length}`)
assert.equal(new Set(automations.map((automation) => automation.id)).size, 2, 'default automation ids must be unique')
const byName = new Map(automations.map((automation) => [automation.name, automation]))
assert.deepEqual([...byName.keys()].sort(), ['context-hygiene', 'memory-consolidation'])
assert.deepEqual(byName.get('memory-consolidation')?.skills, ['commander-memory-cleanup'])
assert.deepEqual(byName.get('context-hygiene')?.skills, ['context-rot-cleanup'])
for (const automation of automations) {
  assert.equal(typeof automation.nextRun, 'string', `${automation.name} is not registered with the scheduler`)
  assert.equal(Number.isNaN(Date.parse(automation.nextRun)), false, `${automation.name} nextRun is not an ISO timestamp`)
  assert.equal(automation.nextScheduledAt, automation.nextRun)
}
NODE
}

post_starter_workforce() {
  local container="$1"
  local api_key="$2"
  local expected_status="$3"
  local response_file="$4"
  local port
  local status
  port="$(container_port "$container")" || fail "could not resolve host port for $container"
  status="$(curl -sS --max-time 30 \
    -o "$response_file" \
    -w '%{http_code}' \
    -X POST \
    -H "x-api-key: $api_key" \
    -H 'content-type: application/json' \
    --data '{}' \
    "http://127.0.0.1:${port}/api/onboarding/actions/seed-starter-workforce")"
  if [[ "$status" != "$expected_status" ]]; then
    redacted_logs "$container" >&2
    fail "starter workforce install returned HTTP $status; expected $expected_status"
  fi
  node - "$response_file" <<'NODE'
const assert = require('node:assert/strict')
const fs = require('node:fs')

const response = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const workforce = response.starterWorkforce
assert.equal(workforce?.complete, true)
assert.equal(workforce?.skipped, false)
assert.equal(workforce?.installedCount, 3)
assert.equal(workforce?.totalCount, 3)
assert.equal(workforce?.packages?.length, 3)
assert.deepEqual(
  workforce.packages.map((entry) => entry.packageId).sort(),
  ['engineering-manager', 'general-assistant', 'research-intelligence-analyst'],
)
assert.equal(workforce.packages.every((entry) => entry.installed === true), true)
const commanderIds = workforce.packages.map((entry) => entry.commanderId)
assert.equal(commanderIds.every((id) => typeof id === 'string' && id.length > 0), true)
assert.equal(new Set(commanderIds).size, 3)
NODE
}

assert_exact_starter_automations() {
  local container="$1"
  local api_key="$2"
  local label="$3"
  local workforce_response="$4"
  local response_file="$WORK_DIR/starter-automations-${label}.json"
  local port
  port="$(container_port "$container")" || fail "could not resolve host port for $container"
  curl -fsS --max-time 10 \
    -H "x-api-key: $api_key" \
    "http://127.0.0.1:${port}/api/automations" \
    -o "$response_file"
  node - "$response_file" "$workforce_response" <<'NODE'
const assert = require('node:assert/strict')
const fs = require('node:fs')

const automations = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const workforce = JSON.parse(fs.readFileSync(process.argv[3], 'utf8')).starterWorkforce
const expectedAutomationByTemplateId = new Map([
  ['engineering-manager:issue-triage-sweep', {
    packageId: 'engineering-manager',
    name: 'issue-triage-sweep',
  }],
  ['engineering-manager:release-drift-review', {
    packageId: 'engineering-manager',
    name: 'release-drift-review',
  }],
  ['general-assistant:daily-briefing', {
    packageId: 'general-assistant',
    name: 'daily-briefing',
  }],
  ['general-assistant:weekly-follow-up-review', {
    packageId: 'general-assistant',
    name: 'weekly-follow-up-review',
  }],
  ['research-intelligence-analyst:monthly-research-backlog-review', {
    packageId: 'research-intelligence-analyst',
    name: 'monthly-research-backlog-review',
  }],
  ['research-intelligence-analyst:weekly-research-distill', {
    packageId: 'research-intelligence-analyst',
    name: 'weekly-research-distill',
  }],
])
const canonicalPackageIds = [
  'engineering-manager',
  'general-assistant',
  'research-intelligence-analyst',
]
const expectedTemplateIds = [...expectedAutomationByTemplateId.keys()].sort()
const commanderByPackage = new Map(
  workforce.packages.map((entry) => [entry.packageId, entry.commanderId]),
)
assert.deepEqual([...commanderByPackage.keys()].sort(), [...canonicalPackageIds].sort())
const starterCommanderIds = new Set(commanderByPackage.values())
const starterAutomations = automations.filter((automation) => (
  starterCommanderIds.has(automation.parentCommanderId)
))
assert.equal(starterAutomations.length, expectedAutomationByTemplateId.size)
assert.equal(
  new Set(starterAutomations.map((automation) => automation.id)).size,
  expectedAutomationByTemplateId.size,
  'starter automation ids must be unique',
)
const starterTemplateAutomations = automations.filter((automation) => (
  typeof automation.templateId === 'string'
  && canonicalPackageIds.some((packageId) => automation.templateId.startsWith(`${packageId}:`))
))
assert.equal(
  starterTemplateAutomations.length,
  expectedAutomationByTemplateId.size,
  'unexpected extra starter-prefixed automation template',
)
assert.deepEqual(
  starterTemplateAutomations.map((automation) => automation.templateId).sort(),
  expectedTemplateIds,
  'starter automation template ids must be exact and unique',
)
assert.equal(
  new Set(starterTemplateAutomations.map((automation) => automation.templateId)).size,
  expectedAutomationByTemplateId.size,
  'each starter automation template id must appear exactly once',
)
for (const [templateId, expected] of expectedAutomationByTemplateId) {
  const matches = starterTemplateAutomations.filter((automation) => (
    automation.templateId === templateId
  ))
  assert.equal(matches.length, 1, `${templateId} must appear exactly once`)
  const automation = matches[0]
  assert.equal(
    automation.parentCommanderId,
    commanderByPackage.get(expected.packageId),
    `${templateId} has the wrong parent commander`,
  )
  assert.equal(automation.name, expected.name, `${templateId} has the wrong automation name`)
  assert.equal(automation.status, 'paused', `${templateId} must remain paused`)
  assert.equal(
    starterAutomations.some((candidate) => candidate.id === automation.id),
    true,
    `${templateId} is not owned by a starter commander`,
  )
}
NODE
}

snapshot_starter_automation_ids() {
  local automation_response="$1"
  local snapshot_file="$2"
  node - "$automation_response" "$snapshot_file" <<'NODE'
const assert = require('node:assert/strict')
const fs = require('node:fs')

const automations = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const snapshotPath = process.argv[3]
const canonicalPrefixes = [
  'engineering-manager:',
  'general-assistant:',
  'research-intelligence-analyst:',
]
const starterAutomations = automations.filter((automation) => (
  typeof automation.templateId === 'string'
  && canonicalPrefixes.some((prefix) => automation.templateId.startsWith(prefix))
))
assert.equal(starterAutomations.length, 6, 'starter automation snapshot must contain exactly six rows')
const entries = starterAutomations
  .map((automation) => {
    assert.equal(typeof automation.id, 'string', `${automation.templateId} has no durable id`)
    assert.notEqual(automation.id.length, 0, `${automation.templateId} has an empty durable id`)
    return [automation.templateId, automation.id]
  })
  .sort(([left], [right]) => left.localeCompare(right))
assert.equal(new Set(entries.map(([templateId]) => templateId)).size, 6)
assert.equal(new Set(entries.map(([, id]) => id)).size, 6)
fs.writeFileSync(snapshotPath, `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`)
NODE
}

assert_same_starter_automation_ids() {
  local snapshot_file="$1"
  local automation_response="$2"
  local label="$3"
  node - "$snapshot_file" "$automation_response" "$label" <<'NODE'
const assert = require('node:assert/strict')
const fs = require('node:fs')

const snapshot = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const automations = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'))
const label = process.argv[4]
const current = Object.fromEntries(
  Object.keys(snapshot)
    .sort()
    .map((templateId) => {
      const matches = automations.filter((automation) => automation.templateId === templateId)
      assert.equal(matches.length, 1, `${templateId} must remain unique ${label}`)
      return [templateId, matches[0].id]
    }),
)
assert.deepEqual(
  current,
  snapshot,
  `starter automation IDs changed ${label}; idempotency must not delete and recreate rows`,
)
NODE
}

assert_exact_starter_commanders() {
  local container="$1"
  local api_key="$2"
  local label="$3"
  local workforce_response="$4"
  local response_file="$WORK_DIR/starter-commanders-${label}.json"
  local port
  port="$(container_port "$container")" || fail "could not resolve host port for $container"
  curl -fsS --max-time 10 \
    -H "x-api-key: $api_key" \
    "http://127.0.0.1:${port}/api/commanders" \
    -o "$response_file"
  node - "$response_file" "$workforce_response" <<'NODE'
const assert = require('node:assert/strict')
const fs = require('node:fs')

const commanders = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const workforce = JSON.parse(fs.readFileSync(process.argv[3], 'utf8')).starterWorkforce
const canonicalPackageIds = [
  'engineering-manager',
  'general-assistant',
  'research-intelligence-analyst',
]
const expectedCommanderIds = new Map(
  workforce.packages.map((entry) => [entry.packageId, entry.commanderId]),
)
assert.deepEqual([...expectedCommanderIds.keys()].sort(), [...canonicalPackageIds].sort())
const canonicalStarterCommanders = commanders.filter((commander) => (
  canonicalPackageIds.includes(commander.templateId)
))
assert.equal(
  canonicalStarterCommanders.length,
  canonicalPackageIds.length,
  'expected no duplicate canonical starter commanders',
)
for (const packageId of canonicalPackageIds) {
  const matches = canonicalStarterCommanders.filter((commander) => (
    commander.templateId === packageId
  ))
  assert.equal(matches.length, 1, `duplicate canonical starter commanders for ${packageId}`)
  const activeMatches = matches.filter((commander) => commander.archived !== true)
  assert.equal(activeMatches.length, 1, `expected exactly one active commander for ${packageId}`)
  assert.equal(
    activeMatches[0].id,
    expectedCommanderIds.get(packageId),
    `${packageId} commander identity drifted`,
  )
}
NODE
}

assert_same_starter_workforce() {
  local first_response="$1"
  local next_response="$2"
  node - "$first_response" "$next_response" <<'NODE'
const assert = require('node:assert/strict')
const fs = require('node:fs')

const first = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).starterWorkforce
const next = JSON.parse(fs.readFileSync(process.argv[3], 'utf8')).starterWorkforce
const ids = (workforce) => Object.fromEntries(
  workforce.packages.map((entry) => [entry.packageId, entry.commanderId]),
)
assert.deepEqual(ids(next), ids(first), 'starter workforce identities changed after restart')
NODE
}

assert_persisted_starter_workforce() {
  local container="$1"
  local api_key="$2"
  local first_response="$3"
  local response_file="$4"
  local port
  port="$(container_port "$container")" || fail "could not resolve host port for $container"
  curl -fsS --max-time 10 \
    -H "x-api-key: $api_key" \
    "http://127.0.0.1:${port}/api/onboarding/status" \
    -o "$response_file"
  node - "$first_response" "$response_file" <<'NODE'
const assert = require('node:assert/strict')
const fs = require('node:fs')

const first = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).starterWorkforce
const persisted = JSON.parse(fs.readFileSync(process.argv[3], 'utf8')).starterWorkforce
assert.equal(persisted?.complete, true)
assert.equal(persisted?.skipped, false)
assert.equal(persisted?.installedCount, 3)
assert.equal(persisted?.totalCount, 3)
assert.equal(persisted?.packages?.length, 3)
const ids = (workforce) => Object.fromEntries(
  workforce.packages.map((entry) => [entry.packageId, entry.commanderId]),
)
assert.deepEqual(ids(persisted), ids(first), 'starter workforce identities changed after restart')
NODE
}

assert_bootstrap_rejected() {
  local container="$1"
  local port
  local status
  port="$(container_port "$container")" || fail "could not resolve host port for $container"
  status="$(curl -sS --max-time 5 \
    -o /dev/null \
    -w '%{http_code}' \
    -H "x-api-key: $BOOTSTRAP_KEY" \
    "http://127.0.0.1:${port}/api/auth/keys")"
  [[ "$status" == "401" ]] || fail "revoked bootstrap credential returned HTTP $status"
}

assert_finish_blocked() {
  local api_key="$1"
  local label="$2"
  local container="$3"
  local port
  local response_file="$WORK_DIR/finish-blocked-${label}.json"
  local status
  port="$(container_port "$container")" || fail "could not resolve host port for $container"
  status="$(curl -sS --max-time 5 \
    -o "$response_file" \
    -w '%{http_code}' \
    -X POST \
    -H "x-api-key: $api_key" \
    -H 'content-type: application/json' \
    --data '{}' \
    "http://127.0.0.1:${port}/api/onboarding/actions/finish")"
  [[ "$status" == "409" ]] || fail "onboarding finish returned HTTP $status before credential rotation ($label)"
  node - "$response_file" <<'NODE'
const fs = require('node:fs')

const response = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
if (response.code !== 'CREDENTIAL_LIFECYCLE_INCOMPLETE' || response.status?.credentials?.ready !== false) {
  process.exit(1)
}
NODE
}

stop_cleanly() {
  local container="$1"
  docker stop --time 30 "$container" >/dev/null
  local exit_code
  exit_code="$(docker inspect --format '{{.State.ExitCode}}' "$container")"
  [[ "$exit_code" == "0" ]] || {
    redacted_logs "$container" >&2
    fail "$container exited with status $exit_code after SIGTERM"
  }
  docker logs "$container" 2>&1 | grep -Fq 'Shutdown complete (SIGTERM)' || {
    redacted_logs "$container" >&2
    fail "$container did not report graceful SIGTERM shutdown"
  }
}

start_container() {
  local container="$1"
  local env_file="$2"
  local volume="${3:-$VOLUME}"
  docker run --detach \
    --name "$container" \
    --env-file "$env_file" \
    --mount "type=volume,src=$volume,dst=/data/.herd" \
    --publish 127.0.0.1::20001 \
    "$IMAGE" >/dev/null
}

prepare_build_context_sentinel() {
  local data_dir="$REPO_ROOT/$APP_PATH/data"

  if [[ ! -d "$data_dir" ]]; then
    mkdir -p "$data_dir"
    BUILD_CONTEXT_SENTINEL_DATA_DIR_CREATED=1
  fi

  BUILD_CONTEXT_SENTINEL_RELATIVE_PATH="$APP_PATH/data/.railway-build-context-secret-${RUN_ID}"
  BUILD_CONTEXT_SENTINEL="$REPO_ROOT/$BUILD_CONTEXT_SENTINEL_RELATIVE_PATH"
  BUILD_CONTEXT_SENTINEL_TOKEN="$(
    node -e "process.stdout.write(require('node:crypto').randomBytes(48).toString('base64url'))"
  )"
  printf '%s' "$BUILD_CONTEXT_SENTINEL_TOKEN" > "$BUILD_CONTEXT_SENTINEL"

  git -C "$REPO_ROOT" check-ignore --quiet -- "$BUILD_CONTEXT_SENTINEL_RELATIVE_PATH" \
    || fail "Railway sentinel must be ignored by Git before the image build"

  BUILD_CONTEXT_ENV_SENTINEL_RELATIVE_PATH="$APP_PATH/.railway-build-context-${RUN_ID}-env"
  BUILD_CONTEXT_ENV_SENTINEL="$REPO_ROOT/$BUILD_CONTEXT_ENV_SENTINEL_RELATIVE_PATH"
  BUILD_CONTEXT_ENV_SENTINEL_TOKEN="$(
    node -e "process.stdout.write(require('node:crypto').randomBytes(48).toString('base64url'))"
  )"
  printf '%s' "$BUILD_CONTEXT_ENV_SENTINEL_TOKEN" > "$BUILD_CONTEXT_ENV_SENTINEL"

  git -C "$REPO_ROOT" check-ignore --quiet -- "$BUILD_CONTEXT_ENV_SENTINEL_RELATIVE_PATH" \
    || fail "Railway env sentinel must be ignored by Git before the image build"
}

assert_build_context_sentinel_absent() {
  local image_archive="$WORK_DIR/railway-image.tar"
  local image_path
  local sentinel_relative_path
  local sentinel_token

  for sentinel_relative_path in \
    "$BUILD_CONTEXT_SENTINEL_RELATIVE_PATH" \
    "$BUILD_CONTEXT_ENV_SENTINEL_RELATIVE_PATH"; do
    image_path="/app/$sentinel_relative_path"
    docker run --rm --entrypoint sh "$IMAGE" -c 'test ! -e "$1"' sh "$image_path" \
      || fail "Git-ignored Railway sentinel reached the final image filesystem"
  done

  docker image save --output "$image_archive" "$IMAGE"
  for sentinel_token in \
    "$BUILD_CONTEXT_SENTINEL_TOKEN" \
    "$BUILD_CONTEXT_ENV_SENTINEL_TOKEN"; do
    if grep -aFq -- "$sentinel_token" "$image_archive"; then
      fail "Git-ignored Railway sentinel reached a saved production-image layer"
    fi
  done
}

require_command docker
require_command curl
require_command git
require_command node

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/herd-railway-smoke.XXXXXX")"
prepare_build_context_sentinel
BOOTSTRAP_KEY="$(node -e "process.stdout.write(require('node:crypto').randomBytes(48).toString('base64url'))")"
ENV_FILE="$WORK_DIR/runtime.env"
FOUNDER_REQUEST="$WORK_DIR/founder-request.json"
umask 077
printf '%s\n' \
  'PORT=20001' \
  'HERD_DATA_DIR=/data/.herd' \
  "HERD_BOOTSTRAP_MASTER_KEY=$BOOTSTRAP_KEY" \
  > "$ENV_FILE"
printf '%s\n' \
  '{"displayName":"Railway Smoke Org","founder":{"displayName":"Railway Smoke Founder","email":"founder@railway-smoke.invalid"}}' \
  > "$FOUNDER_REQUEST"

log "building exact production image"
docker build --progress plain --file "$REPO_ROOT/$APP_PATH/Dockerfile" --tag "$IMAGE" "$REPO_ROOT"
assert_build_context_sentinel_absent
assert_builtin_skills_available

node - "$(docker image inspect --format '{{json .Config.Entrypoint}}' "$IMAGE")" \
  "$(docker image inspect --format '{{json .Config.Cmd}}' "$IMAGE")" \
  "$(docker image inspect --format '{{json .Config.Env}}' "$IMAGE")" <<'NODE'
const assert = require('node:assert/strict')

const [, , entrypointJson, commandJson, environmentJson] = process.argv
assert.deepEqual(JSON.parse(entrypointJson), ['/sbin/tini', '-g', '--'])
assert.deepEqual(JSON.parse(commandJson), ['node', 'dist-server/server/index.js'])
const environment = JSON.parse(environmentJson)
const staleProviderExecutionMode = [
  'HAMMU',
  'RABI_PROVIDER_EXECUTION_MODE=daemon-only',
].join('')
assert.ok(environment.includes('HERD_DATA_DIR=/data/.herd'))
assert.ok(environment.includes('HERD_PROVIDER_EXECUTION_MODE=daemon-only'))
assert.ok(!environment.includes(staleProviderExecutionMode))
NODE

docker run --rm --entrypoint sh "$IMAGE" -c '
  test "$HERD_PROVIDER_EXECUTION_MODE" = daemon-only
  if command -v codex >/dev/null 2>&1; then
    exit 1
  fi
' || fail "production image must use daemon-only execution without a bundled Codex CLI"

docker volume create "$VOLUME" >/dev/null

log "starting a fresh volume"
start_container "$FIRST_CONTAINER" "$ENV_FILE"
wait_for_health "$FIRST_CONTAINER" "$WORK_DIR/health-first.json" 'fresh-initialized'
assert_secrets_absent_from_logs "$FIRST_CONTAINER"

FIRST_PORT="$(container_port "$FIRST_CONTAINER")"
assert_onboarding_stage \
  "$FIRST_CONTAINER" \
  "$BOOTSTRAP_KEY" \
  'fresh-instance' \
  'founder-org' \
  '{"instance":"complete","founder-org":"current","gaia":"pending","starter-workforce":"pending","providers-machines":"pending","credentials":"pending","launch":"pending"}'
assert_finish_blocked "$BOOTSTRAP_KEY" 'bootstrap-only' "$FIRST_CONTAINER"
assert_builtin_skills_resolvable "$FIRST_CONTAINER" "$BOOTSTRAP_KEY"

FIRST_FOUNDER_RESPONSE="$WORK_DIR/founder-first.json"
FIRST_FOUNDER_RETRY_RESPONSE="$WORK_DIR/founder-first-retry.json"
post_founder_org "$FIRST_CONTAINER" "$BOOTSTRAP_KEY" '201' "$FIRST_FOUNDER_RESPONSE"
assert_exact_default_automations "$FIRST_CONTAINER" "$BOOTSTRAP_KEY" 'first'
assert_onboarding_stage \
  "$FIRST_CONTAINER" \
  "$BOOTSTRAP_KEY" \
  'founder-complete' \
  'gaia' \
  '{"instance":"complete","founder-org":"complete","gaia":"current","starter-workforce":"pending","providers-machines":"pending","credentials":"pending","launch":"pending"}'
post_founder_org "$FIRST_CONTAINER" "$BOOTSTRAP_KEY" '200' "$FIRST_FOUNDER_RETRY_RESPONSE"
assert_same_founder "$FIRST_FOUNDER_RESPONSE" "$FIRST_FOUNDER_RETRY_RESPONSE"
assert_exact_default_automations "$FIRST_CONTAINER" "$BOOTSTRAP_KEY" 'first-retry'
FIRST_GAIA_RESPONSE="$WORK_DIR/gaia-first.json"
FIRST_GAIA_RETRY_RESPONSE="$WORK_DIR/gaia-first-retry.json"
post_gaia "$FIRST_CONTAINER" "$BOOTSTRAP_KEY" '201' "$FIRST_GAIA_RESPONSE"
post_gaia "$FIRST_CONTAINER" "$BOOTSTRAP_KEY" '200' "$FIRST_GAIA_RETRY_RESPONSE"
assert_same_gaia "$FIRST_GAIA_RESPONSE" "$FIRST_GAIA_RETRY_RESPONSE"
assert_org_readable "$FIRST_CONTAINER" "$BOOTSTRAP_KEY" 'first-after-gaia'
assert_onboarding_stage \
  "$FIRST_CONTAINER" \
  "$BOOTSTRAP_KEY" \
  'gaia-complete' \
  'starter-workforce' \
  '{"instance":"complete","founder-org":"complete","gaia":"complete","starter-workforce":"current","providers-machines":"pending","credentials":"pending","launch":"pending"}'
FIRST_STARTER_RESPONSE="$WORK_DIR/starter-first.json"
post_starter_workforce "$FIRST_CONTAINER" "$BOOTSTRAP_KEY" '201' "$FIRST_STARTER_RESPONSE"
assert_onboarding_stage \
  "$FIRST_CONTAINER" \
  "$BOOTSTRAP_KEY" \
  'starter-complete' \
  'providers-machines' \
  '{"instance":"complete","founder-org":"complete","gaia":"complete","starter-workforce":"complete","providers-machines":"current","credentials":"pending","launch":"pending"}'
assert_provider_machine_unready_nonblocking "$WORK_DIR/onboarding-stage-starter-complete.json"
assert_exact_starter_commanders "$FIRST_CONTAINER" "$BOOTSTRAP_KEY" 'first' "$FIRST_STARTER_RESPONSE"
assert_exact_starter_automations "$FIRST_CONTAINER" "$BOOTSTRAP_KEY" 'first' "$FIRST_STARTER_RESPONSE"
STARTER_AUTOMATION_ID_SNAPSHOT="$WORK_DIR/starter-automation-id-snapshot.json"
snapshot_starter_automation_ids \
  "$WORK_DIR/starter-automations-first.json" \
  "$STARTER_AUTOMATION_ID_SNAPSHOT"
wait_for_health "$FIRST_CONTAINER" "$WORK_DIR/health-first-after-founder.json" 'fresh-initialized'
assert_runtime_failure_signatures_absent "$FIRST_CONTAINER"

# Step 6: create and verify the permanent credential after the starter workforce.
# Provider and machine readiness intentionally remain an unready, nonblocking
# onboarding step until an external provider-ready daemon connects.
SCOPE_CATALOG="$WORK_DIR/api-key-scopes.json"
PERMANENT_REQUEST="$WORK_DIR/permanent-key-request.json"
curl -fsS --max-time 5 \
  -H "x-api-key: $BOOTSTRAP_KEY" \
  "http://127.0.0.1:${FIRST_PORT}/api/auth/scopes" \
  -o "$SCOPE_CATALOG"
node - "$SCOPE_CATALOG" "$PERMANENT_REQUEST" <<'NODE'
const fs = require('node:fs')

const [, , catalogPath, requestPath] = process.argv
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'))
if (!Array.isArray(catalog.defaultBootstrapScopes) || catalog.defaultBootstrapScopes.length === 0) {
  throw new Error('API key scope catalog did not expose defaultBootstrapScopes')
}
fs.writeFileSync(requestPath, JSON.stringify({
  name: 'Railway Persistence Smoke',
  scopes: catalog.defaultBootstrapScopes,
}))
NODE
PERMANENT_RESPONSE="$WORK_DIR/permanent-key.json"
curl -fsS --max-time 5 \
  -H "x-api-key: $BOOTSTRAP_KEY" \
  -H 'content-type: application/json' \
  --data-binary "@$PERMANENT_REQUEST" \
  "http://127.0.0.1:${FIRST_PORT}/api/auth/keys" \
  -o "$PERMANENT_RESPONSE"
PERMANENT_KEY="$(node - "$PERMANENT_RESPONSE" <<'NODE'
const fs = require('node:fs')

const response = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
if (typeof response.key !== 'string' || response.key.length < 20) {
  process.exit(1)
}
if (response.purpose !== 'permanent') {
  throw new Error('created API key did not declare permanent purpose')
}
process.stdout.write(response.key)
NODE
)"
assert_onboarding_stage \
  "$FIRST_CONTAINER" \
  "$PERMANENT_KEY" \
  'permanent-key-verified' \
  'providers-machines' \
  '{"instance":"complete","founder-org":"complete","gaia":"complete","starter-workforce":"complete","providers-machines":"current","credentials":"pending","launch":"pending"}'
assert_verified_permanent_key_pending "$WORK_DIR/onboarding-stage-permanent-key-verified.json"
assert_finish_blocked "$PERMANENT_KEY" 'bootstrap-still-active' "$FIRST_CONTAINER"

KEY_LIST="$WORK_DIR/keys-before-restart.json"
curl -fsS --max-time 5 \
  -H "x-api-key: $PERMANENT_KEY" \
  "http://127.0.0.1:${FIRST_PORT}/api/auth/keys" \
  -o "$KEY_LIST"
BOOTSTRAP_KEY_ID="$(node - "$KEY_LIST" <<'NODE'
const fs = require('node:fs')

const keys = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const bootstrap = keys.find((key) => key.purpose === 'bootstrap')
if (!bootstrap || typeof bootstrap.id !== 'string') {
  process.exit(1)
}
process.stdout.write(bootstrap.id)
NODE
)"
curl -fsS --max-time 5 \
  -X DELETE \
  -H "x-api-key: $PERMANENT_KEY" \
  "http://127.0.0.1:${FIRST_PORT}/api/auth/keys/${BOOTSTRAP_KEY_ID}" \
  -o /dev/null
assert_bootstrap_rejected "$FIRST_CONTAINER"
assert_onboarding_stage \
  "$FIRST_CONTAINER" \
  "$PERMANENT_KEY" \
  'credentials-complete' \
  'providers-machines' \
  '{"instance":"complete","founder-org":"complete","gaia":"complete","starter-workforce":"complete","providers-machines":"current","credentials":"complete","launch":"pending"}'

FINISH_RESPONSE="$WORK_DIR/finish-ready.json"
curl -fsS --max-time 5 \
  -X POST \
  -H "x-api-key: $PERMANENT_KEY" \
  -H 'content-type: application/json' \
  --data '{}' \
  "http://127.0.0.1:${FIRST_PORT}/api/onboarding/actions/finish" \
  -o "$FINISH_RESPONSE"
assert_finish_receipt "$FINISH_RESPONSE" "$FIRST_GAIA_RESPONSE"

log "stopping through tini"
stop_cleanly "$FIRST_CONTAINER"
assert_secrets_absent_from_logs "$FIRST_CONTAINER"
assert_runtime_failure_signatures_absent "$FIRST_CONTAINER"

log "restarting with the same volume and unchanged bootstrap variable"
start_container "$SECOND_CONTAINER" "$ENV_FILE"
wait_for_health "$SECOND_CONTAINER" "$WORK_DIR/health-second.json" 'ready'
assert_secrets_absent_from_logs "$SECOND_CONTAINER"
assert_bootstrap_rejected "$SECOND_CONTAINER"
assert_onboarding_stage \
  "$SECOND_CONTAINER" \
  "$PERMANENT_KEY" \
  'restart-complete' \
  'providers-machines' \
  '{"instance":"complete","founder-org":"complete","gaia":"complete","starter-workforce":"complete","providers-machines":"current","credentials":"complete","launch":"pending"}'
assert_same_gaia "$FIRST_GAIA_RESPONSE" "$WORK_DIR/onboarding-stage-restart-complete.json"
assert_provider_machine_unready_nonblocking "$WORK_DIR/onboarding-stage-restart-complete.json"

SECOND_PORT="$(container_port "$SECOND_CONTAINER")"
KEY_LIST_AFTER_RESTART="$WORK_DIR/keys-after-restart.json"
curl -fsS --max-time 5 \
  -H "x-api-key: $PERMANENT_KEY" \
  "http://127.0.0.1:${SECOND_PORT}/api/auth/keys" \
  -o "$KEY_LIST_AFTER_RESTART"
node - "$KEY_LIST_AFTER_RESTART" <<'NODE'
const fs = require('node:fs')

const keys = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
if (!keys.some((key) => key.name === 'Railway Persistence Smoke' && key.purpose === 'permanent')) {
  throw new Error('permanent API key did not survive the volume restart')
}
if (keys.some((key) => key.purpose === 'bootstrap')) {
  throw new Error('revoked bootstrap key was recreated while a permanent key existed')
}
NODE

SECOND_FOUNDER_RESPONSE="$WORK_DIR/founder-second.json"
assert_org_readable "$SECOND_CONTAINER" "$PERMANENT_KEY" 'second'
post_founder_org "$SECOND_CONTAINER" "$PERMANENT_KEY" '200' "$SECOND_FOUNDER_RESPONSE"
assert_same_founder "$FIRST_FOUNDER_RESPONSE" "$SECOND_FOUNDER_RESPONSE"
assert_exact_default_automations "$SECOND_CONTAINER" "$PERMANENT_KEY" 'second'
PERSISTED_STARTER_STATUS="$WORK_DIR/starter-status-second-before-retry.json"
assert_persisted_starter_workforce "$SECOND_CONTAINER" "$PERMANENT_KEY" "$FIRST_STARTER_RESPONSE" "$PERSISTED_STARTER_STATUS"
assert_exact_starter_commanders "$SECOND_CONTAINER" "$PERMANENT_KEY" 'second-before-retry' "$FIRST_STARTER_RESPONSE"
assert_exact_starter_automations "$SECOND_CONTAINER" "$PERMANENT_KEY" 'second-before-retry' "$FIRST_STARTER_RESPONSE"
assert_same_starter_automation_ids \
  "$STARTER_AUTOMATION_ID_SNAPSHOT" \
  "$WORK_DIR/starter-automations-second-before-retry.json" \
  'after restart before retry'
SECOND_STARTER_RESPONSE="$WORK_DIR/starter-second.json"
post_starter_workforce "$SECOND_CONTAINER" "$PERMANENT_KEY" '200' "$SECOND_STARTER_RESPONSE"
assert_same_starter_workforce "$FIRST_STARTER_RESPONSE" "$SECOND_STARTER_RESPONSE"
assert_exact_starter_commanders "$SECOND_CONTAINER" "$PERMANENT_KEY" 'second' "$SECOND_STARTER_RESPONSE"
assert_exact_starter_automations "$SECOND_CONTAINER" "$PERMANENT_KEY" 'second' "$SECOND_STARTER_RESPONSE"
assert_same_starter_automation_ids \
  "$STARTER_AUTOMATION_ID_SNAPSHOT" \
  "$WORK_DIR/starter-automations-second.json" \
  'after idempotency POST'
wait_for_health "$SECOND_CONTAINER" "$WORK_DIR/health-second-after-founder.json" 'ready'
assert_runtime_failure_signatures_absent "$SECOND_CONTAINER"

stop_cleanly "$SECOND_CONTAINER"
assert_secrets_absent_from_logs "$SECOND_CONTAINER"
assert_runtime_failure_signatures_absent "$SECOND_CONTAINER"

log "seeding the previous SQLite schema"
docker volume create "$UPGRADE_VOLUME" >/dev/null
docker run --rm \
  --interactive \
  --entrypoint node \
  --mount "type=volume,src=$UPGRADE_VOLUME,dst=/data/.herd" \
  "$IMAGE" - <<'NODE'
const { DatabaseSync } = require('node:sqlite')

const db = new DatabaseSync('/data/.herd/herd.sqlite')
db.exec(`
  CREATE TABLE schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  );
  INSERT INTO schema_migrations (version, applied_at)
    VALUES ('001_agent_runtime_sessions', '2026-01-01T00:00:00.000Z');
  CREATE TABLE agent_runtime_sessions (
    name TEXT PRIMARY KEY,
    session_type TEXT NOT NULL,
    creator_kind TEXT NOT NULL,
    creator_id TEXT,
    conversation_id TEXT,
    spawned_by TEXT,
    transport_type TEXT NOT NULL DEFAULT 'stream',
    machine_id TEXT NOT NULL DEFAULT 'local',
    state TEXT NOT NULL,
    provider TEXT NOT NULL,
    provider_resume_json TEXT NOT NULL,
    cwd TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT
  );
  INSERT INTO agent_runtime_sessions (
    name, session_type, creator_kind, state, provider,
    provider_resume_json, cwd, created_at, updated_at
  ) VALUES (
    'railway-upgrade-fixture', 'commander', 'human', 'paused', 'codex',
    '{"providerId":"codex","threadId":"railway-v1"}', '/workspace',
    '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
  );
`)
db.close()
NODE

log "starting from the previous SQLite schema"
start_container "$UPGRADE_CONTAINER" "$ENV_FILE" "$UPGRADE_VOLUME"
wait_for_health "$UPGRADE_CONTAINER" "$WORK_DIR/health-upgrade.json" 'migrated'
assert_secrets_absent_from_logs "$UPGRADE_CONTAINER"
assert_runtime_failure_signatures_absent "$UPGRADE_CONTAINER"
stop_cleanly "$UPGRADE_CONTAINER"

docker run --rm \
  --interactive \
  --entrypoint node \
  --mount "type=volume,src=$UPGRADE_VOLUME,dst=/data/.herd" \
  "$IMAGE" - <<'NODE'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { DatabaseSync } = require('node:sqlite')

const root = '/data/.herd'
const dbPath = `${root}/herd.sqlite`
const backups = fs.readdirSync(root).filter((name) => name.startsWith('herd.sqlite.bak.'))
assert.equal(backups.length, 1, `expected one pre-migration backup, found ${backups.length}`)

const backup = new DatabaseSync(`${root}/${backups[0]}`, { readOnly: true })
const backupVersions = backup.prepare('SELECT version FROM schema_migrations ORDER BY version')
  .all()
  .map((row) => row.version)
assert.deepEqual(backupVersions, ['001_agent_runtime_sessions'])
const backupColumns = backup.prepare('PRAGMA table_info(agent_runtime_sessions)').all().map((row) => row.name)
assert.equal(backupColumns.includes('runtime_state_json'), false)
backup.close()

const live = new DatabaseSync(dbPath, { readOnly: true })
const liveVersions = live.prepare('SELECT version FROM schema_migrations ORDER BY version')
  .all()
  .map((row) => row.version)
assert.deepEqual(liveVersions, [
  '001_agent_runtime_sessions',
  '002_agent_runtime_session_payload',
])
const row = live.prepare(`
  SELECT provider_resume_json, runtime_state_json
  FROM agent_runtime_sessions
  WHERE name = 'railway-upgrade-fixture'
`).get()
assert.equal(row.provider_resume_json, '{"providerId":"codex","threadId":"railway-v1"}')
assert.equal(row.runtime_state_json, '{}')
live.close()
NODE

log "exact image lifecycle and persistence smoke passed"
