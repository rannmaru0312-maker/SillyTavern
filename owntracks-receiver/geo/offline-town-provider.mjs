/**
 * Node-only, default-OFF adapter for a reviewed private Rust town geocoder CLI.
 * Does not contact GSI, OSM or third-party APIs. Coordinates travel over stdin,
 * not subprocess arguments or logs. This is an isolated trial, not deployed.
 */
import {spawn} from 'node:child_process';
import {isAbsolute} from 'node:path';

const MAX_OUTPUT_BYTES = 8192;
const MAX_ACCURACY_M = 100;
const valid = (n,min,max)=>typeof n==='number'&&Number.isFinite(n)&&n>=min&&n<=max;
const safe = s=>typeof s==='string'&&s.length<=220&&!/[\u0000-\u001f\u007f]/.test(s)&&!/^\s*[=+\-@]/.test(s);

export async function runPrivateTownBinary(binaryPath,point,{timeoutMs=5000}={}) {
  if(!isAbsolute(binaryPath)||!valid(point?.lat,20,46)||!valid(point?.lon,122,154)) {
    throw Error('offline_invalid_configuration');
  }
  return await new Promise((resolve,reject)=>{
    const child=spawn(binaryPath,[],{
      stdio:['pipe','pipe','pipe'],shell:false,windowsHide:true,
    });
    let output='', outputLen=0, settled=false;
    const fail=(code)=>{
      if(settled) return;
      settled=true;clearTimeout(timer);child.kill();reject(Error(code));
    };
    const timer=setTimeout(()=>fail('offline_timeout'),timeoutMs);
    child.on('error',()=>fail('offline_spawn_failed'));
    child.stdout.on('data',chunk=>{
      outputLen+=chunk.length;
      if(outputLen>MAX_OUTPUT_BYTES) return fail('offline_output_too_large');
      output+=chunk.toString('utf8');
    });
    // Discard stderr; the CLI itself emits only generic errors, never coordinates.
    child.stderr.on('data',()=>{});
    child.on('close',code=>{
      if(settled) return;
      if(code!==0) return fail('offline_lookup_failed');
      settled=true;clearTimeout(timer);
      try{resolve(JSON.parse(output));}
      catch{reject(Error('offline_invalid_output'));}
    });
    child.stdin.on('error',()=>fail('offline_input_failed'));
    child.stdin.end(JSON.stringify({lat:point.lat,lon:point.lon}));
  });
}

/**
 * Produces a candidate compatible with planCandidateUpdates() without any HTTP.
 * Caller opts in only after verifying a locally installed, audited CLI binary.
 * No claims of actual shop visits, building entry or street-level addresses.
 */
export async function suggestTownOffline(point,{
  enabled=false, approvedPrivateRuntime=false, binaryPath='',
  invoke=runPrivateTownBinary, now=()=>new Date().toISOString(),
}={}) {
  const eventId=typeof point?.eventId==='string'?point.eventId:'';
  const base={eventId,status:'lookup_not_configured',addressCandidate:'',facilityCandidate:'',providerName:'',checkedAt:''};
  if(!enabled) return base;
  if(!approvedPrivateRuntime||!isAbsolute(binaryPath)) return {...base,status:'privacy_hold'};
  if(!valid(point?.lat,20,46)||!valid(point?.lon,122,154)) return {...base,status:'invalid_location'};
  if(!valid(point?.accuracyMeters,0,MAX_ACCURACY_M)) return {...base,status:'low_accuracy'};
  let data;
  try{data=await invoke(binaryPath,{lat:point.lat,lon:point.lon});}
  catch{return {...base,status:'lookup_failed'};}
  if(data?.status==='no_reliable_town_candidate') return {...base,status:'no_match'};
  if(data?.status!=='town_candidate_unverified'||!safe(data?.addressCandidate)||!safe(data?.providerName)||
      !data?.addressCandidate||!data?.providerName||data?.facilityCandidate!=='') {
    return {...base,status:'lookup_failed'};
  }
  const checkedAt=now();
  if(typeof checkedAt!=='string'||Number.isNaN(Date.parse(checkedAt))) return {...base,status:'lookup_failed'};
  return {...base,status:'automatic_candidate_unverified',addressCandidate:data.addressCandidate,
    facilityCandidate:'',providerName:data.providerName,checkedAt};
}