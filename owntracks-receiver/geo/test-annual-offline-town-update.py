"""Synthetic-only regression tests; no private GPS, external APIs or network."""
import hashlib
import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from artifact_tool import Workbook, SpreadsheetFile, Blob

sys.path.insert(0, str(Path(__file__).parent))
from importlib.machinery import SourceFileLoader
mod=SourceFileLoader('update', str(Path(__file__).parent/'annual-offline-town-update.py')).load_module()
BIN_ZIP=Path('/mnt/data/miya-offline-town-geocoder-linux-20261116.zip')

class TestPrivateAnnualTown(unittest.TestCase):
    def synthetic_book(self,dest,manual=False):
        w=Workbook.create()
        correction=w.worksheets.add('店舗名の修正')
        hdr=['日付','観測時刻','元の場所名','自動店舗候補','自動住所候補','店舗名（本人修正）','表示する名前','確認状態','イベントID','出典','月別シート','元行','地図','候補出典','検索日時']
        correction.get_range('A4:O4').values=[hdr]
        for n in range(1,13):
            s=w.worksheets.add(f'{n}月')
            s.get_range('A4:Q4').values=[["日付","開始・発生","終了","区分","場所・内容","確認状態・備考","出典区分","緯度","経度","精度(m)","統合用ID／イベントID","受信日時","出典","原本行","曜日・端末等","補足・原本属性","地図"]]
        eid='a'*64
        dt=(datetime(2026,11,16)-datetime(1899,12,30)).days
        s=w.worksheets.get_item('11月')
        s.get_range('A5:Q5').values=[[dt,0.42,None,'位置記録','未登録','GPS推定・本人未確認','OwnTracks GPS',35.6812,139.7671,5,eid,None,'OwnTracks','synthetic-public','月','','地図を見る']]
        correction.get_range('A5:F5').values=[[dt,0.42,'未登録',None,None,'正しい公開施設名' if manual else None]]
        correction.get_range('G5').formulas=[['=IF(F5<>"",F5,IF(D5<>"",D5,C5))']]
        correction.get_range('H5').formulas=[['=IF(F5<>"","本人修正済み",IF(D5<>"","未確認候補","未検索"))']]
        correction.get_range('I5:O5').values=[[eid,'OwnTracks GPS','11月',5,'地図を見る',None,None]]
        SpreadsheetFile.export_xlsx(w).save(str(dest))

    def test_new_row_and_idempotence(self):
        with tempfile.TemporaryDirectory() as tmp:
            s=Path(tmp)/'source.xlsx';o=Path(tmp)/'updated.xlsx'
            self.synthetic_book(s,manual=True)
            result=mod.run(s,BIN_ZIP,2026,o,now=datetime(2026,11,16,8,tzinfo=timezone.utc))
            self.assertEqual(result['status'],'updated')
            self.assertEqual(result['updated_rows'],1)
            self.assertEqual(result['unmatched_rows'],0)
            imported=SpreadsheetFile.import_xlsx(Blob.load(str(o)))
            sh=imported.worksheets.get_item('店舗名の修正')
            vals=sh.get_range('D5:O5').values[0]
            self.assertTrue('東京都千代田区丸の内' in vals[1])
            self.assertEqual(vals[2],'正しい公開施設名')
            self.assertIsNone(vals[0])
            self.assertEqual(vals[5],'a'*64)
            self.assertTrue('位置参照情報' in vals[10])
            # already filled E column means no rewrite, manual survives
            again=mod.run(o,BIN_ZIP,2026,Path(tmp)/'unused.xlsx')
            self.assertEqual(again['status'],'unchanged')
            self.assertEqual(again['updated_rows'],0)
    def test_archive_digest_enforced(self):
        with tempfile.TemporaryDirectory() as tmp:
            s=Path(tmp)/'source.xlsx';o=Path(tmp)/'updated.xlsx'
            self.synthetic_book(s)
            bad=Path(tmp)/'bad.zip';bad.write_bytes(b'not an approved binary')
            with self.assertRaises(ValueError):
                mod.run(s,bad,2026,o)
            self.assertFalse(o.exists())
    def test_invalid_source_does_not_overwrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            s=Path(tmp)/'source.xlsx';self.synthetic_book(s)
            raw=s.read_bytes()
            with self.assertRaises(ValueError):
                mod.run(s,BIN_ZIP,2027,Path(tmp)/'updated.xlsx')
            self.assertEqual(s.read_bytes(),raw)

if __name__=='__main__':
    unittest.main(verbosity=2)