/** Private/offline correction candidate planner. No network calls. */
import {readFile,writeFile} from 'node:fs/promises';
import {suggestFromLocalCorrections} from './local-known-place-candidates.mjs';
import {planCandidateUpdates} from './plan-excel-candidates.mjs';

export function planLocalCandidates(input,{checkedAt=new Date().toISOString()}={}){
  if(!input || !Array.isArray(input.targets) || !Array.isArray(input.correctedSources) || !Array.isArray(input.workbookRecords)) throw Error('invalid_source');
  const suggestions=input.targets.map(p=>suggestFromLocalCorrections(p,input.correctedSources,{checkedAt}));
  const result=planCandidateUpdates({records:input.workbookRecords,suggestions,year:input.year});
  return { ...result, matched:suggestions.filter(s=>s.facilityCandidate).length,
    held:suggestions.length-suggestions.filter(s=>s.facilityCandidate).length };
}

if(process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href){
  if(process.argv.length!==4) throw Error('Usage: node plan-local-candidates.mjs PRIVATE_INPUT.json PLAN.json');
  const input=JSON.parse(await readFile(process.argv[2],'utf8'));
  const output=planLocalCandidates(input);
  await writeFile(process.argv[3],JSON.stringify(output,null,2),{mode:0o600});
  console.log(JSON.stringify({candidates:output.matched,planned:output.planned.length,conflicts:output.conflicts.length,held:output.held}));
}