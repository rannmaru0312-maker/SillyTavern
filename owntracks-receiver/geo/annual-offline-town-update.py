#!/usr/bin/env python3
"""Offline, privacy-preserving town-name enrichment for an existing annual diary.

Input: private, locally materialized Excel + SHA-pinned private Linux binary ZIP.
Output: a NEW Excel for verified upstream upload; never overwrites the input.
No network calls, place-name inference, external logs, or credentials.
All real GPS coordinates remain on the private host; stdout reports counts only.

Usage:
  python annual-offline-town-update.py \
    --source /private/生活記録_2026.xlsx \
    --binary-zip /private/miya-offline-town-geocoder-linux-20261116.zip \
    --year 2026 --output /private/生活記録_2026_UPDATED.xlsx

Exit 0 + status=unchanged -> no new output is written.
Exit 0 + status=updated -> new output verified against source in memory.
Other exit -> never upload; preserve the input.
"""

import argparse
import hashlib
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from artifact_tool import Blob, SpreadsheetFile

# GitHub Actions artifact #14206332818, built from PR #30 on 2026-11-16.
# The ZIP is separately stored, unshared, in the user's Google Drive.
APPROVED_ARCHIVE_SHA256 = "09faf08dc2f0e98c6c0b783e4f2944b51052693a9d3ab8b1a6c0ab407a5958f7"
APPROVED_BINARY_SHA256 = "f9923cc08c7818d99f2fb7e28342bc07740a1153349ece9e521a791c4944879d"
APPROVED_MEMBER = "miya-offline-japan-town-geocoder"
PROVIDER_DESCRIPTION = "国土交通省 位置参照情報（町丁目代表点・オフライン）"
CORRECTION_HEADERS = {
    "D": "自動店舗候補", "E": "自動住所候補", "F": "店舗名（本人修正）",
    "G": "表示する名前", "H": "確認状態", "I": "イベントID",
    "J": "出典", "K": "月別シート", "L": "元行", "N": "候補出典", "O": "検索日時"
}
CONTROL = re.compile(r"[\x00-\x1f\x7f]")
DANGEROUS = re.compile(r"^\s*[=+@\-]")
HEX_ID = re.compile(r"^[0-9a-f]{64}$")


def check_sha(data, wanted):
    if hashlib.sha256(data).hexdigest() != wanted:
        raise ValueError("artifact checksum mismatch")


def secure_executable(path, dest):
    raw = Path(path).read_bytes()
    check_sha(raw, APPROVED_ARCHIVE_SHA256)
    with zipfile.ZipFile(path) as z:
        infos = z.infolist()
        if len(infos) != 1 or infos[0].filename != APPROVED_MEMBER:
            raise ValueError("unexpected executable member")
        if infos[0].file_size > 5_000_000:
            raise ValueError("unexpected executable size")
        executable = z.read(APPROVED_MEMBER)
    check_sha(executable, APPROVED_BINARY_SHA256)
    dest.write_bytes(executable)
    dest.chmod(0o700)


def valid_coord(lat, lon, accuracy):
    return (type(lat) in (int, float) and type(lon) in (int, float)
            and type(accuracy) in (int, float)
            and all(math.isfinite(x) for x in (lat, lon, accuracy))
            and 20 <= lat <= 46 and 122 <= lon <= 154 and 0 <= accuracy <= 100)


def safe_text(value):
    if not isinstance(value, str) or not value or len(value) > 160:
        return False
    return not CONTROL.search(value) and not DANGEROUS.search(value)


def query(binary, lat, lon):
    try:
        p = subprocess.run([str(binary)], input=json.dumps({'lat':lat,'lon':lon}),
                           text=True, capture_output=True, shell=False,
                           timeout=7, check=False)
    except (OSError, subprocess.TimeoutExpired) as ex:
        raise ValueError("offline engine unavailable") from None
    if p.returncode != 0 or len(p.stdout) > 8192:
        raise ValueError("offline lookup returned error")
    try:
        data = json.loads(p.stdout)
    except (json.JSONDecodeError, TypeError):
        raise ValueError("malformed offline response") from None
    if not isinstance(data, dict):
        raise ValueError("malformed offline response")
    if data.get("status") == "no_reliable_town_candidate":
        return None
    if (data.get("status") != "town_candidate_unverified"
        or not safe_text(data.get("addressCandidate"))
        or data.get("facilityCandidate") != ""
        or not data.get("providerName", "").startswith("MLIT location reference")
        or data.get("addressLevel") != "approximate_town_nearest_representative_point"):
        raise ValueError("malformed offline address candidate")
    # A nearby representative point is not a street address or confirmed venue.
    return data["addressCandidate"]


def safe_sheet_value(x):
    return "" if x is None else x


def month_row_ends(book):
    """Determine actual used rows rather than truncating long months."""
    rows={}
    for line in book.inspect({"kind":"sheet","include":"id,name"}).ndjson.splitlines():
        item=json.loads(line)
        if item.get("kind") != "sheet":
            continue
        name=item.get("name", "")
        if re.fullmatch(r"(?:[1-9]|1[0-2])月", name):
            m=re.search(r"(\d+)$",item.get("address", ""))
            if not m: raise ValueError("month sheet has no used range")
            rows[name]=max(5,int(m.group(1)))
    if set(rows)!={f"{n}月" for n in range(1,13)}:
        raise ValueError("missing month sheets")
    return rows


def make_snapshot(book, sheet, end):
    """Capture immutable month content and formulas including derived R:T."""
    sh=book.worksheets.get_item(sheet)
    primary=sh.get_range(f"A5:Q{end}")
    derived=sh.get_range(f"R5:T{end}")
    return (primary.values,primary.formulas,derived.formulas)


def run(source, binary_zip, year, output, limit=120, now=None):
    if source.resolve() == output.resolve():
        raise ValueError("source and output must differ")
    if year < 2020 or year > 2100 or not (1 <= limit <= 200):
        raise ValueError("invalid year or batch limit")
    if not source.exists() or not binary_zip.exists():
        raise ValueError("missing input")
    book = SpreadsheetFile.import_xlsx(Blob.load(str(source)))
    cs = book.worksheets.get_item("店舗名の修正")
    for col, expected in CORRECTION_HEADERS.items():
        actual = cs.get_range(f"{col}4").values[0][0]
        if actual != expected:
            raise ValueError("unexpected corrections schema")
    rows = cs.get_range("A5:O1000").values
    seen = set()
    candidates=[]
    held=[]
    for i,row in enumerate(rows,5):
        if not row[8]:
            continue
        event_id = row[8]
        if not isinstance(event_id, str) or event_id in seen:
            raise ValueError("duplicate/missing stable event id")
        seen.add(event_id)
        if row[9] != "OwnTracks GPS" or not HEX_ID.fullmatch(event_id):
            continue
        month = row[10]
        pos = row[11]
        if month not in [f"{m}月" for m in range(1,13)] or type(pos) is not int or pos < 5 or pos > 10000:
            raise ValueError("invalid monthly linkage")
        m = int(month[:-1]); sh=book.worksheets.get_item(month)
        src_id = sh.get_range(f"K{pos}").values[0][0]
        gps_source = sh.get_range(f"G{pos}").values[0][0]
        date=sh.get_range(f"A{pos}").values[0][0]
        if type(date) in (int,float):
            dt = datetime(1899,12,30)+timedelta(days=float(date))
        elif isinstance(date,datetime):
            dt = date
        else:
            raise ValueError("invalid date in monthly source")
        if dt.year != year or dt.month != m or event_id!=src_id or gps_source!="OwnTracks GPS":
            raise ValueError("mismatched monthly ID/date/source")
        if row[4] not in (None, ""):
            continue  # preserve all existing and manually reviewed candidates
        if row[13] not in (None, "") or row[14] not in (None, ""):
            held.append(i)
            continue  # partial prior write / concurrent update should be reviewed
        lat,lon,accuracy = sh.get_range(f"H{pos}:J{pos}").values[0]
        if valid_coord(lat,lon,accuracy):
            candidates.append((i,float(lat),float(lon)))
    if not candidates:
        return {"status":"unchanged", "candidate_rows":0,"updated_rows":0,
                "held_rows":len(held), "remaining":0,"output_created":False}
    # No GPS in stdout, args, GitHub, logs or remote APIs.
    created = 0
    no_match = 0
    if now is None: now = datetime.now(timezone.utc)
    if now.tzinfo is None: raise ValueError("timestamp must include offset")
    stamp=now.astimezone(timezone.utc).isoformat(timespec='seconds').replace('+00:00','Z')
    serial=(now.astimezone(timezone(timedelta(hours=9))).replace(tzinfo=None)-datetime(1899,12,30)).total_seconds()/86400
    snapshot_corrections = cs.get_range("A5:O1000").values
    snapshot_correction_formulas = cs.get_range("A5:O1000").formulas
    sheet_ends=month_row_ends(book)
    snapshot_protected = {month:make_snapshot(book,month,end) for month,end in sheet_ends.items()}
    with tempfile.TemporaryDirectory(prefix="miya-private-town-") as td:
        binary=Path(td)/APPROVED_MEMBER
        secure_executable(binary_zip,binary)
        for row,lat,lon in candidates[:limit]:
            address = query(binary,lat,lon)
            if address is None:
                no_match+=1
                continue
            cs.get_range(f"E{row}").values=[[address]]
            cs.get_range(f"N{row}").values=[[PROVIDER_DESCRIPTION]]
            cs.get_range(f"O{row}").values=[[serial]]
            cs.get_range(f"O{row}").set_number_format("yyyy/mm/dd hh:mm:ss")
            created+=1
    if created==0:
        return {"status":"unchanged","candidate_rows":len(candidates),"updated_rows":0,
                "unmatched_rows":no_match,"held_rows":len(held),"remaining":max(0,len(candidates)-limit),"output_created":False}
    SpreadsheetFile.export_xlsx(book).save(str(output))
    back = SpreadsheetFile.import_xlsx(Blob.load(str(output)))
    actual_range=back.worksheets.get_item("店舗名の修正").get_range("A5:O1000")
    actual=actual_range.values
    actual_formulas=actual_range.formulas
    for r,(before,after) in enumerate(zip(snapshot_corrections,actual),5):
        # Only E, N, O can change; never touch F or G/H formulas.
        for col in range(15):
            if col in (4,13,14): continue
            if safe_sheet_value(before[col])!=safe_sheet_value(after[col]):
                raise ValueError("protected source cell changed")
    if actual_formulas != snapshot_correction_formulas:
        raise ValueError("correction sheet formula changed")
    if month_row_ends(back) != sheet_ends:
        raise ValueError("month used range changed")
    for month,end in sheet_ends.items():
        if make_snapshot(back,month,end) != snapshot_protected[month]:
            raise ValueError("monthly source data/formula changed")
    # Also validate for every edited row that corresponding E/N/O persisted.
    counted=0
    for i,(before,after) in enumerate(zip(snapshot_corrections,actual),5):
        if before[4] in (None,"") and after[4] not in (None,""):
            if after[13]!=PROVIDER_DESCRIPTION or type(after[14]) not in (int,float):
                raise ValueError("candidate write/readback mismatch")
            counted+=1
    if counted!=created:
        raise ValueError("incomplete readback")
    return {"status":"updated","candidate_rows":len(candidates),"updated_rows":created,
            "unmatched_rows":no_match,"held_rows":len(held),"remaining":max(0,len(candidates)-limit),"output_created":True,
            "source_sha256":hashlib.sha256(source.read_bytes()).hexdigest(),
            "output_sha256":hashlib.sha256(output.read_bytes()).hexdigest(),"asof":stamp}


if __name__ == "__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--source", type=Path,required=True)
    parser.add_argument("--binary-zip",type=Path,required=True)
    parser.add_argument("--output",type=Path,required=True)
    parser.add_argument("--year",type=int,required=True)
    parser.add_argument("--limit",type=int,default=120)
    args=parser.parse_args()
    try:
        result=run(args.source,args.binary_zip,args.year,args.output,args.limit)
        print(json.dumps(result,ensure_ascii=False))
    except Exception:
        print(json.dumps({"status":"error","reason":"offline_job_validation_or_execution_failed"}))
        sys.exit(2)