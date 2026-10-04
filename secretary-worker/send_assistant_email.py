#!/Users/nweassistant/.hermes/hermes-agent/venv/bin/python
"""Fixed NWE Assistant sender. One immutable attempt per secretary request."""
import argparse
import hashlib
import importlib.util
import json
import re
import sqlite3
import tomllib
from pathlib import Path

SENDER = 'Newwaveagental@gmail.com'
ACCOUNT = 'gmail'
STATE = Path.home()/'.codex/nwe-secretary-worker'
SKILL = Path.home()/'.codex/skills/nwe-email-send/scripts/send_email.py'

def validate(proposal):
    if set(proposal)-{'recipient','subject','markdown_content','attachments'}:
        raise ValueError('Unsupported fields: sender and account cannot be overridden')
    if not re.fullmatch(r'[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+',proposal.get('recipient','')):
        raise ValueError('One resolved recipient address required')
    for key in ('subject','markdown_content'):
        if not isinstance(proposal.get(key),str) or not proposal[key].strip():
            raise ValueError('Missing '+key)
    if '\n' in proposal['subject'] or '\r' in proposal['subject']:
        raise ValueError('Invalid subject')
    for attachment in proposal.get('attachments',[]):
        if not Path(attachment).is_absolute() or not Path(attachment).is_file():
            raise ValueError('Attachment must be an existing absolute file path')
    return proposal

def execute(request_id, proposal, send, state=STATE):
    if not re.fullmatch(r'[0-9a-fA-F-]{36}',request_id):
        raise ValueError('Original request UUID required')
    validate(proposal)
    fingerprint=hashlib.sha256(json.dumps(proposal,sort_keys=True).encode()).hexdigest()
    state.mkdir(parents=True,exist_ok=True);state.chmod(0o700)
    db=sqlite3.connect(state/'email-attempts.sqlite3')
    db.execute('CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY, fingerprint TEXT, receipt TEXT)')
    db.commit();(state/'email-attempts.sqlite3').chmod(0o600)
    try:
        db.execute('BEGIN IMMEDIATE')
        prior=db.execute('SELECT fingerprint,receipt FROM attempts WHERE id=?',(request_id,)).fetchone()
        if prior:
            db.rollback()
            if prior[0]!=fingerprint: raise ValueError('Request already bound to different content')
            return json.loads(prior[1]) if prior[1] else {'ok':False,'status':'unknown','message':'Prior attempt exists; do not resend'}
        db.execute('INSERT INTO attempts VALUES(?,?,NULL)',(request_id,fingerprint));db.commit()
        try:
            receipt=send(recipient=proposal['recipient'],subject=proposal['subject'],markdown_content=proposal['markdown_content'],attachments=proposal.get('attachments',[]),sender=SENDER,account=ACCOUNT)
            if not receipt.get('ok') or not receipt.get('sent_folder',{}).get('verified'):
                receipt={'ok':False,'status':'unconfirmed','message':'Sent Mail verification missing; do not resend'}
        except Exception:
            receipt={'ok':False,'status':'unknown','message':'Send or verification failed; inspect Sent Mail, do not resend'}
        receipt.update(sender=SENDER,requestId=request_id)
        db.execute('UPDATE attempts SET receipt=? WHERE id=?',(json.dumps(receipt),request_id));db.commit()
        return receipt
    finally: db.close()

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--request-id',required=True);parser.add_argument('--proposal',required=True);args=parser.parse_args()
    spec=importlib.util.spec_from_file_location('nwe_send',SKILL);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    account_config=tomllib.loads((Path.home()/'.config/himalaya/config.toml').read_text()).get('accounts',{}).get(ACCOUNT,{})
    if account_config.get('email','').lower()!=SENDER.lower():
        raise SystemExit('NWE Assistant account identity mismatch; sending disabled')
    result=execute(args.request_id,json.loads(Path(args.proposal).read_text()),module.send_formatted_email)
    print('SEND_STATUS_JSON='+json.dumps(result));return 0 if result.get('ok') else 1

if __name__=='__main__': raise SystemExit(main())
