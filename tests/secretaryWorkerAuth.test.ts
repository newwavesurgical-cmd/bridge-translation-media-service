import {describe,it,expect} from 'vitest';
import {generateKeyPairSync,sign,randomUUID} from 'node:crypto';
import {verifySecretaryWorker} from '../src/secretaryWorkerAuth.js';
it('accepts a signed payload once and rejects tampering, expiry and forged keys',()=>{
 const {publicKey,privateKey}=generateKeyPairSync('ed25519');
 const pub=publicKey.export({type:'spki',format:'pem'}).toString();
 const payload=JSON.stringify({timestamp:100000,nonce:randomUUID(),ownerIds:['alex']});
 const envelope={payload,signature:sign(null,Buffer.from(payload),privateKey).toString('base64')};
 expect(verifySecretaryWorker(envelope,140001,pub)).toBe(false);
 expect(verifySecretaryWorker({...envelope,payload:payload.replace('alex','other')},100000,pub)).toBe(false);
 expect(verifySecretaryWorker(envelope,100000)).toBe(false);
 expect(verifySecretaryWorker(envelope,100000,pub)).toBe(true);
 expect(verifySecretaryWorker(envelope,100000,pub)).toBe(false);
});
