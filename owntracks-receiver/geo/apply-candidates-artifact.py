"""Offline integration for reviewed OwnTracks address/POI candidates.

Requires the ChatGPT artifact_tool spreadsheet runtime. Never calls map APIs or
Google Drive and never changes the source workbook. Caller must independently
verify provider eligibility, Drive version/concurrency, visibility, and readback.

Usage: python apply-candidates-artifact.py input.xlsx plan.json output.xlsx
"""
import json
import re
import sys
from datetime import datetime
from zoneinfo import ZoneInfo
from pathlib import Path
from artifact_tool import Blob, SpreadsheetFile

EXPECTED_HEADERS = {"D": "自動店舗候補", "E": "自動住所候補",
                    "F": "店舗名（本人修正）", "I": "イベントID",
                    "N": "候補出典", "O": "検索日時"}
ALLOWED_COLUMNS = ("D", "E", "N", "O")
UNSAFE = re.compile(r"^\s*[=+\-@]|[\x00-\x1f\x7f]")


def apply_updates(source, plan, output):
    if source.resolve() == output.resolve():
        raise ValueError("Refusing to overwrite the source workbook")
    payload = json.loads(plan.read_text(encoding="utf-8"))
    if not isinstance(payload.get("year"), int) or not isinstance(payload.get("planned"), list):
        raise ValueError("Malformed plan")
    wb = SpreadsheetFile.import_xlsx(Blob.load(str(source)))
    sh = wb.worksheets.get_item("店舗名の修正")
    for col, expected in EXPECTED_HEADERS.items():
        actual = sh.get_range(f"{col}4").values[0][0]
        if actual != expected:
            raise ValueError(f"Sheet schema changed: column {col}: {actual!r}")
    ids_seen = set()
    old_rows = []
    old_f_g_h = {}
    # Validate ALL changes before applying ANY to the in-memory workbook.
    for candidate in payload["planned"]:
        row = candidate.get("rowNumber")
        event_id = candidate.get("eventId")
        cells = candidate.get("cells")
        if not isinstance(row, int) or row < 5 or not isinstance(event_id, str) or event_id in ids_seen:
            raise ValueError("Invalid / duplicated event row")
        ids_seen.add(event_id)
        actual_id = sh.get_range(f"I{row}").values[0][0]
        if actual_id != event_id:
            raise ValueError("Stable event ID changed; aborting")
        if set(cells or {}) != set(ALLOWED_COLUMNS):
            raise ValueError("Only D/E/N/O updates are permitted")
        old_f_g_h[row] = (
            sh.get_range(f"F{row}").values[0][0],
            sh.get_range(f"G{row}").formulas[0][0],
            sh.get_range(f"H{row}").formulas[0][0],
        )
        for col in ALLOWED_COLUMNS:
            val = cells[col]
            if not isinstance(val, str) or len(val) > 250 or UNSAFE.search(val):
                raise ValueError("Suspicious candidate text; aborting")
            prev = sh.get_range(f"{col}{row}").values[0][0]
            if prev not in (None, "", val):
                raise ValueError("Concurrent candidate change; aborting")
            old_rows.append((col, row, val))
    normalized = []
    for col, row, val in old_rows:
        expected = val
        if col == 'O':
            try:
                dt = datetime.fromisoformat(val.replace('Z', '+00:00')).astimezone(ZoneInfo('Asia/Tokyo'))
                expected = (dt.replace(tzinfo=None) - datetime(1899, 12, 30)).total_seconds() / 86400
            except Exception as exc:
                raise ValueError('Invalid ISO time') from exc
        sh.get_range(f"{col}{row}").values = [[expected]]
        if col == 'O':
            sh.get_range(f"{col}{row}").set_number_format("yyyy/mm/dd hh:mm:ss")
        normalized.append((col, row, expected))
    SpreadsheetFile.export_xlsx(wb).save(str(output))
    back = SpreadsheetFile.import_xlsx(Blob.load(str(output)))
    checked = back.worksheets.get_item("店舗名の修正")
    for col, row, expected in normalized:
        actual = checked.get_range(f"{col}{row}").values[0][0]
        if col == 'O':
            assert isinstance(actual,(int,float)) and abs(actual-expected)<1/86400, "Timestamp mismatch"
        else:
            # Empty Excel cells may be normalized from "" to None on roundtrip.
            assert actual == expected or (expected == "" and actual is None), "Write/readback mismatch"
    for row, protected in old_f_g_h.items():
        snapshot = (checked.get_range(f"F{row}").values[0][0],
                    checked.get_range(f"G{row}").formulas[0][0],
                    checked.get_range(f"H{row}").formulas[0][0])
        assert snapshot == protected, "Manual correction or display formula changed"
    return {"applied_cells": len(old_rows), "events": len(ids_seen), "verified": True}


if __name__ == '__main__':
    if len(sys.argv) != 4:
        raise SystemExit("Usage: apply-candidates-artifact.py input.xlsx plan.json output.xlsx")
    print(apply_updates(Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])))