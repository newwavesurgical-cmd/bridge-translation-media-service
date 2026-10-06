import io
import json
import math
from pathlib import Path
import struct
import tempfile
import unittest
import wave
from audio_review import split_recording, offset_segments, channel_activity, transcribe_chunked

class AudioReviewTests(unittest.TestCase):
 def fixture(self, root):
  file=Path(root)/'source.wav'
  with wave.open(str(file),'wb') as wav:
   wav.setnchannels(2);wav.setsampwidth(2);wav.setframerate(8000)
   # 0-2.5s quiet; 2.5-5 left only; 5-7.5 both; 7.5-10 quiet.
   data=bytearray()
   for i in range(80000):
    v=round(9000*math.sin(i*2*math.pi*440/8000))
    data.extend(struct.pack('<hh',v if 20000<=i<60000 else 0,v if 40000<=i<60000 else 0))
   wav.writeframes(data)
  return file
 def test_full_duration_and_small_chunks(self):
  with tempfile.TemporaryDirectory() as d:
   parts=split_recording(self.fixture(d),Path(d)/'chunks',seconds=3)
   self.assertEqual(len(parts),4)
   self.assertAlmostEqual(sum(p['duration'] for p in parts),10)
   self.assertTrue(all(Path(p['file']).stat().st_size<25_000_000 for p in parts))
 def test_silence_including_call_ending_and_overlap(self):
  with tempfile.TemporaryDirectory() as d:
   result=channel_activity(self.fixture(d),d)
   self.assertEqual(result['quiet'],[{'start':0.0,'end':2.5},{'start':7.5,'end':10.0}])
   self.assertEqual(result['bothTracksActive'],[{'start':5.0,'end':7.5}])
 def test_chunk_labels_are_not_merged_and_offsets_preserved(self):
  raw={'segments':[{'start':1,'end':3,'speaker':'A','text':'A decision'}]}
  one=offset_segments(raw,600,'REexample',2)[0]
  two=offset_segments(raw,1200,'REexample',3)[0]
  self.assertEqual(one['start'],601)
  self.assertNotEqual(one['speaker'],two['speaker'])
 def test_resume_does_not_repeat_successful_request(self):
  with tempfile.TemporaryDirectory() as d:
   file=self.fixture(d); calls=[]
   def request(req,timeout):
    calls.append(req)
    return io.BytesIO(json.dumps({'segments':[{'start':0,'end':1,'speaker':'A','text':'test'}]}).encode())
   first=transcribe_chunked(file,Path(d)/'chunks','REexample','test',request)
   second=transcribe_chunked(file,Path(d)/'chunks','REexample','test',request)
   self.assertEqual(first,second);self.assertEqual(len(calls),1)
if __name__=='__main__': unittest.main()
