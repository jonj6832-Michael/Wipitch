// 陽春的自相關基頻追蹤，只是 spike 用來代替 SwiftF0 的暫時替身。
// 正式版會換成 SwiftF0（更準、更平滑、而且不會有八度錯誤）。
export function trackF0(x, sr, hopSec = 0.016, minHz = 70, maxHz = 800) {
	const hop = Math.round(sr * hopSec);
	const N = 2048;
	const lo = Math.floor(sr / maxHz), hi = Math.floor(sr / minHz);
	const times = [], f0 = [];

	// 分析視窗以格點為「中心」，不是以格點為起點。
	// 標在起點的話，每個音高值其實描述的是 N/2 個 sample 之後的聲音
	// （這裡是 21ms），對抖音這種 5Hz 的東西就是 40 度的相位誤差。
	const frameCount = Math.floor(x.length / hop);
	for (let f = 0; f < frameCount; f++) {
		const off = f * hop - (N >> 1);
		if (off < 0 || off + N + hi >= x.length) { times.push(f * hop / sr); f0.push(0); continue; }
		let e = 0;
		for (let i = 0; i < N; i++) e += x[off + i] * x[off + i];
		if (Math.sqrt(e / N) < 0.01) { times.push(f * hop / sr); f0.push(0); continue; }

		let best = 0, bestLag = 0;
		for (let lag = lo; lag <= hi; lag++) {
			let s = 0, n1 = 0, n2 = 0;
			for (let i = 0; i < N; i += 2) { s += x[off + i] * x[off + i + lag]; n1 += x[off + i] * x[off + i]; n2 += x[off + i + lag] * x[off + i + lag]; }
			const c = s / Math.sqrt(n1 * n2 + 1e-20);
			if (c > best) { best = c; bestLag = lag; }
		}
		times.push(f * hop / sr);
		f0.push(best > 0.5 && bestLag ? sr / bestLag : 0);
	}

	// 把無聲(0)的空隙用前後值補起來，避免餵 0 給 formant 分析
	let last = 0;
	for (let i = 0; i < f0.length; i++) { if (f0[i]) last = f0[i]; else f0[i] = last; }
	for (let i = f0.length - 1; i >= 0; i--) { if (f0[i]) last = f0[i]; else f0[i] = last; }

	return { times, f0, hopSec };
}

export function f0At(track, t) {
	const i = Math.round(t / track.hopSec);
	return track.f0[Math.max(0, Math.min(track.f0.length - 1, i))] || 0;
}
