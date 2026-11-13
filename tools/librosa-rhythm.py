#!/usr/bin/env python3
"""Librosa beat tracking with a user-confirmed first-beat phase anchor."""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile

os.environ.setdefault("NUMBA_DISABLE_CACHING", "1")
os.environ.setdefault("NUMBA_CACHE_DIR", os.path.join(tempfile.gettempdir(), "wipitch-numba-cache"))
os.makedirs(os.environ["NUMBA_CACHE_DIR"], exist_ok=True)
import librosa
import numpy as np


def normalized_feature(values: np.ndarray) -> np.ndarray:
    """Robust 0..1 normalization that is not dominated by one loud transient."""
    if values.size == 0:
        return values.astype(float, copy=True)
    ceiling = float(np.percentile(values, 95))
    if not np.isfinite(ceiling) or ceiling <= 1e-9:
        return np.zeros_like(values, dtype=float)
    return np.clip(values / ceiling, 0.0, 1.5)


def onset_envelope(audio: np.ndarray, sample_rate: int, hop_length: int,
                   profile: str) -> tuple[np.ndarray, float, float]:
    """Create profile-specific beat evidence.

    Rhythm instruments use short spectral changes because their attack rises
    quickly and strongly. Melody instruments blend SuperFlux-like spectral
    change with RMS growth over roughly 130 ms, then use slightly more tolerant
    evidence thresholds for piano/guitar/string attacks with a slower rise.
    """
    spectral = librosa.onset.onset_strength(y=audio, sr=sample_rate, hop_length=hop_length,
                                             lag=1 if profile == "rhythm" else 2,
                                             max_size=1 if profile == "rhythm" else 3,
                                             aggregate=np.median)
    if profile == "rhythm":
        return spectral, 1.0, 0.0
    rms = librosa.feature.rms(y=audio, frame_length=2048, hop_length=hop_length, center=True)[0]
    frame_count = min(spectral.size, rms.size)
    spectral = spectral[:frame_count]
    rms = rms[:frame_count]
    lookback = max(1, min(frame_count, round(0.13 * sample_rate / hop_length)))
    previous = np.r_[np.repeat(rms[0] if rms.size else 0.0, lookback), rms[:-lookback]]
    slow_rise = np.maximum(0.0, rms - previous)
    combined = 0.55 * normalized_feature(spectral) + 0.45 * normalized_feature(slow_rise)
    if combined.size >= 3:
        combined = np.convolve(combined, np.array([0.2, 0.6, 0.2]), mode="same")
    # The same visible user settings remain meaningful, while melody mode
    # compensates for slower and lower-amplitude attacks.
    return combined, 0.72, -0.06


def track_downbeats(onset: np.ndarray, sample_rate: int, hop_length: int, anchor: float,
                    initial_bpm: float, beats_per_bar: int, duration: float,
                    bpm_tolerance: float, prominence: float,
                    confirmation: float) -> tuple[list[float], list[float]]:
    """Track downbeats sequentially, starting with the second bar.

    ``anchor`` is the user-confirmed first beat of bar one and is never searched
    or moved.  Bar two is predicted from the configured BPM.  Every later bar is
    predicted from the preceding measured bar duration, which naturally follows
    gradual ritardando/accelerando while limiting each step to at most ±10% BPM.
    """
    if not (0 <= anchor < duration):
        return [], []
    tolerance = max(0.01, min(0.10, bpm_tolerance))
    interval = beats_per_bar * 60.0 / initial_bpm
    frame_times = librosa.frames_to_time(np.arange(onset.size), sr=sample_rate, hop_length=hop_length)
    # Local maxima only.  Sustained energy cannot become a candidate by itself.
    peaks = np.flatnonzero((onset >= np.r_[onset[0], onset[:-1]]) &
                           (onset >= np.r_[onset[1:], onset[-1]])) if onset.size else np.array([], dtype=int)
    bars = [round(anchor, 6)]
    virtual: list[float] = []
    current = anchor
    while True:
        expected = current + interval
        earliest = current + interval / (1.0 + tolerance)
        latest = current + interval / (1.0 - tolerance)
        if earliest >= duration:
            break
        indices = peaks[(frame_times[peaks] >= earliest) & (frame_times[peaks] <= min(latest, duration))]
        ranked: list[tuple[float, float]] = []
        for index in indices:
            time_sec = float(frame_times[index])
            radius = max(1, round(sample_rate / hop_length * 0.5))
            local = onset[max(0, index - radius):min(onset.size, index + radius + 1)]
            mean = float(np.mean(local)) if local.size else 0.0
            std = float(np.std(local)) if local.size else 0.0
            z = (float(onset[index]) - mean) / max(1e-7, std)
            if z < prominence:
                continue
            strength = min(1.0, z / max(1.5, prominence * 1.8))
            proximity = max(0.0, 1.0 - abs(time_sec - expected) / max(0.01, latest - earliest))
            ranked.append((0.72 * strength + 0.28 * proximity, time_sec))
        ranked.sort(reverse=True)
        best = ranked[0] if ranked else None
        ambiguous = best is not None and len(ranked) > 1 and best[0] - ranked[1][0] < 0.08
        if best is not None and best[0] >= confirmation and not ambiguous and best[1] > current + 0.05:
            measured = best[1] - current
            current = best[1]
            interval = measured
            bars.append(round(current, 6))
        else:
            current = expected
            bars.append(round(current, 6))
            virtual.append(round(current, 6))
        if current >= duration:
            bars.pop()
            if virtual and virtual[-1] >= duration:
                virtual.pop()
            break
    return bars, virtual


def track_beats(onset: np.ndarray, sample_rate: int, hop_length: int, anchor: float,
                initial_bpm: float, beats_per_bar: int, duration: float,
                bpm_tolerance: float, prominence: float,
                confirmation: float) -> tuple[list[float], list[float], list[float], list[float]]:
    """Use Librosa's beat tracker, then lock its phase to the user anchor.

    The previous implementation only searched for bar starts and generated beats
    2..N by evenly subdividing each bar.  A clearly detected piano attack inside
    a bar therefore could not move its marker.  Here every beat candidate comes
    from ``librosa.beat.beat_track``; the user anchor remains the exact first
    beat and also defines which tracked beats are bar starts.
    """
    if not (0 <= anchor < duration):
        return [], [], [], []
    tolerance = max(0.01, min(0.10, bpm_tolerance))
    initial_period = 60.0 / initial_bpm
    _, frames = librosa.beat.beat_track(onset_envelope=onset, sr=sample_rate,
                                        hop_length=hop_length, bpm=initial_bpm,
                                        trim=False, sparse=True)
    detected = librosa.frames_to_time(np.asarray(frames, dtype=int), sr=sample_rate,
                                      hop_length=hop_length)
    beats = [round(anchor, 6)]
    virtual: list[float] = []
    period = initial_period
    current = anchor
    frame_slack = hop_length / sample_rate
    while True:
        expected = current + period
        if expected >= duration:
            break
        # Use the previous confirmed beat interval as the next-beat BPM.  BPM
        # and seconds are reciprocal, so a ±5% BPM search becomes an asymmetric
        # time window.  One Librosa frame of slack prevents boundary loss caused
        # by the 32 ms frame quantisation.
        earliest = current + period / (1.0 + tolerance) - frame_slack
        latest = current + period / (1.0 - tolerance) + frame_slack
        indices = np.flatnonzero((detected >= earliest) &
                                 (detected <= min(duration, latest)) &
                                 (detected > current + period * 0.35))
        ranked: list[tuple[float, float]] = []
        for candidate_index in indices:
            frame = int(frames[candidate_index])
            local_radius = max(1, round(sample_rate / hop_length * 0.5))
            local = onset[max(0, frame - local_radius):min(onset.size, frame + local_radius + 1)]
            mean = float(np.mean(local)) if local.size else 0.0
            std = float(np.std(local)) if local.size else 0.0
            z = (float(onset[frame]) - mean) / max(1e-7, std)
            if z < prominence:
                continue
            strength = min(1.0, z / max(1.5, prominence * 1.8))
            distance_scale = max(frame_slack, expected - earliest, latest - expected)
            proximity = max(0.0, 1.0 - abs(float(detected[candidate_index]) - expected) / distance_scale)
            ranked.append((0.72 * strength + 0.28 * proximity,
                           float(detected[candidate_index])))
        ranked.sort(reverse=True)
        best = ranked[0] if ranked else None
        ambiguous = best is not None and len(ranked) > 1 and best[0] - ranked[1][0] < 0.08
        if best is not None and best[0] >= confirmation and not ambiguous:
            measured = best[1] - current
            current = best[1]
            period = measured
            beats.append(round(current, 6))
        else:
            current = expected
            beats.append(round(current, 6))
            virtual.append(round(current, 6))
    bars = beats[::beats_per_bar]
    virtual_set = set(virtual)
    virtual_bars = [time for time in bars if time in virtual_set]
    return beats, virtual, bars, virtual_bars


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sample-rate", type=int, required=True)
    parser.add_argument("--anchor-sec", type=float, required=True)
    parser.add_argument("--bpm", type=float, required=True)
    parser.add_argument("--meter", required=True)
    parser.add_argument("--bpm-tolerance", type=float, default=0.05)
    parser.add_argument("--onset-prominence", type=float, default=0.65)
    parser.add_argument("--confirmation-threshold", type=float, default=0.58)
    parser.add_argument("--instrument-profile", choices=("rhythm", "melody"), default="melody")
    args = parser.parse_args()
    audio = np.frombuffer(sys.stdin.buffer.read(), dtype="<f4").astype(np.float32, copy=False)
    duration = audio.size / args.sample_rate
    beats_per_bar = int(args.meter.split("/")[0])
    if audio.size == 0 or duration <= 0 or not (30 <= args.bpm <= 300) or beats_per_bar not in (2, 3, 4):
        raise ValueError("invalid Librosa rhythm parameters")

    onset, prominence_scale, confirmation_offset = onset_envelope(audio, args.sample_rate, 512,
                                                                   args.instrument_profile)
    beats, virtual_beats, bars, virtual_bars = track_beats(
        onset, args.sample_rate, 512, args.anchor_sec, args.bpm, beats_per_bar,
        duration, args.bpm_tolerance, args.onset_prominence * prominence_scale,
        max(0.30, args.confirmation_threshold + confirmation_offset))
    measured = np.diff(np.asarray(beats, dtype=float))
    confirmed_intervals = [value for index, value in enumerate(measured)
                           if index + 1 < len(beats) and beats[index + 1] not in virtual_beats]
    bpm_value = 60.0 / float(np.median(confirmed_intervals)) if confirmed_intervals else args.bpm
    print(json.dumps({"bpm": bpm_value, "anchorSec": args.anchor_sec,
                      "barStartsSec": bars, "virtualBarStartsSec": virtual_bars,
                      "beatTimesSec": beats, "virtualBeatTimesSec": virtual_beats}, ensure_ascii=False))


if __name__ == "__main__":
    main()
