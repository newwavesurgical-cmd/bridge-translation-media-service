"""Mirror private call reports into authenticated Bridge history. Never sends email."""
import asyncio
import base64
import hashlib
import json
from pathlib import Path
import secrets
import time
import urllib.request


def build_report(folder):
    folder=Path(folder)
    source=json.loads((folder/'live-transcript.json').read_text())
    journal=json.loads((folder/'processing.json').read_text()) if (folder/'processing.json').exists() else {'state':'capturing'}
    evidence=json.loads((folder/'analysis-evidence.json').read_text()) if (folder/'analysis-evidence.json').exists() else {}
    summary=(folder/'executive-summary.txt').read_text() if (folder/'executive-summary.txt').exists() else ''
    audio=(folder/'audio-transcript.json').read_text() if (folder/'audio-transcript.json').exists() else ''
    live='\n'.join(f"{line.get('at','')} [{line.get('speaker','unknown')}] {line.get('delta','')}" for line in source.get('transcripts',[]))
    if (folder/'recovered-ui-captions.txt').exists(): live+='\n\nRecovered caption evidence (may be partial):\n'+(folder/'recovered-ui-captions.txt').read_text()
    limitations=list(journal.get('limitations',[]))
    if source.get('transcriptComplete') is False: limitations.append('The original live transcript is incomplete; use the recording and audio-derived transcript as the primary evidence.')
    recordings=evidence.get('recordings',[])
    # mtime of source files changes only for actual content changes; hashes de-duplicate publication.
    content={'sessionId':source['sessionId'],'ownerId':source['ownerId'],'createdAt':source.get('createdAt') or '',
             'endedAt':source.get('endedAt') or '', 'state':journal.get('state','pending'),
             'title':source.get('targetName') or 'NWE Secretary call','summary':summary,'liveTranscript':live,
             'audioTranscript':audio,'limitations':limitations,'callSid':source.get('callSid'),
             'recordings':[{k:r[k] for k in ('sid','durationSeconds','channels') if k in r} for r in recordings]}
    # Do not use mirrored snapshot mtime (rewritten by each poll) as a version.
    dates=[(folder/name).stat().st_mtime for name in ['processing.json','executive-summary.txt','audio-transcript.json'] if (folder/name).exists()]
    content['updatedAt']=int(max(dates or [0])*1000)
    return content


class ReportPublisher:
    def __init__(self,worker):
        self.worker=worker; self.task=None;self.last=0
    def tick(self):
        if time.time()-self.last<60 or self.task and not self.task.done(): return
        self.last=time.time();self.task=asyncio.create_task(asyncio.to_thread(self.publish))
    def request(self,**data):
        payload=json.dumps({'ownerIds':self.worker.config['ownerIds'],**data,'timestamp':int(time.time()*1000),'nonce':secrets.token_hex(20)},ensure_ascii=False,separators=(',',':'))
        envelope={'payload':payload,'signature':base64.b64encode(self.worker.signing_key.sign(payload.encode())).decode()}
        req=urllib.request.Request(self.worker.config['url'].rstrip('/')+'/secretary-reports/worker',data=json.dumps(envelope,ensure_ascii=False).encode(),headers={'content-type':'application/json'})
        with urllib.request.urlopen(req,timeout=30) as response:return json.load(response)
    def publish(self):
        try:
            existing={(r['ownerId'],r['sessionId']):r['hash'] for r in self.request().get('reports',[])}
            count=0
            for folder in self.worker.post_calls.root.iterdir():
                if not folder.is_dir() or not (folder/'live-transcript.json').exists():continue
                try: report=build_report(folder)
                except (ValueError,OSError,KeyError):continue
                if report['ownerId'] not in self.worker.config['ownerIds']:continue
                raw=json.dumps(report,ensure_ascii=False,separators=(',',':'))
                digest=hashlib.sha256(raw.encode()).hexdigest()
                if existing.get((report['ownerId'],report['sessionId']))==digest:continue
                chunks=[raw[i:i+8000] for i in range(0,len(raw),8000)]
                if len(chunks)>1000:raise ValueError('report_too_large')
                for i,content in enumerate(chunks):
                    receipt=self.request(chunk={'ownerId':report['ownerId'],'sessionId':report['sessionId'],'hash':digest,'total':len(chunks),'index':i,'content':content})
                if not receipt.get('complete'):raise ValueError('report_not_confirmed')
                count+=1
            if count:print(json.dumps({'event':'post_call_history_published','reports':count}),flush=True)
        except Exception as exc:print(json.dumps({'event':'post_call_history_retry','errorType':type(exc).__name__}),flush=True)
