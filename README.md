<p align="center">
  <img src="app/public/logo.png" alt="HamBros Logo" width="120" />
</p>

<h1 align="center">HamBros</h1>

<p align="center">
  Source-available agent observability platform — monitor, trace, and manage your AI agents in one place.
</p>

---

HamBros is a self-hosted dashboard for AI agent teams. It gives you real-time visibility into running agents, OpenTelemetry trace ingestion, API key management, a cron-based command room, and a factory interface for spinning up new agent sessions.

## Features

| Module | Description |
|--------|-------------|
| **Agents Monitor** | Live view of agent sessions — status, logs, interactive terminal |
| **Telemetry Hub** | OTLP/HTTP trace and log ingestion with cost tracking |
| **Services Manager** | Manage external AI services and their API keys |
| **Factory** | Create and configure new agent sessions via a form wizard |
| **Commanders** | GitHub-backed agent personas with memory and task tracking |
| **Command Room** | Cron-scheduled commands that trigger agents automatically |
| **Settings** | Auth, encryption, and per-module configuration |

## Architecture

```
releases/hambros/
├── app/            # React + Express monorepo package
│   ├── src/        # React frontend (Vite + TypeScript)
│   ├── server/     # Express API server (Node.js + TypeScript)
│   └── modules/    # Feature modules (agents, telemetry, commanders, ...)
└── packages/
    ├── auth-providers/   # Auth0 / API-key auth abstractions
    ├── telemetry/        # Cost and usage tracking
    ├── sse-streaming/    # Server-Sent Events utilities
    ├── cli/              # HamBros CLI
    └── tsconfig/         # Shared TypeScript base config
```

**Stack:** React 18 · Vite · TailwindCSS · Express · TypeScript · pnpm workspaces · Capacitor (iOS)

## Prerequisites

- **Node.js** 20+
- **pnpm** 9+
- Auth0 is **not required** — HamBros works with API keys only out of the box

## Quick Start

```bash
curl -fsSL https://raw.githubusercontent.com/NickGuAI/HamBros/main/install.sh | bash
hambros init
hambros start
```

This installs HamBros into `~/.hambros` by default, writes `app/.env` via the interactive init flow, and starts the server from the correct app root regardless of your current working directory.

## Development Setup

```bash
git clone https://github.com/NickGuAI/HamBros.git
cd HamBros
pnpm install
pnpm --filter hambros run build:deps
pnpm --filter hambros run dev
```

Open `http://localhost:5173` in your browser.

## Default Master Key

On first startup, HamBros seeds a **Master Key** with the value:

```
HAMBROS!
```

Enter this key on the login page to get in immediately — no Auth0 setup needed.

Once logged in, go to **Settings → API Keys** to create your own keys, then **delete the Master Key**. It has full access to everything until removed.

> **Security:** Delete the Master Key before exposing HamBros to the internet.

## Environment Variables

All variables go in `app/.env`. Copy `app/.env.example` as a starting point.

### Server (required)

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `20001` | Port the Express API server listens on |
| `HAMBROS_ALLOWED_ORIGINS` | — | Comma-separated list of allowed CORS origins (e.g. `http://localhost:5173`) |
| `NODE_ENV` | — | Set to `production` to enable static file serving from `dist/` |

### Auth0 (optional — skip for API-key-only mode)

| Variable | Description |
|----------|-------------|
| `AUTH0_DOMAIN` | Your Auth0 tenant domain (e.g. `your-tenant.us.auth0.com`) |
| `AUTH0_AUDIENCE` | Auth0 API identifier (e.g. `https://hambros-api`) |
| `AUTH0_CLIENT_ID` | Auth0 application client ID |
| `VITE_AUTH0_DOMAIN` | Same as `AUTH0_DOMAIN` — exposed to the Vite frontend |
| `VITE_AUTH0_AUDIENCE` | Same as `AUTH0_AUDIENCE` — exposed to the Vite frontend |
| `VITE_AUTH0_CLIENT_ID` | Same as `AUTH0_CLIENT_ID` — exposed to the Vite frontend |

### Frontend

| Variable | Description |
|----------|-------------|
| `VITE_APP_URL` | Production server URL. Required for Capacitor iOS bundled mode (e.g. `https://your-server.com`). Leave empty for web-only local dev. |

### Optional

| Variable | Description |
|----------|-------------|
| `GITHUB_TOKEN` | GitHub PAT (`repo:read` scope) — enables Commander task fetching from private repos |
| `HAMBROS_SETTINGS_ENCRYPTION_KEY` | Encryption key for sensitive settings storage. Auto-generated at startup if unset. |
| `HAMBROS_TELEMETRY_SCAN_INTERVAL_MS` | Telemetry scan interval in milliseconds (default: `5000`) |

## Development Commands

All commands run from the workspace root unless noted.

```bash
# Install all workspace dependencies
pnpm install

# Build internal packages (run once after install or when packages change)
pnpm --filter hambros run build:deps

# Start full dev stack (Express API + Vite HMR)
pnpm --filter hambros run dev

# Start only the frontend (Vite)
pnpm --filter hambros run dev:client

# Start only the API server
pnpm --filter hambros run dev:server

# Production build
pnpm --filter hambros run build

# Run tests
pnpm --filter hambros run test

# Lint
pnpm --filter hambros run lint
```

## Data Directory

HamBros stores runtime data in `app/data/`. The following subdirectories are gitignored and created automatically at startup:

```
app/data/
├── agents/       # Agent session state
├── api-keys/     # Encrypted API key storage
├── commanders/   # Commander memory and journal files
├── command-room/ # Scheduled command configurations
└── telemetry/    # OTLP trace and log storage
```

> **Security note:** `api-keys/` contains encrypted secrets. Never commit this directory. It is included in `.gitignore`.

## OpenTelemetry Ingestion

HamBros accepts OTLP/HTTP traces and logs on the Express server:

- **Traces:** `POST /v1/traces` (content-type: `application/json`)
- **Logs:** `POST /v1/logs` (content-type: `application/json`)

Point your OTEL exporter at `http://localhost:20001` to start ingesting.

Use the `@hambros/cli` package to initialize a local install or onboard agents:

```bash
pnpm --filter hambros run init
pnpm --filter hambros run onboard
```

## iOS / Capacitor

HamBros supports native iOS via Capacitor. Set `VITE_APP_URL` to your deployed server URL, then:

```bash
pnpm --filter hambros run cap:sync   # Sync web assets to Xcode project
pnpm --filter hambros run cap:ios    # Open in Xcode
```

## License

HamBros is source-available under the [PolyForm Noncommercial 1.0.0](./LICENSE)
license.

- Personal and other noncommercial uses are permitted under that license.
- Commercial use requires a separate written commercial license.
- See [COMMERCIAL-LICENSING.md](./COMMERCIAL-LICENSING.md) for the commercial
  licensing note.

HamBros is not distributed under an OSI-approved open source license.
