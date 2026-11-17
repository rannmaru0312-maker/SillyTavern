import test from 'node:test';
import assert from 'node:assert/strict';
import {suggestFromLocalCorrections} from './local-known-place-candidates.mjs';
import {ENRICHMENT_STATUS} from './place-enrichment.mjs';

// Fully fabricated coordinates, names, IDs; no user data or online requests.
const point={eventId:'synthetic-target-0001',lat:35.000000,lon:139.000000,accuracyMeters:3};
const refs=[{eventId:'synthetic-ref-000001',manualCorrection:'架空カフェ',lat:35.000030,lon:139.000020,accuracyMeters:3}];
const fixedTime='2026-11-16T00:00:00.000Z';
const lookup=(p=point,r=refs,o={})=>suggestFromLocalCorrections(p,r,{checkedAt:fixedTime,...o});

test('user-confirmed label becomes candidate, NOT confirmed visit',()=>{
 const x=lookup();
 assert.equal(x.status,ENRICHMENT_STATUS.CANDIDATE);
 assert.equal(x.facilityCandidate,'架空カフェ');
 assert.equal(x.sourceKind,'local_user_correction_unverified');
 assert.equal(x.addressCandidate,'');
 assert.notEqual(x.reason,'confirmed_visit');
});
test('same event cannot become its own nearby recommendation',()=>{
 assert.equal(lookup(point,[{...refs[0],eventId:point.eventId}]).status,ENRICHMENT_STATUS.NO_MATCH);
});
test('no external API, no data mutation',()=>{
 const original=structuredClone(refs);
 lookup(); assert.deepEqual(refs,original);
});
test('unknown and poor GPS accuracy are held',()=>{
 assert.equal(lookup({...point,lat:130}).status,ENRICHMENT_STATUS.BAD_LOCATION);
 assert.equal(lookup({...point,accuracyMeters:70}).status,ENRICHMENT_STATUS.LOW_ACCURACY);
});
test('different nearby corrected shops cause ambiguity, not closest-wins',()=>{
 const different={eventId:'synthetic-ref-000002',manualCorrection:'架空スーパー',lat:35.000020,lon:139.000010,accuracyMeters:3};
 const x=lookup(point,[...refs,different]);
 assert.equal(x.status,ENRICHMENT_STATUS.NO_MATCH);
 assert.equal(x.reason,'ambiguous_local_places');
});
test('no reuse when too far from previous correction',()=>{
 assert.equal(lookup({...point,lat:35.001}).status,ENRICHMENT_STATUS.NO_MATCH);
});
test('untrusted formula-like names are rejected',()=>{
 assert.equal(lookup(point,[{...refs[0],manualCorrection:'=HYPERLINK("https://bad")'}]).status,ENRICHMENT_STATUS.NO_MATCH);
});
test('unverified/candidate-only labels never count as manual corrections',()=>{
 assert.equal(lookup(point,[{...refs[0],manualCorrection:'',candidate:'架空カフェ'}]).status,ENRICHMENT_STATUS.NO_MATCH);
});
test('two same-name corrections near location remain a candidate',()=>{
 const other={...refs[0],eventId:'synthetic-ref-000002',lat:35.000045};
 assert.equal(lookup(point,[...refs,other]).facilityCandidate,'架空カフェ');
});
test('incorrect source types are rejected',()=>assert.throws(()=>lookup(point,{}),/invalid_local_sources/));