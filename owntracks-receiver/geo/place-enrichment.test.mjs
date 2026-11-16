import test from 'node:test';
import assert from 'node:assert/strict';
import {suggestPlace, displayNameForEvent, ENRICHMENT_STATUS} from './place-enrichment.mjs';

// All coordinates and providers in tests are synthetic, unrelated to any real user.
const point = {eventId:'synthetic-1',lat:34.5,lon:135.5,accuracyMeters:8,classification:'public_place',publicClassificationVerified:true};
let lookups;
function fakeProvider() {return {name:'synthetic-provider',
  reverseAddress: async () => {lookups++;return {address:'テスト住所'};},
  nearbyFacility: async () => {lookups++;return {name:'架空の店舗'};}};}

test('default is no lookups, no implicit provider', async () => {
  const result = await suggestPlace(point);
  assert.equal(result.status, ENRICHMENT_STATUS.PRIVACY_HOLD);
  assert.equal(result.facilityCandidate, '');
});
test('public point with review and provider only produces unverified candidate', async () => {
  lookups=0;
  const result = await suggestPlace(point, {provider:fakeProvider(),privacy:{mode:'cloud_public_only',approved:true}});
  assert.equal(result.status, ENRICHMENT_STATUS.CANDIDATE);
  assert.equal(result.addressCandidate, 'テスト住所');
  assert.equal(result.facilityCandidate, '架空の店舗');
  assert.equal(lookups,2);
});
test('private and unknown points never call cloud provider', async () => {
  lookups=0;
  for (const classification of ['private_residence','work_site','unknown']) {
    const result = await suggestPlace({...point,classification}, {provider:fakeProvider(),privacy:{mode:'cloud_public_only',approved:true}});
    assert.equal(result.status, ENRICHMENT_STATUS.PRIVACY_HOLD);
  }
  assert.equal(lookups,0);
});
test('asserted public tag without independent verification stays private', async () => {
  lookups=0;
  const result=await suggestPlace({...point,publicClassificationVerified:false},
    {provider:fakeProvider(),privacy:{mode:'cloud_public_only',approved:true}});
  assert.equal(result.status,ENRICHMENT_STATUS.PRIVACY_HOLD);
  assert.equal(lookups,0);
});
test('protected zone blocks cloud lookup even if classified public', async () => {
  lookups=0;
  const result = await suggestPlace(point, {provider:fakeProvider(),
    privacy:{mode:'cloud_public_only',approved:true},
    protectedZones:[{lat:34.5008,lon:135.5,radiusMeters:90}]});
  assert.equal(result.status, ENRICHMENT_STATUS.PRIVACY_HOLD);
  assert.equal(lookups,0);
});
test('device-approved provider can handle private points without cloud override', async () => {
  lookups=0;
  const result = await suggestPlace({...point,classification:'private_residence'},
    {provider:fakeProvider(),privacy:{mode:'approved_device_provider',approved:true}});
  assert.equal(result.status, ENRICHMENT_STATUS.CANDIDATE);
  assert.equal(lookups,2);
});
test('low accuracy and malformed coordinate prevent all lookups', async () => {
  lookups=0;
  const opts={provider:fakeProvider(),privacy:{mode:'cloud_public_only',approved:true}};
  assert.equal((await suggestPlace({...point,accuracyMeters:300},opts)).status,ENRICHMENT_STATUS.LOW_ACCURACY);
  assert.equal((await suggestPlace({...point,lat:95},opts)).status,ENRICHMENT_STATUS.BAD_LOCATION);
  assert.equal(lookups,0);
});
test('provider unavailable or error is not reported as success', async () => {
  const opts={privacy:{mode:'cloud_public_only',approved:true}};
  assert.equal((await suggestPlace(point,opts)).status,ENRICHMENT_STATUS.NOT_CONFIGURED);
  const provider={name:'fake',reverseAddress:async()=>{throw Error('failed');},nearbyFacility:async()=>({name:'bad'})};
  assert.equal((await suggestPlace(point,{...opts,provider})).status,ENRICHMENT_STATUS.CANDIDATE);
});
test('partial provider failure still keeps address-only candidate', async () => {
  const provider={name:'synthetic-provider',reverseAddress:async()=>({address:'架空の町域'}),
    nearbyFacility:async()=>{throw Error('temporary Overpass failure')}};
  const result=await suggestPlace(point,{provider,privacy:{mode:'cloud_public_only',approved:true}});
  assert.equal(result.status,ENRICHMENT_STATUS.CANDIDATE);
  assert.equal(result.addressCandidate,'架空の町域');
  assert.equal(result.facilityCandidate,'');
});
test('address provider unavailable still allows facility-only candidate', async () => {
  const provider={name:'synthetic-provider',reverseAddress:async()=>{throw Error('temporary GSI failure')},
    nearbyFacility:async()=>({name:'架空の施設'})};
  const result=await suggestPlace(point,{provider,privacy:{mode:'cloud_public_only',approved:true}});
  assert.equal(result.status,ENRICHMENT_STATUS.CANDIDATE);
  assert.equal(result.addressCandidate,'');
  assert.equal(result.facilityCandidate,'架空の施設');
});
test('manual names override provider suggestions without editing evidence', () => {
  const candidate={facilityCandidate:'自動推定の店名'};
  assert.deepEqual(displayNameForEvent({existingName:'元の名前',manualCorrection:'本人訂正',suggestion:candidate}),
    {name:'本人訂正',status:'manual_name_confirmed'});
  assert.deepEqual(displayNameForEvent({existingName:'元の名前',suggestion:candidate}),
    {name:'自動推定の店名',status:ENRICHMENT_STATUS.CANDIDATE});
  assert.equal(candidate.facilityCandidate,'自動推定の店名');
});