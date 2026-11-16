"""Synthetic-only tests: never use private coordinates, private venues or Drive."""
import importlib.machinery
import tempfile
import unittest
from datetime import datetime,timedelta,timezone
from pathlib import Path
from artifact_tool import Workbook,Blob,SpreadsheetFile

mod=importlib.machinery.SourceFileLoader('public_venue_candidate',str(Path(__file__).parent/'confirmed-stay-business-candidates.py')).load_module()
EPOCH=datetime(1899,12,30)
DAY=(datetime(2026,11,15)-EPOCH).days

def tt(h,m):return (h*60+m)/1440

class SafeTimeCandidateTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
  self.base=Path(self.temp.name);self.src=self.base/'生活記録_2026.xlsx';self.out=self.base/'out.xlsx'
  b=Workbook.create();b.worksheets.add('使い方');b.worksheets.add('重複候補・保留');b.worksheets.add('出典・照合');c=b.worksheets.add('店舗名の修正')
  c.get_range('A4:O4').values=[['日付','観測時刻','元の場所名','自動店舗候補','自動住所候補','店舗名（本人修正）','表示する名前','確認状態','イベントID','出典','月別シート','元行','地図','候補出典','検索日時']]
  for m in range(1,13):
   b.worksheets.add(f'{m}月')
  sh=b.worksheets.get_item('11月')
  sh.get_range('A5:K5').values=[[DAY,tt(17,7),None,'位置記録','未登録','GPS推定・本人未確認','OwnTracks GPS',35.6812,139.7671,5,'a'*64]]
  sh.get_range('R5:T5').formulas=[["='店舗名の修正'!G5","='店舗名の修正'!E5","='店舗名の修正'!H5"]]
  sh.get_range('A6:G6').values=[[DAY,tt(17,3),tt(18,53),'滞在（GPS推定）','架空喫茶A','訪問先は本人確認済み。時刻はGPS推定であり実際の入退店時刻は未確定','既存生活記録']]
  c.get_range('A5:F5').values=[[DAY,tt(17,7),'未登録',None,None,None]]
  c.get_range('G5:H5').formulas=[['=IF(F5<>"",F5,IF(D5<>"",D5,C5))','=IF(F5<>"","本人修正・確定",IF(D5<>"","自動候補・未確認","候補未取得"))']]
  c.get_range('I5:L5').values=[['a'*64,'OwnTracks GPS','11月',5]]
  SpreadsheetFile.export_xlsx(b).save(str(self.src))
 def update(self,fn):
  b=SpreadsheetFile.import_xlsx(Blob.load(str(self.src)));fn(b);SpreadsheetFile.export_xlsx(b).save(str(self.src))
 def run_job(self):return mod.run(self.src,self.out,allowed_places={'架空喫茶A','架空喫茶B'},now=datetime(2026,11,16,8,tzinfo=timezone.utc))
 def test_candidate_from_confirmed_venue_only(self):
  old=self.src.read_bytes();r=self.run_job()
  self.assertEqual((r['status'],r['candidate_count']),('updated',1))
  self.assertEqual(self.src.read_bytes(),old)
  b=SpreadsheetFile.import_xlsx(Blob.load(str(self.out)));c=b.worksheets.get_item('店舗名の修正')
  self.assertEqual(c.get_range('D5').values[0][0],'架空喫茶A')
  self.assertIsNone(c.get_range('F5').values[0][0])
  self.assertEqual(c.get_range('H5').values[0][0],'自動候補・未確認')
  self.assertIn('現地GPS一致は未確認',c.get_range('P5').values[0][0])
  self.assertEqual(b.worksheets.get_item('11月').get_range('R5').values[0][0],'架空喫茶A')
  self.assertEqual(b.worksheets.get_item('11月').get_range('K5').values[0][0],'a'*64)
  again=self.base/'rerun.xlsx'
  result=mod.run(self.out,again,allowed_places={'架空喫茶A'})
  self.assertEqual(result['status'],'unchanged');self.assertFalse(again.exists())
 def test_manual_correction_is_not_overwritten(self):
  self.update(lambda b:setattr(b.worksheets.get_item('店舗名の修正').get_range('F5'),'values',[['本人修正の架空店']]))
  r=self.run_job();self.assertEqual(r['candidate_count'],0);self.assertFalse(self.out.exists())
 def test_private_venue_is_not_in_allowlist(self):
  self.update(lambda b:b.worksheets.get_item('11月').get_range('E6').__setattr__('values',[['個人宅']]))
  r=self.run_job();self.assertEqual(r['candidate_count'],0)
 def test_ambiguous_overlapping_confirmed_stays_are_held(self):
  self.update(lambda b:b.worksheets.get_item('11月').get_range('A7:G7').__setattr__('values',[[DAY,tt(17,1),tt(18,10),'滞在（GPS推定）','架空喫茶B','訪問先は本人確認済み、時刻は推定','既存生活記録']]))
  r=self.run_job();self.assertEqual(r['held_ambiguous'],1);self.assertEqual(r['candidate_count'],0)
 def test_inaccurate_gps_is_skipped(self):
  self.update(lambda b:b.worksheets.get_item('11月').get_range('J5').__setattr__('values',[[60]]))
  r=self.run_job();self.assertEqual(r['candidate_count'],0)

if __name__=='__main__':unittest.main(verbosity=2)