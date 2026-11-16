"""Synthetic-only tests; never embed or upload real GPS or user diary content."""
import importlib.machinery
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from artifact_tool import Workbook, SpreadsheetFile, Blob

HERE=Path(__file__).parent
mod=importlib.machinery.SourceFileLoader('delta_guard',str(HERE/'verify-diary-delta.py')).load_module()

class Integrity(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.p=Path(self.temp.name)
        self.source=self.p/'生活記録_2026.xlsx'
        self.dest=self.p/'updated.xlsx'
        b=Workbook.create()
        guide=b.worksheets.add('使い方')
        guide.get_range('A26:D26').values=[['11月',1,1,1]]
        corr=b.worksheets.add('店舗名の修正')
        corr.get_range('A4:O4').values=[[
            '日付','観測時刻','元の場所名','自動店舗候補','自動住所候補',
            '店舗名（本人修正）','表示する名前','確認状態','イベントID',
            '出典','月別シート','元行','地図','候補出典','検索日時']]
        for i in range(1,13):
            sh=b.worksheets.add(f'{i}月')
            sh.get_range('A3:F3').values=[['記録合計',1 if i==11 else 0,'生活記録',0,'GPS・Timeline',1 if i==11 else 0]]
            sh.get_range('K4').values=[['統合用ID／イベントID']]
        s=b.worksheets.get_item('11月')
        d=(datetime(2026,11,16)-datetime(1899,12,30)).days
        s.get_range('A5:P5').values=[[d,.45,None,'位置記録','未登録','GPS推定・本人未確認','OwnTracks GPS',35.6812,139.7671,5,'a'*64,None,'OwnTracks','mock',None,'location']]
        s.get_range('Q5:T5').formulas=[['=HYPERLINK("https://example.org","地図")',"='店舗名の修正'!G5","='店舗名の修正'!E5","='店舗名の修正'!H5"]]
        corr.get_range('A5:F5').values=[[d,.45,'未登録',None,None,'本人修正の架空店']]
        corr.get_range('G5:H5').formulas=[['=IF(F5<>"",F5,D5)','=IF(F5<>"","本人修正済み","未確認")']]
        corr.get_range('I5:L5').values=[['a'*64,'OwnTracks GPS','11月',5]]
        SpreadsheetFile.export_xlsx(b).save(str(self.source))
    def tearDown(self):self.temp.cleanup()
    def change(self,callback):
        w=SpreadsheetFile.import_xlsx(Blob.load(str(self.source)))
        callback(w)
        SpreadsheetFile.export_xlsx(w).save(str(self.dest))
    def test_copy_unchanged_allowed(self):
        self.dest.write_bytes(self.source.read_bytes())
        self.assertEqual(mod.verify(self.source,self.dest,2026)['new_gps'],0)
    def test_candidate_added_only_to_blank_columns_allowed(self):
        def patch(w):
            c=w.worksheets.get_item('店舗名の修正')
            c.get_range('E5').values=[['東京都千代田区丸の内一丁目']]
            c.get_range('N5').values=[['MLIT data; offline']]
            c.get_range('O5').values=[[46341.5]]
        self.change(patch)
        self.assertEqual(mod.verify(self.source,self.dest,2026)['new_address_candidates_on_existing_rows'],1)
    def test_manual_name_removal_rejected(self):
        self.change(lambda w:setattr(w.worksheets.get_item('店舗名の修正').get_range('F5'),'values',[['']]))
        with self.assertRaisesRegex(ValueError,'existing correction cell'):
            mod.verify(self.source,self.dest,2026)
    def test_historical_place_or_gps_altered_rejected(self):
        self.change(lambda w:setattr(w.worksheets.get_item('11月').get_range('E5'),'values',[['勝手に変更した店名']]))
        with self.assertRaisesRegex(ValueError,'existing month cell'):
            mod.verify(self.source,self.dest,2026)
    def test_historical_formula_altered_rejected(self):
        self.change(lambda w:setattr(w.worksheets.get_item('11月').get_range('S5'),'formulas',[["='店舗名の修正'!D5"]]))
        with self.assertRaisesRegex(ValueError,'existing month cell'):
            mod.verify(self.source,self.dest,2026)
    def test_counter_changed_without_event_rejected(self):
        self.change(lambda w:setattr(w.worksheets.get_item('11月').get_range('B3'),'values',[[2]]))
        with self.assertRaisesRegex(ValueError,'counter inconsistent'):
            mod.verify(self.source,self.dest,2026)
    def test_partial_address_candidate_rejected(self):
        self.change(lambda w:setattr(w.worksheets.get_item('店舗名の修正').get_range('E5'),'values',[['東京都千代田区丸の内一丁目']]))
        with self.assertRaisesRegex(ValueError,'partial address'):
            mod.verify(self.source,self.dest,2026)
    def test_guide_count_unjustifiably_incremented_rejected(self):
        self.change(lambda w:setattr(w.worksheets.get_item('使い方').get_range('C26'),'values',[[2]]))
        with self.assertRaisesRegex(ValueError,'guide count'):
            mod.verify(self.source,self.dest,2026)
    def test_wrong_new_correction_month_rejected(self):
        def patch(w):
            s=w.worksheets.get_item('11月')
            s.get_range('A6:P6').values=[[46341,.55,None,'位置記録','未登録','GPS推定・本人未確認','OwnTracks GPS',34.7024,135.4959,5,'b'*64,None,'OwnTracks','mock',None,'location']]
            s.get_range('B3').values=[[2]]
            s.get_range('F3').values=[[2]]
            c=w.worksheets.get_item('店舗名の修正')
            c.get_range('I6:L6').values=[['b'*64,'OwnTracks GPS','10月',6]]
            g=w.worksheets.get_item('使い方');g.get_range('C26:D26').values=[[2,2]]
        self.change(patch)
        with self.assertRaisesRegex(ValueError,'correction linkage'):
            mod.verify(self.source,self.dest,2026)

if __name__=='__main__':unittest.main(verbosity=2)