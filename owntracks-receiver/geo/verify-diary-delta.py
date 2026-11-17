#!/usr/bin/env python3
"""Fail-closed, offline verifier for OwnTracks annual-workbook changes.

Compares a private source workbook with a proposed update. Never accesses the
network or emits location details. Existing diary content must be unchanged,
except for the explicitly allowed count increments and blank->candidate address
cells (E,N,O) in the private corrections sheet. New rows must link by ID.
"""
import json
import math
import re
from pathlib import Path
from artifact_tool import Blob, SpreadsheetFile

GPS_ID = re.compile(r'^[0-9a-f]{64}$')
RANGE_END = re.compile(r'([A-Z]+)(\d+)$')


def _same(a, b):
    if a is None and b == '':
        return True
    if b is None and a == '':
        return True
    if type(a) in (int, float) and type(b) in (int, float):
        return math.isfinite(a) and math.isfinite(b) and math.isclose(a, b, rel_tol=0, abs_tol=1e-8)
    return a == b


def _cell_equal(a, af, b, bf):
    if af or bf:
        return af == bf and bool(af) == bool(bf)
    return _same(a,b)


def _metadata(book):
    specs = {}
    for raw in book.inspect({'kind':'sheet','include':'id,name'}).ndjson.splitlines():
        item = json.loads(raw)
        if item.get('kind') != 'sheet':
            continue
        m = RANGE_END.search(item.get('address',''))
        if not m:
            raise ValueError('missing sheet dimension')
        specs[item['name']] = (m.group(1), int(m.group(2)))
    return specs


def _range(book,name,end_col,end_row):
    r = book.worksheets.get_item(name).get_range(f'A1:{end_col}{max(4,end_row)}')
    return r.values, r.formulas


def _cell_at(matrix,r,c):
    return matrix[r-1][c-1]


def _month_ids(book,month,end):
    if end < 5:
        return {}
    sh = book.worksheets.get_item(month)
    ret = {}
    for row, val in enumerate(sh.get_range(f'K5:K{end}').values,5):
        eid = val[0]
        if not isinstance(eid,str) or not GPS_ID.fullmatch(eid):
            continue
        if eid in ret:
            raise ValueError('duplicated monthly GPS ID')
        ret[eid]=row
    return ret


def _correction_ids(book,end):
    sh=book.worksheets.get_item('店舗名の修正')
    out={}
    if end < 5: return out
    for row,val in enumerate(sh.get_range(f'I5:I{end}').values,5):
        eid=val[0]
        if not isinstance(eid,str) or not GPS_ID.fullmatch(eid):
            continue
        if eid in out: raise ValueError('duplicated correction GPS ID')
        out[eid]=row
    return out


def verify(source:Path,updated:Path,year:int) -> dict:
    if source.resolve()==updated.resolve() or not (source.is_file() and updated.is_file()):
        raise ValueError('invalid verification files')
    if not 2020<=year<=2100: raise ValueError('invalid year')
    old=SpreadsheetFile.import_xlsx(Blob.load(str(source)))
    new=SpreadsheetFile.import_xlsx(Blob.load(str(updated)))
    oldmeta,newmeta=_metadata(old),_metadata(new)
    if list(oldmeta)!=list(newmeta):
        raise ValueError('workbook structure changed')
    required={f'{i}月' for i in range(1,13)}|{'店舗名の修正'}
    if not required.issubset(oldmeta):
        raise ValueError('unexpected annual workbook schema')
    newly_added={}; count_by_month={}
    allold={}; allnew={}
    for i in range(1,13):
        month=f'{i}月'
        o_last=oldmeta[month][1]; n_last=newmeta[month][1]
        if n_last<o_last: raise ValueError('monthly sheet truncated')
        bmap=_month_ids(old,month,o_last); amap=_month_ids(new,month,n_last)
        if any(amap.get(eid)!=row for eid,row in bmap.items()):
            raise ValueError('old GPS ID or monthly position changed')
        for eid,row in bmap.items():
            if eid in allold: raise ValueError('duplicate old GPS ID across months')
            allold[eid]=(month,row)
        for eid,row in amap.items():
            if eid in allnew: raise ValueError('duplicate new GPS ID across months')
            allnew[eid]=(month,row)
        add=[(eid,row) for eid,row in amap.items() if eid not in bmap]
        if any(row <= o_last for _,row in add):
            raise ValueError('new GPS overwrote old rows')
        newly_added.update({eid:(month,row) for eid,row in add})
        count_by_month[month]=len(add)
        ov,of=_range(old,month,'T',o_last)
        nv,nf=_range(new,month,'T',o_last)
        for ri,(before,after,beforef,afterf) in enumerate(zip(ov,nv,of,nf),1):
            for ci,(v,w,f,g) in enumerate(zip(before,after,beforef,afterf),1):
                if ri==3 and ci in (2,6):
                    if not(type(v) in (int,float) and type(w) in (int,float)
                           and _same(w,v+len(add))):
                        raise ValueError('monthly counter inconsistent')
                elif not _cell_equal(v,f,w,g):
                    raise ValueError('existing month cell changed')
        sh=new.worksheets.get_item(month)
        for eid,row in add:
            source_tag=sh.get_range(f'G{row}').values[0][0]
            original=sh.get_range(f'K{row}').values[0][0]
            evid=sh.get_range(f'F{row}').values[0][0]
            if source_tag!='OwnTracks GPS' or original!=eid or evid!='GPS推定・本人未確認':
                raise ValueError('new record lacks GPS provenance')
    o_last=oldmeta['店舗名の修正'][1]; n_last=newmeta['店舗名の修正'][1]
    if n_last<o_last: raise ValueError('correction sheet truncated')
    old_ids=_correction_ids(old,o_last); new_ids=_correction_ids(new,n_last)
    if any(new_ids.get(k)!=v for k,v in old_ids.items()):
        raise ValueError('original correction entry moved')
    if set(new_ids)-set(old_ids)!=set(newly_added):
        raise ValueError('new correction IDs do not equal appended GPS IDs')
    ov,of=_range(old,'店舗名の修正','O',o_last)
    nv,nf=_range(new,'店舗名の修正','O',o_last)
    corrected=0
    for ri,(before,after,beforef,afterf) in enumerate(zip(ov,nv,of,nf),1):
        touched=set()
        for ci,(v,w,f,g) in enumerate(zip(before,after,beforef,afterf),1):
            if _cell_equal(v,f,w,g):continue
            if ri<5 or ci not in (5,14,15) or f or g or v not in ('',None):
                raise ValueError('existing correction cell/formula changed')
            touched.add(ci)
        if touched:
            if touched!={5,14,15}:
                raise ValueError('partial address candidate update')
            if not isinstance(after[4],str) or not after[4] or not isinstance(after[13],str) or not after[13] or type(after[14]) not in (float,int):
                raise ValueError('invalid newly filled address candidate')
            corrected+=1
    csh=new.worksheets.get_item('店舗名の修正')
    for eid,(month,row) in newly_added.items():
        c_row=new_ids[eid]
        v=csh.get_range(f'F{c_row}:L{c_row}').values[0]
        if v[0] not in (None,'') or v[3]!=eid or v[5]!=month or v[6]!=row:
            raise ValueError('incorrect new correction linkage')
    # Check existing recorded GPS entries still correspond to the same correction row.
    for eid,(month,row) in allold.items():
        if eid not in new_ids:raise ValueError('existing GPS missing correction')
        c_row=new_ids[eid]
        s=csh.get_range(f'K{c_row}:L{c_row}').values[0]
        if s!=[month,row]:raise ValueError('existing GPS correction linkage changed')
    # Other sheets must remain unchanged except A16:D27 guide month count cells C/D.
    for name,(col,last) in oldmeta.items():
        if name in required:continue
        if newmeta[name][1]<last:raise ValueError('non-month sheet truncated')
        ov,of=_range(old,name,col,last)
        nv,nf=_range(new,name,col,last)
        for ri,(before,after,beforef,afterf) in enumerate(zip(ov,nv,of,nf),1):
            for ci,(v,w,f,g) in enumerate(zip(before,after,beforef,afterf),1):
                is_count=(name=='使い方' and 16<=ri<=27 and ci in (3,4) and len(before)>=1
                          and before[0] in count_by_month)
                if is_count:
                    delta=count_by_month[before[0]]
                    if not(type(v) in (int,float) and type(w) in (int,float) and _same(w,v+delta)):
                        raise ValueError('guide count inconsistent')
                elif not _cell_equal(v,f,w,g):
                    raise ValueError('unrelated sheet cell changed')
    return {'verified':True,'new_gps':len(newly_added),'new_address_candidates_on_existing_rows':corrected}