#!/usr/bin/env bash
# Herd installer.
#
# Piped (no local checkout):
#   curl -fsSL https://herd.gehirn.ai/install.sh | bash
#
# From a local checkout (apps/herd):
#   ./install.sh
#
# From a local checkout (repo root):
#   bash install.sh

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

if [[ -z "${HERD_INSTALL_STARTED_AT_ISO:-}" ]]; then
  export HERD_INSTALL_STARTED_AT_ISO="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
fi
if [[ -z "${HERD_INSTALL_STARTED_AT_MS:-}" ]]; then
  export HERD_INSTALL_STARTED_AT_MS="$(( $(date -u '+%s') * 1000 ))"
fi

PRODUCT_NAME="Herd"
NODE_VERSION="${HERD_NODE_VERSION:-${HERVALD_NODE_VERSION:-22.16.0}}"
PNPM_VERSION="${HERD_PNPM_VERSION:-${HERVALD_PNPM_VERSION:-10.23.0}}"
INSTALLER_MARKER=".herd-installer-checkout"
LEGACY_INSTALLER_MARKER=".hervald-installer-checkout"

step() { printf "${CYAN}==>${NC} %s\n" "$*"; }
ok()   { printf "${GREEN}✓${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}!${NC} %s\n" "$*"; }
fail() {
  local fallback_log="${HOME:-/tmp}/.herd/logs/first-boot.log"
  print_repair_hint \
    "Installer failed" \
    "$*" \
    "Fix the issue above, then rerun install.sh. If first boot started, inspect ${INSTALL_LOG_FILE:-$fallback_log}."
  exit 1
}

brand_opener() {
  printf "${CYAN}"
  printf ' _   _ _____ ______     ___    _     ____  \n'
  printf '| | | | ____|  _ \\ \\   / / \\  | |   |  _ \\ \n'
  printf '| |_| |  _| | |_) \\ \\ / / _ \\ | |   | | | |\n'
  printf '|  _  | |___|  _ < \\ V / ___ \\| |___| |_| |\n'
  printf '|_| |_|_____|_| \\_\\ \\_/_/   \\_\\_____|____/ \n'
  printf "${NC}"
  printf "  ${BOLD}%s${NC} - operator-controlled agent fleet runtime\n" "$PRODUCT_NAME"
  printf "  ${DIM}%s${NC}\n\n" "installer"
}

prompt_select_menu() {
  local prompt="$1"
  local default_value="$2"
  shift 2
  local reply option index normalized

  if ! prompt_available; then
    printf '%s' "$default_value"
    return 0
  fi

  while true; do
    printf "%s\n" "$prompt" > /dev/tty
    index=1
    for option in "$@"; do
      printf "  %s. %s\n" "$index" "$option" > /dev/tty
      index=$((index + 1))
    done
    reply="$(prompt_line "Select one number [$default_value]: " "$default_value" || true)"
    normalized="$(printf '%s' "$reply" | tr -d '[:space:]')"
    case "$normalized" in
      '' ) printf '%s' "$default_value"; return 0 ;;
      *[!0-9]* ) warn "Invalid selection: $reply" ;;
      * )
        if [ "$normalized" -ge 1 ] 2>/dev/null && [ "$normalized" -lt "$index" ] 2>/dev/null; then
          printf '%s' "$normalized"
          return 0
        fi
        warn "Invalid selection: $reply"
        ;;
    esac
  done
}

choose_setup_path() {
  local choice normalized setup_path_env
  setup_path_env="${HERD_SETUP_PATH:-${HERVALD_SETUP_PATH:-}}"
  if [[ -n "$setup_path_env" ]]; then
    normalized="$(printf '%s' "$setup_path_env" | tr '[:upper:]' '[:lower:]')"
    case "$normalized" in
      quickstart|advanced) printf '%s' "$normalized"; return 0 ;;
      *) warn "Unknown HERD_SETUP_PATH/HERVALD_SETUP_PATH=$setup_path_env; using Quickstart." ;;
    esac
  fi

  choice="$(prompt_select_menu \
    "Choose setup path" \
    "1" \
    "Quickstart (recommended) - local install, first boot, CLI self-config" \
    "Advanced - customize provider setup and launch behavior")"
  case "$choice" in
    2) printf 'advanced' ;;
    *) printf 'quickstart' ;;
  esac
}

print_repair_hint() {
  local name="$1"
  local message="$2"
  local hint="$3"
  printf "${YELLOW}!${NC} ${BOLD}%s${NC}: %s\n" "$name" "$message" >&2
  if [[ -n "$hint" ]]; then
    printf "  ${DIM}%s${NC}\n" "$hint" >&2
  fi
}

prompt_available() {
  : 2>/dev/null <>/dev/tty
}

prompt_line() {
  local prompt="$1"
  local default_value="${2:-}"
  local reply
  if ! prompt_available; then
    return 1
  fi
  printf "%s" "$prompt" > /dev/tty
  if ! IFS= read -r reply < /dev/tty; then
    return 1
  fi
  if [[ -z "$reply" ]]; then
    reply="$default_value"
  fi
  printf '%s' "$reply"
}

prompt_yes_no() {
  local prompt="$1"
  local default_value="${2:-n}"
  local reply normalized
  reply="$(prompt_line "$prompt" "$default_value" || true)"
  normalized="$(printf '%s' "$reply" | tr '[:upper:]' '[:lower:]')"
  case "$normalized" in
    y|yes) return 0 ;;
    *) return 1 ;;
  esac
}

prompt_secret() {
  local prompt="$1"
  local reply
  if ! prompt_available; then
    return 1
  fi
  printf "%s" "$prompt" > /dev/tty
  if ! IFS= read -rs reply < /dev/tty; then
    printf '\n' > /dev/tty
    return 1
  fi
  printf '\n' > /dev/tty
  printf '%s' "$reply"
}

install_hint_for_command() {
  local command_name="$1"
  case "$(uname -s):$command_name" in
    Darwin:git)
      printf 'Install Apple Command Line Tools with: xcode-select --install'
      ;;
    Darwin:curl|Darwin:tar)
      printf 'Install Apple Command Line Tools with: xcode-select --install'
      ;;
    Linux:curl)
      printf 'Install curl with your package manager, for example: sudo apt-get install curl'
      ;;
    Linux:tar)
      printf 'Install tar with your package manager, for example: sudo apt-get install tar'
      ;;
    Linux:git)
      printf 'Install git with your package manager, for example: sudo apt-get install git'
      ;;
    *)
      printf 'Install %s and re-run this installer.' "$command_name"
      ;;
  esac
}

require_command_or_prompt() {
  local command_name="$1"
  if command -v "$command_name" >/dev/null 2>&1; then
    return 0
  fi

  warn "$command_name is required."
  printf '  %s\n' "$(install_hint_for_command "$command_name")"
  if ! prompt_available; then
    fail "$command_name is required but no interactive terminal is available"
  fi

  while ! command -v "$command_name" >/dev/null 2>&1; do
    prompt_line "Install $command_name, then press Enter to continue: " "" >/dev/null || true
  done
}

git_ready() {
  if [[ "$(uname -s)" == "Darwin" ]] && command -v xcode-select >/dev/null 2>&1; then
    xcode-select -p >/dev/null 2>&1 || return 1
  fi
  command -v git >/dev/null 2>&1 && git --version >/dev/null 2>&1
}

ensure_git_or_prompt() {
  if git_ready; then
    return 0
  fi

  warn "Git requires installation before this existing checkout can be refreshed."
  printf '  %s\n' "$(install_hint_for_command git)"
  if ! prompt_available; then
    fail "git is required to refresh existing checkout $CHECKOUT_DIR"
  fi

  until git_ready; do
    prompt_line "Finish Git/Command Line Tools installation, then press Enter to continue: " "" >/dev/null || true
  done
}

repo_archive_url() {
  local repo_url="$1"
  local repo_ref="$2"
  local repo_path

  local archive_override
  archive_override="${HERD_ARCHIVE_URL:-${HERVALD_ARCHIVE_URL:-}}"
  if [[ -n "$archive_override" ]]; then
    printf '%s' "$archive_override"
    return 0
  fi

  case "$repo_url" in
    https://github.com/*/*.git)
      repo_path="${repo_url#https://github.com/}"
      repo_path="${repo_path%.git}"
      printf 'https://github.com/%s/archive/%s.tar.gz' "$repo_path" "$repo_ref"
      ;;
    https://github.com/*/*)
      repo_path="${repo_url#https://github.com/}"
      repo_path="${repo_path%.git}"
      printf 'https://github.com/%s/archive/%s.tar.gz' "$repo_path" "$repo_ref"
      ;;
    *)
      return 1
      ;;
  esac
}

directory_is_empty() {
  [[ -d "$1" ]] && [[ -z "$(find "$1" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]
}

resolve_in_tree_installer() {
  local root="$1"
  local candidate
  for candidate in "$root/apps/herd/install.sh" "$root/apps/herd/install.sh"; do
    if [ -f "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

replace_checkout_with_archive() {
  local archive_url="$1"
  local tmp_dir archive extract_dir archive_root first_root

  require_command_or_prompt curl
  require_command_or_prompt tar

  step "Downloading Herd into $CHECKOUT_DIR"
  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/herd-checkout.XXXXXX")"
  archive="$tmp_dir/herd.tar.gz"
  extract_dir="$tmp_dir/extract"
  mkdir -p "$extract_dir"

  curl -fsSL "$archive_url" -o "$archive"
  tar -xzf "$archive" -C "$extract_dir"

  if resolve_in_tree_installer "$extract_dir" >/dev/null; then
    archive_root="$extract_dir"
  else
    first_root="$(find "$extract_dir" -mindepth 1 -maxdepth 1 -type d | head -n 1 || true)"
    [[ -n "$first_root" ]] || fail "Downloaded archive did not contain a repository directory"
    archive_root="$first_root"
  fi

  resolve_in_tree_installer "$archive_root" >/dev/null \
    || fail "Downloaded archive is missing apps/herd/install.sh or apps/herd/install.sh"

  if [ -e "$CHECKOUT_DIR" ]; then
    rm -rf "$CHECKOUT_DIR"
  fi
  mkdir -p "$(dirname "$CHECKOUT_DIR")"
  mv "$archive_root" "$CHECKOUT_DIR"
  printf 'archive_url=%s\nrepo_ref=%s\n' "$archive_url" "${REPO_REF:-unknown}" > "$CHECKOUT_DIR/$INSTALLER_MARKER"
  rm -rf "$tmp_dir"
  ok "downloaded Herd to $CHECKOUT_DIR"
}

clone_and_exec_installer() {
  local default_checkout checkout_override
  local installer_path
  default_checkout="$HOME/Herd"
  if [[ -z "${HERD_CHECKOUT_DIR:-${HERVALD_CHECKOUT_DIR:-}}" && ! -e "$default_checkout" && -d "$HOME/Herd/.git" ]]; then
    default_checkout="$HOME/Herd"
  fi

  REPO_URL="${HERD_REPO_URL:-${HERVALD_REPO_URL:-https://github.com/NickGuAI/Herd.git}}"
  REPO_REF="${HERD_REPO_REF:-${HERVALD_REPO_REF:-v0.0.10-beta}}"
  checkout_override="${HERD_CHECKOUT_DIR:-${HERVALD_CHECKOUT_DIR:-}}"
  CHECKOUT_DIR="${checkout_override:-$default_checkout}"
  ARCHIVE_URL="$(repo_archive_url "$REPO_URL" "$REPO_REF" || true)"

  if [ -d "$CHECKOUT_DIR/.git" ]; then
    ensure_git_or_prompt
    step "Refreshing existing Herd checkout at $CHECKOUT_DIR"
    if git -C "$CHECKOUT_DIR" remote get-url origin >/dev/null 2>&1; then
      git -C "$CHECKOUT_DIR" remote set-url origin "$REPO_URL"
    else
      git -C "$CHECKOUT_DIR" remote add origin "$REPO_URL"
    fi
    git -C "$CHECKOUT_DIR" fetch --quiet origin "$REPO_REF"
    git -C "$CHECKOUT_DIR" checkout --quiet --detach FETCH_HEAD
    git -C "$CHECKOUT_DIR" reset --quiet --hard FETCH_HEAD
  elif [ -n "$ARCHIVE_URL" ]; then
    if [ -e "$CHECKOUT_DIR" ] && ! directory_is_empty "$CHECKOUT_DIR" && [ ! -f "$CHECKOUT_DIR/$INSTALLER_MARKER" ] && [ ! -f "$CHECKOUT_DIR/$LEGACY_INSTALLER_MARKER" ]; then
      warn "$CHECKOUT_DIR already exists and is not a Herd git checkout."
      if ! prompt_yes_no "Replace it with a fresh Herd download? [y/N] " "n"; then
        fail "Cannot install into existing non-empty directory: $CHECKOUT_DIR"
      fi
    fi
    replace_checkout_with_archive "$ARCHIVE_URL"
  else
    ensure_git_or_prompt
    step "Cloning Herd into $CHECKOUT_DIR"
    git clone --quiet --branch "$REPO_REF" --single-branch "$REPO_URL" "$CHECKOUT_DIR"
  fi

  installer_path="$(resolve_in_tree_installer "$CHECKOUT_DIR")" \
    || fail "Checkout is missing apps/herd/install.sh or apps/herd/install.sh"
  exec bash "$installer_path" "$@"
}

# Piped mode: when invoked via `curl ... | bash`, BASH_SOURCE[0] is empty
# and there is no local checkout to install from. Clone the public Herd
# repo (or refresh an existing clone) and re-exec the in-tree installer.
SCRIPT_PATH="${BASH_SOURCE[0]:-}"
if [ -z "$SCRIPT_PATH" ] || [ ! -f "$SCRIPT_PATH" ]; then
  clone_and_exec_installer "$@"
fi

SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
if installer_path="$(resolve_in_tree_installer "$SCRIPT_DIR")"; then
  exec bash "$installer_path" "$@"
fi

if [ ! -f "$SCRIPT_DIR/package.json" ] \
  || [ ! -f "$SCRIPT_DIR/../../pnpm-workspace.yaml" ] \
  || [ ! -d "$SCRIPT_DIR/../../packages/herd-cli" ]; then
  clone_and_exec_installer "$@"
fi

APP_DIR="$SCRIPT_DIR"
REPO_ROOT="$(cd "$APP_DIR/../.." && pwd)"
CLI_PKG_DIR="$REPO_ROOT/packages/herd-cli"
CLI_BIN_REL="bin/herd.mjs"
DATA_DIR="${HERD_DATA_DIR:-${HERD_DATA_DIR:-$HOME/.herd}}"
TOOLCHAIN_DIR="${HERD_TOOLCHAIN_DIR:-$DATA_DIR/toolchain}"
PROVIDER_TOOLS_HOME="${HERD_PROVIDER_TOOLS_DIR:-$TOOLCHAIN_DIR/provider-tools}"
PROVIDER_BIN_DIR="$PROVIDER_TOOLS_HOME/bin"
RUNTIME_DEFAULTS_DIR="$APP_DIR/runtime/defaults"
APP_PATH_FILE="$DATA_DIR/app-path"
BOOTSTRAP_KEY_FILE="$DATA_DIR/bootstrap-key.txt"
API_KEY_STORE_FILE="$DATA_DIR/api-keys/keys.json"
INSTALL_STARTED_AT_FILE="$DATA_DIR/install-started-at.json"
BOOTSTRAP_LOG_DIR="$DATA_DIR/logs"
BOOTSTRAP_LOG_FILE="$BOOTSTRAP_LOG_DIR/first-boot.log"
MACHINES_FILE="$DATA_DIR/machines.json"
LOCAL_MACHINE_ENV_FILE="${HERD_LOCAL_MACHINE_ENV_FILE:-$HOME/.herd-env}"
BIN_DIR="${HERD_BIN_DIR:-$HOME/.local/bin}"
SHIM_PATH="$BIN_DIR/herd"
DEFAULT_PORT="20001"
HEALTHCHECK_TIMEOUT_SECONDS="${HERD_INSTALL_TIMEOUT_SECONDS:-120}"
LAUNCH_AGENT_DIR="$HOME/Library/LaunchAgents"
LAUNCH_AGENT_PATH="$LAUNCH_AGENT_DIR/io.gehirn.hervald.plist"
LAUNCH_LOG_DIR="$HOME/Library/Logs/hervald"
SYSTEMD_USER_DIR="$HOME/.config/systemd/user"
SYSTEMD_USER_UNIT_NAME="io.gehirn.hervald.service"
SYSTEMD_USER_UNIT_PATH="$SYSTEMD_USER_DIR/$SYSTEMD_USER_UNIT_NAME"
SKILLS_INSTALLER="$REPO_ROOT/agent-skills/install.sh"
CLAUDE_RUNTIME_ROOT="$HOME/.claude"
CODEX_RUNTIME_ROOT="$HOME/.codex"
NODE_HOME=""
NODE_BIN=""
PNPM_HOME=""
PNPM_BIN=""
PROVIDER_RESULTS=()
INSTALL_LOGIN_URL=""
INSTALL_BOOTSTRAP_KEY=""
INSTALL_KEY_FILE="$BOOTSTRAP_KEY_FILE"
INSTALL_LOG_FILE="$BOOTSTRAP_LOG_FILE"
INSTALL_PATH_NOTE=""
INSTALL_AUTOSTART_STATUS="not installed"
INSTALL_CLI_CONFIG_STATUS="not configured"

xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  value="${value//\"/&quot;}"
  value="${value//\'/&apos;}"
  printf '%s' "$value"
}

mac_launch_path() {
  printf '%s' "$BIN_DIR:$PROVIDER_BIN_DIR:$PNPM_HOME/bin:$NODE_HOME/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
}

ensure_path_block() {
  local file="$1"
  local export_line="export PATH=\"$BIN_DIR:$PROVIDER_BIN_DIR:\$PATH\""

  touch "$file"
  if ! grep -Fq "$export_line" "$file"; then
    {
      printf '\n# >>> hervald installer >>>\n'
      printf '%s\n' "$export_line"
      printf '# <<< hervald installer <<<\n'
    } >> "$file"
  fi
}

ensure_local_path_setup() {
  ensure_path_block "$HOME/.zshrc"
  ensure_path_block "$HOME/.bashrc"
  ensure_path_block "$HOME/.bash_profile"
  ensure_path_block "$HOME/.profile"
}

node_platform() {
  case "$(uname -s)" in
    Darwin) printf 'darwin' ;;
    Linux) printf 'linux' ;;
    *) fail "unsupported operating system for hermetic Node install: $(uname -s)" ;;
  esac
}

node_arch() {
  case "$(uname -m)" in
    x86_64|amd64) printf 'x64' ;;
    arm64|aarch64) printf 'arm64' ;;
    *) fail "unsupported CPU architecture for hermetic Node install: $(uname -m)" ;;
  esac
}

ensure_node() {
  local platform arch archive stem url tmp_dir

  platform="$(node_platform)"
  arch="$(node_arch)"
  stem="node-v${NODE_VERSION}-${platform}-${arch}"
  NODE_HOME="$TOOLCHAIN_DIR/$stem"
  NODE_BIN="$NODE_HOME/bin/node"

  if [ -x "$NODE_BIN" ] && [ "$("$NODE_BIN" -p 'process.versions.node')" = "$NODE_VERSION" ]; then
    ok "node v$NODE_VERSION at $NODE_BIN"
    return 0
  fi

  step "Installing hermetic Node v${NODE_VERSION}"
  mkdir -p "$TOOLCHAIN_DIR"
  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/hervald-node.XXXXXX")"
  archive="$tmp_dir/${stem}.tar.gz"
  url="https://nodejs.org/dist/v${NODE_VERSION}/${stem}.tar.gz"

  curl -fsSL "$url" -o "$archive"
  tar -xzf "$archive" -C "$tmp_dir"
  rm -rf "$NODE_HOME"
  mv "$tmp_dir/$stem" "$NODE_HOME"
  rm -rf "$tmp_dir"

  [ -x "$NODE_BIN" ] || fail "Node install failed at $NODE_HOME"
  ok "node $("$NODE_BIN" --version) at $NODE_BIN"
}

ensure_pnpm() {
  local current_version

  PNPM_HOME="$TOOLCHAIN_DIR/pnpm-${PNPM_VERSION}"
  PNPM_BIN="$PNPM_HOME/bin/pnpm"

  if [ -x "$PNPM_BIN" ]; then
    current_version="$("$PNPM_BIN" --version 2>/dev/null || true)"
    if [ "$current_version" = "$PNPM_VERSION" ]; then
      ok "pnpm $PNPM_VERSION at $PNPM_BIN"
      return 0
    fi
  fi

  step "Installing hermetic pnpm ${PNPM_VERSION}"
  rm -rf "$PNPM_HOME"
  mkdir -p "$PNPM_HOME"
  "$NODE_HOME/bin/npm" install --global --prefix "$PNPM_HOME" "pnpm@${PNPM_VERSION}"

  current_version="$("$PNPM_BIN" --version 2>/dev/null || true)"
  [ "$current_version" = "$PNPM_VERSION" ] || fail "pnpm $PNPM_VERSION install failed"
  ok "pnpm $current_version at $PNPM_BIN"
}

auth0_enabled() {
  [[ "${HERD_ENABLE_AUTH0:-${HERVALD_ENABLE_AUTH0:-0}}" == "1" ]]
}

configure_environment() {
  step "Configuring environment"
  if [ ! -f "$APP_DIR/.env" ]; then
    cp "$APP_DIR/.env.example" "$APP_DIR/.env"
    ok "Created $APP_DIR/.env with zero-config defaults"
  else
    ok ".env already present"
  fi
}

build_herd() {
  step "Building ${PRODUCT_NAME}"
  if auth0_enabled; then
    "$PNPM_BIN" --dir "$REPO_ROOT" --filter herd run build
    return
  fi

  env \
    -u AUTH0_DOMAIN \
    -u AUTH0_AUDIENCE \
    -u AUTH0_CLIENT_ID \
    -u VITE_AUTH0_DOMAIN \
    -u VITE_AUTH0_AUDIENCE \
    -u VITE_AUTH0_CLIENT_ID \
    "$PNPM_BIN" --dir "$REPO_ROOT" --filter herd run build
}

ensure_sqlite_control_plane() {
  step "Checking SQLite runtime-session store"
  if ! env \
    HERD_DATA_DIR="$DATA_DIR" \
    HERD_DB_PATH="$DATA_DIR/herd.sqlite" \
    "$PNPM_BIN" --dir "$REPO_ROOT" --filter herd run db:ready -- --source-root "$DATA_DIR" --db "$DATA_DIR/herd.sqlite"; then
    fail "SQLite runtime-session store is not ready. Resolve the db:ready error above, then rerun install.sh."
  fi
}

ensure_json_stores_control_plane() {
  step "Checking JSON data stores"
  if ! env \
    HERD_DATA_DIR="$DATA_DIR" \
    "$PNPM_BIN" --dir "$REPO_ROOT" --filter herd run store:ready -- --source-root "$DATA_DIR"; then
    fail "JSON data stores are not ready. Resolve the store:ready error above, then rerun install.sh."
  fi
}

seed_runtime_defaults() {
  [[ -d "$RUNTIME_DEFAULTS_DIR" ]] || fail "Runtime defaults missing at $RUNTIME_DEFAULTS_DIR"

  step "Seeding runtime defaults"
  local source_file relative_path target_file created_count existing_count
  created_count=0
  existing_count=0

  while IFS= read -r source_file; do
    [[ -f "$source_file" ]] || continue
    relative_path="${source_file#$RUNTIME_DEFAULTS_DIR/}"
    target_file="$DATA_DIR/$relative_path"
    mkdir -p "$(dirname "$target_file")"
    if [[ -e "$target_file" ]]; then
      existing_count=$((existing_count + 1))
      continue
    fi
    cp "$source_file" "$target_file"
    created_count=$((created_count + 1))
  done < <(find "$RUNTIME_DEFAULTS_DIR" -type f | sort)

  ok "seeded runtime defaults ($created_count created, $existing_count existing)"
}

single_quote() {
  printf "'"
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
  printf "'"
}

ensure_local_machine_registry() {
  mkdir -p "$DATA_DIR"
  HERD_DATA_DIR="$DATA_DIR" \
  HERD_LOCAL_MACHINE_ENV_FILE="$LOCAL_MACHINE_ENV_FILE" \
  "$NODE_BIN" <<'NODE'
const fs = require('fs')
const path = require('path')

const dataDir = process.env.HERD_DATA_DIR
const machinesFile = path.join(dataDir, 'machines.json')
const envFile = process.env.HERD_LOCAL_MACHINE_ENV_FILE
let payload = { schemaVersion: 1, machines: [] }

if (fs.existsSync(machinesFile)) {
  payload = JSON.parse(fs.readFileSync(machinesFile, 'utf8'))
  if (!payload || !Array.isArray(payload.machines)) {
    throw new Error(`Invalid machines config at ${machinesFile}`)
  }
  if (payload.schemaVersion === undefined || payload.schemaVersion === null) {
    payload.schemaVersion = 1
  } else if (payload.schemaVersion !== 1) {
    throw new Error(`Unsupported machines config schemaVersion ${payload.schemaVersion} at ${machinesFile}`)
  }
}

const existing = payload.machines.find((machine) => machine && machine.id === 'local')
const local = {
  id: 'local',
  label: existing?.label || 'Local (this server)',
  host: null,
  ...(existing?.cwd ? { cwd: existing.cwd } : {}),
  envFile: existing?.envFile || envFile,
}

payload.machines = [
  local,
  ...payload.machines.filter((machine) => machine && machine.id !== 'local'),
]

fs.mkdirSync(path.dirname(machinesFile), { recursive: true })
fs.writeFileSync(machinesFile, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
NODE
  ok "ensured local machine auth target in $MACHINES_FILE"
}

write_local_provider_secret() {
  local key="$1"
  local value="$2"
  local tmp_file quoted_value

  mkdir -p "$(dirname "$LOCAL_MACHINE_ENV_FILE")"
  touch "$LOCAL_MACHINE_ENV_FILE"
  chmod 600 "$LOCAL_MACHINE_ENV_FILE" 2>/dev/null || true

  quoted_value="$(single_quote "$value")"
  tmp_file="$(mktemp "${TMPDIR:-/tmp}/hervald-env.XXXXXX")"
  awk -v key="$key" '
    BEGIN { pattern = "^[[:space:]]*(export[[:space:]]+)?" key "=" }
    $0 !~ pattern { print }
  ' "$LOCAL_MACHINE_ENV_FILE" > "$tmp_file"
  printf 'export %s=%s\n' "$key" "$quoted_value" >> "$tmp_file"
  mv "$tmp_file" "$LOCAL_MACHINE_ENV_FILE"
  chmod 600 "$LOCAL_MACHINE_ENV_FILE"
  export "$key=$value"
}

source_local_provider_env() {
  if [ -f "$LOCAL_MACHINE_ENV_FILE" ]; then
    # This file is created by Herd with 0600 permissions and `export KEY='value'` lines.
    # Sourcing it keeps install-time probes aligned with server launch behavior.
    # shellcheck disable=SC1090
    . "$LOCAL_MACHINE_ENV_FILE"
  fi
}

provider_label() {
  case "$1" in
    claude) printf 'Claude Code' ;;
    codex) printf 'Codex' ;;
    gemini) printf 'Gemini' ;;
    opencode) printf 'OpenCode' ;;
    *) printf '%s' "$1" ;;
  esac
}

provider_cli() {
  case "$1" in
    claude) printf 'claude' ;;
    codex) printf 'codex' ;;
    gemini) printf 'gemini' ;;
    opencode) printf 'opencode' ;;
    *) return 1 ;;
  esac
}

provider_package() {
  case "$1" in
    claude) printf '@anthropic-ai/claude-code' ;;
    codex) printf '@openai/codex' ;;
    gemini) printf '@google/gemini-cli' ;;
    opencode) printf 'opencode-ai' ;;
    *) return 1 ;;
  esac
}

provider_env_keys() {
  case "$1" in
    claude) printf 'CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN' ;;
    codex) printf 'OPENAI_API_KEY' ;;
    gemini) printf 'GEMINI_API_KEY GOOGLE_API_KEY' ;;
    opencode) printf 'OPENCODE_API_KEY' ;;
    *) return 1 ;;
  esac
}

provider_secret_key() {
  case "$1" in
    claude) printf 'CLAUDE_CODE_OAUTH_TOKEN' ;;
    codex) printf 'OPENAI_API_KEY' ;;
    gemini) printf 'GEMINI_API_KEY' ;;
    opencode) printf 'OPENCODE_API_KEY' ;;
    *) return 1 ;;
  esac
}

provider_env_secret() {
  case "$1" in
    claude) printf '%s' "${HERD_CLAUDE_SETUP_TOKEN:-${HERVALD_CLAUDE_SETUP_TOKEN:-${CLAUDE_CODE_OAUTH_TOKEN:-${ANTHROPIC_API_KEY:-${ANTHROPIC_AUTH_TOKEN:-}}}}}" ;;
    codex) printf '%s' "${HERD_CODEX_API_KEY:-${HERVALD_CODEX_API_KEY:-${OPENAI_API_KEY:-}}}" ;;
    gemini) printf '%s' "${HERD_GEMINI_API_KEY:-${HERVALD_GEMINI_API_KEY:-${GEMINI_API_KEY:-${GOOGLE_API_KEY:-}}}}" ;;
    opencode) printf '%s' "${HERD_OPENCODE_API_KEY:-${HERVALD_OPENCODE_API_KEY:-${OPENCODE_API_KEY:-}}}" ;;
    *) return 1 ;;
  esac
}

provider_login_status_command() {
  case "$1" in
    claude) printf 'claude auth status' ;;
    codex) printf 'codex login status' ;;
    *) return 1 ;;
  esac
}

provider_auth_hint() {
  case "$1" in
    claude)
      printf 'Run `claude auth login` if your Claude Code version supports it, or run `claude setup-token` and paste the setup token here.'
      ;;
    codex)
      printf 'Run `codex login` in another terminal, or provide OPENAI_API_KEY/HERD_CODEX_API_KEY for API-key mode.'
      ;;
    gemini)
      printf 'Provide GEMINI_API_KEY or HERD_GEMINI_API_KEY.'
      ;;
    opencode)
      printf 'Provide OPENCODE_API_KEY or HERD_OPENCODE_API_KEY.'
      ;;
  esac
}

provider_has_env_auth() {
  local key value
  source_local_provider_env
  for key in $(provider_env_keys "$1"); do
    value="${!key:-}"
    if [[ -n "$value" ]]; then
      return 0
    fi
  done
  return 1
}

provider_has_login_auth() {
  local provider="$1"
  local command_text
  command_text="$(provider_login_status_command "$provider" 2>/dev/null || true)"
  [[ -n "$command_text" ]] || return 1
  bash -lc "$command_text" >/dev/null 2>&1
}

provider_auth_configured() {
  provider_has_env_auth "$1" || provider_has_login_auth "$1"
}

install_provider_cli() {
  local provider="$1"
  local label cli package version
  label="$(provider_label "$provider")"
  cli="$(provider_cli "$provider")"
  package="$(provider_package "$provider")"

  if command -v "$cli" >/dev/null 2>&1; then
    version="$("$cli" --version 2>&1 | head -n 1 || true)"
    ok "$label CLI detected${version:+: $version}"
    return 0
  fi

  step "Installing $label CLI"
  mkdir -p "$PROVIDER_TOOLS_HOME"
  "$NODE_HOME/bin/npm" install --global --prefix "$PROVIDER_TOOLS_HOME" "$package"
  export PATH="$PROVIDER_BIN_DIR:$PATH"

  if ! command -v "$cli" >/dev/null 2>&1; then
    warn "$label CLI install did not expose $cli on PATH"
    return 1
  fi

  version="$("$cli" --version 2>&1 | head -n 1 || true)"
  ok "$label CLI installed${version:+: $version}"
}

configure_provider_auth() {
  local provider="$1"
  local label secret key reply
  label="$(provider_label "$provider")"

  if provider_auth_configured "$provider"; then
    ok "$label auth ready"
    PROVIDER_RESULTS+=("$label:ready")
    return 0
  fi

  secret="$(provider_env_secret "$provider")"
  if [[ -n "$secret" ]]; then
    key="$(provider_secret_key "$provider")"
    write_local_provider_secret "$key" "$secret"
    ok "$label auth saved to $LOCAL_MACHINE_ENV_FILE"
    PROVIDER_RESULTS+=("$label:ready")
    return 0
  fi

  warn "$label is not authenticated."
  printf '  %s\n' "$(provider_auth_hint "$provider")"

  if ! prompt_available; then
    warn "No interactive terminal is available; skipping $label auth."
    PROVIDER_RESULTS+=("$label:unconfigured")
    return 1
  fi

  while true; do
    reply="$(prompt_select_menu \
      "$label authentication" \
      "1" \
      "Already authenticated - re-check CLI or env auth" \
      "Paste secret - save API key or setup token locally" \
      "Skip - leave this provider unconfigured")"
    case "$reply" in
      1)
        if provider_auth_configured "$provider"; then
          ok "$label auth ready"
          PROVIDER_RESULTS+=("$label:ready")
          return 0
        fi
        warn "$label auth still not detected."
        ;;
      2)
        secret="$(prompt_secret "Paste secret for $label: " || true)"
        if [[ -n "$secret" ]]; then
          key="$(provider_secret_key "$provider")"
          write_local_provider_secret "$key" "$secret"
          ok "$label auth saved to $LOCAL_MACHINE_ENV_FILE"
          PROVIDER_RESULTS+=("$label:ready")
          return 0
        fi
        warn "No secret entered for $label."
        ;;
      3)
        warn "Skipped $label auth."
        PROVIDER_RESULTS+=("$label:unconfigured")
        return 1
        ;;
    esac
  done
}

normalize_provider_selection() {
  local raw="$1"
  local normalized
  normalized="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' | tr ',;' '  ')"
  if [[ -z "${normalized// }" || "$normalized" == "all" ]]; then
    printf 'claude codex gemini opencode'
    return 0
  fi
  if [[ "$normalized" == "none" || "$normalized" == "skip" ]]; then
    printf ''
    return 0
  fi
  printf '%s' "$normalized"
}

prompt_provider_selection() {
  local reply normalized token
  local -a selected tokens

  if ! prompt_available; then
    return 1
  fi

  while true; do
    printf "Provider CLI setup\n" > /dev/tty
    printf "  1. Claude Code\n" > /dev/tty
    printf "  2. Codex\n" > /dev/tty
    printf "  3. Gemini\n" > /dev/tty
    printf "  4. OpenCode\n" > /dev/tty
    printf "  0. Skip provider setup\n" > /dev/tty
    reply="$(prompt_line "Select providers [1,2,3,4]: " "1,2,3,4" || true)"
    normalized="$(printf '%s' "$reply" | tr -d '[:space:]')"
    if [[ -z "$normalized" ]]; then
      normalized="1,2,3,4"
    fi
    if [[ "$normalized" == "0" ]]; then
      printf ''
      return 0
    fi

    selected=()
    IFS=',' read -r -a tokens <<< "$normalized"
    for token in "${tokens[@]}"; do
      case "$token" in
        1) selected+=("claude") ;;
        2) selected+=("codex") ;;
        3) selected+=("gemini") ;;
        4) selected+=("opencode") ;;
        *) selected=(); break ;;
      esac
    done
    if [[ "${#selected[@]}" -gt 0 ]]; then
      printf '%s\n' "${selected[*]}"
      return 0
    fi
    warn "Invalid provider selection: $reply"
  done
}

configure_providers() {
  local setup_path="${1:-advanced}"
  local raw_selection selected provider

  if [[ "${HERD_CONFIGURE_PROVIDERS:-${HERVALD_CONFIGURE_PROVIDERS:-1}}" == "0" ]]; then
    warn "Skipping provider setup because HERD_CONFIGURE_PROVIDERS=0"
    return 0
  fi

  raw_selection="${HERD_PROVIDERS:-${HERVALD_PROVIDERS:-}}"
  if [[ "$setup_path" != "advanced" && -z "$raw_selection" ]]; then
    warn "Quickstart skips provider CLI customization."
    printf "  ${DIM}%s${NC}\n" "Choose Advanced setup, or set HERD_PROVIDERS=claude,codex,gemini,opencode for non-interactive provider setup."
    return 0
  fi

  ensure_local_machine_registry

  if [[ -z "$raw_selection" ]]; then
    if ! prompt_available; then
      warn "No interactive terminal is available; skipping provider setup. Re-run with HERD_PROVIDERS=claude,codex,gemini,opencode to configure non-interactively."
      return 0
    fi
    selected="$(prompt_provider_selection || true)"
  else
    selected="$(normalize_provider_selection "$raw_selection")"
  fi

  if [[ -z "${selected// }" ]]; then
    warn "No providers selected."
    return 0
  fi

  step "Configuring provider CLIs"
  for provider in $selected; do
    case "$provider" in
      claude|codex|gemini|opencode)
        if install_provider_cli "$provider"; then
          configure_provider_auth "$provider" || true
        else
          PROVIDER_RESULTS+=("$(provider_label "$provider"):missing-cli")
        fi
        ;;
      *)
        warn "Unknown provider selection: $provider"
        ;;
    esac
  done
}

print_provider_summary() {
  local item label status
  printf '\n%s\n' "${CYAN}Provider readiness${NC}"
  if [[ "${#PROVIDER_RESULTS[@]}" -eq 0 ]]; then
    printf '  No providers were configured by the installer.\n'
    return 0
  fi

  for item in "${PROVIDER_RESULTS[@]}"; do
    label="${item%%:*}"
    status="${item#*:}"
    case "$status" in
      ready) printf '  %s %s: ready\n' "${GREEN}✓${NC}" "$label" ;;
      *) printf '  %s %s: %s\n' "${YELLOW}!${NC}" "$label" "$status" ;;
    esac
  done
  printf '  Local machine env: %s\n' "$LOCAL_MACHINE_ENV_FILE"
}

install_default_skills() {
  [[ -f "$SKILLS_INSTALLER" ]] || fail "Skill installer missing at $SKILLS_INSTALLER"
  [[ -x "$SKILLS_INSTALLER" ]] || chmod +x "$SKILLS_INSTALLER" 2>/dev/null || true

  step "Installing default skills"
  bash "$SKILLS_INSTALLER" --platform claude --target-root "$CLAUDE_RUNTIME_ROOT"
  bash "$SKILLS_INSTALLER" --platform codex --target-root "$CODEX_RUNTIME_ROOT"
  ok "installed default skills"
}

install_launch_agent_if_needed() {
  if [[ "${HERD_INSTALL_AUTOSTART:-1}" == "0" ]]; then
    warn "Skipping autostart because HERD_INSTALL_AUTOSTART=0"
    INSTALL_AUTOSTART_STATUS="disabled"
    return 0
  fi

  if [[ "$(uname -s)" == "Linux" ]]; then
    install_systemd_user_unit_if_needed
    return 0
  fi

  if [[ "$(uname -s)" != "Darwin" ]]; then
    INSTALL_AUTOSTART_STATUS="not supported on $(uname -s)"
    return 0
  fi

  step "Installing launchd LaunchAgent"
  mkdir -p "$LAUNCH_AGENT_DIR" "$LAUNCH_LOG_DIR"

  cat > "$LAUNCH_AGENT_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>io.gehirn.hervald</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$SHIM_PATH")</string>
    <string>up</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>$(xml_escape "$HOME")</string>
    <key>PATH</key>
    <string>$(xml_escape "$(mac_launch_path)")</string>
    <key>HERD_DATA_DIR</key>
    <string>$(xml_escape "$DATA_DIR")</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>$(xml_escape "$HOME")</string>
  <key>LimitLoadToSessionType</key>
  <array>
    <string>Aqua</string>
  </array>
  <key>ProcessType</key>
  <string>Background</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$LAUNCH_LOG_DIR")/stdout.log</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$LAUNCH_LOG_DIR")/stderr.log</string>
</dict>
</plist>
EOF

  launchctl unload -w "$LAUNCH_AGENT_PATH" >/dev/null 2>&1 || true
  launchctl load -w "$LAUNCH_AGENT_PATH"
  INSTALL_AUTOSTART_STATUS="installed: $LAUNCH_AGENT_PATH"
  ok "installed $LAUNCH_AGENT_PATH"
}

install_systemd_user_unit_if_needed() {
  if ! command -v systemctl >/dev/null 2>&1; then
    warn "Skipping systemd autostart because systemctl is not available"
    INSTALL_AUTOSTART_STATUS="systemd unavailable"
    return 0
  fi

  step "Installing systemd user service"
  mkdir -p "$SYSTEMD_USER_DIR"

  cat > "$SYSTEMD_USER_UNIT_PATH" <<EOF
[Unit]
Description=Herd local server
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=$HOME
Environment=HOME=$HOME
Environment=HERD_DATA_DIR=$DATA_DIR
Environment=PATH=$BIN_DIR:$PROVIDER_BIN_DIR:$PNPM_HOME/bin:$NODE_HOME/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$SHIM_PATH up
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

  local systemd_user_name systemd_user_id linger_enable_command autostart_remediation linger_verified
  systemd_user_name="$(id -un)"
  systemd_user_id="$(id -u)"
  linger_verified="0"
  if [[ "$systemd_user_id" == "0" ]]; then
    linger_enable_command="loginctl enable-linger $systemd_user_name"
  else
    linger_enable_command="sudo loginctl enable-linger $systemd_user_name"
  fi
  autostart_remediation="$linger_enable_command && systemctl --user enable --now $SYSTEMD_USER_UNIT_NAME"

  if command -v loginctl >/dev/null 2>&1; then
    if [[ "$systemd_user_id" == "0" ]]; then
      loginctl enable-linger "$systemd_user_name" >/dev/null 2>&1 || true
    elif command -v sudo >/dev/null 2>&1; then
      sudo -n loginctl enable-linger "$systemd_user_name" >/dev/null 2>&1 || true
    fi
    if loginctl show-user "$systemd_user_name" -p Linger 2>/dev/null | grep -qx 'Linger=yes'; then
      linger_verified="1"
    fi
  fi
  if [[ -z "${XDG_RUNTIME_DIR:-}" && -d "/run/user/$(id -u)" ]]; then
    export XDG_RUNTIME_DIR="/run/user/$(id -u)"
  fi

  if systemctl --user daemon-reload && systemctl --user enable --now "$SYSTEMD_USER_UNIT_NAME"; then
    if [[ "$linger_verified" != "1" ]]; then
      warn "systemd user service was enabled, but boot autostart is not verified because loginctl did not report Linger=yes. Run: $autostart_remediation"
      INSTALL_AUTOSTART_STATUS="manual linger required: $SYSTEMD_USER_UNIT_PATH"
      return 0
    fi
    INSTALL_AUTOSTART_STATUS="installed: $SYSTEMD_USER_UNIT_PATH"
    ok "installed $SYSTEMD_USER_UNIT_PATH"
    return 0
  fi

  if [[ "$linger_verified" != "1" ]]; then
    warn "systemd user service was written but boot autostart is not verified because loginctl did not report Linger=yes. Run: $autostart_remediation"
  else
    warn "systemd user service was written but not started. Run: systemctl --user enable --now $SYSTEMD_USER_UNIT_NAME"
  fi
  INSTALL_AUTOSTART_STATUS="manual start required: $SYSTEMD_USER_UNIT_PATH"
}

read_configured_port() {
  local env_file="$APP_DIR/.env"
  local line

  if [ -f "$env_file" ]; then
    line="$(grep -E '^PORT=' "$env_file" | tail -n 1 || true)"
    if [ -n "$line" ]; then
      printf '%s\n' "${line#PORT=}"
      return 0
    fi
  fi

  printf '%s\n' "$DEFAULT_PORT"
}

wait_for_first_boot() {
  local port="$1"
  local child_pid="$2"
  local deadline=$((SECONDS + HEALTHCHECK_TIMEOUT_SECONDS))
  local health_url="http://127.0.0.1:${port}/api/health"
  local frames='-\|/'
  local frame_index=0
  local frame

  while [ "$SECONDS" -lt "$deadline" ]; do
    if curl -fsS "$health_url" >/dev/null 2>&1; then
      if [ -t 1 ]; then
        printf "\r${GREEN}✓${NC} First boot health check passed.                    \n"
      fi
      return 0
    fi

    if ! kill -0 "$child_pid" >/dev/null 2>&1; then
      break
    fi

    if [ -t 1 ]; then
      frame="${frames:$frame_index:1}"
      printf "\r${CYAN}%s${NC} Waiting for first boot health at %s" "$frame" "$health_url"
      frame_index=$(((frame_index + 1) % 4))
    fi
    sleep 2
  done

  if [ -t 1 ]; then
    printf "\r${RED}✗${NC} First boot health check timed out.                \n"
  fi
  return 1
}

read_bootstrap_key() {
  if [ ! -f "$BOOTSTRAP_KEY_FILE" ]; then
    return 1
  fi

  local bootstrap_key
  bootstrap_key="$(tr -d '\r\n' < "$BOOTSTRAP_KEY_FILE")"
  if [ -z "$bootstrap_key" ]; then
    return 1
  fi

  INSTALL_BOOTSTRAP_KEY="$bootstrap_key"
  return 0
}

bootstrap_key_can_resume_first_boot() {
  "$NODE_BIN" - "$BOOTSTRAP_KEY_FILE" "$API_KEY_STORE_FILE" <<'NODE'
  const { createHash } = require('node:crypto')
  const { readFileSync } = require('node:fs')

  const [, , bootstrapKeyPath, apiKeyStorePath] = process.argv
  try {
    const bootstrapKey = readFileSync(bootstrapKeyPath, 'utf8').replace(/[\r\n]/gu, '')
    const collection = JSON.parse(readFileSync(apiKeyStorePath, 'utf8'))
    if (!collection || typeof collection !== 'object' || !Array.isArray(collection.keys)) {
      process.exit(2)
    }

    const apiKeyRecordSchemaVersion = collection.apiKeyRecordSchemaVersion
    if (apiKeyRecordSchemaVersion !== undefined && apiKeyRecordSchemaVersion !== 1) {
      process.exit(2)
    }

    const isRecord = (record) => (
      record
      && typeof record === 'object'
      && ['id', 'name', 'keyHash', 'prefix', 'createdBy', 'createdAt']
        .every((field) => typeof record[field] === 'string')
      && (
        record.expiresAt === undefined
        || record.expiresAt === null
        || typeof record.expiresAt === 'string'
      )
      && (record.lastUsedAt === null || typeof record.lastUsedAt === 'string')
      && Array.isArray(record.scopes)
      && record.scopes.every((scope) => typeof scope === 'string')
    )
    const hasLegacyBootstrapTtl = (record) => {
      if (typeof record.expiresAt !== 'string') {
        return false
      }
      const createdAtMs = Date.parse(record.createdAt)
      const expiresAtMs = Date.parse(record.expiresAt)
      return Number.isFinite(createdAtMs)
        && Number.isFinite(expiresAtMs)
        && expiresAtMs - createdAtMs === 24 * 60 * 60 * 1000
    }
    const hasLegacyBootstrapEvidence = (record) => (
      record.createdBy === 'system'
      && !record.prefix.startsWith('hmrb_')
      && (
        (record.name === 'Master Key' && record.expiresAt == null)
        || (record.name === 'Bootstrap Master Key' && hasLegacyBootstrapTtl(record))
      )
    )
    const allowLegacyPurposeInference = apiKeyRecordSchemaVersion === undefined
    const classifyPurpose = (record) => {
      if (!isRecord(record)) {
        throw new Error('invalid API key record')
      }
      if (record.purpose === 'bootstrap' || record.purpose === 'permanent') {
        return record.purpose
      }
      if (record.purpose !== undefined || !allowLegacyPurposeInference) {
        throw new Error('invalid API key purpose')
      }

      // Keep installer retries aligned with the one-time migration in
      // server/api-keys/store.ts. Ambiguous legacy records are permanent so a
      // plaintext file cannot regain bootstrap authority during an upgrade.
      return hasLegacyBootstrapEvidence(record) ? 'bootstrap' : 'permanent'
    }
    const classifiedRecords = collection.keys.map((record) => ({
      record,
      purpose: classifyPurpose(record),
    }))

    const now = Date.now()
    const isActive = (record) => {
      if (!record.expiresAt) {
        return true
      }
      const expiresAt = Date.parse(record.expiresAt)
      return Number.isFinite(expiresAt) && expiresAt > now
    }
    const keyHash = createHash('sha256').update(bootstrapKey).digest('hex')
    const hasActivePermanentKey = classifiedRecords.some(({ record, purpose }) => (
      purpose === 'permanent' && isActive(record)
    ))
    const hasMatchingBootstrapKey = classifiedRecords.some(({ record, purpose }) => (
      purpose === 'bootstrap'
      && record.keyHash === keyHash
      && isActive(record)
    ))

    process.exit(!hasActivePermanentKey && hasMatchingBootstrapKey ? 0 : 1)
  } catch {
    process.exit(2)
  }
NODE
}

prepare_bootstrap_key() {
  local bootstrap_resume_status

  if [ -e "$API_KEY_STORE_FILE" ]; then
    if [ -e "$BOOTSTRAP_KEY_FILE" ]; then
      if bootstrap_key_can_resume_first_boot; then
        read_bootstrap_key \
          || fail "The resumable first-boot key file could not be read: $BOOTSTRAP_KEY_FILE"
        ok "resuming the unfinished first boot with its existing bootstrap key"
        return 0
      else
        bootstrap_resume_status=$?
        if [ "$bootstrap_resume_status" -eq 2 ]; then
          fail "Cannot safely inspect the API-key keystore at $API_KEY_STORE_FILE; repair it before rerunning the installer."
        fi
      fi

      rm -f -- "$BOOTSTRAP_KEY_FILE"
      ok "discarded a plaintext bootstrap key that is no longer the only active access path"
    fi
    INSTALL_BOOTSTRAP_KEY=""
    ok "API-key keystore already initialized; bootstrap access will not be recreated"
    return 0
  fi

  if read_bootstrap_key; then
    ok "using the existing local bootstrap key file"
    return 0
  fi

  local bootstrap_key
  bootstrap_key="$("$NODE_BIN" -e "process.stdout.write(require('node:crypto').randomBytes(48).toString('base64url'))")"
  [ -n "$bootstrap_key" ] || fail "Could not generate the first-boot bootstrap key."

  mkdir -p "$(dirname "$BOOTSTRAP_KEY_FILE")"
  (umask 077 && printf '%s\n' "$bootstrap_key" > "$BOOTSTRAP_KEY_FILE")
  chmod 600 "$BOOTSTRAP_KEY_FILE"
  INSTALL_BOOTSTRAP_KEY="$bootstrap_key"
  ok "created a local first-boot bootstrap key file with mode 0600"
}

start_first_boot() {
  local port="$1"
  local login_url="http://localhost:${port}/welcome"
  local -a bootstrap_env=()

  INSTALL_LOGIN_URL="$login_url"
  step "Starting ${PRODUCT_NAME} for first boot"
  mkdir -p "$BOOTSTRAP_LOG_DIR"
  rm -f "$BOOTSTRAP_LOG_FILE"
  prepare_bootstrap_key
  if [[ -n "$INSTALL_BOOTSTRAP_KEY" ]]; then
    bootstrap_env=(HERD_BOOTSTRAP_MASTER_KEY="$INSTALL_BOOTSTRAP_KEY")
  fi

  if auth0_enabled; then
    env "${bootstrap_env[@]}" "$SHIM_PATH" up >"$BOOTSTRAP_LOG_FILE" 2>&1 &
  else
    env \
      -u AUTH0_DOMAIN \
      -u AUTH0_AUDIENCE \
      -u AUTH0_CLIENT_ID \
      -u VITE_AUTH0_DOMAIN \
      -u VITE_AUTH0_AUDIENCE \
      -u VITE_AUTH0_CLIENT_ID \
      "${bootstrap_env[@]}" \
      "$SHIM_PATH" up >"$BOOTSTRAP_LOG_FILE" 2>&1 &
  fi
  local boot_pid=$!

  if ! wait_for_first_boot "$port" "$boot_pid"; then
    if kill -0 "$boot_pid" >/dev/null 2>&1; then
      kill "$boot_pid" >/dev/null 2>&1 || true
    fi
    fail "First boot did not become healthy in time. Inspect $BOOTSTRAP_LOG_FILE"
  fi

  ok "${PRODUCT_NAME} is running at ${login_url}"
  printf '\n%s\n' "${GREEN}${PRODUCT_NAME} is ready.${NC}"
}

configure_cli_from_first_boot() {
  local port="$1"
  local endpoint="http://localhost:${port}"
  local config_path="$HOME/.herd.json"
  local config_action="configured"

  step "Configuring local herd CLI"

  if [[ -z "$INSTALL_BOOTSTRAP_KEY" ]]; then
    if [[ -f "$config_path" ]]; then
      INSTALL_CLI_CONFIG_STATUS="already present: $config_path"
      ok "$INSTALL_CLI_CONFIG_STATUS"
      return 0
    fi
    fail "Cannot configure the local CLI because this keystore is already initialized and bootstrap access cannot be recreated. Restore the existing CLI config or onboard with a valid permanent API key."
  fi

  if [[ -f "$config_path" ]]; then
    config_action="refreshed"
  fi

  "$SHIM_PATH" onboard \
    --non-interactive \
    --endpoint "$endpoint" \
    --api-key "$INSTALL_BOOTSTRAP_KEY" \
    --agents claude-code,codex,terminal-cri \
    --skip-founder-operator \
    --skip-tailscale

  INSTALL_CLI_CONFIG_STATUS="$config_action: $config_path"
  ok "$INSTALL_CLI_CONFIG_STATUS"
}

print_receipt_line() {
  local label="$1"
  local value="$2"
  printf "  ${BOLD}%-18s${NC} %s\n" "$label" "$value"
}

print_install_receipt() {
  printf "\n${GREEN}╔════════════════════════════════════════════════════════════╗${NC}\n"
  printf "${GREEN}║${NC} ${BOLD}Herd setup complete${NC}                                     ${GREEN}║${NC}\n"
  printf "${GREEN}╚════════════════════════════════════════════════════════════╝${NC}\n"
  print_receipt_line "URL" "${INSTALL_LOGIN_URL:-http://localhost:${PORT:-$DEFAULT_PORT}/welcome}"
  print_receipt_line "Account" "local bootstrap admin"
  print_receipt_line "Password" "not used"
  if [[ -n "$INSTALL_BOOTSTRAP_KEY" ]]; then
    print_receipt_line "Bootstrap access" "stored locally; expires within 24 hours"
    print_receipt_line "Key file" "$INSTALL_KEY_FILE"
  else
    print_receipt_line "Bootstrap access" "not recreated for the existing keystore"
  fi
  print_receipt_line "CLI" "$SHIM_PATH"
  print_receipt_line "CLI config" "$INSTALL_CLI_CONFIG_STATUS"
  print_receipt_line "Doctor" "herd doctor"
  print_receipt_line "App directory" "$APP_DIR"
  print_receipt_line "Data directory" "$DATA_DIR"
  print_receipt_line "Install started" "$HERD_INSTALL_STARTED_AT_ISO"
  print_receipt_line "Autostart" "$INSTALL_AUTOSTART_STATUS"
  print_receipt_line "Log" "$INSTALL_LOG_FILE"

  if [[ -n "$INSTALL_PATH_NOTE" ]]; then
    printf "\n${YELLOW}PATH setup${NC}\n"
    printf "  %s\n" "$INSTALL_PATH_NOTE"
  fi

  print_provider_summary
}

print_configuration_saved_summary() {
  printf "\n${GREEN}✓${NC} ${BOLD}Configuration saved${NC}\n"
  printf "  URL: %s\n" "${INSTALL_LOGIN_URL:-http://localhost:${PORT:-$DEFAULT_PORT}/welcome}"
  printf "  CLI: %s\n" "$SHIM_PATH"
  printf "  CLI config: %s\n" "$INSTALL_CLI_CONFIG_STATUS"
  printf "  App path: %s\n" "$APP_PATH_FILE"
  printf "\n${CYAN}Next commands${NC}\n"
  printf "  herd doctor\n"
  printf "  herd up\n"
  printf "  Open Herd, finish browser onboarding, then start the first commander conversation from Command Room.\n"
}

brand_opener
INSTALL_SETUP_PATH="$(choose_setup_path)"
case "$INSTALL_SETUP_PATH" in
  advanced)
    printf "${CYAN}==>${NC} Advanced setup selected\n"
    ;;
  *)
    printf "${CYAN}==>${NC} Quickstart selected (recommended)\n"
    ;;
esac
printf "  app:  %s\n" "$APP_DIR"
printf "  repo: %s\n" "$REPO_ROOT"
printf "  bin:  %s\n\n" "$SHIM_PATH"

step "Checking prerequisites"
require_command_or_prompt curl
require_command_or_prompt tar
ensure_node
export PATH="$NODE_HOME/bin:$PATH"
ensure_pnpm
export PATH="$PROVIDER_BIN_DIR:$PNPM_HOME/bin:$NODE_HOME/bin:$PATH"

configure_environment

step "Installing workspace dependencies"
"$PNPM_BIN" --dir "$REPO_ROOT" install --frozen-lockfile

build_herd

[ -x "$CLI_PKG_DIR/$CLI_BIN_REL" ] || chmod +x "$CLI_PKG_DIR/$CLI_BIN_REL" 2>/dev/null || true
[ -f "$CLI_PKG_DIR/dist/index.js" ] || fail "CLI build missing at $CLI_PKG_DIR/dist/index.js"

step "Recording app path"
mkdir -p "$DATA_DIR"
seed_runtime_defaults
printf "%s\n" "$APP_DIR" > "$APP_PATH_FILE"
printf '{\n  "startedAt": "%s",\n  "startedAtMs": %s,\n  "source": "install.sh"\n}\n' \
  "$HERD_INSTALL_STARTED_AT_ISO" \
  "$HERD_INSTALL_STARTED_AT_MS" \
  > "$INSTALL_STARTED_AT_FILE"
ok "wrote $APP_PATH_FILE"

step "Installing herd CLI shim"
mkdir -p "$BIN_DIR"
shim_data_dir="$(single_quote "$DATA_DIR")"
cat > "$SHIM_PATH" <<EOF
#!/usr/bin/env bash
export PATH="$PROVIDER_BIN_DIR:$PNPM_HOME/bin:$NODE_HOME/bin:\$PATH"
if [ -z "\${HERD_DATA_DIR:-}" ]; then
  export HERD_DATA_DIR=$shim_data_dir
fi
exec "$NODE_BIN" "$CLI_PKG_DIR/$CLI_BIN_REL" "\$@"
EOF
chmod +x "$SHIM_PATH"
ensure_local_path_setup
ok "installed $SHIM_PATH"

install_default_skills
configure_providers "$INSTALL_SETUP_PATH"
ensure_json_stores_control_plane
ensure_sqlite_control_plane

case ":$PATH:" in
  *":$BIN_DIR:"*) ok "$BIN_DIR already on PATH" ;;
  *)
    INSTALL_PATH_NOTE="Add $BIN_DIR to PATH, then reopen your shell: export PATH=\"$BIN_DIR:\$PATH\""
    warn "Add $BIN_DIR to PATH, then reopen your shell:"
    printf "    export PATH=\"%s:\$PATH\"\n" "$BIN_DIR"
    ;;
esac

PORT="$(read_configured_port)"
start_first_boot "$PORT"
configure_cli_from_first_boot "$PORT"

install_launch_agent_if_needed

print_configuration_saved_summary
print_install_receipt

printf "\n${GREEN}Next:${NC}\n"
if [[ -n "$INSTALL_BOOTSTRAP_KEY" ]]; then
  printf "  1. Sign in with the bootstrap key stored in %s.\n" "$INSTALL_KEY_FILE"
else
  printf "  1. Sign in with the existing permanent API key or the already-configured local CLI.\n"
fi
if [[ "$INSTALL_AUTOSTART_STATUS" == installed:* ]]; then
  printf "  2. Complete browser onboarding within 24 hours, create a permanent API key, revoke the bootstrap key, then delete %s.\n" "$INSTALL_KEY_FILE"
  if [[ "$(uname -s)" == "Darwin" ]]; then
    printf "  3. Herd now auto-starts at login via launchd.\n"
    printf "     Reload after config changes with:\n"
    printf "       ${CYAN}launchctl kickstart -k gui/%s/io.gehirn.hervald${NC}\n" "$(id -u)"
  else
    printf "  3. Herd now auto-starts via systemd user service.\n"
    printf "     Reload after config changes with:\n"
    printf "       ${CYAN}systemctl --user restart %s${NC}\n" "$SYSTEMD_USER_UNIT_NAME"
  fi
  printf "  4. Run ${CYAN}herd doctor${NC} after provider authentication if you want a readiness report.\n"
else
  printf "  2. Complete browser onboarding within 24 hours, create a permanent API key, revoke the bootstrap key, then delete %s.\n" "$INSTALL_KEY_FILE"
  printf "  3. The server is already running in the background.\n"
  printf "     Restart later with ${CYAN}herd up${NC} (or ${CYAN}herd up --dev${NC} for hot reload).\n"
  printf "  4. Run ${CYAN}herd doctor${NC} after provider authentication if you want a readiness report.\n"
fi
