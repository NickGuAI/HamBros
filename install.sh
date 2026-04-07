#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${HAMBROS_REPO_URL:-https://github.com/NickGuAI/HamBros.git}"
HAMBROS_HOME="${HAMBROS_HOME:-${HOME}/.hambros}"
BIN_DIR="${HOME}/.local/bin"
CLI_PATH="${HAMBROS_HOME}/app/hambros-cli.mjs"
MAIN_BRANCH="${HAMBROS_BRANCH:-main}"

log() {
  printf '[hambros-install] %s\n' "$1"
}

fail() {
  printf '[hambros-install] ERROR: %s\n' "$1" >&2
  exit 1
}

detect_platform() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"

  case "${os}" in
    Linux|Darwin) ;;
    *)
      fail "Unsupported operating system: ${os}. HamBros install.sh supports Linux and macOS."
      ;;
  esac

  case "${arch}" in
    x86_64|arm64|aarch64) ;;
    *)
      fail "Unsupported architecture: ${arch}. Supported architectures: x86_64, arm64."
      ;;
  esac
}

ensure_git() {
  command -v git >/dev/null 2>&1 || fail "git is required but was not found on PATH."
  command -v curl >/dev/null 2>&1 || fail "curl is required but was not found on PATH."
}

node_major_version() {
  node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true
}

load_nvm() {
  export NVM_DIR="${HOME}/.nvm"
  if [[ -s "${NVM_DIR}/nvm.sh" ]]; then
    # shellcheck source=/dev/null
    . "${NVM_DIR}/nvm.sh"
    return 0
  fi
  return 1
}

install_node_with_nvm() {
  if ! load_nvm; then
    log "Installing nvm"
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
    load_nvm || fail "nvm installation completed but nvm could not be loaded."
  fi

  log "Installing Node.js 20 with nvm"
  nvm install 20
  nvm alias default 20 >/dev/null
}

install_node() {
  if command -v node >/dev/null 2>&1; then
    local major
    major="$(node_major_version)"
    if [[ -n "${major}" && "${major}" -ge 20 ]]; then
      return 0
    fi
  fi

  if command -v nvm >/dev/null 2>&1 || load_nvm; then
    install_node_with_nvm
    return 0
  fi

  case "$(uname -s)" in
    Darwin)
      if command -v brew >/dev/null 2>&1; then
        log "Installing Node.js 20 with Homebrew"
        brew install node@20
        if [[ -d /opt/homebrew/opt/node@20/bin ]]; then
          export PATH="/opt/homebrew/opt/node@20/bin:${PATH}"
        elif [[ -d /usr/local/opt/node@20/bin ]]; then
          export PATH="/usr/local/opt/node@20/bin:${PATH}"
        fi
        return 0
      fi
      ;;
    Linux)
      if command -v apt-get >/dev/null 2>&1; then
        log "Installing Node.js 20 with apt"
        curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
        sudo apt-get install -y nodejs
        return 0
      fi
      ;;
  esac

  install_node_with_nvm
}

install_pnpm() {
  command -v corepack >/dev/null 2>&1 || fail "corepack was not found after Node.js installation."
  log "Enabling pnpm via corepack"
  corepack enable
  corepack prepare pnpm@latest --activate
}

confirm_upgrade() {
  if [[ ! -t 0 ]]; then
    return 0
  fi

  local answer
  read -r -p "Existing HamBros install found at ${HAMBROS_HOME}. Upgrade it? [Y/n] " answer
  case "${answer:-Y}" in
    Y|y|yes|YES|'') return 0 ;;
    *) return 1 ;;
  esac
}

clone_or_update_repo() {
  if [[ -d "${HAMBROS_HOME}/.git" ]]; then
    confirm_upgrade || {
      log "Leaving existing install unchanged."
      exit 0
    }

    if [[ -n "$(git -C "${HAMBROS_HOME}" status --porcelain)" ]]; then
      fail "Existing install has local changes. Clean them up before re-running install.sh."
    fi

    log "Updating existing HamBros checkout"
    git -C "${HAMBROS_HOME}" fetch origin "${MAIN_BRANCH}"
    git -C "${HAMBROS_HOME}" switch "${MAIN_BRANCH}"
    git -C "${HAMBROS_HOME}" pull --ff-only origin "${MAIN_BRANCH}"
    return 0
  fi

  if [[ -e "${HAMBROS_HOME}" ]]; then
    fail "${HAMBROS_HOME} already exists and is not a git checkout."
  fi

  mkdir -p "$(dirname "${HAMBROS_HOME}")"
  log "Cloning HamBros into ${HAMBROS_HOME}"
  git clone --depth 1 --branch "${MAIN_BRANCH}" "${REPO_URL}" "${HAMBROS_HOME}"
}

build_hambros() {
  log "Installing workspace dependencies"
  pnpm --dir "${HAMBROS_HOME}" install --frozen-lockfile

  log "Building HamBros release"
  pnpm --dir "${HAMBROS_HOME}" --filter hambros run build
}

install_cli_symlink() {
  [[ -x "${CLI_PATH}" ]] || fail "Expected CLI entrypoint at ${CLI_PATH} after build."

  mkdir -p "${BIN_DIR}"
  ln -sfn "${CLI_PATH}" "${BIN_DIR}/hambros"

  if [[ ":${PATH}:" != *":${BIN_DIR}:"* ]]; then
    log "Added hambros to ${BIN_DIR}, but that directory is not on PATH."
    log "Add this to your shell profile: export PATH=\"${BIN_DIR}:\$PATH\""
  fi
}

main() {
  detect_platform
  ensure_git
  install_node
  install_pnpm
  clone_or_update_repo
  build_hambros
  install_cli_symlink

  log "Install complete."
  log "Next step: run 'hambros init' to configure your instance."
}

main "$@"
