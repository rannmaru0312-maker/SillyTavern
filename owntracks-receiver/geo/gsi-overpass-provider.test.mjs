import test from 'node:test';
import assert from 'node:assert/strict';
import {suggestPlace,ENRICHMENT_STATUS,displayNameForEvent} from './place-enrichment.mjs';
import {createGsiOverpassProvider} from './gsi-overpass-provider.mjs';
const point={eventId:'fictional-demo-1',lat:35.000001,lon:139.000001,accuracyMeters:7,classification:'public_place',publicClassificationVerified:true};
let clock=1700000000000;
const events=[];
function mock(url,req){events.push({url,req});
  if(url.includes('mreversegeocoder'))return Promise.resolve({ok:true,headers:{get:()=> 'application/json'},json:async()=>({results:{muniCd:'99999',lv01Nm:'架空通り一丁目'}})});
  return Promise.resolve({ok:true,headers:{get:()=> 'application/json'},json:async()=>({elements:[{type:'node',id:1,lat:35.000005,lon:139.000002,tags:{name:'架空カフェ',shop:'coffee'}}]})});
}
const create=(config={})=>createGsiOverpassProvider({enabled:true,fetcher:mock,now:()=>clock,sleep:async ms=>{clock+=ms},minimumDelayMs:15000,maximumQueriesPerSession:5,municipalNames:{'99999':'架空市'},...config});
const opts=provider=>({provider,privacy:{mode:'cloud_public_only',approved:true}});

test('off by default: no provider and no requests',()=>{events.length=0;assert.equal(createGsiOverpassProvider(),null);assert.equal(events.length,0);});
test('explicitly reviewed public point, 2 provider calls with 15 sec pacing',async()=>{
  events.length=0;clock=1700000000000;const provider=create();
  // sequential lookups auto-throttle without a busy loop
  const addr=await provider.reverseAddress(point);
  assert.deepEqual(addr,{address:'架空市 架空通り一丁目',level:'町域程度',municipalityCode:'99999',provider:'GSI'});
  const poi=await provider.nearbyFacility(point);
  assert.equal(poi.name,'架空カフェ');
  assert.equal(poi.reason,'nearby_only_unverified');
  assert.equal(events.length,2);
  assert.equal(provider.getUsage().requests,2);
  assert.deepEqual(await provider.nearbyFacility(point),poi); // cache
  assert.equal(events.length,2);
});
test('privacy gate prevents all network access for personal/unknown points',async()=>{
  events.length=0;clock+=18000;let p=create();
  for(const classification of ['private_residence','work_site','unknown']){
    assert.equal((await suggestPlace({...point,classification,publicClassificationVerified:false},opts(p))).status,ENRICHMENT_STATUS.PRIVACY_HOLD);
  }
  assert.equal(events.length,0);
});
test('protected zones stop a classified public point',async()=>{
  events.length=0;let p=create();const res=await suggestPlace(point,{...opts(p),protectedZones:[{lat:35.0001,lon:139,radiusMeters:120}]});
  assert.equal(res.status,ENRICHMENT_STATUS.PRIVACY_HOLD);assert.equal(events.length,0);
});
test('avoid external request on invalid coordinates',async()=>{
  events.length=0;const provider=create();
  assert.equal((await suggestPlace({...point,lat:200},opts(provider))).status,ENRICHMENT_STATUS.BAD_LOCATION);
  assert.equal(events.length,0);
});
test('ambiguous two close businesses returns no guessed name',async()=>{
  let t=1700000000000;const fn=async(url)=>({ok:true,headers:{get:()=> 'application/json'},json:async()=>({elements:[
    {type:'node',id:1,lat:35.000005,lon:139.000001,tags:{name:'架空喫茶A'}},
    {type:'node',id:2,lat:35.000006,lon:139.000002,tags:{name:'架空喫茶B'}},
  ]})});
  const provider=create({fetcher:fn,now:()=>t});
  assert.equal((await provider.nearbyFacility(point)).reason,'ambiguous_multiple_places');
});
test('GPS accuracy too broad: no POI lookup',async()=>{
  events.length=0;const provider=create();
  assert.equal((await provider.nearbyFacility({...point,accuracyMeters:45})).reason,'insufficient_accuracy');
  assert.equal(events.length,0);
});
test('manual user correction always overrides automated name',()=>{
  const res=displayNameForEvent({existingName:'元の場所',manualCorrection:'本人が決めた店名',suggestion:{facilityCandidate:'架空カフェ'}});
  assert.equal(res.name,'本人が決めた店名');assert.equal(res.status,'manual_name_confirmed');
});
test('provider only accepts approved API endpoints',()=>assert.throws(()=>create({gsiUrl:'https://unknown.example/reverse'}),/unapproved_provider_endpoint/));
test('quota blocks after configured calls',async()=>{
  events.length=0;let t=1700000000000;const p=create({now:()=>t,maximumQueriesPerSession:1});
  await p.reverseAddress(point);t+=15000;
  await assert.rejects(p.nearbyFacility(point),/quota_exhausted/);
  assert.equal(events.length,1);
});
test('end-to-end privacy-reviewed point returns an address and unverified shop suggestion', async()=>{
  events.length=0;clock=1700000000000;
  const provider=create();
  const result=await suggestPlace(point,opts(provider));
  assert.equal(result.status,ENRICHMENT_STATUS.CANDIDATE);
  assert.equal(result.addressCandidate,'架空市 架空通り一丁目');
  assert.equal(result.facilityCandidate,'架空カフェ');
  assert.match(result.providerName,/GSI/);
  assert.equal(events.length,2);
});