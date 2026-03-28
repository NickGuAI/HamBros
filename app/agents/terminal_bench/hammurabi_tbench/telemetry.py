"""Hammurabi telemetry reporter for terminal-bench runs."""

import logging
import time
import uuid

import requests

logger = logging.getLogger(__name__)


class HammurabiReporter:
    """Reports per-turn telemetry to Hammurabi server.

    Degrades gracefully — if the server is unreachable, logs a warning
    and continues without blocking the benchmark.
    """

    def __init__(self, hammurabi_url: str = "http://localhost:20001"):
        self._url = hammurabi_url.rstrip("/")
        self._session_id = f"tbench-{uuid.uuid4().hex[:12]}"
        self._available: bool | None = None  # None = not yet checked

    @property
    def session_id(self) -> str:
        return self._session_id

    def _check_availability(self) -> bool:
        if self._available is not None:
            return self._available
        try:
            resp = requests.get(f"{self._url}/api/health", timeout=2)
            self._available = resp.status_code == 200
        except Exception:
            self._available = False
        if not self._available:
            logger.warning(
                "Hammurabi server not reachable at %s — telemetry disabled", self._url
            )
        return self._available

    def report_turn(
        self,
        turn: int,
        input_tokens: int,
        output_tokens: int,
        model: str,
        task_id: str = "",
    ) -> None:
        if not self._check_availability():
            return
        payload = {
            "sessionId": self._session_id,
            "agentName": "hammurabi-tbench",
            "model": model,
            "provider": "anthropic",
            "inputTokens": input_tokens,
            "outputTokens": output_tokens,
            "timestamp": int(time.time() * 1000),
            "metadata": {
                "source": "terminal-bench",
                "task_id": task_id,
                "turn": turn,
            },
        }
        try:
            requests.post(
                f"{self._url}/api/telemetry/ingest",
                json=payload,
                timeout=3,
            )
        except Exception as e:
            logger.debug("Telemetry report failed: %s", e)

    def report_complete(
        self,
        task_id: str,
        total_input_tokens: int,
        total_output_tokens: int,
        model: str,
        success: bool,
    ) -> None:
        if not self._check_availability():
            return
        payload = {
            "sessionId": self._session_id,
            "agentName": "hammurabi-tbench",
            "model": model,
            "provider": "anthropic",
            "inputTokens": total_input_tokens,
            "outputTokens": total_output_tokens,
            "timestamp": int(time.time() * 1000),
            "metadata": {
                "source": "terminal-bench",
                "task_id": task_id,
                "event": "task_complete",
                "success": success,
            },
        }
        try:
            requests.post(
                f"{self._url}/api/telemetry/ingest",
                json=payload,
                timeout=3,
            )
        except Exception as e:
            logger.debug("Telemetry completion report failed: %s", e)
