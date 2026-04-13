#!/usr/bin/env python3
"""Notion API helper for aria-birthday-venue-monitor sentinel."""
import urllib.request, json, os, sys

key_file = os.path.expanduser("~/.config/notion/personal_api_key")
with open(key_file) as f:
    notion_key = f.read().strip()

def notion_get(path):
    url = "https://api.notion.com/v1/" + path
    req = urllib.request.Request(url, headers={
        "Authorization": "Bearer " + notion_key,
        "Notion-Version": "2025-09-03"
    })
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())

def notion_patch(path, body):
    url = "https://api.notion.com/v1/" + path
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method="PATCH", headers={
        "Authorization": "Bearer " + notion_key,
        "Notion-Version": "2025-09-03",
        "Content-Type": "application/json"
    })
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "get-rows"

    if cmd == "get-rows":
        table_block_id = "33d23ec0-750f-81db-8792-e0b22ce16d37"
        data = notion_get("blocks/" + table_block_id + "/children")
        for i, block in enumerate(data.get("results", [])):
            bid = block.get("id", "")
            btype = block.get("type", "")
            if btype == "table_row":
                cells = block.get("table_row", {}).get("cells", [])
                venue = cells[0][0]["plain_text"] if cells and cells[0] else "unknown"
                status = cells[2][0]["plain_text"] if cells and len(cells) > 2 and cells[2] else ""
                print("ROW " + str(i) + ": " + bid + " | " + venue + " | " + status)

    elif cmd == "update-row":
        # Args: row_id venue contact status price capacity notes
        row_id = sys.argv[2]
        venue = sys.argv[3]
        contact = sys.argv[4]
        status = sys.argv[5]
        price = sys.argv[6]
        capacity = sys.argv[7]
        notes = sys.argv[8]

        def cell(text):
            if text:
                return [{"type": "text", "text": {"content": text}}]
            return []

        body = {"table_row": {"cells": [
            cell(venue), cell(contact), cell(status),
            cell(price), cell(capacity), cell(notes)
        ]}}
        result = notion_patch("blocks/" + row_id, body)
        print("Updated row: " + row_id)

    elif cmd == "update-log":
        # Args: block_id log_content
        block_id = sys.argv[2]
        log_content = sys.argv[3]
        body = {"paragraph": {"rich_text": [{"type": "text", "text": {"content": log_content}}]}}
        result = notion_patch("blocks/" + block_id, body)
        print("Updated log block: " + block_id)
