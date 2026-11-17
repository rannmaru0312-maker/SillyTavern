"""Extract in-memory-only local GPS correction candidates from annual Excel.

Produces a PRIVATE JSON handoff for plan-local-candidates.mjs. It contains real
GPS data if the source workbook does. Never upload it, add it to Git, or expose
its contents in CI. Does not change the source workbook.
"""
import json
import sys
from pathlib import Path
from datetime import datetime, timedelta, date
from artifact_tool import Blob, SpreadsheetFile


def safe_num(value):
    if type(value) not in (int, float):
        return None
    if not (-180 <= value <= 180):
        return None
    return float(value)


def extract(source: Path, target: Path, year: int):
    if source.resolve() == target.resolve():
        raise ValueError('Do not overwrite workbook')
    book = SpreadsheetFile.import_xlsx(Blob.load(str(source)))
    corrections = book.worksheets.get_item('店舗名の修正')
    rows = corrections.get_range('A5:O1000').values
    sources, targets, records = [], [], []
    seen = set()
    for index, row in enumerate(rows, 5):
        if len(row) < 15 or not row[8]:
            continue
        event_id = row[8]
        if not isinstance(event_id, str) or event_id in seen:
            raise ValueError('Duplicate or invalid event ID')
        seen.add(event_id)
        month = row[10]
        row_in_month = row[11]
        if month not in [f'{i}月' for i in range(1, 13)] or type(row_in_month) is not int or row_in_month < 5:
            raise ValueError('Invalid monthly link')
        month_sheet = book.worksheets.get_item(month)
        recorded_day = month_sheet.get_range(f'A{row_in_month}').values[0][0]
        if isinstance(recorded_day, (int, float)):
            recorded_day = (datetime(1899,12,30)+timedelta(days=float(recorded_day))).date()
        elif isinstance(recorded_day, datetime):
            recorded_day = recorded_day.date()
        if not isinstance(recorded_day, date) or recorded_day.year != year or recorded_day.month != int(month[:-1]):
            raise ValueError('Monthly row date does not match workbook year and month')
        sample = month_sheet.get_range(f'H{row_in_month}:K{row_in_month}').values[0]
        lat,lon,acc,source_id = (sample + [None]*4)[:4]
        if event_id != source_id:
            raise ValueError('Event ID in monthly sheet differs')
        # A month/year value is verified by the caller's yearly workbook location.
        if safe_num(lat) is None or safe_num(lon) is None:
            continue
        if not (0 <= lat <= 90 or -90 <= lat <= 0) or not (-180 <= lon <= 180):
            raise ValueError('Invalid coordinates')
        if type(acc) not in (int, float) or acc < 0:
            continue
        point = dict(eventId=event_id,lat=float(lat),lon=float(lon),accuracyMeters=float(acc))
        manual = row[5] or ''
        if isinstance(manual, str) and manual.strip():
            sources.append({**point,'manualCorrection': manual})
        else:
            targets.append(point)
        records.append(dict(eventId=event_id,rowNumber=index,monthSheet=month,year=year,
            existingBusinessCandidate=row[3] or '',existingAddressCandidate=row[4] or '',
            existingProvider=row[13] or '',existingCheckedAt=str(row[14] or ''),
            manualCorrection=str(manual or '')))
    target.parent.mkdir(parents=True,exist_ok=True)
    target.write_text(json.dumps(dict(year=year,correctedSources=sources,targets=targets,workbookRecords=records),ensure_ascii=False),encoding='utf-8')
    try: target.chmod(0o600)
    except OSError: pass
    return {'corrections':len(sources),'targets':len(targets),'records':len(records)}

if __name__ == '__main__':
    if len(sys.argv)!=4:
        raise SystemExit('Usage: extract-local-corrections.py private.xlsx private-handoff.json 2026')
    print(extract(Path(sys.argv[1]),Path(sys.argv[2]),int(sys.argv[3])))