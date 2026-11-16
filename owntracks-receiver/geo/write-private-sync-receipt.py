#!/usr/bin/env python3
"""Write a minimal, privacy-safe and verifiable annual OwnTracks sync receipt.

NO network. This receives only a previously verified Drive readback and a
private runner's structured summary. Never accepts/stores GPS, places or names.
Drive permissions/current-version and upload/readback checks belong to caller.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

SHA = re.compile(r'^[0-9a-f]{64}$')
DRIVE_ID = re.compile(r'^[A-Za-z0-9_-]{20,200}$')
YEAR = range(2020, 2101)
MAX_HISTORY = 14


def digest(path: Path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _valid_time(value):
    if not isinstance(value, str) or not value.endswith('Z'):
        raise ValueError('invalid_check_time')
    date = datetime.fromisoformat(value[:-1] + '+00:00')
    if not (2020 <= date.year <= 2100):
        raise ValueError('invalid_check_time')
    return date


def prepare_receipt(previous: dict | None, run_result: dict, *,
                    workbook: Path, year: int, file_id: str,
                    run_kind: str, checked_at: str,
                    visibility: str = 'not_shared') -> dict:
    """Return next receipt, without mutating source; raising leaves Drive untouched."""
    if type(year) is not int or year not in YEAR or not DRIVE_ID.fullmatch(file_id):
        raise ValueError('invalid_year_or_file_id')
    _valid_time(checked_at)
    if visibility != 'not_shared' or run_kind not in ('manual', 'scheduled'):
        raise ValueError('unverified_privacy_or_trigger')
    if workbook.name != f'生活記録_{year}.xlsx' or not workbook.is_file():
        raise ValueError('wrong_workbook')
    if not isinstance(run_result, dict) or run_result.get('status') not in ('unchanged', 'updated'):
        raise ValueError('invalid_run_result')
    if run_result.get('year') != year or run_result.get('address_status') not in ('completed', 'deferred_missing_binary'):
        raise ValueError('invalid_pipeline_year_or_address_status')
    for field in ('processed_days', 'appended', 'address_candidates', 'address_held', 'address_unmatched'):
        v = run_result.get(field)
        if type(v) is not int or not 0 <= v <= 100000:
            raise ValueError('invalid_count')
    if run_result['processed_days'] > 31 or run_result['appended'] > run_result['processed_days'] * 500:
        raise ValueError('implausible_counts')
    if run_result.get('status') == 'unchanged':
        if run_result['appended'] or run_result['address_candidates'] or run_result.get('output_created') is not False:
            raise ValueError('unchanged_with_changes')
        expected = run_result.get('source_sha256')
    else:
        if run_result.get('output_created') is not True or not (run_result['appended'] or run_result['address_candidates']):
            raise ValueError('updated_without_changes')
        expected = run_result.get('output_sha256')
    if not isinstance(expected, str) or not SHA.fullmatch(expected):
        raise ValueError('invalid_expected_digest')
    actual = digest(workbook)
    if actual != expected:
        raise ValueError('readback_sha_mismatch')

    if previous is None:
        previous = {}
    if not isinstance(previous, dict) or (previous and (previous.get('schema') != 1
        or previous.get('year') != year or previous.get('masterFileId') != file_id)):
        raise ValueError('wrong_existing_receipt')
    history = previous.get('recentRuns', [])
    if not isinstance(history, list) or len(history) > MAX_HISTORY or any(not isinstance(item,dict) for item in history):
        raise ValueError('invalid_history')
    previous_times = [item.get('checkedAt') for item in history]
    if any(not isinstance(t,str) for t in previous_times):
        raise ValueError('invalid_prior_history')
    if history and _valid_time(checked_at) < max(_valid_time(t) for t in previous_times):
        raise ValueError('cannot_backdate_receipt')
    point = {
        'checkedAt': checked_at,
        'runKind': run_kind,
        'status': run_result['status'],
        'processedDays': run_result['processed_days'],
        'newGpsEvents': run_result['appended'],
        'newTownCandidates': run_result['address_candidates'],
        'addressStatus': run_result['address_status'],
        'heldCandidates': run_result['address_held'],
        'unmatchedCandidates': run_result['address_unmatched'],
        'readbackVerified': True,
        'masterSha256': actual,
        'masterSizeBytes': workbook.stat().st_size,
    }
    # A deterministic repeat with the same clock and result is idempotent.
    if not history or history[-1] != point:
        history = [*history, point][-MAX_HISTORY:]
    receipt = {
        'schema': 1, 'year': year, 'masterFileId': file_id,
        'lastChecked': point,
        'lastSuccessfulSave': point if point['status'] == 'updated' else previous.get('lastSuccessfulSave'),
        'lastScheduledCheck': point if run_kind == 'scheduled' else previous.get('lastScheduledCheck'),
        'recentRuns': history,
        'explanation': 'Contains no coordinates, addresses, venue names or personal identifiers; scheduled status must be proven by an actual scheduled run.',
    }
    return receipt


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--runner-result', type=Path, required=True)
    ap.add_argument('--workbook', type=Path, required=True)
    ap.add_argument('--previous', type=Path)
    ap.add_argument('--output', type=Path, required=True)
    ap.add_argument('--year', type=int, required=True)
    ap.add_argument('--file-id', required=True)
    ap.add_argument('--run-kind', choices=['manual', 'scheduled'], required=True)
    ap.add_argument('--verified-visibility', choices=['not_shared'], required=True)
    args=ap.parse_args()
    try:
        run=json.loads(args.runner_result.read_text(encoding='utf8'))
        previous=json.loads(args.previous.read_text(encoding='utf8')) if args.previous else None
        receipt=prepare_receipt(previous,run,workbook=args.workbook,
            year=args.year,file_id=args.file_id,run_kind=args.run_kind,
            checked_at=datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00','Z'),
            visibility=args.verified_visibility)
        if args.output.exists(): raise ValueError('refuse_unsafe_overwrite')
        args.output.write_text(json.dumps(receipt,ensure_ascii=False,indent=2,sort_keys=True)+'\n',encoding='utf8')
        print(json.dumps({'status':'receipt_created','runKind':args.run_kind,'runStatus':run['status'],
                          'count':len(receipt['recentRuns']),'masterDigestVerified':True}))
    except Exception:
        # Do not emit names or detailed paths in logs.
        print(json.dumps({'status':'error','reason':'receipt_generation_failed'}))
        return 2
    return 0

if __name__ == '__main__': sys.exit(main())