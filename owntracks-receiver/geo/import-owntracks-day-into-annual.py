#!/usr/bin/env python3
"""Import one validated OwnTracks daily JSON into the annual Excel *copy*.
No network, no uploads, no mutation of inputs. Private GPS stays in local working set.
"""
import argparse
import hashlib
import json
import re
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo
from artifact_tool import Blob, SpreadsheetFile

JST=ZoneInfo('Asia/Tokyo')
EPOCH=datetime(1899,12,30)
HEX=re.compile(r'^[0-9a-f]{64}$')


def serial(dt):
    return (dt.replace(tzinfo=None)-EPOCH).total_seconds()/86400


def parse_day(path):
    obj=json.loads(path.read_text(encoding='utf8'))
    if (obj.get('version')!=1 or obj.get('source')!='owntracks'
            or obj.get('timezone')!='Asia/Tokyo'
            or obj.get('coverageVerified') is not False
            or not re.fullmatch(r'\d{4}-\d{2}-\d{2}',obj.get('date',''))
            or not isinstance(obj.get('events'),list)):
        raise ValueError('invalid OwnTracks source envelope')
    if path.name.split('.')[0] != f"owntracks_{obj['date']}":
        raise ValueError('source filename/date mismatch')
    seen=set()
    out=[]
    for item in obj['events']:
        eid=item.get('id'); canonical=item.get('canonical'); payload=item.get('payload')
        if not isinstance(eid,str) or not HEX.fullmatch(eid) or eid in seen:
            raise ValueError('invalid or duplicate event ID')
        seen.add(eid)
        if not isinstance(canonical,str) or hashlib.sha256(canonical.encode('utf8')).hexdigest()!=eid:
            raise ValueError('invalid canonical SHA')
        if json.loads(canonical)!=payload or not isinstance(payload,dict) or payload.get('_type') not in ('location','transition'):
            raise ValueError('payload mismatch')
        # Ignore intentionally generated tests but never invent a real visit from them.
        if (str(payload.get('tid', '')).upper() == 'TEST'
                or 'SYNTHETIC' in str(payload.get('desc', '')).upper()
                or item.get('synthetic') is True):
            continue
        # Text from a phone must not become a spreadsheet formula or control text.
        tid=payload.get('tid', '')
        if not isinstance(tid,str) or len(tid)>32 or re.match(r'^\s*[=+@\-]',tid) or re.search(r'[\x00-\x1f\x7f]',tid):
            raise ValueError('unsafe device label')
        for field,a,b in [('lat',-90,90),('lon',-180,180)]:
            v=payload.get(field)
            if type(v) not in (int,float) or not (a<=v<=b): raise ValueError('invalid GPS')
        acc=payload.get('acc')
        if acc is not None and (type(acc) not in (int,float) or not 0<=acc<=200000):
            raise ValueError('invalid GPS accuracy')
        tst=payload.get('tst')
        if type(tst) is not int or tst<946684800:
            raise ValueError('invalid observation time')
        t=datetime.fromtimestamp(tst,tz=timezone.utc).astimezone(JST)
        if t.date().isoformat()!=obj['date']:
            raise ValueError('observation local date mismatch')
        if payload['_type']=='transition' and payload.get('event') not in ('enter','leave'):
            raise ValueError('invalid transition')
        raw_recv=item.get('receivedAt')
        if not isinstance(raw_recv,str) or not raw_recv.endswith('Z'):
            raise ValueError('invalid receivedAt timezone')
        recv=datetime.fromisoformat(raw_recv.replace('Z','+00:00')).astimezone(JST)
        if recv.year<2020 or recv.year>2100:
            raise ValueError('invalid receivedAt')
        out.append({'id':eid,'p':payload,'observed':t,'received':recv})
    return obj['date'],sorted(out,key=lambda d:(d['observed'],d['id']))


def existing_ids(book):
    seen={}
    for mo in range(1,13):
        sh=book.worksheets.get_item(f'{mo}月')
        ids=sh.get_range('K5:K2000').values
        for row,values in enumerate(ids,5):
            eid=values[0]
            if isinstance(eid,str) and HEX.fullmatch(eid):
                if eid in seen: raise ValueError('duplicate ID in monthly rows')
                seen[eid]=(mo,row)
    return seen


def last_occupied(sh,col,start=5,limit=2000):
    rows=sh.get_range(f'{col}{start}:{col}{limit}').values
    last=start-1
    for r,v in enumerate(rows,start):
        if v[0] not in (None,''):
            last=r
    return last


def import_daily(source_book, source_json, output, expected_year):
    if source_book.resolve()==output.resolve():raise ValueError('input and output paths must differ')
    day,events=parse_day(source_json)
    y,m,_=map(int,day.split('-'))
    if y != expected_year:
        raise ValueError('wrong annual destination year')
    match=re.search(r'生活記録_(\d{4})\.xlsx$',source_book.name)
    if match and int(match.group(1)) != expected_year:
        raise ValueError('destination filename year mismatch')
    book=SpreadsheetFile.import_xlsx(Blob.load(str(source_book)))
    sh=book.worksheets.get_item(f'{m}月')
    corrections=book.worksheets.get_item('店舗名の修正')
    if sh.get_range('K4').values[0][0]!='統合用ID／イベントID' or corrections.get_range('I4').values[0][0]!='イベントID':
        raise ValueError('unexpected annual workbook schema')
    seen=existing_ids(book)
    correction_rows=corrections.get_range('I5:I2000').values
    old_corr={a[0]:r for r,a in enumerate(correction_rows,5) if a[0] not in ('',None)}
    if len(old_corr)!=sum(a[0] not in ('',None) for a in correction_rows):
        raise ValueError('duplicate correction IDs')
    for eid,(month,row) in seen.items():
        if eid not in old_corr:
            raise ValueError('existing GPS lacks correction row')
    # If an event already exists, check immutable observation evidence instead
    # of treating every matching ID as proof of identical workbook content.
    for ev in events:
        if ev['id'] not in seen:
            continue
        old_month,old_row=seen[ev['id']]
        current=book.worksheets.get_item(f'{old_month}月')
        old_source=current.get_range(f'G{old_row}').values[0][0]
        current_lat,current_lon=current.get_range(f'H{old_row}:I{old_row}').values[0]
        current_day=current.get_range(f'A{old_row}').values[0][0]
        current_time=current.get_range(f'B{old_row}').values[0][0]
        if (old_source!='OwnTracks GPS' or old_month!=m
                or type(current_lat) not in (int,float)
                or type(current_lon) not in (int,float)
                or abs(current_lat-ev['p']['lat'])>1e-6
                or abs(current_lon-ev['p']['lon'])>1e-6
                or type(current_day) not in (int,float)
                or int(current_day)!=int(serial(ev['observed']))
                or type(current_time) not in (int,float)
                or abs(float(current_time) - (serial(ev['observed'])%1))*86400>3):
            raise ValueError('existing event conflicts with original observation')
    to_add=[x for x in events if x['id'] not in seen]
    if not to_add:
        return {'status':'unchanged','raw_events':len(events),'appended':0,'output_created':False}
    if len(to_add)>200:raise ValueError('single run exceeds 200 new entries')
    month_start=last_occupied(sh,'K')+1
    corr_start=last_occupied(corrections,'I')+1
    if month_start<5 or corr_start<5:raise ValueError('invalid output position')
    # Source pages are preserved. No actual visit or arrival can be inferred from a GPS point.
    month_vals=[];corr_vals=[];month_formulas=[];corr_forms=[]
    for j,ev in enumerate(to_add):
        p=ev['p']; t=ev['observed']; r=ev['received']; rr=month_start+j;cr=corr_start+j
        dt=int(serial(t));tm=serial(t)-dt
        note='GPS推定・本人未確認'
        event_detail=(p.get('event') or '') if p['_type']=='transition' else 'location'
        location='未登録'
        type_='位置記録' if p['_type']=='location' else '位置イベント（GPS推定）'
        # A:P values, Q:T formulas: ensure even month-specific derived values are ID-linked.
        month_vals.append([dt,tm,None,type_,location,note,'OwnTracks GPS',p['lat'],p['lon'],p.get('acc'),
                           ev['id'],serial(r),'OwnTracks',f'owntracks_{day}.json',p.get('tid',''),event_detail])
        mapformula=f'=HYPERLINK("https://www.google.com/maps/search/?api=1&query={p["lat"]:.7f}%2C{p["lon"]:.7f}","座標を開く")'
        month_formulas.append([mapformula,f"='店舗名の修正'!G{cr}",f"='店舗名の修正'!E{cr}",f"='店舗名の修正'!H{cr}"])
        corr_vals.append([dt,tm,location,None,None,None,None,None,ev['id'],'OwnTracks GPS',f'{m}月',rr,
                          None,None,None])
        corr_forms.append([f'=IF(F{cr}<>"",F{cr},IF(D{cr}<>"",D{cr},C{cr}))',
                           f'=IF(F{cr}<>"","本人修正・確定",IF(D{cr}<>"","自動候補・未確認",IF(C{cr}="未登録","候補未取得","既存登録・未再判定")))'])
    e1=month_start+len(to_add)-1;e2=corr_start+len(to_add)-1
    sh.get_range(f'A{month_start}:P{e1}').values=month_vals
    sh.get_range(f'Q{month_start}:T{e1}').formulas=month_formulas
    corrections.get_range(f'A{corr_start}:O{e2}').values=corr_vals
    corrections.get_range(f'G{corr_start}:H{e2}').formulas=corr_forms
    corrections.get_range(f'M{corr_start}:M{e2}').formulas=[[v[0]] for v in month_formulas]
    sh.get_range(f'A{month_start}:A{e1}').set_number_format('yyyy/mm/dd')
    sh.get_range(f'B{month_start}:B{e1}').set_number_format('hh:mm:ss')
    sh.get_range(f'H{month_start}:I{e1}').set_number_format('0.000000')
    sh.get_range(f'L{month_start}:L{e1}').set_number_format('yyyy/mm/dd hh:mm:ss')
    sh.get_range(f'D{month_start}:G{e1}').format.fill='#FFF7E8'
    corrections.get_range(f'F{corr_start}:F{e2}').format.fill='#FFF1BC'
    corrections.get_range(f'A{corr_start}:A{e2}').set_number_format('yyyy/mm/dd')
    corrections.get_range(f'B{corr_start}:B{e2}').set_number_format('hh:mm:ss')
    # Preserve current statistics; increment only newly appended rows.
    old_count=sh.get_range('B3').values[0][0]
    old_gps=sh.get_range('F3').values[0][0]
    if type(old_count) not in (int,float) or type(old_gps) not in (int,float):
        raise ValueError('existing summary counters are invalid')
    sh.get_range('B3').values=[[int(old_count)+len(to_add)]]
    sh.get_range('F3').values=[[int(old_gps)+len(to_add)]]
    try:
        guide=book.worksheets.get_item('使い方')
        rows=guide.get_range('A16:D27').values
        for i,row in enumerate(rows,16):
            if row[0]==f'{m}月':
                for col in ('C','D'):
                    v=guide.get_range(f'{col}{i}').values[0][0]
                    if type(v) not in (int,float):raise ValueError('invalid yearly summary')
                    guide.get_range(f'{col}{i}').values=[[int(v)+len(to_add)]]
                break
    except (KeyError,AttributeError):
        pass
    # Export new file and test newly appended event IDs and originals.
    SpreadsheetFile.export_xlsx(book).save(str(output))
    check=SpreadsheetFile.import_xlsx(Blob.load(str(output)))
    got_month=check.worksheets.get_item(f'{m}月').get_range(f'K{month_start}:K{e1}').values
    got_corr=check.worksheets.get_item('店舗名の修正').get_range(f'I{corr_start}:I{e2}').values
    wanted=[x['id'] for x in to_add]
    if [x[0] for x in got_month]!=wanted or [x[0] for x in got_corr]!=wanted:
        raise ValueError('new IDs differ after readback')
    # All records from the original workbook remain in the same month and row.
    if existing_ids(check).items() >= seen.items():
        pass
    else:
        raise ValueError('old event IDs changed')
    got=check.worksheets.get_item('店舗名の修正').get_range(f'F{corr_start}:F{e2}').values
    if any(x[0] not in (None,'') for x in got):raise ValueError('unexpected manual correction')
    return {'status':'updated','raw_events':len(events),'appended':len(to_add),
            'year':y,'month':m,'output_created':True,
            'source_sha256':hashlib.sha256(source_book.read_bytes()).hexdigest(),
            'output_sha256':hashlib.sha256(output.read_bytes()).hexdigest()}

if __name__=='__main__':
    ap=argparse.ArgumentParser()
    ap.add_argument('--source',type=Path,required=True)
    ap.add_argument('--year',type=int,required=True)
    ap.add_argument('--daily-json',type=Path,required=True)
    ap.add_argument('--output',type=Path,required=True)
    a=ap.parse_args()
    try:
        print(json.dumps(import_daily(a.source,a.daily_json,a.output,a.year),ensure_ascii=False))
    except Exception:
        print(json.dumps({'status':'error','reason':'daily_source_or_workbook_validation_failed'}))
        sys.exit(2)