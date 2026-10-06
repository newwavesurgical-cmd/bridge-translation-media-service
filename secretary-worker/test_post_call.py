import unittest
import tempfile
from pathlib import Path
from post_call import speaker_stats, save_json, PostCallProcessor
from types import SimpleNamespace

class PostCallTests(unittest.TestCase):
 def test_anonymous_labels_do_not_merge_recordings(self):
  data={'recordings':[{'recordingSid':r,'transcript':{'segments':[{'speaker':'A','start':0,'end':3}]}} for r in ['one','two']]}
  result=speaker_stats(data)
  self.assertEqual(set(result),{'one:A','two:A'})
  self.assertEqual(result['one:A']['speechSeconds'],3)
 def test_private_atomic_archive(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'evidence.json';save_json(p,{'source':'transcript'})
   self.assertEqual(p.stat().st_mode & 0o777,0o600)
 def test_active_call_archived_but_not_analyzed(self):
  with tempfile.TemporaryDirectory() as d:
   worker=SimpleNamespace(config={'postCallDirectory':d})
   processor=PostCallProcessor(worker)
   processor.ingest([{'sessionId':'test','state':'live','transcripts':[]}])
   self.assertIsNone(processor.task)
   self.assertTrue((Path(d)/'test/live-transcript.json').exists())
if __name__=='__main__':unittest.main()
