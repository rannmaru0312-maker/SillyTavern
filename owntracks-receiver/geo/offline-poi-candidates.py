#!/usr/bin/env python3
"""Private, offline, opt-in OSM POI candidates for an annual OwnTracks workbook.

The catalog is *public reference data only*. The workbook and actual GPS are
never transmitted. Suggestions are NOT confirmed visits, are not written in
original GPS fields, and never overwrite the user's F-column manual corrections.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import math
import os
import re
from datetime import datetime,timezone
from pathlib import Path
from artifact_tool import Blob,SpreadsheetFile

SAFE_TEXT=re.compile(r'^[^\x00-\x1f\x7f]{1,140}$')
SHA=re.compile(r'^[0-9a-f]{64}$')
SOURCE='OpenStreetMap (オフラインPOI・候補未確認)'
CATEGORY=frozenset({'shop','amenity','tourism'})
MAX_CATALOG_BYTES=100*1024*1024
GRID=0.001

def valid_name(n):
    return type(n)==str and n.strip()==n and bool(SAFE_TEXT.fullmatch(n)) and n[0] not in '=+-@'

def valid_latlon(lat,lon):
    return type(lat) in (int,float) and type(lon) in (int,float) and math.isfinite(lat) and math.isfinite(lon) and -90<=lat<=90 and -180<=lon<=180

def dist_m(a,b,c,d):
    r=math.pi/180
    dlat=(c-a)*r;dlon=(d-b)*r
    x=math.sin(dlat/2)**2+math.cos(a*r)*math.cos(c*r)*math.sin(dlon/2)**2
    return 6371000*2*math.asin(min(1,math.sqrt(x)))

def gridkey(lat,lon):return (math.floor(lat/GRID),math.floor(lon/GRID))

def load_catalog(path:Path,*,expected_sha256=None):
    path=Path(path)
    if not path.is_file() or path.stat().st_size==0 or path.stat().st_size>MAX_CATALOG_BYTES:raise ValueError('invalid catalog file')
    raw_hash=hashlib.sha256(path.read_bytes()).hexdigest()
    if expected_sha256 is not None and (not SHA.fullmatch(expected_sha256) or raw_hash!=expected_sha256):raise ValueError('catalog checksum mismatch')
    bins={}; seen=set();count=0
    with path.open(encoding='utf-8') as f:
        header=json.loads(f.readline())
        if not isinstance(header,dict) or header.get('schema')!=1 or header.get('kind')!='public_osm_named_poi_nodes' or header.get('license')!='ODbL-1.0' or header.get('attribution')!='© OpenStreetMap contributors' or not str(header.get('source_url','')).startswith('https://download.geofabrik.de/') or type(header.get('count'))!=int:raise ValueError('untrusted catalog header')
        for line in f:
            if len(line)>1000:raise ValueError('oversized catalog record')
            if not line.strip():continue
            item=json.loads(line)
            if set(item.keys())!={'osm_id','name','lat','lon','category'} or not isinstance(item['osm_id'],str) or not re.fullmatch(r'node/[0-9]{1,20}',item['osm_id']) or not valid_name(item['name']) or not valid_latlon(item['lat'],item['lon']) or item['category'] not in CATEGORY:raise ValueError('invalid POI record')
            if item['osm_id'] in seen:raise ValueError('duplicated POI object')
            seen.add(item['osm_id']);count+=1
            if count>500_000:raise ValueError('catalog exceeds approved size')
            bins.setdefault(gridkey(item['lat'],item['lon']),[]).append(item)
    if count!=header['count']:raise ValueError('truncated POI catalog')
    return bins,{'count':count,'catalog_sha256':raw_hash,'source_url':header['source_url'],'source_snapshot_date':header.get('snapshot_date','unverified')}

def candidate_at(bins,lat,lon,accuracy,*,max_accuracy=12,search_radius=15,ambiguity_radius=35):
    if not valid_latlon(lat,lon) or type(accuracy) not in (float,int) or not math.isfinite(accuracy) or accuracy<0 or accuracy>max_accuracy:return None,'low_accuracy_or_invalid'
    ky,kx=gridkey(lat,lon); candidates=[]
    for y in range(ky-2,ky+3):
        for x in range(kx-2,kx+3):
            for entry in bins.get((y,x),[]):
                d=dist_m(lat,lon,entry['lat'],entry['lon'])
                if d<=ambiguity_radius+accuracy:candidates.append((d,entry))
    if not candidates:return None,'no_named_poi_nearby'
    candidates.sort(key=lambda v:v[0]);best_distance,best=candidates[0]
    if best_distance>search_radius:return None,'no_reliable_close_poi'
    other={v['name'] for d,v in candidates if v['name']!=best['name']}
    if other:return None,'ambiguous_multiple_pois'
    return (best,best_distance),'one_nearby_poi_unverified'

def review_shortlist(bins,lat,lon,accuracy,*,max_accuracy=12,search_radius=15,ambiguity_radius=35):
    """Return text for HUMAN REVIEW only; never assert which place was visited."""
    if not valid_latlon(lat,lon) or type(accuracy) not in (int,float) or not math.isfinite(accuracy) or not 0<=accuracy<=max_accuracy:return None
    ky,kx=gridkey(lat,lon);names={}
    for y in range(ky-2,ky+3):
        for x in range(kx-2,kx+3):
            for obj in bins.get((y,x),[]):
                d=dist_m(lat,lon,obj['lat'],obj['lon'])
                if d<=ambiguity_radius+accuracy:
                    prev=names.get(obj['name'])
                    if prev is None or d<prev[0]:names[obj['name']]=(d,obj)
    if len(names)<2 or len(names)>12 or min(d for d,_ in names.values())>search_radius:return None
    ranked=sorted(names.items(),key=lambda x:x[1][0])
    first=[name for name,_ in ranked[:2]]
    # User-facing cell contains competing candidates, not a confirmed shop.
    label='周辺候補（要確認）：'+'／'.join(first)
    if len(ranked)>2:label+=f' ほか{len(ranked)-2}件'
    if len(label)>140:label=label[:138]+'…'
    if not valid_name(label):return None
    return {'label':label,'count':len(ranked),'nearest':round(ranked[0][1][0]),
            'osm_ids':[entry['osm_id'] for _,(_,entry) in ranked[:2]]}

def snapshot(wb):
    # Read only original fixed-schema sheets, not new display tabs whose cached values may recompute.
    out={}
    for month in range(1,13):
        name=f'{month}月';rng=wb.worksheets.get_item(name).get_range('A1:T500')
        out[name]=(rng.values,rng.formulas)
    for name,range_ in [('店舗名の修正','A1:Q500'),('使い方','A1:D60'),('重複候補・保留','A1:J100'),('出典・照合','A1:I60')]:
        rng=wb.worksheets.get_item(name).get_range(range_)
        out[name]=(rng.values,rng.formulas)
    return out

def verify_delta(before,after,updates):
    for name,(values,formulas) in before.items():
        newv,newf=after[name]
        for ri,(oldrow,newrow,fo,fn) in enumerate(zip(values,newv,formulas,newf),start=1):
            for ci,(av,bv,oldformula,newformula) in enumerate(zip(oldrow,newrow,fo,fn)):
                if oldformula!=newformula:raise ValueError('protected formula changed')
                if av==bv:continue
                allowed=(name=='店舗名の修正' and ri in updates and ci in (3,15,16))
                derived=(name=='店舗名の修正' and ri in updates and ci in (6,7))
                month_derived=any(u['month']==name and u['month_row']==ri and ci in (17,19) for u in updates.values())
                if allowed:
                    u=updates[ri]
                    want={3:u['name'],15:u['provenance'],16:u['at']}[ci]
                    if (ci==16 and (not isinstance(bv,(int,float)) or abs(bv-want)>1/86400)) or (ci!=16 and bv!=want):raise ValueError('wrong candidate write')
                elif month_derived:
                    u=next(u for u in updates.values() if u['month']==name and u['month_row']==ri)
                    want=u['name'] if ci==17 else '自動候補・未確認'
                    if bv!=want:raise ValueError('wrong derived label')
                elif not derived:raise ValueError('protected value changed')

def run(source:Path,catalog:Path,output:Path,*,expected_catalog_sha256=None,limit=250,now=None,allow_review_shortlists=False):
    source,catalog,output=Path(source),Path(catalog),Path(output)
    if not source.is_file() or source.resolve()==output.resolve() or output.exists() or not 1<=limit<=500:raise ValueError('invalid paths or limit')
    bins,info=load_catalog(catalog,expected_sha256=expected_catalog_sha256)
    if info['count']==0:return {'status':'no_public_poi_data','candidate_count':0,'output_created':False}
    at=now or datetime.now(timezone.utc)
    if at.tzinfo is None:raise ValueError('timezone required')
    date_serial=(at.astimezone(timezone.utc)-datetime(1899,12,30,tzinfo=timezone.utc)).total_seconds()/86400
    source_digest=hashlib.sha256(source.read_bytes()).hexdigest()
    wb=SpreadsheetFile.import_xlsx(Blob.load(str(source)))
    sheet=wb.worksheets.get_item('店舗名の修正')
    if sheet.get_range('D4').values[0][0]!='自動店舗候補' or sheet.get_range('F4').values[0][0]!='店舗名（本人修正）' or sheet.get_range('I4').values[0][0]!='イベントID' or sheet.get_range('P4:Q4').values[0]!=['店舗候補の根拠','候補判定日時']:raise ValueError('schema mismatch')
    before=snapshot(wb); updates={}; held=0; scanned=0; review_added=0
    for rown,row in enumerate(sheet.get_range('A5:Q500').values,5):
        if len(updates)>=limit:break
        (day,clock,old_name,poi,old_address,manual,_,_,eid,sourcekind,month,month_row,_,_,_,proof,checked)=row
        if sourcekind!='OwnTracks GPS':continue
        if not isinstance(eid,str) or not SHA.fullmatch(eid):raise ValueError('invalid event ID')
        scanned+=1
        if manual not in (None,'') or poi not in (None,'') or proof not in (None,'') or checked not in (None,''):continue
        if not isinstance(month,str) or not month.endswith('月') or type(month_row)!=int or month_row<5 or month_row>500:raise ValueError('invalid linked original row')
        source_row=wb.worksheets.get_item(month).get_range(f'A{month_row}:K{month_row}').values[0]
        if source_row[10]!=eid or source_row[6]!='OwnTracks GPS' or not all(type(v) in (float,int) and math.isfinite(v) for v in source_row[7:10]):raise ValueError('untrusted GPS linkage')
        if not isinstance(source_row[0],(float,int)) or not isinstance(day,(float,int)) or int(source_row[0])!=int(day):raise ValueError('date mismatch')
        # Existing confirmed/private place names are not overridden. Only source rows explicitly '未登録'.
        if source_row[4]!='未登録':continue
        candidate,reason=candidate_at(bins,source_row[7],source_row[8],source_row[9])
        if candidate is None:
            if reason=='ambiguous_multiple_pois':
                held+=1
                if allow_review_shortlists:
                    choices=review_shortlist(bins,source_row[7],source_row[8],source_row[9])
                    if choices:
                        updates[rown]={'name':choices['label'],
                            'provenance':f'OSM複数候補 {choices["count"]}店 / 最短約{choices["nearest"]}m / {",".join(choices["osm_ids"])} / 要本人確認・入店未確定（ODbL）',
                            'at':date_serial,'month':month,'month_row':month_row}
                        review_added+=1
            continue
        item,dist=candidate
        updates[rown]={'name':item['name'],'provenance':f'OSM {item["osm_id"]} / {item["category"]} / 約{round(dist)}m・近接未確認、入店未確定（ODbL）','at':date_serial,'month':month,'month_row':month_row}
    if not updates:return {'status':'unchanged','gps_scanned':scanned,'candidate_count':0,'ambiguous_held':held,'public_pois_loaded':info['count'],'output_created':False}
    for rown,u in updates.items():
        sheet.get_range(f'D{rown}').values=[[u['name']]]
        sheet.get_range(f'P{rown}').values=[[u['provenance']]]
        sheet.get_range(f'Q{rown}').values=[[u['at']]]
        sheet.get_range(f'Q{rown}').set_number_format('yyyy/mm/dd hh:mm')
    if source_digest!=hashlib.sha256(source.read_bytes()).hexdigest():raise ValueError('source changed')
    SpreadsheetFile.export_xlsx(wb).save(str(output))
    check=SpreadsheetFile.import_xlsx(Blob.load(str(output)))
    verify_delta(before,snapshot(check),updates)
    return {'status':'updated','gps_scanned':scanned,'candidate_count':len(updates),'review_shortlists':review_added,'ambiguous_held':held,'public_pois_loaded':info['count'],'output_created':True,'source_sha256':source_digest,'output_sha256':hashlib.sha256(output.read_bytes()).hexdigest()}

if __name__=='__main__':
    a=argparse.ArgumentParser();a.add_argument('--source',type=Path,required=True);a.add_argument('--catalog',type=Path,required=True);a.add_argument('--output',type=Path,required=True);a.add_argument('--catalog-sha256');a.add_argument('--limit',type=int,default=250);a.add_argument('--allow-review-shortlists',action='store_true')
    q=a.parse_args()
    try:print(json.dumps(run(q.source,q.catalog,q.output,expected_catalog_sha256=q.catalog_sha256,limit=q.limit,allow_review_shortlists=q.allow_review_shortlists),ensure_ascii=False))
    except Exception:print(json.dumps({'status':'error','reason':'offline_poi_candidate_validation_failed'}));raise SystemExit(2)