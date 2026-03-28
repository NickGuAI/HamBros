# Hammurabi Terminal-Bench Agent

Hammurabi agent adapter for [Terminal-Bench](https://tbench.ai) — Stanford's benchmark for evaluating AI agents on real-world terminal tasks.

## Architecture

**External agent pattern**: the LLM loop runs on the host machine and interacts with Docker containers via `TmuxSession` (send_keys / capture_pane). This keeps `ANTHROPIC_API_KEY` on the host and gives full access to the Hammurabi telemetry server.

```
┌──────────────┐      ┌─────────────────┐     ┌──────────────┐
│ tb harness   │─────▶│ HammurabiAgent  │────▶│ Hammurabi    │
│ (Python)     │      │ (Anthropic SDK) │ HTTP│ API :20001   │
│              │      │                 │     │ (telemetry)  │
│ perform_task │      │ Agentic loop:   │     └──────────────┘
└──────────────┘      │ read terminal → │
                      │ call Claude API │
                      │ with tools →    │
                      │ execute command │
                      │ → loop          │
                      └────────┬────────┘
                               │ send_keys / capture_pane
                      ┌────────▼────────┐
                      │ Docker Container│
                      │ (tmux session)  │
                      └─────────────────┘
```

## Setup

```bash
# Install terminal-bench (if not already)
pip install terminal-bench

# Install this adapter (editable)
cd apps/hammurabi/agents/terminal_bench
pip install -e .

# Verify
python3 -c "from hammurabi_tbench import HammurabiAgent; print(HammurabiAgent.name())"
# -> hammurabi
```

## Usage

### Single task

```bash
ANTHROPIC_API_KEY=sk-ant-api03-... tb run \
  --agent-import-path "hammurabi_tbench:HammurabiAgent" \
  --task-id hello-world \
  -k model_name=claude-sonnet-4-20250514
```

### Full benchmark (80 tasks)

```bash
ANTHROPIC_API_KEY=sk-ant-api03-... tb run \
  --agent-import-path "hammurabi_tbench:HammurabiAgent" \
  -k model_name=claude-sonnet-4-20250514 \
  --dataset "terminal-bench-core==0.1.1" \
  --n-concurrent 2
```

### With Hammurabi telemetry

Start the Hammurabi server first, then the agent will automatically report per-turn token usage:

```bash
# In another terminal
cd apps/hammurabi && npm run dev

# Run benchmark (telemetry auto-reports to localhost:20001)
ANTHROPIC_API_KEY=sk-ant-api03-... tb run \
  --agent-import-path "hammurabi_tbench:HammurabiAgent" \
  --task-id hello-world \
  -k model_name=claude-sonnet-4-20250514 \
  -k hammurabi_url=http://localhost:20001
```

## Agent kwargs

| Kwarg | Default | Description |
|-------|---------|-------------|
| `model_name` | `claude-sonnet-4-20250514` | Anthropic model to use |
| `max_episodes` | `200` | Max agentic turns before timeout |
| `hammurabi_url` | `http://localhost:20001` | Hammurabi server URL for telemetry |

## Requirements

- Docker running (for terminal-bench containers)
- `ANTHROPIC_API_KEY` environment variable (console API key, not OAuth token)
- Python 3.12+

## Leaderboard submission

After a full 80-task run:

```bash
tb run \
  --agent-import-path "hammurabi_tbench:HammurabiAgent" \
  -k model_name=claude-sonnet-4-20250514 \
  --dataset "terminal-bench-core==0.1.1" \
  --upload-results
```

Requires 5 full runs for official leaderboard submission at https://tbench.ai/leaderboard/terminal-bench/1.0
