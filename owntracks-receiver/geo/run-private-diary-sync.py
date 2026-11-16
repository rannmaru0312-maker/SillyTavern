#!/usr/bin/env python3
"""Run validated OwnTracks daily intake and town enrichment in one private session.

This module deliberately NEVER calls Google Drive, public map APIs, or networks.
The controller must fetch private inputs, verify the current Drive file version,
manage non-shared backups, commit by the same file ID, and read back the uploaded
bytes. This script only creates an output copy on success.

All exact coordinates are kept in the private workbook and passed via stdin to
an SHA-pinned offline binary; stdout contains counts and hashes, not locations.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.machinery
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent

def _load(name, file):
    return importlib.machinery.SourceFileLoader(name, str(HERE / file)).load_module()


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(source: Path, daily_files: list[Path], binary_zip: Path, year: int, output: Path,
        *, town_limit: int = 120, max_files: int = 31) -> dict:
    source, output = Path(source), Path(output)
    binary_zip = Path(binary_zip) if binary_zip is not None else None
    if source.resolve() == output.resolve() or not source.is_file():
        raise ValueError('invalid annual source/destination')
    if year < 2020 or year > 2100 or source.name != f'生活記録_{year}.xlsx':
        raise ValueError('wrong annual source')
    if len(daily_files) > max_files or max_files > 366 or not 1 <= town_limit <= 200:
        raise ValueError('unbounded work')
    # The pipeline may import verified GPS data even if the optional offline
    # binary is temporarily unavailable; address completion is reported as deferred.
    # A PRESENT but tampered archive is rejected by the updater (fail closed).
    address_available = bool(binary_zip is not None and binary_zip.is_file())
    # The updater validates both fixed SHA256 digests before executing the binary.
    intake = _load('owntracks_daily_intake', 'import-owntracks-day-into-annual.py')
    town = _load('owntracks_private_town', 'annual-offline-town-update.py')
    integrity = _load('owntracks_diary_integrity', 'verify-diary-delta.py')
    # Detect a changed executable archive even when every address is already filled.
    if address_available and _sha(binary_zip) != town.APPROVED_ARCHIVE_SHA256:
        raise ValueError('offline archive checksum mismatch')

    inputs = []
    seen_days = set()
    for name in daily_files:
        path = Path(name)
        if not path.is_file():
            raise ValueError('daily source missing')
        # Re-read and validate *all* daily events before any workbook edits.
        date, _events = intake.parse_day(path)
        if int(date[:4]) != year or date in seen_days:
            raise ValueError('duplicate or wrong-year daily source')
        seen_days.add(date)
        inputs.append((date, path))
    inputs.sort(key=lambda e: e[0])
    initial_sha = _sha(source)
    day_digests = {date: _sha(path) for date, path in inputs}
    appended, processed = 0, 0
    town_result = {'status': 'unchanged', 'updated_rows': 0, 'held_rows': 0,
                   'unmatched_rows': 0, 'remaining': None}
    address_status = 'ready' if address_available else 'deferred_missing_binary'
    with tempfile.TemporaryDirectory(prefix='miya-private-annual-') as dirname:
        tmp = Path(dirname)
        latest = source
        for index, (date, path) in enumerate(inputs):
            stage = tmp / f'year-{year}-{index:03d}.xlsx'
            result = intake.import_daily(latest, path, stage, year)
            processed += 1
            if result['status'] == 'updated':
                appended += result['appended']
                latest = stage
            elif result['status'] != 'unchanged':
                raise ValueError('unexpected intake result')
        if address_available:
            enriched = tmp / 'enriched.xlsx'
            town_result = town.run(latest, binary_zip, year, enriched, limit=town_limit)
            if town_result['status'] == 'updated':
                latest = enriched
            elif town_result['status'] != 'unchanged':
                raise ValueError('unexpected offline lookup result')
            address_status = 'completed'
        if initial_sha != _sha(source) or any(_sha(path) != day_digests[date] for date, path in inputs):
            raise ValueError('input changed during validation')
        if latest == source:
            return {
                'status': 'unchanged', 'year': year, 'processed_days': processed,
                'appended': 0, 'address_candidates': 0,
                'address_status': address_status,
                'address_held': town_result.get('held_rows', 0),
                'address_unmatched': town_result.get('unmatched_rows', 0),
                'remaining': town_result.get('remaining', 0),
                'output_created': False, 'source_sha256': initial_sha,
            }
        # Verify the entire historical workbook, formula links, manual edits and
        # allowed per-month counters before any candidate is committed.
        report = integrity.verify(source, latest, year)
        if report['new_gps'] != appended:
            raise ValueError('unverified GPS row count')
        if report['new_address_candidates_on_existing_rows'] > town_result['updated_rows']:
            raise ValueError('unverified address changes')
        # Do not leave a misleading output from a previous execution.
        if output.exists():
            raise ValueError('destination already exists')
        output.parent.mkdir(parents=True, exist_ok=True)
        staged = output.with_name(output.name + '.incomplete')
        if staged.exists():
            raise ValueError('stale incomplete output')
        try:
            shutil.copyfile(latest, staged)
            if _sha(staged) != _sha(latest):
                raise ValueError('output copy integrity mismatch')
            os.replace(staged, output)
        finally:
            staged.unlink(missing_ok=True)
    return {
        'status': 'updated', 'year': year, 'processed_days': processed,
        'appended': appended,
        'address_candidates': town_result['updated_rows'],
        'address_status': address_status,
        'address_held': town_result['held_rows'],
        'address_unmatched': town_result['unmatched_rows'],
        'remaining': town_result['remaining'],
        'output_created': True,
        'source_sha256': initial_sha,
        'output_sha256': _sha(output),
    }


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument('--source', type=Path, required=True)
    p.add_argument('--daily-json', type=Path, action='append', default=[])
    p.add_argument('--binary-zip', type=Path, default=None)
    p.add_argument('--year', type=int, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--town-limit', type=int, default=120)
    a = p.parse_args()
    try:
        result = run(a.source, a.daily_json, a.binary_zip, a.year, a.output,
                     town_limit=a.town_limit)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception:
        # No raw GPS, locations, exception messages, paths or credentials in logs.
        print(json.dumps({'status': 'error', 'reason': 'private_daily_pipeline_failed'}))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())