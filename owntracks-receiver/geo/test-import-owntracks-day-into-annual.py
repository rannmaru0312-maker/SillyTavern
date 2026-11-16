"""Synthetic-only tests for the OwnTracks daily -> annual Excel delta importer."""
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from artifact_tool import Workbook, SpreadsheetFile, Blob
from importlib.machinery import SourceFileLoader
sys.path.insert(0,str(Path(__file__).parent))
mod=SourceFileLoader('intake',str(Path(__file__).parent/'import-owntracks-day-into-annual.py')).load_module()

class TestDailyIntake(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.root=Path(self.tmp.name)
        self.year=2026
        self.src=self.root/'生活記録_2026.xlsx'
        self.raw=self.root/'owntracks_2026-11-16.json'
        book=Workbook.create(); guide=book.worksheets.add('使い方'); c=book.worksheets.add('店舗名の修正')
        guide.get_range('A26:D26').values=[['11月',0,0,0]]
        c.get_range('A4:O4').values=[['日付','観測時刻','元の場所名','自動店舗候補','自動住所候補','店舗名（本人修正)','表示する名前','確認状態','イベントID','出典','月別シート','元行','地図','候補出典','検索日時']]
        for i in range(1,13):
            s=book.worksheets.add(f'{i}月');s.get_range('K4').values=[['統合用ID／イベントID']]
            s.get_range('A3:F3').values=[['記録合計',0,'生活記録',0,'GPS・Timeline',0]]
        SpreadsheetFile.export_xlsx(book).save(str(self.src))
        p={'_type':'location','tst':1794790491,'lat':35.6812,'lon':139.7671,'acc':5,'tid':'32'}
        canonical=json.dumps(p,separators=(',',':'),ensure_ascii=False)
        e={'id':hashlib.sha256(canonical.encode()).hexdigest(), 'canonical':canonical,'payload':p,'receivedAt':'2026-11-16T01:00:00Z'}
        self.event=e
        self.raw.write_text(json.dumps({'version':1,'source':'owntracks','timezone':'Asia/Tokyo','coverageVerified':False,'date':'2026-11-16','events':[e]},ensure_ascii=False),encoding='utf8')
    def tearDown(self):
        self.tmp.cleanup()
    def test_idempotent_and_stable_link(self):
        out=self.root/'result.xlsx'
        r=mod.import_daily(self.src,self.raw,out,2026)
        self.assertEqual(r['appended'],1)
        b=SpreadsheetFile.import_xlsx(Blob.load(str(out)))
        self.assertEqual(b.worksheets.get_item('11月').get_range('K5').values[0][0],self.event['id'])
        self.assertEqual(b.worksheets.get_item('店舗名の修正').get_range('I5').values[0][0],self.event['id'])
        self.assertEqual(b.worksheets.get_item('11月').get_range('B3').values[0][0],1)
        self.assertEqual(mod.import_daily(out,self.raw,self.root/'unused.xlsx',2026)['status'],'unchanged')
    def test_conflicting_existing_event_is_rejected(self):
        out=self.root/'result.xlsx';mod.import_daily(self.src,self.raw,out,2026)
        w=SpreadsheetFile.import_xlsx(Blob.load(str(out)))
        w.worksheets.get_item('11月').get_range('H5').values=[[35.99]]
        altered=self.root/'altered.xlsx';SpreadsheetFile.export_xlsx(w).save(str(altered))
        with self.assertRaises(ValueError):mod.import_daily(altered,self.raw,self.root/'should-not.xlsx',2026)
    def test_wrong_year_and_bad_hash(self):
        with self.assertRaises(ValueError):mod.import_daily(self.src,self.raw,self.root/'bad.xlsx',2027)
        d=json.loads(self.raw.read_text());d['events'][0]['canonical']+='x'
        self.raw.write_text(json.dumps(d),encoding='utf8')
        with self.assertRaises(ValueError):mod.import_daily(self.src,self.raw,self.root/'bad.xlsx',2026)

if __name__=='__main__':unittest.main(verbosity=2)