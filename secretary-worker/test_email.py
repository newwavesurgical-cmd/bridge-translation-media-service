import tempfile
import unittest
from pathlib import Path
from send_assistant_email import execute, validate, SENDER

class EmailTests(unittest.TestCase):
    def test_fixed_sender_and_single_attempt(self):
        calls=[]
        def send(**kw):
            calls.append(kw);return {'ok':True,'sent_folder':{'verified':True}}
        p={'recipient':'alex@example.com','subject':'Report','markdown_content':'Verified report'}
        with tempfile.TemporaryDirectory() as directory:
            first=execute('12345678-1234-1234-1234-123456789012',p,send,Path(directory))
            second=execute('12345678-1234-1234-1234-123456789012',p,send,Path(directory))
        self.assertEqual(first,second);self.assertEqual(len(calls),1)
        self.assertEqual(calls[0]['sender'],SENDER);self.assertEqual(calls[0]['account'],'gmail')
    def test_unknown_not_retried(self):
        calls=[]
        def send(**kw): calls.append(kw);raise TimeoutError()
        p={'recipient':'alex@example.com','subject':'Report','markdown_content':'Report'}
        with tempfile.TemporaryDirectory() as directory:
            for _ in range(2): self.assertFalse(execute('12345678-1234-1234-1234-123456789012',p,send,Path(directory))['ok'])
        self.assertEqual(len(calls),1)
    def test_personal_override_rejected(self):
        with self.assertRaises(ValueError): validate({'recipient':'alex@example.com','subject':'Hi','markdown_content':'Hi','sender':'personal@example.com'})
    def test_unverified_not_sent(self):
        with tempfile.TemporaryDirectory() as directory:
            receipt=execute('12345678-1234-1234-1234-123456789012',{'recipient':'alex@example.com','subject':'Hi','markdown_content':'Hi'},lambda **kw:{'ok':True},Path(directory))
        self.assertFalse(receipt['ok'])

if __name__=='__main__': unittest.main()
