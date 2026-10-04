/** No phone call, no OpenAI voice session: exercise real dispatcher and specialist. */
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {getConfig} from '../src/config.js';
import {createBridgeMediaServer} from '../src/http.js';
import {secretarySupervisor} from '../src/secretarySupervisor.js';
const secret=randomBytes(32).toString('hex');
const config={...getConfig(),PORT:0,DRY_RUN_CALLS:true,BRIDGE_MEDIA_SHARED_SECRET:secret,};
const {server,agentCallRegistry}=createBridgeMediaServer(config);
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
const address=server.address() as any;
const dir=mkdtempSync(join(tmpdir(),'secretary-rehearsal-'));
writeFileSync(join(dir,'config.json'),JSON.stringify({url:`http://127.0.0.1:${address.port}`,stateDir:dir,signingKey:process.env.HOME+'/.codex/nwe-secretary-worker/signing-key.pem',ownerIds:['alex.gomez@newwaveendo.com']}),{mode:0o600});
const worker=spawn('/Users/nweassistant/.hermes/hermes-agent/venv/bin/python',['secretary-worker/worker.py','--config',join(dir,'config.json')],{stdio:['ignore','inherit','inherit'],env:{...process.env,NWE_CODEX_BIN:'/Users/nweassistant/.hermes/node/bin/codex'}});
const deadline=Date.now()+360_000;
try {
 while(!secretarySupervisor.available('alex.gomez@newwaveendo.com')) {if(Date.now()>deadline)throw Error('heartbeat timeout');await new Promise(r=>setTimeout(r,500));}
 const session:any=agentCallRegistry.create({to:'+15555550100',missionPrompt:'No dial rehearsal',agentEngine:'gpt-live-1',metadata:{agentProfile:'nwe_secretary',authenticatedOwnerId:'alex.gomez@newwaveendo.com'}});
 session.data.state='live';const events:any[]=[];
 session.agent={appendSupervisorResult:(event:any)=>{events.push(event);return true;},close:()=>{}};
 session.observeRemoteTranscript(process.argv[2] || 'Can you find Dr. Estape in Florida in the CRM? Read-only lookup; give the verified name and city, do not contact anyone.');
 session.flushRemoteUtterance();
 session.observeRemoteTranscript('Nice weather today.');session.flushRemoteUtterance();
 while(!events.some(e=>e.kind==='answer')) {if(Date.now()>deadline)throw Error('result timeout');await new Promise(r=>setTimeout(r,1000));}
 if (!secretarySupervisor.list(session.sessionId).some(j=>j.status==='completed' && j.result)) throw Error('worker failed');
 writeFileSync(join(dir,'result.json'),JSON.stringify({noDial:true,events,jobs:secretarySupervisor.list(session.sessionId)},null,2),{mode:0o600});
 console.log(JSON.stringify({rehearsal:'completed',noDial:true,eventKinds:events.map(e=>e.kind),artifact:join(dir,'result.json')}));
 await session.end('rehearsal_complete');
} finally {worker.kill('SIGTERM');server.close();}
