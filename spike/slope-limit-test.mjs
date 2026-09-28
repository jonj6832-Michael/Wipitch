// 音高偏移變化率上限（edits.limitSlope）的性質測試。純數值，不需要 Rubber Band。
import { limitSlope } from '../src/model/edits.ts';
import { CURVE_HOP_SEC } from '../src/model/curves.ts';

const L = 60, c = L * CURVE_HOP_SEC;
let failed = 0;
const check = (pass, name, detail) => { console.log(`${pass ? '✅' : '❌'} ${name}  — ${detail}`); if (!pass) failed++; };
const maxStep = a => { let m = 0; for (let i = 1; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - a[i - 1])); return m; };
const same = (a, b) => a.every((v, i) => Object.is(v, b[i]));

// 1) 全 0、合乎限制的抖音 → 逐位元不變
{
	const z = new Float32Array(2000);
	limitSlope(z, 0, z.length, L);
	check(z.every(v => Object.is(v, 0)), '全 0 逐位元不變', '');
	const v = new Float32Array(2000).map((_, i) => Math.sin(2 * Math.PI * 6 * i * CURVE_HOP_SEC));   // 峰值 37.7 半音/秒
	const before = v.slice();
	limitSlope(v, 0, v.length, L);
	check(same(v, before), '深 1 半音、6Hz 的抖音逐位元不變', `峰值斜率 ${(maxStep(before) / CURVE_HOP_SEC).toFixed(1)} 半音/秒`);
}

// 2) 階梯 → 以原位置為中心的斜坡，斜率不超過上限
{
	const n = 2000, k = 1000, S = 12;
	const a = new Float32Array(n); a.fill(S, k);
	limitSlope(a, 0, n, L);
	const first = a.findIndex(v => v > 1e-6), last = a.findIndex(v => v >= S - 1e-6);
	const center = (first + last) / 2;
	check(maxStep(a) <= c * 1.0001, '階梯拉緩後斜率 ≤ 上限', `${(maxStep(a) / CURVE_HOP_SEC).toFixed(1)} 半音/秒`);
	check(Math.abs(center - (k - 0.5)) <= 1, '斜坡以原階梯為中心', `斜坡 ${first}~${last}，中心 ${center}，階梯在 ${k - 0.5}`);
	check(Math.abs((last - first) * CURVE_HOP_SEC - 2 * S / L) < 0.01, '斜坡長度 = 2S/L', `${((last - first) * CURVE_HOP_SEC * 1000).toFixed(0)}ms`);
}

// 3) 隨機曲線：結果一定合乎限制，而且只在範圍內動
{
	let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
	const a = new Float32Array(5000).map(() => (rnd() - 0.5) * 8);
	const before = a.slice();
	limitSlope(a, 1000, 4000, L);
	let inRange = 0; for (let i = 1001; i < 4000; i++) inRange = Math.max(inRange, Math.abs(a[i] - a[i - 1]));
	const outside = same(a.subarray(0, 1000), before.subarray(0, 1000)) && same(a.subarray(4000), before.subarray(4000));
	check(inRange <= c * 1.0001 && outside, '隨機曲線：範圍內合乎限制、範圍外不動', `範圍內最大 ${(inRange / CURVE_HOP_SEC).toFixed(1)} 半音/秒`);
}

// 4) 0 = 不限制
{
	const a = new Float32Array(100); a.fill(5, 50);
	const before = a.slice();
	limitSlope(a, 0, 100, 0);
	check(same(a, before), '上限 0 = 不限制', '');
}
process.exit(failed ? 1 : 0);
