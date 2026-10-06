import {describe,it,expect} from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import {SecretaryPostCalls,postCallSnapshot} from '../src/secretaryPostCall.js';
import type {AgentCallRecord} from '../src/agentCallRegistry.js';
describe('secretary private post-call archive',()=>{
 it('excludes generic profiles and missing owners',()=>{
   expect(postCallSnapshot({metadata:{agentProfile:'generic'}} as AgentCallRecord)).toBeNull();
   expect(postCallSnapshot({metadata:{agentProfile:'nwe_secretary'}} as AgentCallRecord)).toBeNull();
 });
 it('preserves all transcript entries, scopes owners, survives instance restart and rejects traversal',()=>{
   const root=fs.mkdtempSync(path.join(os.tmpdir(),'post-call-test-'));
   try {
    const store=new SecretaryPostCalls(root);
    const snapshot=postCallSnapshot({sessionId:'agent_test',callSid:null,metadata:{agentProfile:'nwe_secretary',authenticatedOwnerId:'alice'},transcripts:Array.from({length:1400},(_,i)=>({at:String(i),speaker:'remote',delta:'line '+i})),state:'ended'} as unknown as AgentCallRecord)!;
    store.save(snapshot);
    expect(new SecretaryPostCalls(root).get('agent_test',['alice']).transcripts).toHaveLength(1400);
    expect(store.list(['bob'])).toEqual([]);
    expect(()=>store.get('agent_test',['bob'])).toThrow('post_call_not_found');
    expect(()=>store.save({...snapshot,sessionId:'../escape'})).toThrow('invalid_session');
   } finally {fs.rmSync(root,{recursive:true,force:true});}
 });
});
