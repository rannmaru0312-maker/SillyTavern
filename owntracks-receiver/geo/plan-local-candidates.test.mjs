import test from 'node:test';
import assert from 'node:assert/strict';
import {planLocalCandidates} from './plan-local-candidates.mjs';

const base={year:2026,correctedSources:[{eventId:'source-corrected-1111',manualCorrection:'架空の薬局',lat:35.0000,lon:139.0000,accuracyMeters:3}],
 targets:[{eventId:'event-new-aaaaaaaaaa',lat:35.00003,lon:139.00002,accuracyMeters:4}],
 workbookRecords:[{eventId:'event-new-aaaaaaaaaa',rowNumber:6,monthSheet:'11月',year:2026,existingBusinessCandidate:'',existingAddressCandidate:'',existingProvider:'',existingCheckedAt:'',manualCorrection:''}]};
const now='2026-11-16T00:00:00.000Z';
test('local private source becomes unverified D/E/N/O patch only',()=>{
 const x=planLocalCandidates(base,{checkedAt:now});
 assert.equal(x.planned.length,1);assert.equal(x.matched,1);assert.equal(x.conflicts.length,0);
 assert.deepEqual(Object.keys(x.planned[0].cells),['D','E','N','O']);
 assert.equal(x.planned[0].cells.D,'架空の薬局');assert.equal(x.planned[0].cells.E,'');
 assert.equal(x.planned[0].cells.O,now);
});
test('no match without user correction',()=>{
 const x=planLocalCandidates({...base,correctedSources:[]},{checkedAt:now});
 assert.equal(x.matched,0);assert.equal(x.planned.length,0);
});
test('nearby competing labels do not silently win',()=>{
 const r={eventId:'other-corrected-1111',manualCorrection:'別の架空商店',lat:35.00002,lon:139.00003,accuracyMeters:3};
 const x=planLocalCandidates({...base,correctedSources:[...base.correctedSources,r]},{checkedAt:now});
 assert.equal(x.matched,0);assert.equal(x.planned.length,0);
});
test('previously different automatic candidate triggers conflict',()=>{
 const x=planLocalCandidates({...base,workbookRecords:[{...base.workbookRecords[0],existingBusinessCandidate:'以前の候補'}]},{checkedAt:now});
 assert.equal(x.planned.length,0);assert.equal(x.conflicts.length,1);
});