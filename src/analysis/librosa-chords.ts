import type { BeatHarmony } from './reference-chord';

/** Optional local Librosa bridge. A null result means the browser fallback should be used. */
export async function detectLibrosaBeatHarmony(audio: Float32Array, sampleRate: number,
	beatTimes: readonly number[], fallbackBeatDuration: number): Promise<BeatHarmony[] | null> {
	if (!beatTimes.length) return [];
	const body = new ArrayBuffer(audio.byteLength);
	new Float32Array(body).set(audio);
	const params = new URLSearchParams({
		sampleRate: String(sampleRate),
		beatTimes: JSON.stringify(beatTimes),
		fallbackBeatDuration: String(fallbackBeatDuration),
	});
	try {
		const response = await fetch(`/__analysis/librosa-chords?${params}`, {
			method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body,
		});
		if (!response.ok) return null;
		const result = await response.json() as BeatHarmony[];
		return Array.isArray(result) ? result : null;
	} catch {
		return null;
	}
}
