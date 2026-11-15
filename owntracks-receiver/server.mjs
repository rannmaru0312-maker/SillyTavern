import http from 'node:http';
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const MAX=32768;
const hash=s=>createHash('sha256').update(s).digest('hex');
const equal=(a,b)=>timingSafeEqual(Buffer.from(hash(a)),Buffer.from(hash(b)));
export function validate(p,now=Date.now()) {
  if(!p||Array.isArray(p)||typeof p!=='object')throw Error('payload');
  if(!['location','transition'].includes(p._type))throw Error('type');
  for(const [k,min,max]of [['lat',-90,90],['lon',-180,180]])if(typeof p[k]!=='number'||!Number.isFinite(p[k])||p[k]<min||p[k]>max)throw Error(k);
  if(!Number.isSafeInteger(p.tst)||p.tst<946684800||p.tst>Math.floor(now/1000)+600)throw Error('time');
  if(p.acc!==undefined&&(typeof p.acc!=='number'||!Number.isFinite(p.acc)||p.acc<0))throw Error('accuracy');
  if(p._type==='transition'&&!['enter','leave'].includes(p.event))throw Error('event');
  const out={_type:p._type,tst:p.tst,lat:p.lat,lon:p.lon};
  for(const k of ['acc','alt','batt','vel','cog'])if(typeof p[k]==='number'&&Number.isFinite(p[k]))out[k]=p[k];
  for(const k of ['tid','event','desc','t'])if(typeof p[k]==='string')out[k]=p[k].slice(0,k==='desc'?200:32);
  return out;
}
export function envelope(payload,secret,now=Date.now()) {
  const data=JSON.stringify(payload), sentAt=Math.floor(now/1000);
  return {version:1,sentAt,data,signature:createHmac('sha256',secret).update(`${sentAt}\n${data}`).digest('hex')};
}
export function configuration(env) {
  if(!/^[A-Za-z0-9_-]{1,40}$/.test(env.OWNTRACKS_USER||'')||(env.OWNTRACKS_PASSWORD||'').length<24||!/^[a-f0-9]{64}$/.test(env.BRIDGE_SECRET||''))throw Error('Missing secure credentials');
  const url=new URL(env.BRIDGE_URL);
  if(url.origin!=='https://script.google.com'||!/^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url.pathname)||url.search||url.hash)throw Error('Invalid bridge URL');
  return {user:env.OWNTRACKS_USER,password:env.OWNTRACKS_PASSWORD,secret:env.BRIDGE_SECRET,url:url.href};
}
export function createServer(config,fetcher=fetch) {
  let active=0;
  const server=http.createServer(async(req,res)=>{
    const respond=(code,value)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
    if(req.url==='/healthz'&&req.method==='GET')return respond(200,{status:'running',storage:'not_checked'});
    if(req.url!=='/pub'||req.method!=='POST')return respond(404,{error:'not_found'});
    const expected='Basic '+Buffer.from(config.user+':'+config.password).toString('base64');
    if(!equal(req.headers.authorization||'',expected)){res.setHeader('WWW-Authenticate','Basic realm="OwnTracks"');return respond(401,{error:'unauthorized'});}
    if(active>=4)return respond(503,{error:'busy'});
    if(Number(req.headers['content-length']||0)>MAX)return respond(413,{error:'too_large'});
    active++;
    try {
      const chunks=[];let size=0;
      for await(const c of req){size+=c.length;if(size>MAX){respond(413,{error:'too_large'});return;}chunks.push(c);}
      // OwnTracks uses empty payloads for removing friend records. No private friends are stored here.
      if(!size)return respond(200,[]);
      let payload;
      try {payload=validate(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{return respond(422,{error:'invalid_or_unsupported_event'});}
      const body=envelope(payload,config.secret);
      const upstream=await fetcher(config.url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),redirect:'follow',signal:AbortSignal.timeout(20000)});
      const reply=await upstream.text();
      if(!upstream.ok||reply.length>2048)throw Error('storage');
      const result=JSON.parse(reply);
      // Google can return HTTP 200 for script failures: require a matching durable-storage receipt.
      if(result.ok!==true||result.sha256!==hash(body.data)||typeof result.fileId!=='string'||!result.fileId)throw Error('storage');
      return respond(200,[]);
    }catch{return respond(503,{error:'storage_not_confirmed'});}
    finally{active--;}
  });
  server.requestTimeout=30000;server.headersTimeout=15000;server.keepAliveTimeout=5000;
  return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{const cfg=configuration(process.env);createServer(cfg).listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log('Receiver started'));}
  catch{console.error('Receiver configuration incomplete');process.exitCode=1;}
}
