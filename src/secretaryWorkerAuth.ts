import {verify} from 'node:crypto';
import {secretaryWorkerPublicKey} from './secretaryWorkerPublicKey.js';
const seen=new Map<string,number>();
/** Signed exact payload with bounded clock skew and single-use nonce. No shared app credential. */
export function verifySecretaryWorker(body: unknown, now=Date.now(), publicKey=secretaryWorkerPublicKey): body is {payload:string;signature:string} {
  if (!body || typeof body!=='object') return false;
  const {payload,signature}=body as any;
  if (typeof payload!=='string' || payload.length>20000 || typeof signature!=='string') return false;
  let data;try{data=JSON.parse(payload);}catch{return false;}
  if (!Number.isFinite(data.timestamp) || Math.abs(now-data.timestamp)>30000 || typeof data.nonce!=='string' || data.nonce.length<20 || data.nonce.length>100) return false;
  for(const [key,at] of seen)if(now-at>60000)seen.delete(key);
  if(seen.has(data.nonce))return false;
  try{if(!verify(null,Buffer.from(payload),publicKey,Buffer.from(signature,'base64')))return false;}catch{return false;}
  seen.set(data.nonce,now);return true;
}
