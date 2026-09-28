// 探測 Rubber Band 即時模式在「逐 block 改 time ratio」時的行為。
//
// 問題：rbcore 目前假設「輸入位置 = 輸出位置」。加了伸縮之後要知道：
//   1. 輸出總長是不是 Σ(每個 block 的輸入長度 × 當下倍率)
//   2. 起點延遲（start pad）在伸縮下還是不是被 Rubber Band 自己補掉
//   3. 倍率在中途切換時，輸出時間跟「理想的分段線性對應」差多少
//
// 做法：每 0.25s 一個短脈衝，找輸出裡每個脈衝的位置，跟理想對應比較。
import { loadRubberBand } from './rubberband-node.mjs';

const sr = 48000, DUR = 6;
const RT = 1, FINER = 536870912, FORMANT = 16777216, HC = 67108864;
const api = await loadRubberBand();

const n = sr * DUR;
const src = new Float32Array(n);
const clickEvery = 0.25;
for (let t = 0.125; t < DUR; t += clickEvery) {
	// 5ms 的 2kHz 短音包，比單一 sample 的脈衝更不容易被相位聲碼器抹掉
	const i0 = Math.round(t * sr);
	for (let i = 0; i < sr * 0.005; i++) src[i0 + i] = 0.6 * Math.sin(2 * Math.PI * 2000 * i / sr) * Math.sin(Math.PI * i / (sr * 0.005));
}

/** ratioAtSrc: 依輸入時間回傳倍率。回傳整段輸出（未截斷） */
function run(ratioAtSrc, block = 1024) {
	const state = api.rubberband_new(sr, 1, RT | FINER | FORMANT | HC, 1.0, 1.0);
	api.rubberband_set_max_process_size(state, block);
	const startPad = api.rubberband_get_preferred_start_pad(state);
	const arr = api.malloc(4), buf = api.malloc(block * 4);
	api.memWritePtr(arr, buf);
	const chunks = [];
	let written = 0;
	const drain = () => {
		for (;;) {
			const avail = api.rubberband_available(state);
			if (avail < 1) break;
			const got = api.rubberband_retrieve(state, arr, Math.min(block, avail));
			if (got < 1) break;
			chunks.push(api.memReadF32(buf, got).slice());
			written += got;
		}
	};
	// start pad 用第一個倍率
	api.rubberband_set_time_ratio(state, ratioAtSrc(0));
	const zero = new Float32Array(block);
	for (let done = 0; done < startPad;) {
		const c = Math.min(block, startPad - done);
		api.memWrite(buf, zero.subarray(0, c));
		api.rubberband_process(state, arr, c, 0);
		done += c; drain();
	}
	let ideal = 0;
	const padOut = written;   // start pad 階段吐出來的量
	for (let read = 0; read < n;) {
		const c = Math.min(block, n - read);
		const r = ratioAtSrc((read + c / 2) / sr);
		api.rubberband_set_time_ratio(state, r);
		api.memWrite(buf, src.subarray(read, read + c));
		read += c;
		ideal += c * r;
		api.rubberband_process(state, arr, c, read >= n ? 1 : 0);
		drain();
	}
	drain();
	api.rubberband_delete(state); api.free(buf); api.free(arr);
	const out = new Float32Array(written);
	let o = 0; for (const ch of chunks) { out.set(ch, o); o += ch.length; }
	return { out, startPad, padOut, ideal, startDelay: api.rubberband_get_start_delay ? null : null };
}

/** 找脈衝位置（秒）：能量包絡的局部峰 */
function clicks(x) {
	const win = Math.round(sr * 0.004), env = new Float32Array(Math.floor(x.length / win));
	for (let k = 0; k < env.length; k++) { let s = 0; for (let i = 0; i < win; i++) s += x[k * win + i] ** 2; env[k] = s; }
	const peak = Math.max(...env), out = [];
	for (let k = 1; k < env.length - 1; k++) {
		if (env[k] > peak * 0.05 && env[k] >= env[k - 1] && env[k] > env[k + 1]) {
			// 能量重心，比取最大格精準
			let sw = 0, sm = 0;
			for (let j = Math.max(0, k - 3); j <= Math.min(env.length - 1, k + 3); j++) { sw += j * env[j]; sm += env[j]; }
			const t = (sw / sm + 0.5) * win / sr;
			if (!out.length || t - out[out.length - 1] > 0.05) out.push(t);
		}
	}
	return out;
}

const cases = [
	{ name: '固定 1×', f: () => 1, map: t => t },
	{ name: '固定 2×', f: () => 2, map: t => 2 * t },
	{ name: '固定 0.5×', f: () => 0.5, map: t => 0.5 * t },
	// 使用者的例子：1~2s 拉長一倍，其餘 1×
	{ name: '1~2s 為 2×', f: t => (t >= 1 && t < 2 ? 2 : 1), map: t => (t < 1 ? t : t < 2 ? 1 + 2 * (t - 1) : t + 1) },
	{ name: '1~3s 為 0.5×', f: t => (t >= 1 && t < 3 ? 0.5 : 1), map: t => (t < 1 ? t : t < 3 ? 1 + 0.5 * (t - 1) : t - 1) },
];

for (const c of cases) {
	const r = run(c.f);
	const found = clicks(r.out);
	const expectSrc = [];
	for (let t = 0.125; t < DUR; t += clickEvery) expectSrc.push(t);
	// 把每個找到的脈衝配對到最近的理想位置（扣掉 start pad 對應的輸出）
	const padSec = r.startPad / sr;
	const errs = [];
	for (const t of expectSrc) {
		const want = c.map(t) + padSec * c.f(0);
		const got = found.reduce((b, x) => (Math.abs(x - want) < Math.abs(b - want) ? x : b), Infinity);
		errs.push({ src: t, want, got, errMs: (got - want) * 1000 });
	}
	const e = errs.map(x => x.errMs);
	console.log(`\n${c.name}：startPad=${r.startPad}（pad 階段吐出 ${r.padOut}）輸出 ${(r.out.length / sr).toFixed(3)}s、理想 Σc·r=${(r.ideal / sr).toFixed(3)}s、找到 ${found.length}/${expectSrc.length} 個脈衝`);
	console.log(`  誤差 ms：min ${Math.min(...e).toFixed(1)}  max ${Math.max(...e).toFixed(1)}  中位數 ${e.sort((a, b) => a - b)[e.length >> 1].toFixed(1)}`);
	console.log('  ' + errs.filter((_, i) => i % 2 === 0).map(x => `${x.src.toFixed(2)}→${x.errMs.toFixed(0)}`).join(' '));
}
