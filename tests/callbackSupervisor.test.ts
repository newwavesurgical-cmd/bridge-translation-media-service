import { describe,it,expect,vi,afterEach } from 'vitest';
import { CallbackSupervisor, supervisorEnabled } from '../src/callbackSupervisor.js';
import type { Store } from '../src/crmVoice.js';
afterEach(()=>vi.useRealTimers());
function setup(mode='live') {
 let revision=1; let rows:any[]=[];
 const store=vi.fn<Store>(async body=>body.action==='supervisor_results'?{supervisorMode:mode,supervisorResults:rows}:body.action==='supervisor_observe'?{supervisorResult:{accepted:true}}:{toolResult:{status:'confirmed'}});
 const deliver=vi.fn(()=>true);const flush=vi.fn(async()=>true);
 const supervisor=new CallbackSupervisor('session',store,flush,()=>revision,deliver);
 return {supervisor,store,deliver,flush,setRevision:(n:number)=>{revision=n;},setRows:(r:any[])=>{rows=r;}};
}
describe('callback supervisor isolation and lifecycle',()=>{
 it('fails closed without current owner capabilities',async()=>{
  const store=vi.fn(async()=>({supervisorCapabilities:{enabled:true,protocolVersion:1,mode:'live',workerReady:false}}));
  expect(await supervisorEnabled(false,'s',store)).toBe(false);expect(store).not.toHaveBeenCalled();
  expect(await supervisorEnabled(true,'s',store)).toBe(false);
 });
 it('coalesces transcript fragments after a settled turn and flushes first',async()=>{
  vi.useFakeTimers();const s=setup();s.supervisor.remote();s.setRevision(2);s.supervisor.remote();
  await vi.advanceTimersByTimeAsync(1999);expect(s.flush).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);expect(s.store).toHaveBeenCalledWith({action:'supervisor_observe',sessionId:'session',revision:2});s.supervisor.close();
 });
 it('suppresses stale answers after caller corrections',async()=>{
  const s=setup();s.setRows([{id:'1',revision:1,kind:'answer',text:'old fact'}]);s.setRevision(2);s.supervisor.remote();
  await s.supervisor.poll();expect(s.deliver).not.toHaveBeenCalled();expect(s.store).toHaveBeenCalledWith(expect.objectContaining({delivery:'suppressed'}));s.supervisor.close();
 });
 it('shadow records results without speech',async()=>{
  const s=setup('shadow');s.setRows([{id:'1',revision:1,kind:'answer',text:'fact'}]);await s.supervisor.poll();expect(s.deliver).not.toHaveBeenCalled();s.supervisor.close();
 });
 it('waits for a natural pause and does not replay a submitted answer',async()=>{
  vi.useFakeTimers();const s=setup();s.setRows([{id:'1',revision:1,kind:'answer',text:'fact'}]);s.supervisor.audio();
  await s.supervisor.poll();expect(s.deliver).not.toHaveBeenCalled();await vi.advanceTimersByTimeAsync(1000);
  await s.supervisor.poll();await s.supervisor.poll();expect(s.deliver).toHaveBeenCalledTimes(1);s.supervisor.close();
 });
 it('does not deliver after hangup during an outstanding network response',async()=>{
  let resolve!:(x:any)=>void;const deliver=vi.fn(()=>true);const s=new CallbackSupervisor('s',()=>new Promise(r=>{resolve=r;}),async()=>true,()=>1,deliver);
  const pending=s.poll();s.close();resolve({supervisorMode:'live',supervisorResults:[{id:'1',revision:1,kind:'answer',text:'fact'}]});await pending;expect(deliver).not.toHaveBeenCalled();
 });
 it('requires transcript persistence before confirming and never confirms after end',async()=>{
  const s=setup();s.flush.mockResolvedValue(false);
  const args={actionId:'11111111-1111-4111-8111-111111111111',consentQuote:'yes send it'};
  expect(await s.supervisor.confirm(args,'call_1')).toMatchObject({ok:false});expect(s.store).not.toHaveBeenCalled();s.supervisor.close();
  expect(await s.supervisor.confirm(args,'call_2')).toMatchObject({ok:false});
 });
 it('preserves completion receipts across topic changes',async()=>{
  const s=setup();s.setRows([{id:'1',revision:1,kind:'action_result',text:'Saved'}]);await s.supervisor.poll();expect(s.deliver).toHaveBeenCalledOnce();s.supervisor.close();
 });
});
