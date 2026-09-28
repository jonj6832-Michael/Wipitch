// 頻譜包絡分析，用來客觀測量 formant 有沒有被保留。
//
// 原理：移調之後，泛音（harmonics）一定會跟著移動，那是應該的。
// 但「音色」是由頻譜包絡（spectral envelope）決定的——也就是共振峰的位置。
// 保留音色 = 泛音移動、但包絡不動。
//
// 要把這兩者分開，用倒頻譜（cepstrum）：對 log 頻譜再做一次 FFT，
// 密集的泛音會落在高 quefrency，緩慢起伏的包絡落在低 quefrency。
// 只留低的部分，就得到不含泛音的包絡。

/** 原地 FFT，radix-2。re/im 長度必須是 2 的次方。 */
export function fft(re, im, inverse = false) {
	const n = re.length;
	for (let i = 1, j = 0; i < n; i++) {
		let bit = n >> 1;
		for (; j & bit; bit >>= 1) j ^= bit;
		j ^= bit;
		if (i < j) {
			[re[i], re[j]] = [re[j], re[i]];
			[im[i], im[j]] = [im[j], im[i]];
		}
	}
	for (let len = 2; len <= n; len <<= 1) {
		const ang = (inverse ? 2 : -2) * Math.PI / len;
		const wr = Math.cos(ang), wi = Math.sin(ang);
		for (let i = 0; i < n; i += len) {
			let cr = 1, ci = 0;
			for (let k = 0; k < len / 2; k++) {
				const ar = re[i + k], ai = im[i + k];
				const br = re[i + k + len / 2], bi = im[i + k + len / 2];
				const tr = br * cr - bi * ci, ti = br * ci + bi * cr;
				re[i + k] = ar + tr; im[i + k] = ai + ti;
				re[i + k + len / 2] = ar - tr; im[i + k + len / 2] = ai - ti;
				const ncr = cr * wr - ci * wi;
				ci = cr * wi + ci * wr; cr = ncr;
			}
		}
	}
	if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

/** 整段音訊的平均振幅頻譜（Welch 式：重疊分frame、加 Hann 窗、取平均）。 */
export function averageSpectrum(x, fftSize = 4096, hop = 1024) {
	const win = new Float32Array(fftSize);
	for (let i = 0; i < fftSize; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / fftSize);

	const half = fftSize / 2;
	const acc = new Float64Array(half);
	let frames = 0;

	for (let off = 0; off + fftSize <= x.length; off += hop) {
		const re = new Float64Array(fftSize), im = new Float64Array(fftSize);
		let energy = 0;
		for (let i = 0; i < fftSize; i++) { re[i] = x[off + i] * win[i]; energy += x[off + i] * x[off + i]; }
		if (energy / fftSize < 1e-8) continue; // 跳過靜音段，否則會稀釋掉包絡
		fft(re, im);
		for (let k = 0; k < half; k++) acc[k] += Math.hypot(re[k], im[k]);
		frames++;
	}
	if (!frames) throw new Error('整段都是靜音，分析不了');
	for (let k = 0; k < half; k++) acc[k] /= frames;
	return acc;
}

/**
 * 用倒頻譜平滑取出頻譜包絡。
 * @param lifter 保留幾個倒頻譜係數。必須小於基頻週期（樣本數），才濾得掉泛音。
 */
export function spectralEnvelope(mag, lifter = 80) {
	const half = mag.length;
	const n = half * 2;
	const re = new Float64Array(n), im = new Float64Array(n);
	for (let k = 0; k < half; k++) {
		const v = Math.log(mag[k] + 1e-12);
		re[k] = v;
		re[n - 1 - k] = v; // 對稱延拓，保證倒頻譜是實數
	}
	fft(re, im, true);
	// 高 quefrency 歸零 = 濾掉泛音結構，只留緩慢起伏的包絡
	for (let q = lifter; q < n - lifter; q++) { re[q] = 0; im[q] = 0; }
	fft(re, im);
	const env = new Float64Array(half);
	for (let k = 0; k < half; k++) env[k] = re[k];  // 這是 log 域的包絡
	return env;
}

/**
 * 比較兩條包絡，回傳「B 相對 A 在對數頻率軸上平移了幾個半音」。
 *
 * 這就是核心指標：
 *   保留音色成功 → 接近 0
 *   完全沒保留   → 接近移調的半音數
 */
export function envelopeShiftSemitones(envA, envB, sampleRate, fftSize, loHz = 300, hiHz = 4500) {
	const binHz = sampleRate / fftSize;
	const step = 1 / 8; // 取樣解析度：1/8 半音
	const lo = 12 * Math.log2(loHz / 440), hi = 12 * Math.log2(hiHz / 440);
	const count = Math.floor((hi - lo) / step);

	const sample = (env, semi) => {
		const hz = 440 * Math.pow(2, semi / 12);
		const bin = hz / binHz;
		const i = Math.floor(bin);
		if (i < 0 || i + 1 >= env.length) return 0;
		const f = bin - i;
		return env[i] * (1 - f) + env[i + 1] * f;
	};

	// 取到對數頻率軸上，然後「去除線性趨勢」。
	//
	// 只去平均是不夠的：人聲的頻譜包絡有很強的整體下降斜率，那條斜線在任何
	// 平移量下都高度吻合，會把互相關的峰值完全淹沒（實測相關係數在 ±7 半音
	// 都還有 0.93）。把最小平方擬合的直線減掉之後，剩下的才是共振峰的起伏，
	// 也才是真正對平移敏感的部分。
	const a = new Float64Array(count), b = new Float64Array(count);
	for (let i = 0; i < count; i++) { a[i] = sample(envA, lo + i * step); b[i] = sample(envB, lo + i * step); }
	const detrend = v => {
		const n = v.length;
		let sx = 0, sy = 0, sxx = 0, sxy = 0;
		for (let i = 0; i < n; i++) { sx += i; sy += v[i]; sxx += i * i; sxy += i * v[i]; }
		const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
		const inter = (sy - slope * sx) / n;
		for (let i = 0; i < n; i++) v[i] -= slope * i + inter;
	};
	detrend(a); detrend(b);

	// 互相關找最佳平移量
	const maxLag = Math.round(14 / step);
	let best = { lag: 0, c: -Infinity };
	for (let lag = -maxLag; lag <= maxLag; lag++) {
		let num = 0, da = 0, db = 0;
		for (let i = 0; i < count; i++) {
			const j = i + lag;
			if (j < 0 || j >= count) continue;
			num += a[i] * b[j]; da += a[i] * a[i]; db += b[j] * b[j];
		}
		const c = num / Math.sqrt(da * db + 1e-20);
		if (c > best.c) best = { lag, c };
	}
	// b 要往負 lag 移才對得上 a，代表 b 的包絡是往高頻移動的
	return { semitones: -best.lag * step, correlation: best.c };
}

/**
 * 頻譜包絡在「對數頻率軸」上的重心，單位是半音（相對 440Hz）。
 *
 * 為什麼用這個而不是互相關：包絡經過倒頻譜平滑之後解析度有限，
 * 互相關的峰值很容易被雜訊和頻譜整體斜率帶偏（實測會給出完全錯誤的答案）。
 * 重心是個積分量，沒有峰值挑選的問題，穩定得多。
 *
 * 數學上：如果整條包絡在對數頻率軸上平移 k 個半音，重心就剛好跟著平移 k。
 * 所以「移調前後的重心差」就是 formant 實際移動了多少半音。
 *
 * 兩端各加一段 raised-cosine 漸弱，避免內容移進／移出分析頻帶時造成跳動。
 */
export function envelopeCentroidSemitones(env, sampleRate, fftSize, loHz = 250, hiHz = 5000) {
	const binHz = sampleRate / fftSize;
	const step = 1 / 16;
	const lo = 12 * Math.log2(loHz / 440), hi = 12 * Math.log2(hiHz / 440);
	const count = Math.floor((hi - lo) / step);
	const taper = Math.round(count * 0.15);

	let num = 0, den = 0;
	for (let i = 0; i < count; i++) {
		const semi = lo + i * step;
		const bin = 440 * Math.pow(2, semi / 12) / binHz;
		const j = Math.floor(bin);
		if (j < 0 || j + 1 >= env.length) continue;
		const f = bin - j;
		const logMag = env[j] * (1 - f) + env[j + 1] * f;

		let w = Math.exp(logMag);          // 回到線性振幅當權重
		if (i < taper) w *= 0.5 - 0.5 * Math.cos(Math.PI * i / taper);
		else if (i >= count - taper) w *= 0.5 - 0.5 * Math.cos(Math.PI * (count - 1 - i) / taper);

		num += w * semi;
		den += w;
	}
	return num / den;
}
