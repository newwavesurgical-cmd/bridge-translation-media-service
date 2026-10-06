import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const runFile=promisify(execFile);
import twilio from 'twilio';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AgentCallRecord } from './agentCallRegistry.js';
import type { AppConfig } from './config.js';
import { createRecordingAccess } from './twilio/recordings.js';

export function postCallSnapshot(r: AgentCallRecord) {
  if (!['nwe_secretary','nwe-secretary'].includes(String(r.metadata?.agentProfile))) return null;
  const ownerId = String(r.metadata?.authenticatedOwnerId ?? '');
  if (!ownerId) return null;
  return { sessionId:r.sessionId, ownerId, callSid:r.callSid, to:r.to, targetName:r.targetName,
    createdAt:r.createdAt, endedAt:r.endedAt, endedReason:r.endedReason, state:r.state,
    transcripts:r.transcripts, provenance:'bridge_live_transcript', transcriptComplete:true };
}
export type PostCallRecord = NonNullable<ReturnType<typeof postCallSnapshot>>;
/** Private local spool; the Mac worker mirrors it durably. No public media URLs. */
export class SecretaryPostCalls {
  constructor(private root=process.env.SECRETARY_POST_CALL_DIR || path.join(os.tmpdir(),'nwe-secretary-post-calls')) {}
  private file(id:string) { if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id)) throw new Error('invalid_session'); return path.join(this.root,id+'.json'); }
  save(record:PostCallRecord) {
    fs.mkdirSync(this.root,{recursive:true,mode:0o700});
    const file=this.file(record.sessionId);
    if(fs.existsSync(file) && JSON.parse(fs.readFileSync(file,'utf8')).ownerId!==record.ownerId) throw new Error('post_call_owner_mismatch');
    fs.writeFileSync(file+'.tmp',JSON.stringify(record),{mode:0o600}); fs.renameSync(file+'.tmp',file);
  }
  list(owners:string[]) {
    if (!fs.existsSync(this.root)) return [];
    return fs.readdirSync(this.root).filter(f=>f.endsWith('.json')).flatMap(f=>{
      try { const r=JSON.parse(fs.readFileSync(path.join(this.root,f),'utf8')) as PostCallRecord; return owners.includes(r.ownerId)?[r]:[]; } catch { return []; }
    });
  }
  get(id:string,owners:string[]) { const r=this.list(owners).find(r=>r.sessionId===id); if (!r) throw new Error('post_call_not_found'); return r; }
  async recording(config:AppConfig,id:string,owners:string[],media=false) {
    const r=this.get(id,owners); if (!r.callSid || !['ended','error'].includes(r.state)) return {status:'waiting', recordings:[]};
    const api=createRecordingAccess(config); const recordings=await api.list(r.callSid);
    // Preserve every recording if a provider ever splits a call.
    const ready=recordings.filter(x=>x.status==='completed');
    return {status:ready.length?'available':'processing', recordings:await Promise.all(ready.map(async x=>({...x,
      ...(media?{audioBase64:(await api.media(r.callSid!,x.sid,'mp3')).toString('base64')}:{} )}))) };
  }
  async recover(config:AppConfig,input:{sessionId:string;callSid:string;ownerId:string;to:string},owners:string[]) {
    if(!owners.includes(input.ownerId)) throw new Error('post_call_not_found');
    const user=config.TWILIO_API_KEY_SID || config.TWILIO_ACCOUNT_SID;
    const password=config.TWILIO_API_KEY_SID?config.TWILIO_API_KEY_SECRET:config.TWILIO_AUTH_TOKEN;
    const call=await twilio(user,password,{accountSid:config.TWILIO_ACCOUNT_SID,timeout:15000}).calls(input.callSid).fetch();
    if(call.accountSid!==config.TWILIO_ACCOUNT_SID || call.to!==input.to || !['completed','failed','busy','no-answer','canceled'].includes(call.status)) throw new Error('recovery_call_mismatch');
    const existing=this.list(owners).find(r=>r.sessionId===input.sessionId);
    if(existing) return existing;
    const record={sessionId:input.sessionId,ownerId:input.ownerId,callSid:input.callSid,to:input.to,targetName:undefined,createdAt:call.startTime?.toISOString()||call.dateCreated.toISOString(),endedAt:call.endTime?.toISOString(),endedReason:'recovered_'+call.status,state:'ended' as const,transcripts:[],provenance:'provider_verified_recovery_audio; live transcript unavailable',transcriptComplete:false};
    this.save(record);return record;
  }
  private pending=new Map<string,Promise<unknown>>();
  async transcribe(config:AppConfig,id:string,owners:string[]) {
    const r=this.get(id,owners); if (!r.callSid || !['ended','error'].includes(r.state)) throw new Error('call_not_ended');
    const cache=this.file(id)+'.diarized';
    if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache,'utf8'));
    if(this.pending.has(id)) return this.pending.get(id);
    const task=(async()=>{
      const api=createRecordingAccess(config); const rows=(await api.list(r.callSid!)).filter(x=>x.status==='completed');
      if(!rows.length) throw new Error('recording_not_ready');
      const results=[];
      for(const row of rows) {
        const audio=await api.media(r.callSid!,row.sid,'mp3');
        const parts:Array<{audio:Buffer;offset:number;index:number}>=[];
        if(audio.length<=24_000_000) parts.push({audio,offset:0,index:0});
        else {
          const chunkDir=this.file(id)+'.'+row.sid+'.chunks'; fs.mkdirSync(chunkDir,{recursive:true,mode:0o700});
          const source=path.join(chunkDir,'source.mp3');fs.writeFileSync(source,audio,{mode:0o600});
          await runFile('ffmpeg',['-v','error','-y','-i',source,'-ac','1','-ar','16000','-c:a','pcm_s16le','-f','segment','-segment_time','600','-reset_timestamps','1',path.join(chunkDir,'part-%05d.wav')],{timeout:600000});
          let offset=0;
          for(const file of fs.readdirSync(chunkDir).filter(x=>/^part-[0-9]+\.wav$/.test(x)).sort()) {
            const full=path.join(chunkDir,file);fs.chmodSync(full,0o600);
            const probe=await runFile('ffprobe',['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',full]);
            parts.push({audio:fs.readFileSync(full),offset,index:parts.length+1});offset+=Number(probe.stdout.trim());
          }
          if(!parts.length) throw new Error('audio_chunking_failed');
        }
        const segments:unknown[]=[];
        for(const part of parts) {
          if(part.audio.length>25_000_000) throw new Error('audio_chunk_exceeds_limit');
          const partCache=this.file(id)+'.'+row.sid+'.'+part.index+'.transcript';
          let raw:any;
          if(fs.existsSync(partCache)) raw=JSON.parse(fs.readFileSync(partCache,'utf8'));
          else {
            const form=new FormData(); form.append('file',new Blob([new Uint8Array(part.audio)],{type:part.index?'audio/wav':'audio/mpeg'}),part.index?'part.wav':'call.mp3');
            form.append('model','gpt-4o-transcribe-diarize'); form.append('response_format','diarized_json'); form.append('chunking_strategy','auto');
            const response=await fetch('https://api.openai.com/v1/audio/transcriptions',{method:'POST',headers:{Authorization:`Bearer ${config.OPENAI_API_KEY}`},body:form,signal:AbortSignal.timeout(600000)});
            if(!response.ok) throw new Error(`diarization_http_${response.status}`);
            raw=await response.json(); if(!Array.isArray(raw.segments)) throw new Error('diarized_segments_missing');
            fs.writeFileSync(partCache,JSON.stringify(raw),{mode:0o600});
          }
          segments.push(...raw.segments.map((x:any)=>({...x,start:x.start+part.offset,end:x.end+part.offset,speaker:part.index?`chunk${part.index}:${x.speaker}`:x.speaker})));
        }
        results.push({recordingSid:row.sid,durationSeconds:row.durationSeconds,channels:row.channels,chunks:parts.length,speakerContinuity:parts.length>1?'chunk-local; do not infer cross-chunk identity':'whole-recording clusters',transcript:{segments}});
      }
      const result={model:'gpt-4o-transcribe-diarize',speakerIdentity:'anonymous; labels are not verified names',recordings:results};
      fs.writeFileSync(cache,JSON.stringify(result),{mode:0o600}); return result;
    })();
    this.pending.set(id,task); try{return await task;} finally{this.pending.delete(id);}
  }
}
export const secretaryPostCalls=new SecretaryPostCalls();
