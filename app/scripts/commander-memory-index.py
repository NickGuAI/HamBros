#!/usr/bin/env python3
"""
Commander memory vector indexer.

Maintains a per-commander LanceDB table keyed by candidate IDs supplied from
Node (commander-memory-candidates.json). This script handles only vector sync
and search; BM25 stays in the Node SQLite FTS index.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[3]
KNOWLEDGE_SEARCH_DIR = REPO_ROOT / "agent-skills" / "pkos" / "knowledge-search"
if str(KNOWLEDGE_SEARCH_DIR) not in sys.path:
    sys.path.insert(0, str(KNOWLEDGE_SEARCH_DIR))

import knowledge_search as shared_search  # noqa: E402

TABLE_NAME = "memory_chunks"
MAX_EMBED_CHARS = 8000

shared_search._TABLE_NAME = TABLE_NAME
EmbeddingClient = shared_search.EmbeddingClient
IndexManifest = shared_search.IndexManifest
LanceDBIndex = shared_search.LanceDBIndex


@dataclass
class CandidateChunk:
    chunk_id: str
    hash: str
    title: str
    source_type: str
    source_file: str
    text: str


@dataclass
class SearchResult:
    id: str
    score: float
    text: str
    source_file: str
    source_type: str
    title: str


@dataclass
class MemoryManifest(IndexManifest):
    chunks: Dict[str, str] = field(default_factory=dict)


def as_object(value: Any) -> Optional[Dict[str, Any]]:
    return value if isinstance(value, dict) else None


def parse_trimmed_string(value: Any) -> Optional[str]:
    if isinstance(value, str):
        trimmed = value.strip()
        return trimmed if trimmed else None
    return None


def truncate_for_embedding(text: str) -> str:
    if len(text) <= MAX_EMBED_CHARS:
        return text
    return text[:MAX_EMBED_CHARS]


class CommanderMemoryVectorIndex(LanceDBIndex):
    def _load(self) -> None:
        if self.manifest_path.exists():
            with open(self.manifest_path, "r", encoding="utf-8") as handle:
                self.manifest = MemoryManifest(**json.load(handle))
        else:
            self.manifest = MemoryManifest()

        try:
            self.table = self.db.open_table(TABLE_NAME)
        except Exception:
            self.table = None

    @staticmethod
    def _build_rows(chunks: List[CandidateChunk], embeddings: np.ndarray) -> List[dict]:
        rows: List[dict] = []
        for index, chunk in enumerate(chunks):
            rows.append({
                "chunk_id": chunk.chunk_id,
                "hash": chunk.hash,
                "title": chunk.title,
                "source_type": chunk.source_type,
                "source_file": chunk.source_file,
                "text": chunk.text,
                "vector": embeddings[index].tolist(),
            })
        return rows

    def upsert_chunks(self, chunks: List[CandidateChunk], embeddings: np.ndarray) -> None:
        rows = self._build_rows(chunks, embeddings)
        if not rows:
            return

        if self.table is None:
            self.table = self.db.create_table(TABLE_NAME, rows, mode="overwrite")
            return

        for chunk in chunks:
            safe_chunk_id = chunk.chunk_id.replace("'", "''")
            self.table.delete(f"chunk_id = '{safe_chunk_id}'")
        self.table.add(rows)

    def delete_chunk_ids(self, chunk_ids: List[str]) -> None:
        if self.table is None:
            return

        for chunk_id in chunk_ids:
            safe_chunk_id = chunk_id.replace("'", "''")
            self.table.delete(f"chunk_id = '{safe_chunk_id}'")

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
                id=result["chunk_id"],
                score=round(1.0 - result.get("_distance", 0.0), 4),
                text=result["text"],
                source_file=result.get("source_file", ""),
                source_type=result.get("source_type", "memory"),
                title=result.get("title", ""),
            )
            for result in results
            if isinstance(result.get("chunk_id"), str)
        ]


def load_candidates(candidates_file: Path) -> List[CandidateChunk]:
    if not candidates_file.exists():
        return []

    try:
        raw = json.loads(candidates_file.read_text(encoding="utf-8"))
    except Exception:
        return []

    if not isinstance(raw, list):
        return []

    chunks: List[CandidateChunk] = []
    for entry in raw:
        obj = as_object(entry)
        if not obj:
            continue

        chunk_id = parse_trimmed_string(obj.get("id"))
        chunk_hash = parse_trimmed_string(obj.get("hash"))
        title = parse_trimmed_string(obj.get("title"))
        source_type = parse_trimmed_string(obj.get("type"))
        source_file = parse_trimmed_string(obj.get("path"))
        text = parse_trimmed_string(obj.get("text"))

        if not chunk_id or not chunk_hash or not text:
            continue

        chunks.append(
            CandidateChunk(
                chunk_id=chunk_id,
                hash=chunk_hash,
                title=title or chunk_id,
                source_type=source_type or "memory",
                source_file=source_file or "",
                text=text,
            )
        )

    return chunks


def sync_index(index_root: Path, candidates_file: Path, client: EmbeddingClient) -> Dict[str, int]:
    index = CommanderMemoryVectorIndex(str(index_root))
    manifest = index.manifest if isinstance(index.manifest, MemoryManifest) else MemoryManifest()

    candidates = load_candidates(candidates_file)
    current_by_id = {candidate.chunk_id: candidate for candidate in candidates}

    stale_ids = sorted(set(manifest.chunks.keys()) - set(current_by_id.keys()))
    if stale_ids:
        index.delete_chunk_ids(stale_ids)
        for stale_id in stale_ids:
            manifest.chunks.pop(stale_id, None)

    dirty_chunks: List[CandidateChunk] = []
    for chunk in candidates:
        if manifest.chunks.get(chunk.chunk_id) == chunk.hash:
            continue
        dirty_chunks.append(chunk)

    if dirty_chunks:
        embeddings = client.embed_batch(
            [truncate_for_embedding(chunk.text) for chunk in dirty_chunks]
        )
        index.upsert_chunks(dirty_chunks, embeddings)
        for chunk in dirty_chunks:
            manifest.chunks[chunk.chunk_id] = chunk.hash

    index.save_manifest(manifest)

    return {
        "indexed_chunks": len(dirty_chunks),
        "deleted_chunks": len(stale_ids),
        "total_chunks": len(manifest.chunks),
    }


def search_index(index_root: Path, query: str, top_k: int, client: EmbeddingClient) -> List[SearchResult]:
    index = CommanderMemoryVectorIndex(str(index_root))
    if index.table is None:
        return []

    query_embedding = client.embed(query)
    return index.search(query_embedding, top_k)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Commander memory LanceDB helper")
    subparsers = parser.add_subparsers(dest="command", required=True)

    sync_parser = subparsers.add_parser("sync", help="Sync LanceDB vectors from candidates JSON")
    sync_parser.add_argument("--index-root", required=True)
    sync_parser.add_argument("--candidates-file", required=True)
    sync_parser.add_argument("--json", action="store_true")

    search_parser = subparsers.add_parser("search", help="Search LanceDB vectors")
    search_parser.add_argument("--index-root", required=True)
    search_parser.add_argument("--query", required=True)
    search_parser.add_argument("--top-k", type=int, default=8)
    search_parser.add_argument("--json", action="store_true")

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    try:
        client = EmbeddingClient()

        if args.command == "sync":
            payload = sync_index(
                index_root=Path(args.index_root).resolve(),
                candidates_file=Path(args.candidates_file).resolve(),
                client=client,
            )
            if args.json:
                print(json.dumps(payload, ensure_ascii=False))
            else:
                print(payload)
            return 0

        if args.command == "search":
            results = search_index(
                index_root=Path(args.index_root).resolve(),
                query=args.query,
                top_k=max(1, int(args.top_k)),
                client=client,
            )
            payload = [asdict(result) for result in results]
            if args.json:
                print(json.dumps(payload, ensure_ascii=False))
            else:
                for row in payload:
                    print(row)
            return 0

        parser.error(f"Unsupported command: {args.command}")
        return 2
    except Exception as error:
        parser.exit(1, f"error: {error}\n")


if __name__ == "__main__":
    raise SystemExit(main())
