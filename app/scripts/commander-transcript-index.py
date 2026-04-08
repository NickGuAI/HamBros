#!/usr/bin/env python3
"""
Commander transcript indexer.

Builds and queries a per-commander LanceDB index over transcript JSONL files.
Each extracted user/assistant message becomes one row in the vector table.
Messages are never split into chunks; oversized messages are truncated only for
embedding input, while the stored row keeps the original full message text.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[3]
KNOWLEDGE_SEARCH_DIR = REPO_ROOT / "agent-skills" / "pkos" / "knowledge-search"
if str(KNOWLEDGE_SEARCH_DIR) not in sys.path:
    sys.path.insert(0, str(KNOWLEDGE_SEARCH_DIR))

import knowledge_search as shared_search  # noqa: E402

TABLE_NAME = "messages"
MAX_EMBED_CHARS = 8000

shared_search._TABLE_NAME = TABLE_NAME
EmbeddingClient = shared_search.EmbeddingClient
IndexManifest = shared_search.IndexManifest
LanceDBIndex = shared_search.LanceDBIndex


@dataclass
class IndexedMessage:
    message_id: str
    commander_id: str
    transcript_id: str
    source_file: str
    timestamp: Optional[str]
    role: str
    turn_number: int
    message_index: int
    line_number: int
    text: str


@dataclass
class SearchResult:
    score: float
    text: str
    source_file: str
    transcript_id: str
    timestamp: Optional[str]
    role: str
    turn_number: int
    message_index: int


@dataclass
class TranscriptCheckpoint:
    mtime: float = 0.0
    last_indexed_line: int = 0
    completed_turns: int = 0


@dataclass
class TranscriptManifest(IndexManifest):
    transcripts: Dict[str, Dict[str, float | int]] = field(default_factory=dict)


def as_object(value: Any) -> Optional[Dict[str, Any]]:
    return value if isinstance(value, dict) else None


def compact_text(value: str) -> str:
    return " ".join(value.split()).strip()


def extract_text_content(content: Any) -> str:
    if isinstance(content, str):
        return content.strip()

    if not isinstance(content, list):
        return ""

    parts: List[str] = []
    for block in content:
        obj = as_object(block)
        if not obj:
            continue
        if obj.get("type") == "text" and isinstance(obj.get("text"), str):
            text = obj["text"].strip()
            if text:
                parts.append(text)
    return "\n".join(parts).strip()


def truncate_for_embedding(text: str) -> str:
    if len(text) <= MAX_EMBED_CHARS:
        return text
    return text[:MAX_EMBED_CHARS]


class TranscriptMessageIndex(LanceDBIndex):
    def _load(self) -> None:
        if self.manifest_path.exists():
            with open(self.manifest_path, "r", encoding="utf-8") as handle:
                self.manifest = TranscriptManifest(**json.load(handle))
        else:
            self.manifest = TranscriptManifest()

        try:
            self.table = self.db.open_table(TABLE_NAME)
        except Exception:
            self.table = None

    @staticmethod
    def _build_rows(messages: List[IndexedMessage], embeddings: np.ndarray) -> List[dict]:
        rows: List[dict] = []
        for index, message in enumerate(messages):
            rows.append({
                "message_id": message.message_id,
                "commander_id": message.commander_id,
                "transcript_id": message.transcript_id,
                "source_file": message.source_file,
                "timestamp": message.timestamp,
                "role": message.role,
                "turn_number": int(message.turn_number),
                "message_index": int(message.message_index),
                "line_number": int(message.line_number),
                "text": message.text,
                "vector": embeddings[index].tolist(),
            })
        return rows

    def search(self, query_embedding: np.ndarray, top_k: int) -> List[SearchResult]:
        if self.table is None:
            return []

        results = (
            self.table.search(query_embedding.flatten().tolist())
            .metric("cosine")
            .limit(top_k)
            .to_list()
        )

        return [
            SearchResult(
                score=round(1.0 - result.get("_distance", 0.0), 4),
                text=result["text"],
                source_file=result["source_file"],
                transcript_id=result["transcript_id"],
                timestamp=result.get("timestamp"),
                role=result["role"],
                turn_number=result["turn_number"],
                message_index=result["message_index"],
            )
            for result in results
        ]


def read_new_events(
    transcript_path: Path,
    start_line_exclusive: int,
) -> Tuple[List[Tuple[int, Dict[str, Any]]], int]:
    events: List[Tuple[int, Dict[str, Any]]] = []
    total_lines = 0

    with open(transcript_path, "r", encoding="utf-8") as handle:
        for total_lines, raw_line in enumerate(handle, start=1):
            if total_lines <= start_line_exclusive:
                continue

            line = raw_line.strip()
            if not line:
                continue

            try:
                parsed = json.loads(line)
            except Exception:
                continue

            obj = as_object(parsed)
            if obj and isinstance(obj.get("type"), str):
                events.append((total_lines, obj))

    return events, total_lines


def extract_indexable_messages(
    commander_id: str,
    transcript_id: str,
    source_file: str,
    events: List[Tuple[int, Dict[str, Any]]],
    starting_turn: int,
) -> Tuple[List[IndexedMessage], Optional[int], int]:
    turn_messages: List[Tuple[str, str, Optional[str]]] = []
    indexed_messages: List[IndexedMessage] = []
    pending_text = ""
    pending_timestamp: Optional[str] = None
    completed_turns = 0
    checkpoint_line: Optional[int] = None

    def flush_pending() -> None:
        nonlocal pending_text, pending_timestamp
        text = pending_text.strip()
        if text:
            turn_messages.append(("assistant", text, pending_timestamp))
        pending_text = ""
        pending_timestamp = None

    for line_number, event in events:
        event_type = event.get("type")

        if event_type in ("user", "assistant"):
            flush_pending()
            message = as_object(event.get("message"))
            if not message:
                continue
            role = message.get("role")
            if role not in ("user", "assistant"):
                role = event_type
            if role not in ("user", "assistant"):
                continue
            text = extract_text_content(message.get("content"))
            if text:
                timestamp = event.get("timestamp") if isinstance(event.get("timestamp"), str) else None
                turn_messages.append((str(role), text, timestamp))
            continue

        if event_type == "message_start":
            flush_pending()
            timestamp = event.get("timestamp")
            if isinstance(timestamp, str):
                pending_timestamp = timestamp
            continue

        if event_type == "content_block_start":
            timestamp = event.get("timestamp")
            if pending_timestamp is None and isinstance(timestamp, str):
                pending_timestamp = timestamp
            continue

        if event_type == "content_block_delta":
            delta = as_object(event.get("delta"))
            text = delta.get("text") if delta else None
            if isinstance(text, str):
                pending_text += text
            timestamp = event.get("timestamp")
            if pending_timestamp is None and isinstance(timestamp, str):
                pending_timestamp = timestamp
            continue

        if event_type != "result":
            continue

        flush_pending()
        turn_number = starting_turn + completed_turns + 1
        for message_index, (role, text, timestamp) in enumerate(turn_messages, start=1):
            normalized = text.strip()
            if not normalized:
                continue
            indexed_messages.append(
                IndexedMessage(
                    message_id=f"{transcript_id}:{turn_number}:{message_index}:{role}",
                    commander_id=commander_id,
                    transcript_id=transcript_id,
                    source_file=source_file,
                    timestamp=timestamp,
                    role=role,
                    turn_number=turn_number,
                    message_index=message_index,
                    line_number=line_number,
                    text=normalized,
                )
            )

        turn_messages = []
        completed_turns += 1
        checkpoint_line = line_number

    return indexed_messages, checkpoint_line, completed_turns


def load_checkpoint(manifest: TranscriptManifest, source_file: str) -> TranscriptCheckpoint:
    raw = manifest.transcripts.get(source_file)
    if not isinstance(raw, dict):
        return TranscriptCheckpoint()

    checkpoint = TranscriptCheckpoint()
    mtime = raw.get("mtime")
    last_indexed_line = raw.get("last_indexed_line")
    completed_turns = raw.get("completed_turns")

    if isinstance(mtime, (int, float)):
        checkpoint.mtime = float(mtime)
    if isinstance(last_indexed_line, int):
        checkpoint.last_indexed_line = last_indexed_line
    if isinstance(completed_turns, int):
        checkpoint.completed_turns = completed_turns
    return checkpoint


def save_checkpoint(
    manifest: TranscriptManifest,
    source_file: str,
    checkpoint: TranscriptCheckpoint,
) -> None:
    manifest.transcripts[source_file] = asdict(checkpoint)


def sync_transcript_index(
    commander_id: str,
    commander_data_dir: Path,
    index_root: Path,
    client: EmbeddingClient,
) -> Dict[str, int]:
    commander_sessions_dir = commander_data_dir / commander_id / "sessions"
    commander_cache_dir = index_root / commander_id
    index = TranscriptMessageIndex(str(commander_cache_dir))
    manifest = index.manifest if isinstance(index.manifest, TranscriptManifest) else TranscriptManifest()

    if commander_sessions_dir.exists():
        source_files = sorted(
            str(path.resolve())
            for path in commander_sessions_dir.glob("*.jsonl")
            if path.is_file()
        )
    else:
        source_files = []

    indexed_files = 0
    indexed_messages = 0
    deleted_sources = 0

    current_sources = set(source_files)
    stale_sources = sorted(set(manifest.transcripts.keys()) - current_sources)
    manifest_changed = False
    for stale_source in stale_sources:
        index.delete_by_source(stale_source)
        manifest.transcripts.pop(stale_source, None)
        manifest.files.pop(stale_source, None)
        deleted_sources += 1
        manifest_changed = True

    if manifest_changed:
        index.save_manifest(manifest)

    for source_file in source_files:
        transcript_path = Path(source_file)
        mtime = transcript_path.stat().st_mtime
        checkpoint = load_checkpoint(manifest, source_file)

        events, total_lines = read_new_events(transcript_path, checkpoint.last_indexed_line)
        if total_lines < checkpoint.last_indexed_line:
            index.delete_by_source(source_file)
            checkpoint = TranscriptCheckpoint()
            events, total_lines = read_new_events(transcript_path, 0)
            deleted_sources += 1
        elif checkpoint.mtime == mtime and not events:
            manifest.files[source_file] = mtime
            continue

        transcript_id = transcript_path.stem
        messages, checkpoint_line, completed_turns = extract_indexable_messages(
            commander_id=commander_id,
            transcript_id=transcript_id,
            source_file=source_file,
            events=events,
            starting_turn=checkpoint.completed_turns,
        )

        if messages:
            embeddings = client.embed_batch([truncate_for_embedding(message.text) for message in messages])
            index.add_chunks(messages, embeddings)
            indexed_messages += len(messages)

        if checkpoint_line is not None:
            checkpoint.last_indexed_line = checkpoint_line
            checkpoint.completed_turns += completed_turns

        checkpoint.mtime = mtime
        manifest.files[source_file] = mtime
        save_checkpoint(manifest, source_file, checkpoint)
        indexed_files += 1
        index.save_manifest(manifest)

    return {
        "indexed_files": indexed_files,
        "indexed_messages": indexed_messages,
        "deleted_sources": deleted_sources,
    }


def search_transcript_index(
    commander_id: str,
    _commander_data_dir: Path,
    index_root: Path,
    query: str,
    top_k: int,
    client: EmbeddingClient,
) -> List[SearchResult]:
    index = TranscriptMessageIndex(str(index_root / commander_id))
    query_embedding = client.embed_batch([truncate_for_embedding(query)])
    return index.search(query_embedding[0], top_k)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Commander transcript LanceDB index")
    subparsers = parser.add_subparsers(dest="command", required=True)

    sync_parser = subparsers.add_parser("sync")
    sync_parser.add_argument("--commander-id", required=True)
    sync_parser.add_argument("--commander-data-dir", required=True)
    sync_parser.add_argument("--index-root", required=True)
    sync_parser.add_argument("--json", action="store_true")

    search_parser = subparsers.add_parser("search")
    search_parser.add_argument("--commander-id", required=True)
    search_parser.add_argument("--commander-data-dir", required=True)
    search_parser.add_argument("--index-root", required=True)
    search_parser.add_argument("--query", required=True)
    search_parser.add_argument("--top-k", type=int, default=8)
    search_parser.add_argument("--json", action="store_true")

    return parser.parse_args()


def main() -> int:
    args = parse_args()
    client = EmbeddingClient()
    commander_data_dir = Path(args.commander_data_dir).expanduser().resolve()
    index_root = Path(args.index_root).expanduser().resolve()

    if args.command == "sync":
        result = sync_transcript_index(
            commander_id=args.commander_id,
            commander_data_dir=commander_data_dir,
            index_root=index_root,
            client=client,
        )
        if args.json:
            print(json.dumps(result))
        else:
            print(
                f"indexed_files={result['indexed_files']} "
                f"indexed_messages={result['indexed_messages']} "
                f"deleted_sources={result['deleted_sources']}"
            )
        return 0

    if args.command == "search":
        results = search_transcript_index(
            commander_id=args.commander_id,
            _commander_data_dir=commander_data_dir,
            index_root=index_root,
            query=args.query,
            top_k=max(1, args.top_k),
            client=client,
        )
        if args.json:
            print(json.dumps([asdict(result) for result in results]))
        else:
            for result in results:
                print(
                    f"[{result.score:.3f}] {result.transcript_id} "
                    f"turn={result.turn_number} role={result.role}"
                )
                print(compact_text(result.text))
                print()
        return 0

    raise RuntimeError(f"Unsupported command: {args.command}")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
