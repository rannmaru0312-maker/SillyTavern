/**
 * MIYA OwnTracks private-only enrichment fallback.
 *
 * Build from user-corrected annual workbook rows in memory. Do not transmit
 * coordinates or names to an external API, log them, or save them in source code.
 * This is NOT an arrival detector and NEVER creates a confirmed visit.
 */
import {distanceMeters, ENRICHMENT_STATUS} from './place-enrichment.mjs';

const isNum=(v,min,max)=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max;
const validPoint=p=>p&&isNum(p.lat,-90,90)&&isNum(p.lon,-180,180)&&isNum(p.accuracyMeters,0,20000);
const validName=n=>typeof n==='string'&&n.trim().length>0&&n.trim().length<=140&& !/^[=+\-@]/.test(n.trim()) && !/[\x00-\x1f\x7f]/.test(n);
const validId=i=>typeof i==='string'&&i.length>=8&&i.length<=170;

/**
 * Return a candidate only when ONE distinct previously user-corrected place
 * falls inside a conservative distance and accuracy tolerance. All corrections
 * are inputs supplied locally by the caller, never read from a remote service.
 *
 * sourceRows = [{eventId, manualCorrection, lat,lon,accuracyMeters}].
 * Never infer a new correction for the user; caller may only set candidate.
 */
export function suggestFromLocalCorrections(point, sourceRows, {
  maxPointAccuracyMeters=15,
  maxReferenceAccuracyMeters=15,
  maximumDistanceMeters=12,
  ambiguityDistanceMeters=25,
  checkedAt=new Date().toISOString(),
}={}) {
  const base={eventId:validId(point?.eventId)?point.eventId:'',
    status:ENRICHMENT_STATUS.NO_MATCH,addressCandidate:'',facilityCandidate:'',
    providerName:'端末・非公開記録の本人修正地点（近接候補）',checkedAt,
    sourceKind:'local_user_correction_unverified'};
  if (!validPoint(point)||!validId(point?.eventId)) return {...base,status:ENRICHMENT_STATUS.BAD_LOCATION};
  if(point.accuracyMeters>maxPointAccuracyMeters) return {...base,status:ENRICHMENT_STATUS.LOW_ACCURACY};
  if(!Array.isArray(sourceRows)) throw Error('invalid_local_sources');
  if(!isNum(maximumDistanceMeters,0,25)||!isNum(ambiguityDistanceMeters,maximumDistanceMeters,100)) throw Error('invalid_distance_limit');
  const matches=[];
  for(const row of sourceRows){
    if (!validId(row?.eventId)||row.eventId===point.eventId||!validName(row.manualCorrection)||
        !validPoint(row)||row.accuracyMeters>maxReferenceAccuracyMeters) continue;
    const d=distanceMeters(point,row);
    // Include GPS uncertainty. A wide-accuracy point cannot be 'nearby' evidence.
    if(d<=ambiguityDistanceMeters+point.accuracyMeters+row.accuracyMeters){
      matches.push({name:row.manualCorrection.trim(),distance:d,accuracy:row.accuracyMeters});
    }
  }
  // Never assume the closest name when different locations overlap.
  const names=new Set(matches.map(x=>x.name));
  if(names.size>1) return {...base,reason:'ambiguous_local_places'};
  const best=matches.sort((a,b)=>a.distance-b.distance)[0];
  if(!best||best.distance>maximumDistanceMeters || best.accuracy>maxReferenceAccuracyMeters){
    return {...base,reason:'no_close_user_corrected_location'};
  }
  return {...base,status:ENRICHMENT_STATUS.CANDIDATE,
    facilityCandidate:best.name,reason:'nearby_user_corrected_location_unverified',
    distanceMeters:Math.round(best.distance)};
}