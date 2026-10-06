import json
from pathlib import Path
import tempfile
import unittest
from report_publish import build_report
class ReportTests(unittest.TestCase):
 def test_reports_are_read_only_complete_sources_with_coverage_caveat(self):
  with tempfile.TemporaryDirectory() as d:
   folder=Path(d)
   (folder/'live-transcript.json').write_text(json.dumps({'sessionId':'agent_test','ownerId':'alice','transcriptComplete':False,'transcripts':[{'speaker':'operator','delta':'private fact','at':'now'}]}))
   (folder/'audio-transcript.json').write_text('{"segments":["full original source"]}')
   (folder/'executive-summary.txt').write_text('<script>untrusted</script>')
   report=build_report(folder)
   self.assertEqual(report['ownerId'],'alice');self.assertEqual(len(report['limitations']),1)
   self.assertIn('private fact',report['liveTranscript']);self.assertIn('full original source',report['audioTranscript'])
   self.assertEqual(report,build_report(folder))
if __name__=='__main__':unittest.main()
