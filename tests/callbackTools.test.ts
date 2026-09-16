import { describe, expect, it, vi } from 'vitest';
import { callbackEnabled, callbackExecutor } from '../src/callbackTools.js';
import { crmInterviewInstructions, crmStartSchema } from '../src/crmVoice.js';
import { LiveFunctionDispatcher } from '../src/openai/liveFunctionTools.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
const request = crmStartSchema.parse({ sessionId, idempotencyKey: 'synthetic:callback:1', to: '+15555550123',
  missionPrompt: 'Continue the requested business discussion.', reportPeriod: 'custom' });
describe('callback tools authority and lifecycle', () => {
  it('anchors callback relative dates to the current call while other missions stay unchanged', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-16T04:22:00Z'));
      const callback = crmInterviewInstructions(request, undefined, true);
      expect(callback).toContain('2026-09-16T04:22:00.000Z');
      expect(crmInterviewInstructions(request)).not.toContain('2026-09-16T04:22:00.000Z');
      vi.setSystemTime(new Date('2026-09-17T04:22:00Z'));
      expect(crmInterviewInstructions(request, undefined, true)).toContain('2026-09-17T04:22:00.000Z');
      expect(crmInterviewInstructions({...request, reportPeriod:'weekly'}, undefined, true))
        .not.toContain('2026-09-17T04:22:00.000Z');
    } finally { vi.useRealTimers(); }
  });
  it('preserves contact field evidence and does not turn an upstream error into an empty search', async () => {
    const card = {ok:true, contacts:[{id:sessionId, full_name:'Synthetic Surgeon',
      procedure_volume:67, notes_summary:null, mclose_status:'champion'}]};
    const execute=callbackExecutor(sessionId,async()=>({toolResult:card}),()=>false,async()=>true);
    expect(await execute('search_callback_crm',{query:'Synthetic Surgeon annual procedure volume'},'call_card')).toEqual(card);
    for (const volume of [0,null]) {
      card.contacts[0].procedure_volume=volume as any;
      expect(await execute('search_callback_crm',{query:'Synthetic Surgeon'},'call_card_next')).toEqual(card);
    }
    const failed=callbackExecutor(sessionId,async()=>{throw new Error('database unavailable');},()=>false,async()=>true);
    const result=await failed('search_callback_crm',{query:'Synthetic Surgeon'},'call_failed');
    expect(result).toMatchObject({ok:false,error:'callback_tool_unavailable'});
    expect(result).not.toHaveProperty('contacts');
  });
  it('requires affirmative server capability and never probes review/check-in missions', async () => {
    const store = vi.fn(async () => ({ callbackCapabilities: { enabled: true, protocolVersion:2 } }));
    for (const excluded of [{...request, reportPeriod: 'weekly'}, {...request, reportPeriod: 'monthly'}, {...request, reviewContext: {}}])
      expect(await callbackEnabled(excluded, store)).toBe(false);
    expect(store).not.toHaveBeenCalled();
    expect(await callbackEnabled(request, store)).toBe(true);
    expect(store).toHaveBeenCalledWith({action:'callback_capabilities', sessionId});
    expect(await callbackEnabled(request, async () => ({}))).toBe(false);
    expect(await callbackEnabled(request, async () => ({callbackCapabilities:{enabled:true}}))).toBe(false);
    expect(await callbackEnabled(request, async () => ({callbackCapabilities:{enabled:'true'}}))).toBe(false);
    expect(await callbackEnabled(request, async () => {throw new Error('unavailable');})).toBe(false);
  });
  it('rejects destinations, identities, unknown tools and malformed requests before network', async () => {
    const store = vi.fn(); const execute = callbackExecutor(sessionId, store, () => false, async () => true);
    for (const [name, args, id] of [
      ['search_callback_crm', {query:'clinic', userId:'other'}, 'call_1'],
      ['save_callback_followup', {question:'school?', delivery:'call', consentQuote:'yes', phone:'+15555550124'}, 'call_2'],
      ['save_callback_followup', {question:'school?', delivery:'call', consentQuote:''}, 'call_3'],
      ['get_callback_task', {taskId:'bad'}, 'call_4'],
      ['run_sql', {query:'select all'}, 'call_5'],
      ['search_callback_crm', {query:'clinic'}, undefined],
    ] as const) expect(await execute(name, args, id)).toMatchObject({ok:false});
    expect(store).not.toHaveBeenCalled();
  });
  it('flushes caller transcript before saving and preserves durable receipt and request ID', async () => {
    const order: string[] = [];
    const receipt = {ok:true, taskId:sessionId, status:'queued',consentVerified:true};
    const store = vi.fn(async () => {order.push('save'); return {toolResult:receipt};});
    const execute = callbackExecutor(sessionId, store, () => false, async () => {order.push('flush'); return true;});
    const args = {question:'Find public education history', delivery:'call', consentQuote:'Yes, call me with that.'};
    expect(await execute('save_callback_followup', args, 'call_123')).toEqual(receipt);
    expect(order).toEqual(['flush','save']);
    expect(store).toHaveBeenCalledWith({action:'callback_tool',sessionId,requestId:'call_123',tool:'save_callback_followup',arguments:args});
    const noTranscript = callbackExecutor(sessionId, store, () => false, async () => false);
    expect(await noTranscript('save_callback_followup', args, 'call_124')).toMatchObject({ok:false});
    expect(store).toHaveBeenCalledTimes(1);
  });
  it('keeps durable server work but discards results after hangup; refuses new work', async () => {
    let ended = false; let resolve!: (value:any)=>void;
    const store = vi.fn(() => new Promise<any>(r=>{resolve=r;}));
    const execute = callbackExecutor(sessionId, store, () => ended, async () => true);
    const pending = execute('research_callback_question', {question:'Public hospital location?'}, 'call_slow');
    ended = true; resolve({toolResult:{ok:true, answer:'Found it'}});
    expect(await pending).toMatchObject({ok:false});
    expect(await execute('search_callback_crm',{query:'clinic'},'call_after')).toMatchObject({ok:false});
    expect(store).toHaveBeenCalledTimes(1);
  });
  it('never turns a timeout, malformed result or oversized response into a promise', async () => {
    for (const store of [async()=>{throw new Error('timeout');}, async()=>({}),
      async()=>({toolResult:{answer:'x'.repeat(25000)}})]) {
      const execute = callbackExecutor(sessionId, store, () => false, async () => true);
      expect(await execute('search_callback_crm',{query:'clinic'},'call_error')).toMatchObject({ok:false});
    }
  });
  it('returns background research to the live call without launching another job', async () => {
    const store=vi.fn().mockResolvedValueOnce({toolResult:{taskId:sessionId,status:'pending'}})
      .mockResolvedValueOnce({toolResult:{taskId:sessionId,status:'running'}})
      .mockResolvedValueOnce({toolResult:{taskId:sessionId,status:'ready',answer:'Cited public result'}});
    const execute=callbackExecutor(sessionId,store,()=>false,async()=>true,async()=>{});
    expect(await execute('research_callback_question',{question:'Public hospital address?'},'call_background'))
      .toMatchObject({status:'ready',answer:'Cited public result'});
    expect(store.mock.calls.map(([body])=>body.tool)).toEqual(['research_callback_question','get_callback_task','get_callback_task']);
    expect(store.mock.calls[1][0].arguments).toEqual({taskId:sessionId});
  });
  it('requires a verified-consent receipt before confirming delivery', async () => {
    const execute=callbackExecutor(sessionId,async()=>({toolResult:{status:'saved',taskId:sessionId,consentVerified:false}}),()=>false,async()=>true);
    expect(await execute('save_callback_followup',{question:'Find the address',delivery:'call',consentQuote:'Call me with that.'},'call_consent'))
      .toMatchObject({ok:false});
  });
  it('passes provider function call ID to executor and suppresses closed-call output', async () => {
    let resolve!: (value:unknown)=>void;
    const execute = vi.fn(() => new Promise(r=>{resolve=r;})); const send = vi.fn();
    const dispatcher = new LiveFunctionDispatcher(send, execute);
    const accept = (event:unknown) => dispatcher.accept({type:'response.event',delegation_id:'d',event});
    accept({type:'response.created',response:{id:'r'}});
    const item={type:'function_call',name:'search_callback_crm',call_id:'call_stable',arguments:'{"query":"clinic"}'};
    accept({type:'response.output_item.done',item});
    accept({type:'response.output_item.done',item});
    accept({type:'response.completed',response:{id:'r'}});
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith('search_callback_crm',{query:'clinic'},'call_stable');
    dispatcher.close(); resolve({ok:true}); await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
  });
  it('changes only callback scope and never enables tools by prompt text', () => {
    expect(crmInterviewInstructions(request)).toContain('No research or follow-up delivery tools');
    expect(crmInterviewInstructions(request, undefined, true)).toContain('search_callback_crm');
    const weekly={...request,reportPeriod:'weekly' as const};
    expect(crmInterviewInstructions(weekly, undefined, true)).toBe(crmInterviewInstructions(weekly));
  });
});
