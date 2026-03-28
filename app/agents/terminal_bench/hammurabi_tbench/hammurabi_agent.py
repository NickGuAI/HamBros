"""Hammurabi agent adapter for Terminal-Bench.

External agent pattern: runs the LLM loop on the host machine and interacts
with the Docker container via TmuxSession (send_keys / capture_pane).
"""

import json
import logging
import os
import time
from pathlib import Path

import anthropic

from terminal_bench.agents.base_agent import AgentResult, BaseAgent
from terminal_bench.agents.failure_mode import FailureMode
from terminal_bench.terminal.tmux_session import TmuxSession

from hammurabi_tbench.telemetry import HammurabiReporter
from hammurabi_tbench.tools import SYSTEM_PROMPT, TOOLS

logger = logging.getLogger(__name__)

# Truncation limit for terminal output (bytes)
MAX_OUTPUT_BYTES = 10_000
# Default max agentic turns
DEFAULT_MAX_EPISODES = 200


def _truncate_output(output: str, max_bytes: int = MAX_OUTPUT_BYTES) -> str:
    """Truncate output keeping first and last halves if too long."""
    encoded = output.encode("utf-8")
    if len(encoded) <= max_bytes:
        return output
    half = max_bytes // 2
    first = encoded[:half].decode("utf-8", errors="ignore")
    last = encoded[-half:].decode("utf-8", errors="ignore")
    omitted = len(encoded) - len(first.encode("utf-8")) - len(last.encode("utf-8"))
    return (
        f"{first}\n"
        f"[... truncated {omitted} bytes ...]\n"
        f"{last}"
    )


class HammurabiAgent(BaseAgent):
    """Hammurabi agent for terminal-bench benchmarks.

    Uses the Anthropic Python SDK with tool_use to drive an agentic loop.
    Interacts with the Docker container exclusively via TmuxSession.
    Reports telemetry to the Hammurabi server (graceful degradation).
    """

    def __init__(
        self,
        model_name: str = "claude-sonnet-4-20250514",
        max_episodes: int | None = None,
        hammurabi_url: str = "http://localhost:20001",
        **kwargs,
    ):
        super().__init__(**kwargs)
        self._model_name = model_name
        self._max_episodes = max_episodes or DEFAULT_MAX_EPISODES
        self._client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY from env
        self._reporter = HammurabiReporter(hammurabi_url)
        self._total_input_tokens = 0
        self._total_output_tokens = 0
        self._timestamped_markers: list[tuple[float, str]] = []
        self._pending_completion = False

    @staticmethod
    def name() -> str:
        return "hammurabi"

    def _record_marker(self, text: str, session: TmuxSession) -> None:
        ts = session.get_asciinema_timestamp()
        self._timestamped_markers.append((ts, text))

    def _execute_command(
        self,
        command: str,
        timeout: int,
        session: TmuxSession,
    ) -> str:
        """Send a command to the container and return the output."""
        # Send the command + Enter
        session.send_keys(
            command + "\n",
            block=True,
            max_timeout_sec=timeout,
        )
        # Small delay for output to settle
        time.sleep(0.5)
        output = session.get_incremental_output()
        return _truncate_output(output)

    def _build_initial_message(
        self, instruction: str, session: TmuxSession
    ) -> str:
        terminal_state = _truncate_output(session.get_incremental_output())
        return (
            f"## Task\n\n{instruction}\n\n"
            f"## Current Terminal State\n\n```\n{terminal_state}\n```\n\n"
            f"Solve this task by executing commands in the terminal. "
            f"When done, call the task_complete tool."
        )

    def perform_task(
        self,
        instruction: str,
        session: TmuxSession,
        logging_dir: Path | None = None,
    ) -> AgentResult:
        instruction = self._render_instruction(instruction)

        if logging_dir:
            logging_dir.mkdir(parents=True, exist_ok=True)

        messages = [
            {"role": "user", "content": self._build_initial_message(instruction, session)}
        ]

        failure_mode = FailureMode.NONE
        task_id = os.environ.get("TB_TASK_ID", "unknown")

        try:
            failure_mode = self._run_loop(messages, session, logging_dir, instruction, task_id)
        except anthropic.APIStatusError as e:
            logger.error("Anthropic API error: %s", e)
            if "context_length" in str(e).lower():
                failure_mode = FailureMode.CONTEXT_LENGTH_EXCEEDED
            else:
                failure_mode = FailureMode.UNKNOWN_AGENT_ERROR
        except Exception as e:
            logger.error("Agent error: %s", e)
            failure_mode = FailureMode.UNKNOWN_AGENT_ERROR

        self._reporter.report_complete(
            task_id=task_id,
            total_input_tokens=self._total_input_tokens,
            total_output_tokens=self._total_output_tokens,
            model=self._model_name,
            success=(failure_mode == FailureMode.NONE),
        )

        return AgentResult(
            total_input_tokens=self._total_input_tokens,
            total_output_tokens=self._total_output_tokens,
            failure_mode=failure_mode,
            timestamped_markers=self._timestamped_markers,
        )

    def _run_loop(
        self,
        messages: list[dict],
        session: TmuxSession,
        logging_dir: Path | None,
        instruction: str,
        task_id: str,
    ) -> FailureMode:
        """Main agentic loop. Returns the failure mode."""
        for episode in range(self._max_episodes):
            if not session.is_session_alive():
                logger.info("Session ended at episode %d", episode)
                return FailureMode.NONE

            self._record_marker(f"Episode {episode}", session)

            # Call Claude with tools
            response = self._client.messages.create(
                model=self._model_name,
                max_tokens=4096,
                system=SYSTEM_PROMPT,
                tools=TOOLS,
                messages=messages,
            )

            # Accumulate tokens
            self._total_input_tokens += response.usage.input_tokens
            self._total_output_tokens += response.usage.output_tokens

            self._reporter.report_turn(
                turn=episode,
                input_tokens=response.usage.input_tokens,
                output_tokens=response.usage.output_tokens,
                model=self._model_name,
                task_id=task_id,
            )

            # Log episode if logging_dir set
            if logging_dir:
                ep_dir = logging_dir / f"episode-{episode}"
                ep_dir.mkdir(parents=True, exist_ok=True)
                self._log_response(ep_dir, response)

            # Process response
            assistant_content = response.content
            messages.append({"role": "assistant", "content": assistant_content})

            # If stop_reason is "end_turn" with no tool use, agent decided to stop
            if response.stop_reason == "end_turn":
                # Check if there were any tool calls in this response
                has_tool_use = any(
                    block.type == "tool_use" for block in assistant_content
                )
                if not has_tool_use:
                    logger.info("Agent stopped without tool call at episode %d", episode)
                    return FailureMode.NONE

            # Process tool calls
            tool_results = []
            task_done = False

            for block in assistant_content:
                if block.type != "tool_use":
                    continue

                tool_name = block.name
                tool_input = block.input
                tool_use_id = block.id

                if tool_name == "bash_command":
                    cmd = tool_input.get("command", "")
                    timeout = tool_input.get("timeout", 30)
                    logger.info("Episode %d: bash_command(%s, timeout=%d)", episode, cmd[:80], timeout)

                    try:
                        output = self._execute_command(cmd, timeout, session)
                    except TimeoutError:
                        output = (
                            f"[TIMEOUT] Command timed out after {timeout}s. "
                            f"Terminal state:\n{_truncate_output(session.capture_pane(capture_entire=False))}"
                        )
                    except Exception as e:
                        output = f"[ERROR] Failed to execute command: {e}"

                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": tool_use_id,
                        "content": output if output.strip() else "(no output)",
                    })

                elif tool_name == "task_complete":
                    explanation = tool_input.get("explanation", "")
                    logger.info("Episode %d: task_complete(%s)", episode, explanation[:80])

                    if self._pending_completion:
                        # Double-confirmed — actually complete
                        tool_results.append({
                            "type": "tool_result",
                            "tool_use_id": tool_use_id,
                            "content": "Task marked as complete.",
                        })
                        task_done = True
                    else:
                        # First call — ask for confirmation
                        self._pending_completion = True
                        terminal_state = _truncate_output(
                            session.capture_pane(capture_entire=False)
                        )
                        tool_results.append({
                            "type": "tool_result",
                            "tool_use_id": tool_use_id,
                            "content": (
                                f"Current terminal state:\n{terminal_state}\n\n"
                                "Are you sure the task is complete? This will trigger "
                                "grading and you cannot make further changes. If you "
                                "are sure, call task_complete again to confirm."
                            ),
                        })

                else:
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": tool_use_id,
                        "content": f"Unknown tool: {tool_name}",
                        "is_error": True,
                    })

            if task_done:
                return FailureMode.NONE

            # Reset pending_completion if no task_complete was called this turn
            if not any(
                block.type == "tool_use" and block.name == "task_complete"
                for block in assistant_content
            ):
                self._pending_completion = False

            # Append tool results as user message
            if tool_results:
                messages.append({"role": "user", "content": tool_results})

        # Exhausted max episodes
        logger.warning("Agent exhausted %d episodes", self._max_episodes)
        return FailureMode.AGENT_TIMEOUT

    def _log_response(self, ep_dir: Path, response) -> None:
        """Log a response to the episode directory."""
        try:
            log_data = {
                "model": response.model,
                "stop_reason": response.stop_reason,
                "usage": {
                    "input_tokens": response.usage.input_tokens,
                    "output_tokens": response.usage.output_tokens,
                },
                "content": [
                    {
                        "type": block.type,
                        **({"text": block.text} if block.type == "text" else {}),
                        **(
                            {
                                "name": block.name,
                                "input": block.input,
                            }
                            if block.type == "tool_use"
                            else {}
                        ),
                    }
                    for block in response.content
                ],
            }
            (ep_dir / "response.json").write_text(
                json.dumps(log_data, indent=2, default=str)
            )
        except Exception as e:
            logger.debug("Failed to log response: %s", e)
