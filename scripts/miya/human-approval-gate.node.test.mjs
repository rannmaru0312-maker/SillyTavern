import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateHumanHandoff } from './human-approval-gate.mjs';

const sha = 'a'.repeat(40);
const valid = () => ({sourceSha:sha,checksPassed:true,reviewPassed:true,targetBranch:'miya-ai-dev',
    paidBudgetUsd:0,allowProduction:false,autoMerge:false,
    approval:{decision:'approve-next-task',sourceSha:sha,actorType:'human',actor:'repository-owner'}});
test('matching human approval permits scheduling next task but never launches it',()=>{
    assert.deepEqual(evaluateHumanHandoff(valid()),{approvedForNextTask:true,reason:'human-approved',taskLaunchAuthorized:false});
});
for(const [name,mutate,reason] of [
    ['no approval',x=>{delete x.approval;},'human-approval-required'],
    ['AI approval',x=>{x.approval.actorType='bot';},'human-approval-required'],
    ['stale approval',x=>{x.approval.sourceSha='b'.repeat(40);},'human-approval-required'],
    ['rejected',x=>{x.approval.rejected=true;},'human-approval-required'],
    ['failed tests',x=>{x.checksPassed=false;},'verification-incomplete'],
    ['no review',x=>{x.reviewPassed=false;},'verification-incomplete'],
    ['release target',x=>{x.targetBranch='release';},'invalid-target'],
    ['paid usage',x=>{x.paidBudgetUsd=1;},'unsafe-permissions'],
    ['production',x=>{x.allowProduction=true;},'unsafe-permissions'],
    ['auto merge',x=>{x.autoMerge=true;},'unsafe-permissions'],
]){
    test('blocks '+name,()=>{const data=valid();mutate(data);assert.equal(evaluateHumanHandoff(data).reason,reason);});
}
