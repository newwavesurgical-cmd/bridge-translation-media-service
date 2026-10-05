import {describe,it,expect} from 'vitest';
import {SecretaryWebRegistry} from './secretaryWeb.js';
import {secretarySupervisor} from './secretarySupervisor.js';
const id='52f32b8e-bb61-4db5-b0a7-e6c822d562fa';
describe('web secretary owner-scoped supervision',()=>{
 it('rejects another owner and unknown sessions',()=>{const r=new SecretaryWebRegistry();r.handle('a',{action:'open',sessionId:id});expect(()=>r.handle('b',{action:'poll',sessionId:id})).toThrow('web_forbidden');});
 it('deduplicates transcript events and requests',()=>{const r=new SecretaryWebRegistry();secretarySupervisor.heartbeat(['a']);r.handle('a',{action:'open',sessionId:id});const f={id:'event',role:'user' as const,text:'What are sales?',start:0,end:1000};r.handle('a',{action:'observe',sessionId:id,fragments:[f,f]});expect(r.inspect(id)[0].transcript).toHaveLength(1);r.handle('a',{action:'request',sessionId:id,requestId:'req',text:'What are sales?'});const result=r.handle('a',{action:'request',sessionId:id,requestId:'req',text:'What are sales?'});expect(result.jobs).toHaveLength(1);});
 it('closed sessions reject new work',()=>{const r=new SecretaryWebRegistry();r.handle('a',{action:'open',sessionId:id});r.handle('a',{action:'close',sessionId:id});expect(()=>r.handle('a',{action:'request',sessionId:id,requestId:'new',text:'Email me'})).toThrow('web_closed');expect(r.control(id,'say hello')).toBeNull();});
 it('guest requests explicitly restrict external actions',()=>{const r=new SecretaryWebRegistry();secretarySupervisor.heartbeat(['guest-test']);const sid='6a2f3278-a2d4-48c8-b93e-33552c2f4891';r.handle('guest-test',{action:'open',sessionId:sid});const result=r.handle('guest-test',{action:'request',sessionId:sid,requestId:'one',text:'Email the chart',guest:true});expect(result.jobs[0].text).toMatch(/^GUEST REQUEST:/);});
});
