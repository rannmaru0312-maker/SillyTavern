#!/usr/bin/env python3
"""Create unverified business-name suggestions from *already user-confirmed*
public-venue stays and same-day GPS observations, entirely offline.

Does not geocode, infer arrivals, or silently overwrite manual names, known
candidates, address provenance, raw GPS, or the source annual workbook.
A narrow first version: only public venues on the explicit allow-list, and
only diary rows explicitly stating the PLACE (not the timestamp) was confirmed.
"""
import argparse
import hashlib
import json
import math
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo
from artifact_tool import Blob, SpreadsheetFile

# Site-specific allow-lists are private configuration, never committed to GitHub.
PUBLIC_PLACES = frozenset()
JST=ZoneInfo('Asia/Tokyo')
EPOCH=datetime(1899,12,30)
SHA=re.compile(r'^[0-9a-f]{64}$')

def serial_time(now):
    return (now.astimezone(JST).replace(tzinfo=None)-EPOCH).total_seconds()/86400

def safe(v):
    return isinstance(v,str) and 1 <= len(v) <= 140 and not re.search(r'[\x00-\x1f\x7f]',v) and not re.match(r'^\s*[=+\-@]',v)

def realnum(v):
    return type(v) in (int,float) and math.isfinite(v)

def snapshot(wb):
    """Protect all original month rows, all correction content except allowable candidate metadata."""
    ret={}
    for line in wb.inspect({'kind':'sheet','include':'id,name'}).ndjson.splitlines():
        item=json.loads(line)
        found=re.search(r'(\d+)$',item.get('address',''))
        if found and int(found.group(1))>350:
            raise ValueError('workbook extends beyond protected scan range')
    for m in range(1,13):
        sh=wb.worksheets.get_item(f'{m}月')
        r=sh.get_range('A1:T350')
        ret[f'{m}月']={'values':r.values,'formulas':r.formulas}
    sh=wb.worksheets.get_item('店舗名の修正');r=sh.get_range('A1:Q350')
    ret['店舗名の修正']={'values':r.values,'formulas':r.formulas}
    for name,rect in [('使い方','A1:D350'),('重複候補・保留','A1:J350'),('出典・照合','A1:I350')]:
        try:
            v=wb.worksheets.get_item(name).get_range(rect)
            ret[name]={'values':v.values,'formulas':v.formulas}
        except (KeyError,AttributeError):
            pass
    return ret

def _validate_integrity(prior,after,updates):
    counts={'month':0,'correction':0}
    for name,p in prior.items():
        q=after[name]
        for ri,(a,b,fa,fb) in enumerate(zip(p['values'],q['values'],p['formulas'],q['formulas'])):
            excel_row=ri+1
            for ci,(av,bv,afv,bfv) in enumerate(zip(a,b,fa,fb)):
                if afv != bfv: raise ValueError('protected formula changed')
                allowed=name=='店舗名の修正' and excel_row in updates and ci in (3,15,16)
                header_added=name=='店舗名の修正' and excel_row==4 and ci in (15,16) and av in (None,'')
                # Formula result in G/H derives from candidate D, and may recalculate.
                derived=name=='店舗名の修正' and excel_row in updates and ci in (6,7)
                month_derived=name!='店舗名の修正' and ci in (17,19) and any(
                    u['month_name']==name and u['month_row']==excel_row for u in updates.values())
                if not allowed and not header_added and not derived and not month_derived and (av if av is not None else '') != (bv if bv is not None else ''):
                    raise ValueError('protected value changed')
                if header_added and bv != ('店舗候補の根拠' if ci==15 else '候補判定日時'):
                    raise ValueError('unexpected provenance header')
                if month_derived:
                    match=next(u for u in updates.values() if u['month_name']==name and u['month_row']==excel_row)
                    expected=match['name'] if ci==17 else '自動候補・未確認'
                    if bv!=expected:raise ValueError('derived month label/status mismatch')
                if allowed:
                    want=updates[excel_row]
                    val={3:want['name'],15:want['provenance'],16:want['checked_serial']}[ci]
                    if ci==16:
                        if not realnum(bv) or abs(bv-val)>1/86400:raise ValueError('timestamp changed')
                    elif bv!=val:raise ValueError('candidate/provenance mismatch')
        counts['month' if name!='店舗名の修正' else 'correction']+=1
    return counts

def run(source:Path, output:Path, *, allowed_places=PUBLIC_PLACES, now=None):
    source=Path(source);output=Path(output)
    if not source.is_file() or source.resolve()==output.resolve() or output.exists():
        raise ValueError('invalid paths')
    now=now or datetime.now(timezone.utc)
    if now.tzinfo is None:raise ValueError('timezone required')
    if not all(safe(p) for p in allowed_places):raise ValueError('invalid venue allowlist')
    original_sha=hashlib.sha256(source.read_bytes()).hexdigest()
    wb=SpreadsheetFile.import_xlsx(Blob.load(str(source)))
    cs=wb.worksheets.get_item('店舗名の修正')
    required={"D":"自動店舗候補","F":"店舗名（本人修正）","I":"イベントID"}
    for c,h in required.items():
        if cs.get_range(f'{c}4').values[0][0]!=h:raise ValueError('unknown correction sheet schema')
    p_hdr=cs.get_range('P4').values[0][0]
    q_hdr=cs.get_range('Q4').values[0][0]
    if p_hdr not in (None,'','店舗候補の根拠') or q_hdr not in (None,'','候補判定日時'):
        raise ValueError('conflicting provenance columns')
    before=snapshot(wb)
    anchors=[]
    for m in range(1,13):
        sh=wb.worksheets.get_item(f'{m}月')
        rows=sh.get_range('A5:G350').values
        for rownum,row in enumerate(rows,5):
            day,started,ended,kind,place,note,sourcekind=row
            if (kind!='滞在（GPS推定）' or place not in allowed_places or
                not isinstance(note,str) or '訪問先は本人確認済み' not in note or
                not (realnum(day) and realnum(started) and realnum(ended)) or
                not 0<=started<1 or not 0<=ended<1 or ended<=started):
                continue
            anchor_day=int(day)
            if (EPOCH+timedelta(days=anchor_day)).month!=m:raise ValueError('anchor month mismatch')
            anchors.append({'day':anchor_day,'start':started,'end':ended,'place':place,'m':m,'row':rownum})
    rows=cs.get_range('A5:Q350').values
    updates={}; held=0; examined=0
    for c_row,row in enumerate(rows,5):
        day,t,old_place,business,address,manual,_,_,eid,src,month,sourcerow,_,_,_,old_reason,old_checked=row
        if src!='OwnTracks GPS' or not isinstance(eid,str):continue
        if not SHA.fullmatch(eid):raise ValueError('invalid event ID')
        if not (realnum(day) and realnum(t) and 0<=t<1):raise ValueError('invalid observation time')
        examined+=1
        if business not in ('',None) or manual not in ('',None) or old_reason not in ('',None) or old_checked not in ('',None):continue
        if not (isinstance(month,str) and month.endswith('月') and type(sourcerow) is int and sourcerow>=5):
            raise ValueError('invalid linked month row')
        sh=wb.worksheets.get_item(month)
        source_link=sh.get_range(f'A{sourcerow}:K{sourcerow}').values[0]
        if (source_link[10]!=eid or source_link[6]!='OwnTracks GPS' or
            not all(realnum(x) for x in (source_link[7],source_link[8],source_link[9])) or
            source_link[9] >25 or int(source_link[0])!=int(day) or
            abs((source_link[1]-t)*86400)>3):
            continue
        # The user-confirmed venue does not confirm that the phone was physically inside.
        matched=[a for a in anchors if a['day']==int(day) and
                 a['start']+2/1440<=t<=a['end']-2/1440]
        names={a['place'] for a in matched}
        if not matched: continue
        if len(names)!=1:held+=1;continue
        a=matched[0]
        updates[c_row]={
            'name':a['place'],
            'provenance':f'{a["m"]}月!{a["row"]} 本人確認の訪問先＋推定滞在時刻との一致（現地GPS一致は未確認）',
            'checked_serial':serial_time(now),
            'month_name':month,'month_row':sourcerow
        }
    if not updates:return {'status':'unchanged','gps_examined':examined,'candidate_count':0,'held_ambiguous':held,'output_created':False}
    cs.get_range('P4:Q4').values=[['店舗候補の根拠','候補判定日時']]
    cs.get_range('P4:Q4').format={'fill':'#24556B','font':{'bold':True,'color':'#FFFFFF'},'wrap_text':True}
    cs.get_range('P:P').format.column_width=47
    cs.get_range('Q:Q').format.column_width=22
    for n,entry in updates.items():
        cs.get_range(f'D{n}').values=[[entry['name']]]
        cs.get_range(f'P{n}').values=[[entry['provenance']]]
        cs.get_range(f'Q{n}').values=[[entry['checked_serial']]]
        cs.get_range(f'Q{n}').set_number_format('yyyy/mm/dd hh:mm:ss')
    if original_sha!=hashlib.sha256(source.read_bytes()).hexdigest():raise ValueError('source changed during calculation')
    SpreadsheetFile.export_xlsx(wb).save(str(output))
    b=SpreadsheetFile.import_xlsx(Blob.load(str(output)))
    after=snapshot(b)
    _validate_integrity(before,after,updates)
    c=b.worksheets.get_item('店舗名の修正')
    for k,e in updates.items():
        if c.get_range(f'D{k}').values[0][0]!=e['name'] or c.get_range(f'F{k}').values[0][0] not in (None,''):
            raise ValueError('manual correction or business candidate changed')
    return {'status':'updated','gps_examined':examined,'candidate_count':len(updates),
            'held_ambiguous':held,'output_created':True,
            'source_sha256':original_sha,'output_sha256':hashlib.sha256(output.read_bytes()).hexdigest()}

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--source',required=True,type=Path);p.add_argument('--output',required=True,type=Path)
    p.add_argument('--allowed-places-file',required=True,type=Path,help='private JSON string array (never commit or log)')
    a=p.parse_args()
    try:
        sites=json.loads(a.allowed_places_file.read_text(encoding='utf-8'))
        if not isinstance(sites,list) or len(sites)>100 or not all(safe(x) for x in sites):
            raise ValueError('invalid private allowed places')
        print(json.dumps(run(a.source,a.output,allowed_places=frozenset(sites)),ensure_ascii=False))
    except Exception:
        print(json.dumps({'status':'error','reason':'offline_business_candidate_validation_failed'}));raise SystemExit(2)