#!/usr/bin/env python3
"""Build a *public OSM only* named-POI catalog from osmium-export geojsonseq.

No personal GPS is accepted. The output is a static, shareable ODbL catalog.
For Kansai: download Geofabrik kansai-latest.osm.pbf, then run:
  osmium tags-filter kansai.osm.pbf nwr/shop nwr/amenity nwr/tourism -o poi-filtered.osm.pbf
  osmium export poi-filtered.osm.pbf -f geojsonseq -a type,id -o poi.geojsonseq
  python build-public-poi-catalog.py --input poi.geojsonseq --output public-kansai-poi.ndjson
"""
from __future__ import annotations
import argparse
import hashlib
import json
import math
from pathlib import Path

ALLOWED_AMENITIES=frozenset('restaurant cafe bar pub fast_food food_court pharmacy hospital clinic doctors dentist bank post_office library community_centre school college university kindergarten theatre cinema arts_centre fuel marketplace public_bath townhall'.split())
ALLOWED_TOURISM=frozenset('hotel guest_house hostel museum gallery attraction information zoo aquarium theme_park viewpoint'.split())
REJECT_SHOPS=frozenset(['no','vacant','disused','abandoned'])
MAX_SIZE=750*1024*1024

def clean(v,maxlen=140):
    if not isinstance(v,str):return ''
    s=v.strip()
    if not s or len(s)>maxlen or s[0] in '=+-@' or any(ord(c)<32 for c in s):return ''
    return s

def category(props):
    shop=clean(props.get('shop'),60)
    if shop and shop not in REJECT_SHOPS and shop!='yes': return 'shop'
    amenity=clean(props.get('amenity'),60)
    if amenity in ALLOWED_AMENITIES:return 'amenity'
    tourism=clean(props.get('tourism'),60)
    if tourism in ALLOWED_TOURISM:return 'tourism'
    return ''

def coords(geometry):
    """Point or small (<100m) building polygon: conservative center.

    Large buildings/complexes and long ways are not approximated as a point.
    """
    if not isinstance(geometry,dict):return None
    kind=geometry.get('type'); data=geometry.get('coordinates')
    if kind=='Point':
        if not isinstance(data,list) or len(data)<2:return None
        lon,lat=data[:2]
        if any(type(z) not in (int,float) or not math.isfinite(z) for z in (lat,lon)):return None
        if not (-90<=lat<=90 and -180<=lon<=180):return None
        return (round(lat,7),round(lon,7))
    # Reject area geometries: centroids of large buildings are misleading; node POIs only
    return None

def read_features(src:Path):
    if not src.is_file() or src.stat().st_size>MAX_SIZE:raise ValueError('invalid input size')
    with src.open(encoding='utf-8') as f:
        for index,line in enumerate(f):
            if len(line)>1_000_000:raise ValueError('feature too large')
            s=line.lstrip('\x1e \t\r\n')
            if not s:continue
            if index>6_000_000:raise ValueError('too many objects')
            yield json.loads(s)

def create(src:Path,dst:Path,*,source_url='https://download.geofabrik.de/asia/japan/kansai-latest.osm.pbf',snapshot_date='unverified'):
    if dst.exists() or src.resolve()==dst.resolve():raise ValueError('destination exists')
    if not source_url.startswith('https://download.geofabrik.de/'):
        raise ValueError('unapproved public source')
    seen=set(); out=[]; groups={}; checked=0
    for feature in read_features(src):
        checked+=1
        if not isinstance(feature,dict) or feature.get('type')!='Feature':continue
        props=feature.get('properties') or {}
        if not isinstance(props,dict):continue
        name=clean(props.get('name:ja') or props.get('name'))
        cat=category(props); location=coords(feature.get('geometry'))
        if not (name and cat and location):continue
        object_type=clean(props.get('@type') or props.get('osm_type') or 'node',30)
        object_id=props.get('@id') or props.get('osm_id')
        if object_type!='node' or isinstance(object_id,bool) or not str(object_id).isdigit():continue
        osm_id=f'node/{object_id}'
        if osm_id in seen:continue
        seen.add(osm_id)
        item={'osm_id':osm_id,'name':name,'lat':location[0],'lon':location[1],'category':cat}
        out.append(item)
    out.sort(key=lambda x:(x['osm_id']))
    # This is only public OSM POI data, no private GPS or visit history.
    header={'schema':1,'kind':'public_osm_named_poi_nodes','source_url':source_url,'snapshot_date':snapshot_date,
            'license':'ODbL-1.0','attribution':'© OpenStreetMap contributors','count':len(out)}
    dst.parent.mkdir(parents=True,exist_ok=True)
    with dst.open('w',encoding='utf-8') as f:
        f.write(json.dumps(header,ensure_ascii=False,separators=(',',':'))+'\n')
        for obj in out:f.write(json.dumps(obj,ensure_ascii=False,separators=(',',':'))+'\n')
    return {'status':'built','source_features_scanned':checked,'public_named_nodes':len(out),'sha256':hashlib.sha256(dst.read_bytes()).hexdigest()}

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--input',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--snapshot-date',default='unverified');a=p.parse_args()
    print(json.dumps(create(a.input,a.output,snapshot_date=a.snapshot_date)))