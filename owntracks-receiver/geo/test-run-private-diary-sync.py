"""Synthetic GPS coordinates only. Never fetch or transmit real personal data."""
import hashlib
import importlib.machinery
import json
import shutil
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from artifact_tool import Blob, Workbook, SpreadsheetFile

D = Path(__file__).resolve().parent
runner = importlib.machinery.SourceFileLoader('private_pipeline', str(D / 'run-private-diary-sync.py')).load_module()
ZIP = Path('/mnt/data/miya-offline-town-geocoder-linux-20261116.zip')

class Pipeline(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='miya-test-public-')
        self.p = Path(self.temp.name)
        self.year = 2026
        self.source = self.p / '生活記録_2026.xlsx'
        self.day = self.p / 'owntracks_2026-11-16.json'
        self.output = self.p / 'out.xlsx'
        b = Workbook.create()
        b.worksheets.add('使い方').get_range('A26:D26').values = [['11月',0,0,0]]
        c = b.worksheets.add('店舗名の修正')
        c.get_range('A4:O4').values = [[
            '日付','観測時刻','元の場所名','自動店舗候補','自動住所候補',
            '店舗名（本人修正）','表示する名前','確認状態','イベントID','出典',
            '月別シート','元行','地図','候補出典','検索日時']]
        for n in range(1,13):
            sh=b.worksheets.add(f'{n}月')
            sh.get_range('K4').values=[['統合用ID／イベントID']]
            sh.get_range('A3:F3').values=[['記録合計',0,'生活記録',0,'GPS・Timeline',0]]
        SpreadsheetFile.export_xlsx(b).save(str(self.source))
        event = {'_type':'location','tst':1794790491,'lat':35.6812,'lon':139.7671,'acc':5,'tid':'32'}
        canon=json.dumps(event,ensure_ascii=False,separators=(',',':'))
        self.eid=hashlib.sha256(canon.encode()).hexdigest()
        self.day.write_text(json.dumps({
            'version':1,'source':'owntracks','timezone':'Asia/Tokyo',
            'coverageVerified':False,'date':'2026-11-16',
            'events':[{'id':self.eid,'canonical':canon,'payload':event,
                       'receivedAt':'2026-11-16T01:00:00Z'}]},ensure_ascii=False),encoding='utf-8')
    def tearDown(self):
        self.temp.cleanup()
    def test_one_execution_and_idempotence(self):
        original=self.source.read_bytes()
        res=runner.run(self.source,[self.day],ZIP,2026,self.output)
        self.assertEqual((res['appended'],res['address_candidates']),(1,1))
        self.assertEqual(self.source.read_bytes(),original)
        w=SpreadsheetFile.import_xlsx(Blob.load(str(self.output)))
        c=w.worksheets.get_item('店舗名の修正')
        self.assertEqual(c.get_range('I5').values[0][0],self.eid)
        self.assertIn('東京都千代田区丸の内',c.get_range('E5').values[0][0])
        self.assertIsNone(c.get_range('F5').values[0][0])
        self.assertEqual(w.worksheets.get_item('11月').get_range('K5').values[0][0],self.eid)
        no=self.p/'should-not-create.xlsx'
        rerun_source=self.p/'rerun'/'生活記録_2026.xlsx'
        rerun_source.parent.mkdir(parents=True)
        shutil.copyfile(self.output,rerun_source)
        res2=runner.run(rerun_source,[self.day],ZIP,2026,no)
        self.assertEqual(res2['status'],'unchanged')
        self.assertFalse(no.exists())
    def test_two_day_batch_and_atomic_abort_on_later_corruption(self):
        next_day=self.p/'owntracks_2026-11-17.json'
        event={'_type':'location','tst':int(datetime(2026,11,17,1,tzinfo=timezone.utc).timestamp()),
               'lat':34.7024,'lon':135.4959,'acc':5,'tid':'32'}
        canon=json.dumps(event,ensure_ascii=False,separators=(',',':'))
        eid=hashlib.sha256(canon.encode()).hexdigest()
        body={'version':1,'source':'owntracks','timezone':'Asia/Tokyo',
              'coverageVerified':False,'date':'2026-11-17',
              'events':[{'id':eid,'canonical':canon,'payload':event,
                         'receivedAt':'2026-11-17T01:01:00Z'}]}
        next_day.write_text(json.dumps(body,ensure_ascii=False),encoding='utf-8')
        original=self.source.read_bytes()
        result=runner.run(self.source,[next_day,self.day],ZIP,2026,self.output)
        self.assertEqual((result['appended'],result['address_candidates']),(2,2))
        self.assertEqual(result['processed_days'],2)
        self.assertEqual(self.source.read_bytes(),original)
        wb=SpreadsheetFile.import_xlsx(Blob.load(str(self.output)))
        self.assertEqual(len([r for r in wb.worksheets.get_item('店舗名の修正').get_range('I5:I6').values if r[0]]),2)
        # Corrupt the second day; no partial output may escape even though day 1 is valid.
        next_day.write_text(next_day.read_text(encoding='utf-8').replace('34.7024','34.7999'),encoding='utf-8')
        with self.assertRaises(ValueError):
            runner.run(self.source,[self.day,next_day],ZIP,2026,self.p/'should-not-create.xlsx')
        self.assertFalse((self.p/'should-not-create.xlsx').exists())
        self.assertEqual(self.source.read_bytes(),original)
    def test_invalid_inputs_leave_source_intact(self):
        original=self.source.read_bytes()
        with self.assertRaises(ValueError):
            runner.run(self.source,[self.day,self.day],ZIP,2026,self.output)
        self.assertFalse(self.output.exists())
        self.assertEqual(self.source.read_bytes(),original)
        bad_zip=self.p/'bad.zip'
        bad_zip.write_bytes(b'fake archive cannot pass SHA256')
        with self.assertRaises(ValueError):
            runner.run(self.source,[self.day],bad_zip,2026,self.output)
        self.assertFalse(self.output.exists())
    def test_missing_binary_imports_gps_and_defers_address(self):
        res=runner.run(self.source,[self.day],None,2026,self.output)
        self.assertEqual(res['status'],'updated')
        self.assertEqual(res['appended'],1)
        self.assertEqual(res['address_candidates'],0)
        self.assertEqual(res['address_status'],'deferred_missing_binary')
        imported=SpreadsheetFile.import_xlsx(Blob.load(str(self.output)))
        self.assertIsNone(imported.worksheets.get_item('店舗名の修正').get_range('E5').values[0][0])
        filled=self.p/'filled.xlsx'
        yr=self.p/'continue'/'生活記録_2026.xlsx'
        yr.parent.mkdir(parents=True)
        shutil.copyfile(self.output,yr)
        back=runner.run(yr,[self.day],ZIP,2026,filled)
        self.assertEqual(back['appended'],0)
        self.assertEqual(back['address_candidates'],1)
        self.assertEqual(back['address_status'],'completed')
    def test_even_when_no_missing_address_bad_existing_archive_is_rejected(self):
        # A tampered artifact must be rejected even when the workbook has
        # already received all of its address candidates.
        runner.run(self.source,[self.day],ZIP,2026,self.output)
        newroot=self.p/'current'
        newroot.mkdir()
        current=newroot/'生活記録_2026.xlsx'
        shutil.copyfile(self.output,current)
        broken=self.p/'broken.zip'
        broken.write_bytes(b'incorrect content')
        with self.assertRaises(ValueError):
            runner.run(current,[self.day],broken,2026,self.p/'unexpected-output.xlsx')
        self.assertFalse((self.p/'unexpected-output.xlsx').exists())

    def test_previous_manual_name_survives_repeat_no_change(self):
        runner.run(self.source,[self.day],ZIP,2026,self.output)
        imported=SpreadsheetFile.import_xlsx(Blob.load(str(self.output)))
        imported.worksheets.get_item('店舗名の修正').get_range('F5').values=[['架空の本人確認済み施設']]
        current=self.p/'manual'/'生活記録_2026.xlsx'
        current.parent.mkdir()
        SpreadsheetFile.export_xlsx(imported).save(str(current))
        ret=runner.run(current,[self.day],ZIP,2026,self.p/'not-generated.xlsx')
        self.assertEqual(ret['status'],'unchanged')
        self.assertFalse((self.p/'not-generated.xlsx').exists())
        checked=SpreadsheetFile.import_xlsx(Blob.load(str(current)))
        self.assertEqual(checked.worksheets.get_item('店舗名の修正').get_range('F5').values[0][0],
                         '架空の本人確認済み施設')

    def test_wrong_year_rejected(self):
        with self.assertRaises(ValueError):
            runner.run(self.source,[self.day],ZIP,2027,self.output)
        self.assertFalse(self.output.exists())

if __name__=='__main__':
    unittest.main(verbosity=2)