import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from importlib.machinery import SourceFileLoader
P=Path(__file__).parent
m=SourceFileLoader('receipt',str(P/'write-private-sync-receipt.py')).load_module()
T='2026-11-16T10:12:00Z'
T2='2026-11-17T00:10:00Z'
ID='1NYdq8hTk2bA26VhbBO0J7-ZYaVif7chm'
class ReceiptTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.p=Path(self.tmp.name)/'生活記録_2026.xlsx'
        self.p.write_bytes(b'non-private test bytes')
        self.digest=hashlib.sha256(self.p.read_bytes()).hexdigest()
        self.run=dict(status='unchanged',year=2026,address_status='completed',
            processed_days=2,appended=0,address_candidates=0,address_held=0,
            address_unmatched=0,output_created=False,source_sha256=self.digest)
    def tearDown(self):self.tmp.cleanup()
    def make(self, prev=None, run=None, kind='manual', checked=T):
        return m.prepare_receipt(prev,run or self.run,workbook=self.p,year=2026,
            file_id=ID,run_kind=kind,checked_at=checked)
    def test_noop_receipt_has_no_scheduled_success(self):
        r=self.make()
        self.assertEqual(r['lastChecked']['newGpsEvents'],0)
        self.assertIsNone(r['lastScheduledCheck'])
        self.assertTrue(r['lastChecked']['readbackVerified'])
    def test_scheduled_only_after_scheduled_run(self):
        a=self.make(); b=self.make(a,kind='scheduled',checked=T2)
        self.assertEqual(b['lastScheduledCheck']['runKind'],'scheduled')
        self.assertEqual(len(b['recentRuns']),2)
    def test_repeated_receipt_is_idempotent(self):
        a=self.make();b=self.make(a)
        self.assertEqual(len(b['recentRuns']),1)
    def test_sha_mismatch_rejected(self):
        self.run['source_sha256']='a'*64
        with self.assertRaises(ValueError):self.make()
    def test_successful_update_recorded(self):
        r=dict(self.run,status='updated',appended=2,address_candidates=1,
               output_created=True,output_sha256=self.digest)
        x=self.make(run=r)
        self.assertEqual(x['lastSuccessfulSave']['newGpsEvents'],2)
    def test_false_update_or_visibility_rejected(self):
        run=dict(self.run,status='updated',output_created=True,output_sha256=self.digest)
        with self.assertRaises(ValueError):self.make(run=run)
        with self.assertRaises(ValueError):m.prepare_receipt(None,self.run,workbook=self.p,
            year=2026,file_id=ID,run_kind='manual',checked_at=T,visibility='unknown')
    def test_bad_prior_state_rejected(self):
        with self.assertRaises(ValueError):self.make({'schema':1,'year':2025,'masterFileId':ID})
        with self.assertRaises(ValueError):self.make({'schema':1,'year':2026,'masterFileId':ID,
            'recentRuns':[{'checkedAt':'2026-11-18T00:00:00Z'}]})
    def test_no_raw_coordinates_in_receipt(self):
        r=self.make()
        text=json.dumps(r)
        for forbidden in ('latitude','longitude','addressCandidate','facilityCandidate','35.6812'):
            self.assertNotIn(forbidden,text)
if __name__=='__main__': unittest.main(verbosity=2)