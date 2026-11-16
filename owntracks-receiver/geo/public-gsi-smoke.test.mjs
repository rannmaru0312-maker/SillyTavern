import test from 'node:test';
import assert from 'node:assert/strict';
import {smokeGsiPublic} from './public-gsi-smoke.mjs';

test('validates a public geocoder response without live external network',async()=>{
  let calls=0;
  const fake=async(url,options)=>{calls++;assert.match(url,/35\.681236/);
    assert.equal(options.redirect,'error');
    return {ok:true,headers:{get:()=> '86'},text:async()=>JSON.stringify({results:{muniCd:'13101',lv01Nm:'丸の内一丁目'}})};
  };
  const result=await smokeGsiPublic(fake);
  assert.deepEqual(result,{provider:'GSI',responded:true,municipalityCode:'13101',neighborhood:'丸の内一丁目'});
  assert.equal(calls,1);
});
test('unexpected response is rejected',async()=>{
  await assert.rejects(smokeGsiPublic(async()=>({ok:true,headers:{get:()=>''},text:async()=>JSON.stringify({results:{}})})),/unexpected_payload/);
});
test('HTTP failure is rejected',async()=>{
  await assert.rejects(smokeGsiPublic(async()=>({ok:false,status:503})),/gsi_http_503/);
});
test('over-large response is rejected before parsing',async()=>{
  await assert.rejects(smokeGsiPublic(async()=>({ok:true,headers:{get:()=> '9000'},text:async()=>{throw Error('should not parse')}})),/unexpected_large_response/);
});