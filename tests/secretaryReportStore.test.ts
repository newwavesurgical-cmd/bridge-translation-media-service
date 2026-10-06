import {it,expect} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import {SecretaryReportStore} from '../src/secretaryReportStore.js';
it('publishes only complete matching signed-worker content, isolates owners and rejects stale replacement',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'reports-test-'));const store=new SecretaryReportStore(root);
 const report={sessionId:'agent_test',ownerId:'alice',updatedAt:200,createdAt:'2026-10-06',state:'complete',title:'Call',summary:'<script>untrusted</script>',liveTranscript:'entire source',audioTranscript:'speaker 1',limitations:[],recordings:[]};
 const raw=JSON.stringify(report);const hash=createHash('sha256').update(raw).digest('hex');
 const a={ownerId:'alice',sessionId:'agent_test',hash,total:2,index:0,content:raw.slice(0,50)};
 try{
  expect(()=>store.receive(a,['bob'])).toThrow('invalid_report_scope');
  expect(store.receive(a,['alice'])).toBe(false);expect(store.get('alice','agent_test')).toBeUndefined();
  expect(store.receive({...a,index:1,content:raw.slice(50)},['alice'])).toBe(true);
  expect(store.get('alice','agent_test')?.summary).toBe(report.summary);expect(store.list('bob')).toEqual([]);
  const older=JSON.stringify({...report,updatedAt:100,summary:'stale'});
  store.receive({...a,total:1,index:0,hash:createHash('sha256').update(older).digest('hex'),content:older},['alice']);
  expect(new SecretaryReportStore(root).get('alice','agent_test')?.updatedAt).toBe(200);
  expect(()=>store.receive({...a,sessionId:'../escape'},['alice'])).toThrow();
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
