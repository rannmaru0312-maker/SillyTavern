import test from 'node:test';
import assert from 'node:assert/strict';
import {suggestTownOffline} from './offline-town-provider.mjs';
const p={eventId:'12345678',lat:35.6812,lon:139.7671,accuracyMeters:7};
const fake=async(path,point)=>{
  assert.equal(path,'/trusted/bin/offline-town');
  assert.deepEqual(point,{lat:p.lat,lon:p.lon});
  return {status:'town_candidate_unverified',addressCandidate:'東京都千代田区丸の内一丁目',
    facilityCandidate:'',providerName:'MLIT location reference / japan-reverse-geocoder 0.1.0'};
};
const opts={enabled:true,approvedPrivateRuntime:true,binaryPath:'/trusted/bin/offline-town',invoke:fake,now:()=> '2026-11-16T00:00:00Z'};
test('default OFF, no subprocess',async()=>{
  assert.equal((await suggestTownOffline(p,{invoke:()=>{throw Error('called')}})).status,'lookup_not_configured');
});
test('requires reviewed private runtime',async()=>{
  assert.equal((await suggestTownOffline(p,{...opts,approvedPrivateRuntime:false,invoke:()=>{throw Error('called')}})).status,'privacy_hold');
});
test('requires absolute binary path',async()=>{
  assert.equal((await suggestTownOffline(p,{...opts,binaryPath:'../../bash'})).status,'privacy_hold');
});
test('invalid coordinate is not submitted',async()=>{
  assert.equal((await suggestTownOffline({...p,lat:0},opts)).status,'invalid_location');
});
test('poor GPS accuracy is not enriched',async()=>{
  assert.equal((await suggestTownOffline({...p,accuracyMeters:101},opts)).status,'low_accuracy');
});
test('valid town result is unverified and has no shop suggestion',async()=>{
  assert.deepEqual(await suggestTownOffline(p,opts),{
    eventId:p.eventId,status:'automatic_candidate_unverified',addressCandidate:'東京都千代田区丸の内一丁目',
    facilityCandidate:'',providerName:'MLIT location reference / japan-reverse-geocoder 0.1.0',checkedAt:'2026-11-16T00:00:00Z'
  });
});
test('far from a representative point returns no candidate',async()=>{
  assert.equal((await suggestTownOffline(p,{...opts,invoke:async()=>({status:'no_reliable_town_candidate'})})).status,'no_match');
});
test('exception returns generic failure',async()=>{
  assert.equal((await suggestTownOffline(p,{...opts,invoke:async()=>{throw Error('very_private_coordinate')}})).status,'lookup_failed');
});
test('rejects candidate formula injection',async()=>{
  assert.equal((await suggestTownOffline(p,{...opts,invoke:async()=>({
    status:'town_candidate_unverified',addressCandidate:'=HYPERLINK("evil")',
    facilityCandidate:'',providerName:'synthetic'})})).status,'lookup_failed');
});
test('rejects false shop name from town-only lookup',async()=>{
  assert.equal((await suggestTownOffline(p,{...opts,invoke:async()=>({
    status:'town_candidate_unverified',addressCandidate:'東京都千代田区',
    facilityCandidate:'Tokyo Station',providerName:'synthetic'})})).status,'lookup_failed');
});
test('offline address candidate flows into annual Excel plan without replacing manual shop name',async()=>{
  const {planCandidateUpdates}=await import('./plan-excel-candidates.mjs');
  const suggestion=await suggestTownOffline(p,opts);
  const plan=planCandidateUpdates({year:2026,records:[{
    eventId:p.eventId,monthSheet:'11月',year:2026,rowNumber:9,
    existingBusinessCandidate:'',existingAddressCandidate:'',existingProvider:'',
    existingCheckedAt:'',manualCorrection:'本人修正の店舗名'
  }],suggestions:[suggestion]});
  assert.equal(plan.planned.length,1);
  assert.equal(plan.planned[0].cells.D,'');
  assert.equal(plan.planned[0].cells.E,'東京都千代田区丸の内一丁目');
  assert.equal(plan.planned[0].manualCorrectionPreserved,true);
});
