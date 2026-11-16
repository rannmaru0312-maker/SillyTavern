import test from 'node:test';
import assert from 'node:assert/strict';
import {planCandidateUpdates} from './plan-excel-candidates.mjs';
const id='gps-demo-event-0001';
const base={year:2026,records:[{eventId:id,rowNumber:6,monthSheet:'11月',year:2026,
  existingBusinessCandidate:'',existingAddressCandidate:'',existingProvider:'',manualCorrection:'正しいカフェ名',existingCheckedAt:''}]};
const good={eventId:id,status:'automatic_candidate_unverified',addressCandidate:'架空市 さくら町',
  facilityCandidate:'候補のカフェ',providerName:'合成テスト',checkedAt:'2026-11-16T08:00:00Z'};
test('only D/E/N/O are proposed; manual correction F never touched',()=>{
 const p=planCandidateUpdates({...base,suggestions:[good]});
 assert.deepEqual(Object.keys(p.planned[0].cells),['D','E','N','O']);
 assert.equal(p.planned[0].manualCorrectionPreserved,true);
 assert.equal(p.planned[0].cells.D,'候補のカフェ');
 assert.equal(p.planned[0].eventId,id);
});
test('no candidate status cannot be imported',()=>{
 const p=planCandidateUpdates({...base,suggestions:[{...good,status:'privacy_hold'}]});
 assert.equal(p.planned.length,0);
});
test('unknown event id cannot create new rows',()=>{
 const p=planCandidateUpdates({...base,suggestions:[{...good,eventId:'not-in-book-0002'}]});
 assert.equal(p.planned.length,0);assert.equal(p.skipped[0].reason,'event_id_not_in_workbook');
});
test('changed candidate is conflict, not overwritten',()=>{
 const r={...base.records[0],existingBusinessCandidate:'以前の候補'};
 const p=planCandidateUpdates({year:2026,records:[r],suggestions:[good]});
 assert.equal(p.planned.length,0);assert.equal(p.conflicts.length,1);
});
test('duplicate existing event key stops',()=>assert.throws(()=>
 planCandidateUpdates({year:2026,records:[base.records[0],base.records[0]],suggestions:[good]}),/duplicate_existing_event_id/));
test('duplicate suggestions stop',()=>assert.throws(()=>
 planCandidateUpdates({...base,suggestions:[good,good]}),/duplicate_or_invalid_suggestion_id/));
test('spreadsheet formula injection is refused',()=>assert.throws(()=>
 planCandidateUpdates({...base,suggestions:[{...good,facilityCandidate:'=HYPERLINK("evil")'}]}),/invalid_untrusted_text/));
test('line breaks and tabs in provider response are refused',()=>assert.throws(()=>
 planCandidateUpdates({...base,suggestions:[{...good,addressCandidate:'街\n=cmd'}]}),/invalid_untrusted_text/));
test('invalid event timestamp is refused',()=>assert.throws(()=>
 planCandidateUpdates({...base,suggestions:[{...good,checkedAt:'yesterday'}]}),/invalid_lookup_timestamp/));
test('re-applying identical suggestion has no writes',()=>{
 const r={...base.records[0],existingBusinessCandidate:good.facilityCandidate,
 existingAddressCandidate:good.addressCandidate,existingProvider:good.providerName,existingCheckedAt:good.checkedAt};
 const p=planCandidateUpdates({year:2026,records:[r],suggestions:[good]});
 assert.equal(p.planned.length,0);assert.equal(p.skipped[0].reason,'already_identical');
});
test('year mismatch refuses source record',()=>assert.throws(()=>
 planCandidateUpdates({year:2027,records:base.records,suggestions:[good]}),/invalid_existing_record/));
test('no writes for lookup failure',()=>{
 const p=planCandidateUpdates({...base,suggestions:[{...good,status:'lookup_failed'}]});
 assert.equal(p.planned.length,0);assert.equal(p.conflicts.length,0);
});
test('address-only candidate is allowed',()=>{
 const p=planCandidateUpdates({...base,suggestions:[{...good,facilityCandidate:''}]});
 assert.equal(p.planned[0].cells.D,'');assert.equal(p.planned[0].cells.E,'架空市 さくら町');
});
test('no implicit changes to private GPS or original location fields',()=>{
 const p=planCandidateUpdates({...base,suggestions:[good]});
 assert.equal(JSON.stringify(p).includes('lat'),false);
 assert.equal(JSON.stringify(p).includes('lon'),false);
 assert.equal(JSON.stringify(p).includes('F:'),false);
});