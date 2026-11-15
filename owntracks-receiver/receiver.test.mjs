import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import vm from 'node:vm';
import fs from 'node:fs';
import {createServer,validate,envelope,configuration} from './server.mjs';
const secret='a'.repeat(64), payload={_type:'location',tst:1700000000,lat:0,lon:0,acc:5,tid:'T1'};
const config={user:'test',password:'test-only-password-24-characters',secret,url:'https://script.google.com/macros/s/test/exec'};
const auth='Basic '+Buffer.from(config.user+':'+config.password).toString('base64');
test('valid coordinates and historical offline reports are retained',()=>assert.deepEqual(validate(payload),payload));
test('reject invalid coordinates, timestamps, unsupported types and transitions',()=>{
  for(const p of [{...payload,lat:91},{...payload,lon:'1'},{...payload,tst:1.5},{...payload,tst:9999999999},{...payload,_type:'cmd'},{...payload,_type:'transition',event:'anything'},{...payload,acc:-1}])assert.throws(()=>validate(p));
});
test('configuration fails closed without secure secret or fixed Google URL',()=>{
  assert.throws(()=>configuration({}));
  const e={OWNTRACKS_USER:config.user,OWNTRACKS_PASSWORD:config.password,BRIDGE_SECRET:secret,BRIDGE_URL:config.url};
  assert.equal(configuration(e).url,config.url);
  for(const u of ['http://script.google.com/macros/s/a/exec','https://evil.example/exec','https://script.google.com/macros/s/a/exec?token=x'])assert.throws(()=>configuration({...e,BRIDGE_URL:u}));
});
function bridge(){
  const files=new Map();let writes=0,fail=false,corrupt=false;
  const props={BRIDGE_SECRET:secret,ENABLED:'true',OUTPUT_FOLDER_ID:'test'};
  const makeFile=(name,text)=>({getId:()=>name,getSharingAccess:()=>0,getSize:()=>text.length,getBlob:()=>({getDataAsString:()=>corrupt?'broken':text}),setContent:t=>{if(fail)throw Error('storage');writes++;text=t;}});
  const folder={getSharingAccess:()=>0,getFilesByName:name=>{let f=files.get(name);return {hasNext:()=>!!f,next:()=>{const x=f;f=null;return x;}};},createFile:(name,text)=>{if(fail)throw Error('storage');writes++;const f=makeFile(name,text);files.set(name,f);return f;}};
  const ctx=vm.createContext({PropertiesService:{getScriptProperties:()=>({getProperty:k=>props[k]})},Utilities:{computeHmacSha256Signature:(s,key)=>[...createHmac('sha256',key).update(s).digest()],computeDigest:(_,s)=>[...createHash('sha256').update(s).digest()],DigestAlgorithm:{SHA_256:'sha256'},formatDate:d=>new Date(+d+9*3600000).toISOString().slice(0,10)},LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock:()=>{}})},DriveApp:{getFolderById:()=>folder,Access:{PRIVATE:0}},MimeType:{PLAIN_TEXT:'text/plain'},ContentService:{MimeType:{JSON:'json'},createTextOutput:s=>({setMimeType:()=>s})}});
  vm.runInContext(fs.readFileSync(new URL('./Code.gs',import.meta.url),'utf8'),ctx);
  return {send:body=>JSON.parse(ctx.doPost({postData:{contents:JSON.stringify(body)}})),props,files,get writes(){return writes;},set fail(v){fail=v;},set corrupt(v){corrupt=v;}};
}
test('bridge authenticates before any writes; rejects stale signatures and invalid GPS',()=>{
  const b=bridge(),e=envelope(payload,secret);
  assert.equal(b.send({...e,signature:'0'.repeat(64)}).ok,false);
  assert.equal(b.send(envelope(payload,secret,Date.now()-600000)).ok,false);
  assert.equal(b.send(envelope({...payload,lat:100},secret)).ok,false);
  assert.equal(b.writes,0);
});
test('bridge persists and read-verifies, deduplicates retries, retains conflicts',()=>{
  const b=bridge(),e=envelope(payload,secret);
  const result=b.send(e);assert.equal(result.ok,true);assert.equal(result.sha256,createHash('sha256').update(e.data).digest('hex'));
  assert.equal(b.send(e).ok,true);assert.equal(b.writes,1);
  assert.equal(b.send(envelope({...payload,lat:1},secret)).ok,true);assert.equal(b.writes,2);
});
test('bridge rejects disabled operation and storage failures/readback corruption',()=>{
  const b=bridge(),e=envelope(payload,secret);b.props.ENABLED='false';assert.equal(b.send(e).ok,false);assert.equal(b.writes,0);
  b.props.ENABLED='true';b.fail=true;assert.equal(b.send(e).ok,false);
  b.fail=false;b.corrupt=true;assert.equal(b.send(e).ok,false);
});
async function withServer(t,fetcher,run){
  const server=createServer(config,fetcher);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>{server.closeAllConnections();server.close();});
  const url='http://127.0.0.1:'+server.address().port;
  await run((body=payload,authorization=auth)=>fetch(url+'/pub',{method:'POST',headers:{authorization,'Content-Type':'application/json'},body:typeof body==='string'?body:JSON.stringify(body)}),url);
}
test('HTTP rejects unauthenticated requests before calling storage',async t=>{
  let calls=0;await withServer(t,async()=>{calls++;},async post=>{assert.equal((await post(payload,'Basic bad')).status,401);assert.equal(calls,0);});
});
test('HTTP validates size and JSON; non-location payload not acknowledged',async t=>{
  await withServer(t,async()=>{throw Error('must not call');},async post=>{assert.equal((await post('invalid')).status,422);assert.equal((await post('a'.repeat(33000))).status,413);assert.equal((await post({_type:'cmd'})).status,422);});
});
test('HTTP does not mistake upstream HTTP 200 for successful persistence',async t=>{
  for(const body of ['<html>Error</html>','{"ok":false}','{"ok":true,"sha256":"wrong","fileId":"x"}'])await withServer(t,async()=>new Response(body),async post=>assert.equal((await post()).status,503));
});
test('HTTP returns 503 on network failure; phone can retry',async t=>{
  await withServer(t,async()=>{throw Error('offline');},async post=>assert.equal((await post()).status,503));
});
test('HTTP to mock Google bridge: acknowledge only after verified write; duplicate safe',async t=>{
  const b=bridge();await withServer(t,async(_,options)=>new Response(JSON.stringify(b.send(JSON.parse(options.body)))),async(post,url)=>{
    const res=await post();assert.equal(res.status,200);assert.deepEqual(await res.json(),[]);assert.equal(b.writes,1);
    assert.equal((await post()).status,200);assert.equal(b.writes,1);
    const health=await(await fetch(url+'/healthz')).json();assert.equal(health.storage,'not_checked');
  });
});
