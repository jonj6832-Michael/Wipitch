import importlib.util
from pathlib import Path
import numpy as np

module_path = Path(__file__).parents[1] / "tools" / "librosa-rhythm.py"
spec = importlib.util.spec_from_file_location("wipitch_librosa_rhythm", module_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

onset = np.zeros(1100, dtype=float)
for time, strength in [(1.1, 9), (3.0, 8), (5.1, 8), (7.31, 8)]:
    onset[round(time * 100)] = strength
bars, virtual = module.track_downbeats(onset, 100, 1, 1.0, 120, 4, 10.0, 0.10, 0.65, 0.58)
assert bars[:4] == [1.0, 3.0, 5.1, 7.31], bars
assert bars[0] == 1.0, "anchor must remain the first beat of bar one"
assert virtual[-1] == 9.52, virtual

outside = np.zeros(500, dtype=float)
outside[330] = 10
bars, virtual = module.track_downbeats(outside, 100, 1, 1.0, 120, 4, 4.0, 0.25, 0.65, 0.58)
assert bars == [1.0, 3.0], bars
assert virtual == [3.0], "configured tolerance must be capped at 10%"
print("PASS: fixed first-bar anchor, second-bar initial BPM search, per-bar tempo carry and 10% cap")

sample_rate = 16000
time = np.arange(sample_rate * 2) / sample_rate
attack = np.clip((time - 0.6) / 0.25, 0, 1)
slow_note = (0.35 * np.sin(2 * np.pi * 220 * time) * attack).astype(np.float32)
rhythm_feature, rhythm_prominence, rhythm_confirmation = module.onset_envelope(slow_note, sample_rate, 512, "rhythm")
melody_feature, melody_prominence, melody_confirmation = module.onset_envelope(slow_note, sample_rate, 512, "melody")
assert melody_feature.size == rhythm_feature.size
assert np.max(melody_feature) > 0
assert melody_prominence < rhythm_prominence and melody_confirmation < rhythm_confirmation
print("PASS: rhythm profile uses transient evidence; melody profile adds slow RMS-rise evidence and gentler thresholds")

# Every beat, not only each bar start, must be allowed to follow a Librosa beat
# candidate.  Each confirmed interval becomes the BPM prediction for the next
# beat, allowing a gradual tempo change while every step stays inside ±5% BPM.
per_beat = np.zeros(900, dtype=float)
for time in [1.0, 2.0, 2.96, 3.88, 4.80, 5.72, 6.64, 7.56, 8.48]:
    per_beat[round(time * 100)] = 10
beats, virtual_beats, bars, virtual_bars = module.track_beats(
    per_beat, 100, 1, 1.0, 60, 4, 8.5, 0.05, 0.65, 0.58)
assert beats[:5] == [1.0, 2.0, 2.96, 3.88, 4.8], beats
assert bars[:2] == [1.0, 4.8], bars
assert 4.0 not in beats and 4.0 not in virtual_beats
assert virtual_bars == []
print("PASS: Librosa candidates snap every beat while the anchor fixes bar phase")
