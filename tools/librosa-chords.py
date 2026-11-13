#!/usr/bin/env python3
"""Read mono float32 PCM from stdin and estimate beat-wise chords with Librosa.

The input is intentionally raw float32 rather than a temporary audio file. This
keeps the Vite development endpoint local and avoids depending on ffmpeg.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile

# Apple system/framework Python may not expose a writable source locator for
# user-site packages. Librosa/Numba caching is only an optimization, so disable
# it before importing Librosa to avoid a startup RuntimeError.
os.environ.setdefault("NUMBA_DISABLE_CACHING", "1")
os.environ.setdefault("NUMBA_CACHE_DIR", os.path.join(tempfile.gettempdir(), "wipitch-numba-cache"))
os.makedirs(os.environ["NUMBA_CACHE_DIR"], exist_ok=True)
import librosa
import numpy as np


PITCH_NAMES = ("C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B")
TEMPLATES = {
    "": (0, 4, 7),
    "m": (0, 3, 7),
    "dim": (0, 3, 6),
    "aug": (0, 4, 8),
    "sus2": (0, 2, 7),
    "sus4": (0, 5, 7),
    "7": (0, 4, 7, 10),
    "maj7": (0, 4, 7, 11),
    "m7": (0, 3, 7, 10),
}


def classify(chroma: np.ndarray) -> tuple[list[int], list[str], str | None, str | None]:
    chroma = np.maximum(chroma, 0.0)
    peak = float(chroma.max(initial=0.0))
    total = float(chroma.sum())
    if peak <= 1e-8 or total <= 1e-8:
        return [], [], None, None

    active = np.flatnonzero((chroma >= peak * 0.34) & (chroma >= total * 0.065))
    active = sorted(active.tolist(), key=lambda i: float(chroma[i]), reverse=True)[:5]
    active.sort()
    names = [PITCH_NAMES[i] for i in active]
    if len(active) == 1:
        return active, names, PITCH_NAMES[active[0]], "high"

    best: tuple[float, int, str] | None = None
    triads: list[tuple[float, int, str]] = []
    normalized = chroma / peak
    for root in range(12):
        for suffix, intervals in TEMPLATES.items():
            members = {(root + interval) % 12 for interval in intervals}
            values = np.array([normalized[i] for i in members])
            matches = sum(i in members for i in active)
            missing = len(members) - matches
            extra = len(active) - matches
            outside = sum(float(normalized[i]) for i in range(12) if i not in members)
            score = (float(values.mean()) * 0.56 + float(values.min()) * 0.18
                     + float(normalized[root]) * 0.14 - outside * 0.018
                     - missing * 0.10 - extra * 0.07 - max(0, len(members) - 3) * 0.025)
            candidate = (score, root, suffix)
            if best is None or candidate[0] > best[0]:
                best = candidate
            if suffix in ("", "m"):
                triads.append(candidate)
    if best is not None and best[0] >= 0.34:
        return active, names, f"{PITCH_NAMES[best[1]]}{best[2]}", "high"

    # A complete extension (7/maj7/etc.) may be uncertain while the root and
    # major/minor third remain clear enough to guide pitch correction. Keep this
    # as a low-confidence chord and render it green instead of discarding it.
    triads.sort(reverse=True)
    if triads:
        score, root, suffix = triads[0]
        third = (root + (3 if suffix == "m" else 4)) % 12
        fifth = (root + 7) % 12
        root_strength, third_strength, fifth_strength = normalized[root], normalized[third], normalized[fifth]
        runner_score = triads[1][0] if len(triads) > 1 else -1.0
        if (score >= 0.22 and root_strength >= 0.45 and third_strength >= 0.25
                and fifth_strength >= 0.20 and sum(index in {root, third, fifth} for index in active) >= 2
                and score - runner_score >= 0.025):
            return active, names, f"{PITCH_NAMES[root]}{suffix}", "low"
    return active, names, None, None


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sample-rate", type=int, required=True)
    parser.add_argument("--beat-times", required=True, help="JSON array of seconds")
    parser.add_argument("--fallback-beat-duration", type=float, default=0.5)
    args = parser.parse_args()
    audio = np.frombuffer(sys.stdin.buffer.read(), dtype="<f4").astype(np.float32, copy=False)
    beat_times = [float(t) for t in json.loads(args.beat_times)]
    if audio.size == 0 or not beat_times:
        print(json.dumps([]))
        return

    # CQT is more robust than a single FFT bin for pitch-class extraction.
    chroma = librosa.feature.chroma_cqt(y=audio, sr=args.sample_rate, hop_length=512,
                                        n_chroma=12, tuning=None, norm=2.0)
    duration = audio.size / args.sample_rate
    result = []
    for index, start in enumerate(beat_times):
        end = beat_times[index + 1] if index + 1 < len(beat_times) else min(duration, start + args.fallback_beat_duration)
        frame_start = max(0, int(np.floor(start * args.sample_rate / 512)))
        frame_end = min(chroma.shape[1], max(frame_start + 1, int(np.ceil(end * args.sample_rate / 512))))
        vector = chroma[:, frame_start:frame_end].mean(axis=1) if frame_start < chroma.shape[1] else np.zeros(12)
        classes, names, chord, confidence = classify(vector)
        row = {"timeSec": start, "pitchClasses": classes, "pitchNames": names}
        if chord is not None:
            row["chord"] = chord
            row["chordConfidence"] = confidence
        result.append(row)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
