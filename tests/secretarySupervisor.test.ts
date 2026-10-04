import {describe,it,expect} from 'vitest';
import {SecretarySupervisor} from '../src/secretarySupervisor.js';
describe('secretary asynchronous jobs', () => {
  it('requires fresh authenticated owner enrollment and deduplicates utterances', () => {
    let now=100; const q=new SecretarySupervisor(()=>now);
    expect(q.enqueue('s','alex',1,'CRM')).toBeNull();
    q.heartbeat(['alex']);
    expect(q.enqueue('s','stranger',1,'CRM')).toBeNull();
    const j=q.enqueue('s','alex',1,'CRM')!;
    expect(q.enqueue('s','alex',1,'CRM')?.id).toBe(j.id);
    now+=30001; expect(q.enqueue('s','alex',2,'sales')).toBeNull();
  });
  it('does not announce acceptance until routed and preserves results during unrelated conversation', () => {
    const q=new SecretarySupervisor(()=>100);q.heartbeat(['alex']);
    const a=q.enqueue('s','alex',1,'sales')!;
    expect(q.claim(['alex'])?.status).toBe('claimed');
    q.accept(a.id);q.enqueue('s','alex',2,'nice weather');
    expect(q.complete(a.id,'completed','verified report')?.result).toBe('verified report');
    expect(q.complete(a.id,'completed','verified report')?.id).toBe(a.id);
    expect(q.complete(a.id,'completed','different')).toBeNull();
  });
  it('never reclaims or publishes cancelled work and isolates sessions', () => {
    const q=new SecretarySupervisor(()=>100);q.heartbeat(['alex']);
    const a=q.enqueue('s','alex',1,'sales')!;q.claim(['alex']);q.accept(a.id);
    q.enqueue('other','alex',1,'CRM');q.cancel('s');
    expect(q.complete(a.id,'completed','late')).toBeNull();
    expect(q.claim(['alex'])?.sessionId).toBe('other');
    expect(q.claim(['alex'])).toBeNull();
  });
});
