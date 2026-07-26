#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LEAK_COUNT=0
EXPECTED_LICENSE="AGPL-3.0-only"
EXPECTED_AGPL_SHA256="0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0"

# Token splits below keep the release rename/sanitize passes from rewriting
# this scanner's own pattern strings (HERD_->HERD_, commander-name map,
# Herd->Herd would otherwise invert these gates in the shipped artifact).

red() { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }

read_release_version() {
  node - "$ROOT/package.json" <<'NODE'
const fs = require('node:fs')

const [, , manifestPath] = process.argv
const semverPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

try {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (typeof manifest.version !== 'string' || !semverPattern.test(manifest.version)) {
    process.exit(1)
  }
  process.stdout.write(manifest.version)
} catch {
  process.exit(1)
}
NODE
}

required_paths=(
  "README.md"
  "CHANGELOG.md"
  "CLA.md"
  "COMMERCIAL-LICENSE.md"
  "CONTRIBUTING.md"
  "LICENSE"
  "NOTICE"
  "RELEASE_NOTES.md"
  "SECURITY.md"
  "install.sh"
  "package.json"
  "docs"
  "docs/llms.txt"
  "docs/getting-started/quickstart.md"
  "apps/herd"
  "apps/herd/.env.example"
  "apps/herd/Dockerfile"
  "apps/herd/Dockerfile.dockerignore"
  "apps/herd/install.sh"
  "apps/herd/package.json"
  "apps/herd/public/install.sh"
  "apps/herd/public/repo-root/LICENSE"
  "apps/herd/railway.json"
  "apps/herd/runtime/defaults/global-rules/USER.md"
  "apps/herd/runtime/defaults/global-rules/WORKSPACE.md"
  "apps/herd/runtime/defaults/global-rules/SKILLS_INDEX.md"
  "apps/herd/runtime/defaults/agent-skills/commander-ops/commander-memory-cleanup/SKILL.md"
  "apps/herd/runtime/defaults/agent-skills/commander-ops/context-rot-cleanup/SKILL.md"
  "apps/herd/runtime/defaults/shared-knowledge/DOCTRINES.md"
  "apps/herd/runtime/defaults/shared-knowledge/COMMANDER_GUIDE.md"
  "apps/herd/runtime/defaults/shared-knowledge/LEARNINGS.md"
  "agent-skills/commander-ops/write-new-skill/SKILL.md"
  "agent-skills/commander-ops/commander-memory-cleanup/SKILL.md"
  "agent-skills/commander-ops/context-rot-cleanup/SKILL.md"
  "agent-skills/gehirn-skills/add-machine/SKILL.md"
  "agent-skills/gehirn-skills/commander-create-wizard/SKILL.md"
  "agent-skills/gehirn-skills/create-automation/SKILL.md"
  "packages/herd-cli/package.json"
  "operations/deploy/ec2/install-ec2.sh"
  "operations/deploy/ec2/herd.service"
  "operations/deploy/ec2/smoke-test.sh"
  "operations/deploy/railway/smoke-test.sh"
)

for path in "${required_paths[@]}"; do
  if [ ! -e "$ROOT/$path" ]; then
    red "missing required public artifact path: $path"
    LEAK_COUNT=$((LEAK_COUNT + 1))
  fi
done

if ! grep -Fq 'HERD_BOOTSTRAP_MASTER_KEY' "$ROOT/apps/herd/.env.example" \
  || grep -Fq 'ALLOW_DEFAULT_MASTER_KEY' "$ROOT/apps/herd/.env.example"; then
  red "public environment example does not preserve the injected, fresh-only bootstrap contract"
  LEAK_COUNT=$((LEAK_COUNT + 1))
fi

if ! node - \
  "$ROOT/apps/herd/Dockerfile" \
  "$ROOT/apps/herd/Dockerfile.dockerignore" \
  "$ROOT/apps/herd/railway.json" <<'NODE'
const fs = require('node:fs')

const [, , dockerfilePath, dockerignorePath, railwayPath] = process.argv
const dockerfile = fs.readFileSync(dockerfilePath, 'utf8')
const dockerignoreRules = fs.readFileSync(dockerignorePath, 'utf8')
  .split(/\r?\n/u)
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith('#'))
const railway = JSON.parse(fs.readFileSync(railwayPath, 'utf8'))
const requiredDockerFragments = [
  'COPY packages/transcription/package.json ./packages/transcription/package.json',
  'COPY packages/transcription ./packages/transcription',
  'COPY --from=build /workspace/packages/transcription ./packages/transcription',
  'ENV HERD_DATA_DIR=/data/.herd',
  'ENV HERD_PROVIDER_EXECUTION_MODE=daemon-only',
  'ENTRYPOINT ["/sbin/tini", "-g", "--"]',
]
if (!requiredDockerFragments.every((fragment) => dockerfile.includes(fragment))) {
  process.exit(1)
}
const requiredDockerignoreRules = [
  '.factory/**',
  '.wide-research/**',
  '.cocoindex_code/**',
  '.playwright-cli/**',
  '.worktrees/**',
  '.claude/worktrees/**',
  '.general-env',
  '.*-env',
  '**/.*-env',
  '**/.env',
  '**/.env.*',
  '**/.npmrc',
  '**/auth.json',
  '**/credentials.json',
  '**/*.pem',
  '**/*.key',
  'apps/prep/server/**',
  'shared_infras/database/**',
  '**/data',
  '**/data/**',
  '**/.herd/**',
  '**/.herd.json',
  '**/.herd.json',
  '**/*.sqlite',
  '**/*.sqlite.bak.*',
  '**/*.sqlite-*',
  '**/*.db.bak.*',
  '**/node_modules',
  '**/node_modules/**',
  '**/.pnpm-store/**',
  '**/.turbo/**',
  '**/.next/**',
  '**/dist/**',
  '**/dist-server/**',
  '**/coverage/**',
  '**/.vercel/**',
]
if (
  !requiredDockerignoreRules.every((rule) => dockerignoreRules.includes(rule))
  || dockerignoreRules.some((rule) => rule.startsWith('!'))
) {
  process.exit(1)
}
if (
  railway.build?.dockerfilePath !== '/apps/herd/Dockerfile'
  || !railway.build?.watchPatterns?.includes('/packages/transcription/**')
  || railway.deploy?.numReplicas !== 1
  || railway.deploy?.overlapSeconds !== 0
  || railway.deploy?.drainingSeconds !== 30
  || railway.deploy?.requiredMountPath !== '/data/.herd'
  || railway.deploy?.healthcheckPath !== '/api/health'
  || Object.hasOwn(railway.deploy ?? {}, 'startCommand')
) {
  process.exit(1)
}
NODE
then
  red "Railway production-image contract is incomplete or stale"
  LEAK_COUNT=$((LEAK_COUNT + 1))
fi

if ! grep -Fqx 'apps/herd/data/' "$ROOT/.gitignore" \
  || ! grep -Fqx '.*-env' "$ROOT/.gitignore"; then
  red "public repository must ignore the Railway build-context sentinel locations"
  LEAK_COUNT=$((LEAK_COUNT + 1))
fi

if [ ! -f "$ROOT/package.json" ] || ! EXPECTED_RELEASE_VERSION="$(read_release_version)"; then
  red "package.json must declare a valid semantic release version"
  LEAK_COUNT=$((LEAK_COUNT + 1))
  EXPECTED_RELEASE_VERSION="__invalid_release_version__"
fi
EXPECTED_RELEASE_TAG="v${EXPECTED_RELEASE_VERSION}"

check_manifest_metadata() {
  local manifest="$1"
  [ -f "$manifest" ] || return 0

  if ! node - "$manifest" "$EXPECTED_RELEASE_VERSION" "$EXPECTED_LICENSE" <<'NODE'
const fs = require('node:fs')

const [, , manifestPath, expectedVersion, expectedLicense] = process.argv
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
if (manifest.version !== expectedVersion || manifest.license !== expectedLicense) {
  process.exit(1)
}
NODE
  then
    red "release metadata mismatch in ${manifest#$ROOT/}: expected version $EXPECTED_RELEASE_VERSION and license $EXPECTED_LICENSE"
    LEAK_COUNT=$((LEAK_COUNT + 1))
  fi
}

check_manifest_metadata "$ROOT/package.json"
check_manifest_metadata "$ROOT/apps/herd/package.json"
check_manifest_metadata "$ROOT/packages/herd-cli/package.json"

license_paths=(
  "$ROOT/LICENSE"
  "$ROOT/apps/herd/public/repo-root/LICENSE"
)

for license_path in "${license_paths[@]}"; do
  [ -f "$license_path" ] || continue
  actual_license_sha256=""
  if command -v sha256sum >/dev/null 2>&1; then
    actual_license_sha256="$(sha256sum "$license_path" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual_license_sha256="$(shasum -a 256 "$license_path" | awk '{print $1}')"
  else
    red "cannot verify ${license_path#$ROOT/}: sha256sum or shasum is required"
    LEAK_COUNT=$((LEAK_COUNT + 1))
  fi

  if [ -n "$actual_license_sha256" ] && [ "$actual_license_sha256" != "$EXPECTED_AGPL_SHA256" ]; then
    red "${license_path#$ROOT/} is not the unmodified GNU AGPLv3 text"
    LEAK_COUNT=$((LEAK_COUNT + 1))
  fi
done

installer_paths=(
  "$ROOT/install.sh"
  "$ROOT/apps/herd/install.sh"
  "$ROOT/apps/herd/public/install.sh"
)
if [ -f "${installer_paths[0]}" ] && [ -f "${installer_paths[1]}" ] && [ -f "${installer_paths[2]}" ]; then
  if ! cmp "${installer_paths[0]}" "${installer_paths[1]}" >/dev/null || \
     ! cmp "${installer_paths[0]}" "${installer_paths[2]}" >/dev/null; then
    red "release installers are not byte-identical"
    LEAK_COUNT=$((LEAK_COUNT + 1))
  fi

  expected_legacy_installer_ref='REPO_REF="${HERD_REPO_REF:-${HERVALD_REPO_REF:-'"$EXPECTED_RELEASE_TAG"'}}"'
  expected_installer_ref='REPO_REF="${HERD_REPO_REF:-'"$EXPECTED_RELEASE_TAG"'}"'
  for installer in "${installer_paths[@]}"; do
    if ! grep -Fq "$expected_legacy_installer_ref" "$installer" \
      && ! grep -Fq "$expected_installer_ref" "$installer"; then
      red "installer is not pinned to $EXPECTED_RELEASE_TAG: ${installer#$ROOT/}"
      LEAK_COUNT=$((LEAK_COUNT + 1))
    fi
  done
fi

current_license_docs=(
  "$ROOT/README.md"
  "$ROOT/SECURITY.md"
  "$ROOT/CONTRIBUTING.md"
  "$ROOT/CLA.md"
  "$ROOT/COMMERCIAL-LICENSE.md"
  "$ROOT/RELEASE_NOTES.md"
)
old_polyform="Poly""Form"
old_source_label="source-""available"
old_noncommercial="non""commercial"
stale_license_hits="$(
  grep -nEi "$old_polyform|$old_source_label|$old_noncommercial" "${current_license_docs[@]}" 2>/dev/null \
    || true
)"
if [ -n "$stale_license_hits" ]; then
  red "stale pre-AGPL licensing language present:"
  printf '%s\n' "$stale_license_hits" | head -20 | sed "s|^$ROOT/|  |"
  LEAK_COUNT=$((LEAK_COUNT + 1))
fi

for license_doc in "$ROOT/README.md" "$ROOT/COMMERCIAL-LICENSE.md" "$ROOT/RELEASE_NOTES.md"; do
  if [ -f "$license_doc" ] && ! grep -Fq 'AGPL-3.0-only' "$license_doc"; then
    red "current license document is missing AGPL-3.0-only: ${license_doc#$ROOT/}"
    LEAK_COUNT=$((LEAK_COUNT + 1))
  fi
  if [ -f "$license_doc" ] && ! grep -Fiq 'no license purchase is required' "$license_doc"; then
    red "current license document must state that AGPL commercial use requires no license purchase: ${license_doc#$ROOT/}"
    LEAK_COUNT=$((LEAK_COUNT + 1))
  fi
  if [ -f "$license_doc" ] && ! grep -Fiq 'separate paid commercial agreement' "$license_doc"; then
    red "current license document must identify the optional paid non-AGPL agreement: ${license_doc#$ROOT/}"
    LEAK_COUNT=$((LEAK_COUNT + 1))
  fi
done

if [ -f "$ROOT/COMMERCIAL-LICENSE.md" ]; then
  if ! grep -Fiq 'permits commercial use' "$ROOT/COMMERCIAL-LICENSE.md"; then
    red "COMMERCIAL-LICENSE.md must state that the AGPL permits commercial use"
    LEAK_COUNT=$((LEAK_COUNT + 1))
  fi
  if ! grep -Fiq 'proprietary or other non-AGPL' "$ROOT/COMMERCIAL-LICENSE.md"; then
    red "COMMERCIAL-LICENSE.md must scope separate terms to proprietary or other non-AGPL use"
    LEAK_COUNT=$((LEAK_COUNT + 1))
  fi
fi

expected_commercial_license_url="https://github.com/NickGuAI/Herd/blob/${EXPECTED_RELEASE_TAG}/COMMERCIAL-LICENSE.md"
if [ -f "$ROOT/RELEASE_NOTES.md" ] \
  && ! grep -Fq "$expected_commercial_license_url" "$ROOT/RELEASE_NOTES.md"; then
  red "RELEASE_NOTES.md must use the $EXPECTED_RELEASE_TAG-pinned commercial license URL"
  LEAK_COUNT=$((LEAK_COUNT + 1))
fi

for path in \
  "apps/herd/CLAUDE.md" \
  "apps/herd/.claude" \
  "apps/herd/agents" \
  "apps/herd/data/policies" \
  "apps/herd/ios" \
  "apps/herd/modules/commanders/README.md" \
  "apps/herd/modules/policies/README.md" \
  "apps/herd/docs" \
  "apps/herd/assets" \
  "benchmarks/herd"; do
  if [ -e "$ROOT/$path" ]; then
    red "internal-only path present in public artifact: $path"
    LEAK_COUNT=$((LEAK_COUNT + 1))
  fi
done

old_upper="Ham""murabi"
old_lower="ham""murabi"
old_env="HAM""MURABI"
old_header="X-${old_upper}"
old_product_hits="$(
  grep -rEI "${old_upper}|${old_lower}|${old_env}|${old_header}" \
    --include='*.md' \
    --include='*.txt' \
    --include='*.example' \
    --include='.env.example' \
    "$ROOT/README.md" "$ROOT/CHANGELOG.md" "$ROOT/docs" "$ROOT/apps/herd" "$ROOT/packages" "$ROOT/agent-skills" 2>/dev/null \
    | grep -v '/node_modules/' \
    | grep -v '/dist/' \
    | grep -v '/dist-server/' \
    || true
)"
if [ -n "$old_product_hits" ]; then
  red "old internal product names present in public artifact:"
  printf '%s\n' "$old_product_hits" | head -20 | sed "s|^$ROOT/|  |"
  LEAK_COUNT=$((LEAK_COUNT + 1))
fi

herd_env_residue_files=()
if [ -f "$ROOT/apps/herd/.env.example" ]; then
  herd_env_residue_files+=("$ROOT/apps/herd/.env.example")
fi
if git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  while IFS= read -r -d '' path; do
    example_path="$ROOT/$path"
    if [ "$example_path" != "$ROOT/apps/herd/.env.example" ]; then
      herd_env_residue_files+=("$example_path")
    fi
  done < <(git -C "$ROOT" ls-files -z -- 'apps/herd/*.example' 'apps/herd/**/*.example' 2>/dev/null || true)
fi

if [ "${#herd_env_residue_files[@]}" -gt 0 ]; then
  herd_env_residue_hits="$(
    grep -nH -F 'HAMMU''RABI_' "${herd_env_residue_files[@]}" 2>/dev/null \
      || true
  )"
else
  herd_env_residue_hits=""
fi
if [ -n "$herd_env_residue_hits" ]; then
  red "HAMMU""RABI_ residue present in public env/example templates:"
  printf '%s\n' "$herd_env_residue_hits" | head -20 | sed "s|^$ROOT/|  |"
  LEAK_COUNT=$((LEAK_COUNT + 1))
fi

identity_hits="$(
  grep -rEI '\b(Ath''ena|Jar''vis|Alb''ert|War''ren|Zen''dude|gehirn-''main-ec2)\b|mono''repo-g' \
    --include='*.md' \
    --include='*.txt' \
    --include='*.ts' \
    --include='*.tsx' \
    --include='*.js' \
    --include='*.jsx' \
    --include='*.mjs' \
    --include='*.cjs' \
    --include='*.json' \
    --include='*.yaml' \
    --include='*.yml' \
    --include='*.sh' \
    --include='*.example' \
    --include='.env.example' \
    "$ROOT" 2>/dev/null \
    | grep -v "^$ROOT/.git/" \
    | grep -v '/node_modules/' \
    | grep -v '/dist/' \
    | grep -v '/dist-server/' \
    | grep -v "^$ROOT/scripts/check-public-artifact.sh:" \
    | grep -v "^$ROOT/LICENSE" \
    | grep -v "^$ROOT/NOTICE" \
    || true
)"
if [ -n "$identity_hits" ]; then
  red "commander identity or internal infra strings present:"
  printf '%s\n' "$identity_hits" | head -20 | sed "s|^$ROOT/|  |"
  LEAK_COUNT=$((LEAK_COUNT + 1))
fi

legacy_orchestrator_name_lower="ath""ena"
legacy_orchestrator_name_upper="Ath""ena"
legacy_eval_identity_pattern="Herd${legacy_orchestrator_name_upper}|herd-${legacy_orchestrator_name_lower}|\\b${legacy_orchestrator_name_lower}\\b"
legacy_eval_identity_hits="$(
  grep -rEIn "$legacy_eval_identity_pattern" \
    --include='*.md' \
    --include='*.txt' \
    --include='*.ts' \
    --include='*.tsx' \
    --include='*.js' \
    --include='*.jsx' \
    --include='*.mjs' \
    --include='*.cjs' \
    --include='*.json' \
    --include='*.yaml' \
    --include='*.yml' \
    --include='*.sh' \
    --include='*.example' \
    --include='.env.example' \
    "$ROOT" 2>/dev/null \
    | grep -v "^$ROOT/.git/" \
    | grep -v '/node_modules/' \
    | grep -v '/dist/' \
    | grep -v '/dist-server/' \
    | grep -v "^$ROOT/scripts/check-public-artifact.sh:" \
    | grep -v "^$ROOT/apps/herd/public/repo-root/scripts/check-public-artifact.sh:" \
    | sed "s|^$ROOT/||" \
    || true
)"
if [ -n "$legacy_eval_identity_hits" ]; then
  red "contiguous legacy eval identity present in public artifact:"
  printf '%s\n' "$legacy_eval_identity_hits" | head -20 | sed 's/^/  /'
  LEAK_COUNT=$((LEAK_COUNT + 1))
fi

benchmark_host_ec2="ec2-""user"
benchmark_host_builder="build""er"
benchmark_root_pattern="/home/(${benchmark_host_ec2}|${benchmark_host_builder})/App/bench""marks"
benchmark_root_hits="$(
  grep -rEIn "$benchmark_root_pattern" \
    --include='*.md' \
    --include='*.txt' \
    --include='*.ts' \
    --include='*.tsx' \
    --include='*.js' \
    --include='*.jsx' \
    --include='*.mjs' \
    --include='*.cjs' \
    --include='*.json' \
    --include='*.yaml' \
    --include='*.yml' \
    --include='*.sh' \
    --include='*.example' \
    --include='.env.example' \
    "$ROOT" 2>/dev/null \
    | grep -v "^$ROOT/.git/" \
    | grep -v '/node_modules/' \
    | grep -v '/dist/' \
    | grep -v '/dist-server/' \
    | sed "s|^$ROOT/||" \
    || true
)"
if [ -n "$benchmark_root_hits" ]; then
  red "host-specific benchmark root present in public artifact:"
  printf '%s\n' "$benchmark_root_hits" | head -20 | sed 's/^/  /'
  LEAK_COUNT=$((LEAK_COUNT + 1))
fi

secret_hits="$(
  grep -rIlE '(vcp_[A-Za-z0-9]{30,}|team_[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|gh[po]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AIza[0-9A-Za-z_-]{35}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|PRIVATE KEY)' \
    --include='*.md' \
    --include='*.txt' \
    --include='*.ts' \
    --include='*.tsx' \
    --include='*.js' \
    --include='*.jsx' \
    --include='*.mjs' \
    --include='*.cjs' \
    --include='*.json' \
    --include='*.yaml' \
    --include='*.yml' \
    --include='*.sh' \
    --include='*.example' \
    --include='.env.example' \
    --include='*.env' \
    "$ROOT" 2>/dev/null \
    | grep -v "^$ROOT/.git/" \
    | grep -v '/node_modules/' \
    | grep -v '/dist/' \
    | grep -v '/dist-server/' \
    | grep -v "^$ROOT/scripts/check-public-artifact.sh$" \
    | grep -v "^$ROOT/apps/herd/public/repo-root/scripts/check-public-artifact.sh$" \
    || true
)"
if [ -n "$secret_hits" ]; then
  red "secret-shaped strings present:"
  printf '%s\n' "$secret_hits" | head -20 | sed "s|^$ROOT/|  |"
  LEAK_COUNT=$((LEAK_COUNT + 1))
fi

if [ "$LEAK_COUNT" -gt 0 ]; then
  red "$LEAK_COUNT public artifact cleanliness check(s) failed."
  exit 1
fi

green "public artifact cleanliness checks passed."
