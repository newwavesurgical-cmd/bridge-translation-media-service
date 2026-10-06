import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {createHash, timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {verifySecretaryWorker} from './secretaryWorkerAuth.js';
import type {AppConfig} from './config.js';
import {createRecordingAccess} from './twilio/recordings.js';

const id=z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/);
const recording=z.object({sid:z.string().regex(/^RE[a-fA-F0-9]{32}$/),durationSeconds:z.number().nullable().optional(),channels:z.number().nullable().optional()});
export const reportSchema=z.object({sessionId:id,ownerId:z.string().min(1).max(200),updatedAt:z.number().finite(),createdAt:z.string(),endedAt:z.string().optional(),state:z.string().max(80),title:z.string().max(300),summary:z.string().max(1000000),liveTranscript:z.string().max(3000000),audioTranscript:z.string().max(3000000),limitations:z.array(z.string().max(2000)).max(100),callSid:z.string().regex(/^CA[a-fA-F0-9]{32}$/).nullable().optional(),recordings:z.array(recording).max(100)});
type Report=z.infer<typeof reportSchema>;
const chunkSchema=z.object({ownerId:z.string().min(1).max(200),sessionId:id,hash:z.string().regex(/^[a-f0-9]{64}$/),index:z.number().int().min(0).max(999),total:z.number().int().min(1).max(1000),content:z.string().max(8000)});
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
export class SecretaryReportStore {
 constructor(private root=process.env.SECRETARY_REPORT_DIR || path.join(os.tmpdir(),'nwe-secretary-reports')){}
 private owner(owner:string){return path.join(this.root,sha(owner));}
 list(owner:string): Array<Report & {hash:string}> {
  const dir=this.owner(owner); if(!fs.existsSync(dir))return [];
  return fs.readdirSync(dir).filter(f=>f.endsWith('.json')).flatMap(f=>{
   try {const raw=fs.readFileSync(path.join(dir,f),'utf8');const r=reportSchema.parse(JSON.parse(raw));return r.ownerId===owner?[{...r,hash:sha(raw)}]:[];}catch{return [];}
  });
 }
 get(owner:string,sessionId:string){return this.list(owner).find(r=>r.sessionId===sessionId);}
 receive(input:unknown,owners:string[]){
  const c=chunkSchema.parse(input);if(!owners.includes(c.ownerId)||c.index>=c.total)throw new Error('invalid_report_scope');
  const dir=path.join(this.owner(c.ownerId),'pending',c.sessionId+'-'+c.hash);fs.mkdirSync(dir,{recursive:true,mode:0o700});
  fs.writeFileSync(path.join(dir,String(c.index)),c.content,{mode:0o600});
  if(!Array.from({length:c.total},(_,i)=>fs.existsSync(path.join(dir,String(i)))).every(Boolean))return false;
  const raw=Array.from({length:c.total},(_,i)=>fs.readFileSync(path.join(dir,String(i)),'utf8')).join('');
  if(Buffer.byteLength(raw)>8*1024*1024||sha(raw)!==c.hash)throw new Error('invalid_report_hash');
  const report=reportSchema.parse(JSON.parse(raw));
  if(report.ownerId!==c.ownerId||report.sessionId!==c.sessionId)throw new Error('invalid_report_scope');
  const current=this.get(c.ownerId,c.sessionId);
  if(!current||report.updatedAt>=current.updatedAt){
   const file=path.join(this.owner(c.ownerId),c.sessionId+'.json');
   fs.writeFileSync(file+'.tmp',raw,{mode:0o600});fs.renameSync(file+'.tmp',file);
  }
  fs.rmSync(dir,{recursive:true,force:true});return true;
 }
}
const store=new SecretaryReportStore();
function reply(res:http.ServerResponse,status:number,body:unknown){res.writeHead(status,{'content-type':'application/json','cache-control':'private, no-store'});res.end(JSON.stringify(body));}
function apiAuthorized(config:AppConfig,req:http.IncomingMessage){
 const key=config.BRIDGE_MEDIA_API_KEY;if(!key)return false;
 const actual=Buffer.from(req.headers.authorization||'');const expected=Buffer.from('Bearer '+key);
 return actual.length===expected.length&&timingSafeEqual(actual,expected);
}
export async function handleSecretaryReports(req:http.IncomingMessage,res:http.ServerResponse,url:URL,config:AppConfig){
 if(!url.pathname.startsWith('/secretary-reports'))return false;
 try {
  if(req.method==='POST'&&url.pathname==='/secretary-reports/worker'){
   const chunks:Buffer[]=[];let size=0;for await(const c of req){size+=c.length;if(size>100000)throw new Error('too_large');chunks.push(c);}
   const envelope=JSON.parse(Buffer.concat(chunks).toString());
   if(!verifySecretaryWorker(envelope)){reply(res,401,{error:'unauthorized'});return true;}
   const body=z.object({ownerIds:z.array(z.string().min(1).max(200)).min(1).max(10),chunk:chunkSchema.optional()}).parse(JSON.parse(envelope.payload));
   if(body.chunk)reply(res,200,{ok:true,complete:store.receive(body.chunk,body.ownerIds)});
   else reply(res,200,{reports:body.ownerIds.flatMap(owner=>store.list(owner).map(r=>({sessionId:r.sessionId,ownerId:owner,hash:r.hash})))});
   return true;
  }
  if(req.method!=='GET'||!apiAuthorized(config,req)){reply(res,401,{error:'unauthorized'});return true;}
  const owner=url.searchParams.get('ownerId')||'';if(!owner){reply(res,400,{error:'owner_required'});return true;}
  if(url.pathname==='/secretary-reports'){
   reply(res,200,{reports:store.list(owner).map(({sessionId,createdAt,endedAt,state,title,updatedAt,limitations})=>({sessionId,createdAt,endedAt,state,title,updatedAt,limitations})).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))});return true;
  }
  const parts=url.pathname.split('/');const report=store.get(owner,parts[2]||'');
  if(!report){reply(res,404,{error:'not_found'});return true;}
  if(parts.length===3){reply(res,200,report);return true;}
  if(parts[3]==='recording'&&report.callSid&&report.recordings.some(r=>r.sid===parts[4])){
   const audio=await createRecordingAccess(config).media(report.callSid,parts[4]!,'mp3');
   reply(res,200,{filename:parts[4]+'.mp3',audioBase64:audio.toString('base64')});return true;
  }
  reply(res,404,{error:'not_found'});return true;
 }catch{reply(res,400,{error:'report_request_failed'});return true;}
}
