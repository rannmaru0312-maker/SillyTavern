"""All coordinates and store names in this test are fabricated, never user GPS."""
import importlib.machinery
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from datetime import datetime,timezone
from artifact_tool import Blob,Workbook,SpreadsheetFile
D=Path(__file__).resolve().parent
builder=importlib.machinery.SourceFileLoader('poi_builder',str(D/'build-public-poi-catalog.py')).load_module()
private=importlib.machinery.SourceFileLoader('poi_private',str(D/'offline-poi-candidates.py')).load_module()

class TestPoi(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.p=Path(self.tmp.name)
  self.geo=self.p/'public_test.geojsonseq';self.cat=self.p/'poi_catalog.ndjson'
  self.geo.write_text(''.join('\x1e'+json.dumps({'type':'Feature','geometry':{'type':'Point','coordinates':[135.0+i*.1,34.0+i*.1]},'properties':{'@type':'node','@id':100+i,'name':name,'amenity':'restaurant'}})+'\n' for i,name in enumerate(['架空喫茶あおい','架空定食こもれび'])),encoding='utf-8')
  self.src=self.p/'生活記録_2026.xlsx';self.out=self.p/'candidate.xlsx'
  w=Workbook.create();w.worksheets.add('使い方');w.worksheets.add('店舗名の修正');w.worksheets.add('重複候補・保留');w.worksheets.add('出典・照合')
  for m in range(1,13):w.worksheets.add(f'{m}月')
  self.eid='f'*64
  c=w.worksheets.get_item('店舗名の修正');c.get_range('A4:Q4').values=[['日付','観測時刻','元の場所名','自動店舗候補','自動住所候補','店舗名（本人修正）','表示する名前','確認状態','イベントID','出典','月別シート','元行','地図','候補出典','検索日時','店舗候補の根拠','候補判定日時']]
  self.link=[46342,0.5,'未登録',None,None,None,None,None,self.eid,'OwnTracks GPS','11月',5,None,None,None,None,None]
  c.get_range('A5:Q5').values=[self.link]
  sh=w.worksheets.get_item('11月');sh.get_range('A4:T4').values=[['日付','開始・発生','終了','区分','場所・内容','確認状態・備考','出典区分','緯度','経度','精度(m)','統合用ID／イベントID','受信日時','出典','原本行','曜日・端末等','補足・原本属性','地図','場所名（修正反映）','住所候補','店舗名の状態']]
  sh.get_range('A5:T5').values=[[46342,0.5,None,'GPS観測','未登録','GPS推定・本人未確認','OwnTracks GPS',34.0,135.0,4,self.eid,None,None,None,None,None,None,None,None,None]]
  SpreadsheetFile.export_xlsx(w).save(str(self.src))
 def tearDown(self):self.tmp.cleanup()
 def build(self):
  return builder.create(self.geo,self.cat)
 def test_builder_and_lookup(self):
  x=self.build();self.assertEqual(x['public_named_nodes'],2)
  bins,meta=private.load_catalog(self.cat,expected_sha256=x['sha256'])
  c,reason=private.candidate_at(bins,34.0,135.0,4)
  self.assertEqual(c[0]['name'],'架空喫茶あおい')
  self.assertIsNone(private.candidate_at(bins,34.0,135.0,40)[0])
  self.assertIsNone(private.candidate_at(bins,34.6,135.6,4)[0])
 def test_one_new_and_idempotence(self):
  self.build();start=self.src.read_bytes()
  r=private.run(self.src,self.cat,self.out,now=datetime(2026,11,17,12,tzinfo=timezone.utc));self.assertEqual(r['candidate_count'],1)
  self.assertEqual(self.src.read_bytes(),start)
  w=SpreadsheetFile.import_xlsx(Blob.load(str(self.out)))
  c=w.worksheets.get_item('店舗名の修正');self.assertEqual(c.get_range('D5').values[0][0],'架空喫茶あおい')
  self.assertIsNone(c.get_range('F5').values[0][0]);self.assertIn('未確認',c.get_range('P5').values[0][0])
  second=self.p/'next.xlsx';u=private.run(self.out,self.cat,second)
  self.assertEqual(u['status'],'unchanged');self.assertFalse(second.exists())
 def test_manual_name_remains(self):
  self.build();w=SpreadsheetFile.import_xlsx(Blob.load(str(self.src)))
  w.worksheets.get_item('店舗名の修正').get_range('F5').values=[['本人の正式名']]
  SpreadsheetFile.export_xlsx(w).save(str(self.p/'withmanual.xlsx'))
  r=private.run(self.p/'withmanual.xlsx',self.cat,self.out)
  self.assertEqual(r['status'],'unchanged');self.assertFalse(self.out.exists())
 def test_ambiguous_pois_fail_closed(self):
  geo=json.loads(self.geo.read_text(encoding='utf-8').split('\x1e')[1].strip())
  geo['properties']['@id']=999;geo['properties']['name']='別の架空店舗';geo['geometry']['coordinates']=[135.00008,34.0]
  with self.geo.open('a',encoding='utf-8') as f:f.write('\x1e'+json.dumps(geo)+'\n')
  self.build();r=private.run(self.src,self.cat,self.out)
  self.assertEqual((r['candidate_count'],r['ambiguous_held']),(0,1));self.assertFalse(self.out.exists())
 def test_catalog_tamper_rejected(self):
  x=self.build();self.cat.write_text(self.cat.read_text(encoding='utf-8')+'\n',encoding='utf-8')
  with self.assertRaises(ValueError):private.run(self.src,self.cat,self.out,expected_catalog_sha256=x['sha256'])
  self.assertFalse(self.out.exists())
 def test_no_dataset_no_guessed_shop(self):
  self.geo.write_text('',encoding='utf-8');self.build();r=private.run(self.src,self.cat,self.out)
  self.assertEqual(r['status'],'no_public_poi_data');self.assertFalse(self.out.exists())
 def test_formula_injection_rejected(self):
  bad=json.loads(self.geo.read_text(encoding='utf-8').split('\x1e')[1].strip())
  bad['properties']['name']='=HYPERLINK("bad","x")'
  self.geo.write_text('\x1e'+json.dumps(bad)+'\n',encoding='utf-8')
  x=self.build();self.assertEqual(x['public_named_nodes'],0)
 def test_ambiguous_review_shortlist_is_not_confirmed(self):
  feature=json.loads(self.geo.read_text(encoding='utf-8').split('\x1e')[1].strip())
  feature['properties']['@id']=999;feature['properties']['name']='別の架空店舗';feature['geometry']['coordinates']=[135.00008,34.0]
  with self.geo.open('a',encoding='utf-8') as f:f.write('\x1e'+json.dumps(feature)+'\n')
  self.build();r=private.run(self.src,self.cat,self.out,allow_review_shortlists=True)
  self.assertEqual((r['candidate_count'],r['review_shortlists']), (1,1))
  w=SpreadsheetFile.import_xlsx(Blob.load(str(self.out)))
  c=w.worksheets.get_item('店舗名の修正')
  self.assertIn('要確認',c.get_range('D5').values[0][0])
  self.assertIsNone(c.get_range('F5').values[0][0])
  self.assertIn('入店未確定',c.get_range('P5').values[0][0])
if __name__=='__main__':unittest.main(verbosity=2)