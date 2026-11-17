/**
 * MIYA GPS enrichment: reviewed public-place coordinates only.
 * OFF by default. No secrets, no personal coordinates, no background worker.
 * Pair with suggestPlace() from place-enrichment.mjs, which enforces privacy.
 *
 * Sources:
 * - GSI reverse geocoder: returns municipality code + neighbourhood, NOT street number.
 * - OSM Overpass: searches nearby named businesses; results are CANDIDATES, not visits.
 * Public endpoints can change/deny access; callers must comply with usage terms.
 */
import {distanceMeters} from './place-enrichment.mjs';

const GSI = 'https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress';
const OVERPASS = 'https://overpass-api.de/api/interpreter';
const valid=(x,a,b)=>typeof x==='number'&&Number.isFinite(x)&&x>=a&&x<=b;
const string=(s,max=160)=>typeof s==='string'?s.replace(/[\x00-\x1f]/g,' ').trim().slice(0,max):'';
const coordinate=(p)=>valid(p.lat,-90,90)&&valid(p.lon,-180,180);
const cacheKey=(kind,p)=>`${kind}:${p.lat.toFixed(5)}:${p.lon.toFixed(5)}`;

export function createGsiOverpassProvider({
  enabled=false,
  fetcher=globalThis.fetch,
  now=()=>Date.now(),
  minimumDelayMs=15000,
  maximumQueriesPerSession=12,
  sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),
  cache=new Map(),
  municipalNames={},
  gsiUrl=GSI,
  overpassUrl=OVERPASS,
}={}) {
  if (!enabled) return null; // Network is never implicitly enabled.
  if (typeof fetcher!=='function') throw Error('fetcher_required');
  if (!Number.isInteger(maximumQueriesPerSession)||maximumQueriesPerSession<1||maximumQueriesPerSession>50) throw Error('invalid_query_cap');
  if (minimumDelayMs<15000) throw Error('minimum_delay_too_short');
  // Never accept arbitrary endpoints in production: prevent accidental SSRF.
  if (![GSI].includes(gsiUrl)||![OVERPASS].includes(overpassUrl)) throw Error('unapproved_provider_endpoint');
  let requestCount=0, lastRequestAt=-Infinity;
  async function charge() {
    if (requestCount>=maximumQueriesPerSession) throw Error('quota_exhausted');
    const gap=now()-lastRequestAt;
    if (gap<minimumDelayMs) await sleep(minimumDelayMs-gap);
    if (now()-lastRequestAt<minimumDelayMs) throw Error('rate_limit');
    lastRequestAt=now(); requestCount++;
  }
  async function request(url,init={}) {
    await charge();
    // Identification required by public OSM providers. No account or device ID.
    const projectUserAgent='MIYA-GPS-Prototype/0.1 (+https://github.com/rannmaru0312-maker/SillyTavern)';
    const headers={...init.headers,'User-Agent':projectUserAgent,'Accept':'application/json'};
    const res=await fetcher(url,{redirect:'error',signal:AbortSignal.timeout(8000),...init,headers});
    if (!res || !res.ok) throw Error('provider_unavailable');
    const contentType=res.headers?.get?.('content-type')||'';
    if (contentType && !/application\/json|text\/json/i.test(contentType)) throw Error('unexpected_response_type');
    const size=res.headers?.get?.('content-length');
    if (size && Number(size)>100000) throw Error('response_too_large');
    const data=await res.json();
    return data;
  }
  return {
    name:'国土地理院GSI（住所の町域）＋OpenStreetMap/Overpass（店舗候補）',
    async reverseAddress(point){
      if(!coordinate(point)) throw Error('invalid_coordinate');
      const key=cacheKey('address',point);
      if(cache.has(key)) return cache.get(key);
      const url=new URL(gsiUrl);
      url.searchParams.set('lat',String(point.lat));
      url.searchParams.set('lon',String(point.lon));
      const response=await request(url.href);
      const result=response?.results;
      const code=/^\d{5}$/.test(result?.muniCd)?result.muniCd:'';
      const locality=string(result?.lv01Nm,100);
      const municipality=string(municipalNames[code],100);
      // GSI does not return a street number, building or confirmed full address.
      const address=[municipality,locality].filter(Boolean).join(' ');
      const outcome={address,level:locality?'町域程度':'未特定',municipalityCode:code,provider:'GSI'};
      cache.set(key,outcome);
      return outcome;
    },
    async nearbyFacility(point){
      if(!coordinate(point)) throw Error('invalid_coordinate');
      // Restrict query to close-by POIs only; fail closed for poor GPS accuracy.
      const acc=point.accuracyMeters;
      if(!valid(acc,0,25)) return {name:'',reason:'insufficient_accuracy'};
      const radius=Math.min(60,Math.max(20,acc+15));
      const key=`facility:${cacheKey('point',point)}:${radius}`;
      if(cache.has(key)) return cache.get(key);
      const q=`[out:json][timeout:7];(nwr(around:${radius},${point.lat},${point.lon})[name][shop];nwr(around:${radius},${point.lat},${point.lon})[name][amenity~"^(restaurant|cafe|bar|pub|fast_food|pharmacy|hospital|clinic|doctors|bank|library|community_centre|school|college)$"];nwr(around:${radius},${point.lat},${point.lon})[name][tourism];);out center 35;`;
      const res=await request(overpassUrl,{
        method:'POST',headers:{'content-type':'application/x-www-form-urlencoded; charset=UTF-8'},
        body:new URLSearchParams({data:q}).toString(),
      });
      const candidates=(Array.isArray(res?.elements)?res.elements:[])
        .map(el=>({
          name:string(el?.tags?.['name:ja']||el?.tags?.name,110),
          lat:typeof el?.lat==='number'?el.lat:el?.center?.lat,
          lon:typeof el?.lon==='number'?el.lon:el?.center?.lon,
          osmId:typeof el?.id==='number'?`${el?.type||'node'}/${el.id}`:'',
        }))
        .filter(el=>el.name&&coordinate(el))
        .map(el=>({...el,distance:distanceMeters(point,el)}))
        .filter(el=>el.distance<=radius)
        .sort((a,b)=>a.distance-b.distance);
      // We never guess among similarly close sites. A closest POI isn't proof of a visit.
      const best=candidates[0], runnerUp=candidates.find(x=>x.name!==best?.name);
      const ambiguous=best&&runnerUp&&runnerUp.distance-best.distance<Math.max(8,acc);
      const outcome=best&&!ambiguous?{name:best.name,distanceMeters:Math.round(best.distance),osmId:best.osmId,source:'OSM/Overpass',reason:'nearby_only_unverified'}:
        {name:'',reason:ambiguous?'ambiguous_multiple_places':'no_named_poi'};
      cache.set(key,outcome);
      return outcome;
    },
    getUsage(){return {requests:requestCount,max:maximumQueriesPerSession,minimumDelayMs};},
  };
}