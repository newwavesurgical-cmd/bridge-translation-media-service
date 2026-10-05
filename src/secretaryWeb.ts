import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { secretarySupervisor, secretaryInstructions } from './secretarySupervisor.js';
const AUTH_URL = 'https://rugdrytrgsabbtfhsqsa.supabase.co';
const PUBLIC_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ1Z2RyeXRyZ3NhYmJ0ZmhzcXNhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAwNjMwNjYsImV4cCI6MjA5NTYzOTA2Nn0.KTx4JlgDxor9WLkzz0yCz80JMNciMmcdav-TwkWltj0";
const tokenCache = new Map<string, { owner: string; until: number }>();
export async function secretaryWebOwner(req: IncomingMessage): Promise<string> {
  const bearer = req.headers.authorization ?? '';
  if (!bearer.startsWith('Bearer ')) throw new Error('web_unauthorized');
  const cached = tokenCache.get(bearer);
  if (cached && cached.until > Date.now()) return cached.owner;
  const headers = { apikey: PUBLIC_KEY, Authorization: bearer, 'Content-Type': 'application/json' };
  const userResponse = await fetch(AUTH_URL + '/auth/v1/user', { headers, signal: AbortSignal.timeout(8000) });
  if (!userResponse.ok) throw new Error('web_unauthorized');
  const user = await userResponse.json() as { id?: string; email?: string };
  if (!user.id || !user.email) throw new Error('web_unauthorized');
  const role = await fetch(AUTH_URL + '/rest/v1/rpc/has_role', { method: 'POST', headers, body: JSON.stringify({ _user_id: user.id, _role: 'admin' }), signal: AbortSignal.timeout(8000) });
  if (!role.ok || await role.json() !== true) throw new Error('web_forbidden');
  if (tokenCache.size > 50) tokenCache.clear();
  tokenCache.set(bearer, { owner: user.email.toLowerCase(), until: Date.now() + 15000 });
  return user.email.toLowerCase();
}
const fragment = z.object({ id: z.string().max(160), role: z.enum(['user','assistant']), text: z.string().max(2000), start: z.number(), end: z.number() });
export const webSchema = z.object({
 action: z.enum(['open','observe','request','poll','close']), sessionId: z.string().uuid(),
 fragments: z.array(fragment).max(100).optional(), requestId: z.string().max(160).optional(), text: z.string().max(6000).optional(), guest: z.boolean().optional(),
});
type WebSession = { id: string; owner: string; lastSeen: number; closed: boolean; transcript: z.infer<typeof fragment>[]; seen: Set<string>; requests: Map<string,number>; controls: {id:string;text:string}[] };
export class SecretaryWebRegistry {
 sessions = new Map<string,WebSession>();
 handle(owner: string, body: z.infer<typeof webSchema>) {
  if (body.action === 'open' && !this.sessions.has(body.sessionId)) {
   for (const [id,s] of this.sessions) if (Date.now()-s.lastSeen > 3600000) this.sessions.delete(id);
   if(this.sessions.size >= 100) throw new Error('web_capacity');
   this.sessions.set(body.sessionId,{ id:body.sessionId,owner,lastSeen:Date.now(),closed:false,transcript:[],seen:new Set(),requests:new Map(),controls:[] });
  }
  const s=this.sessions.get(body.sessionId);
  if(!s || s.owner!==owner) throw new Error('web_forbidden');
  if(s.closed && body.action!=='poll' && body.action!=='close') throw new Error('web_closed');
  s.lastSeen=Date.now();
  for(const f of body.fragments ?? []) if(!s.seen.has(f.id)) {s.seen.add(f.id);s.transcript.push(f);}
  if(s.transcript.length>5000) s.transcript.splice(0,s.transcript.length-5000);
  if(body.action==='request') {
   if(!body.requestId || !body.text?.trim()) throw new Error('web_missing_request');
   const duplicate=secretarySupervisor.list('web_'+s.id).find(j=>j.text===body.text && j.status!=='failed' && j.status!=='cancelled');
   if(duplicate) s.requests.set(body.requestId,duplicate.utteranceId);
   let n=s.requests.get(body.requestId);
   if(n===undefined) {n=s.requests.size+1;s.requests.set(body.requestId,n);}
   const text=(body.guest ? 'GUEST REQUEST: Read-only research only. Never send emails or modify external systems from a guest request; return an owner-approval proposal.\n' : '') + body.text;
   secretarySupervisor.enqueue('web_'+s.id,owner,n,text);
  }
  if(body.action==='close') s.closed=true;
  return {ok:true,closed:s.closed, capability:secretarySupervisor.signal(owner),jobs:secretarySupervisor.list('web_'+s.id),controls:s.controls,instructions:secretaryInstructions('Speak English unless Alex requests another language.')};
 }
 inspect(id?:string) { return [...this.sessions.values()].filter(s=>!id||s.id===id).map(s=>({id:s.id,owner:s.owner,closed:s.closed,lastSeen:s.lastSeen,transcript:s.transcript,jobs:secretarySupervisor.list('web_'+s.id)})); }
 control(id:string,text:string) {const s=this.sessions.get(id); if(!s||s.closed)return null;const control={id:randomUUID(),text};s.controls.push(control);return control;}
}
export const secretaryWeb = new SecretaryWebRegistry();
