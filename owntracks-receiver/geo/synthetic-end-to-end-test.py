"""Create and verify entirely fictional workbook for local-correction integration."""
import tempfile, subprocess, json
from pathlib import Path
from artifact_tool import Workbook, SpreadsheetFile, Blob

root=Path(__file__).parent
with tempfile.TemporaryDirectory(prefix='miya-geo-synthetic-') as tmp:
  temp=Path(tmp)
  wb=Workbook.create()
  month=wb.worksheets.add('11月')
  month.get_range('A9:A10').values=[[46341],[46341]]
  month.get_range('H9:K10').values=[
   [35.000000,139.000000,3,'source-corrected-1111'],
   [35.000030,139.000020,4,'event-new-aaaaaaaaaa'],
  ]
  cor=wb.worksheets.add('店舗名の修正')
  cor.get_range('D4:O4').values=[['自動店舗候補','自動住所候補','店舗名（本人修正）','表示する名前','確認状態','イベントID','出典','月別シート','元行','地図','候補出典','検索日時']]
  cor.get_range('A5:O6').values=[
   [46341,0.5,'架空地区','','','架空の喫茶店',None,None,'source-corrected-1111','合成テスト','11月',9,None,'',''],
   [46341,0.6,'架空地区','','','',None,None,'event-new-aaaaaaaaaa','合成テスト','11月',10,None,'',''],
  ]
  cor.get_range('G5:G6').formulas=[['=IF(F5<>"",F5,D5)'],['=IF(F6<>"",F6,D6)']]
  cor.get_range('H5:H6').formulas=[['=IF(F5<>"","本人修正済み","未確認")'],['=IF(F6<>"","本人修正済み","未確認")']]
  workbook=temp/'synthetic_input.xlsx'
  SpreadsheetFile.export_xlsx(wb).save(str(workbook))
  extracted=temp/'private.json'
  plan=temp/'plan.json'
  updated=temp/'updated.xlsx'
  subprocess.run(['python',str(root/'extract-local-corrections.py'),str(workbook),str(extracted),'2026'],check=True,capture_output=True)
  subprocess.run(['node',str(root/'plan-local-candidates.mjs'),str(extracted),str(plan)],check=True,capture_output=True)
  data=json.loads(plan.read_text())
  assert len(data['planned'])==1 and data['planned'][0]['cells']['D']=='架空の喫茶店',data
  subprocess.run(['python',str(root/'apply-candidates-artifact.py'),str(workbook),str(plan),str(updated)],check=True)
  back=SpreadsheetFile.import_xlsx(Blob.load(str(updated)))
  s=back.worksheets.get_item('店舗名の修正')
  assert s.get_range('F5').values[0][0]=='架空の喫茶店'
  assert s.get_range('F6').values[0][0] in (None,'')
  assert s.get_range('D6').values[0][0]=='架空の喫茶店'
  assert s.get_range('I6').values[0][0]=='event-new-aaaaaaaaaa'
  assert s.get_range('G6').formulas[0][0]=='=IF(F6<>"",F6,D6)'
  print('PASS: private GPS correction → candidate plan → XLSX copy → readback, manual cells unchanged')