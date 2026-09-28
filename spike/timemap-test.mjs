// TimeMap 的單元測試：對應、反對應、夾限、刪除。
// 用法：node --experimental-strip-types --import ./tools/ts-resolve.mjs spike/timemap-test.mjs
import { TimeMap } from '../src/model/timemap.ts';

let fails = 0;
const check = (name, pass, detail = '') => {
	if (!pass) fails++;
	console.log(`${pass ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`);
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// 使用者的例子：1s 和 2s 加錨點，把 2s 拉到 3s → 1~2s 拉長一倍
const m = new TimeMap();
const a1 = m.add(1), a2 = m.add(2);
check('加錨點不改變對應', m.isIdentity && near(m.srcToOut(1.5), 1.5));
m.move(a2.id, 3);
check('1~2s 拉長一倍', near(m.srcToOut(1.5), 2) && near(m.ratioAt(1.5), 2), `srcToOut(1.5)=${m.srcToOut(1.5)}`);
check('第一個錨點之前不動', near(m.srcToOut(0.5), 0.5) && near(m.ratioAt(0.5), 1));
check('最後一個錨點之後只平移', near(m.srcToOut(10), 11) && near(m.ratioAt(10), 1));
let roundTrip = 0;
for (let t = 0; t < 12; t += 0.037) roundTrip = Math.max(roundTrip, Math.abs(m.outToSrc(m.srcToOut(t)) - t));
check('outToSrc 是 srcToOut 的反函數', roundTrip < 1e-9, `最大誤差 ${roundTrip}`);

// 不能越過相鄰錨點，但沒有倍率上下限
m.move(a2.id, 0.5);
check('拖不過左邊的錨點', m.get(a2.id).out > m.get(a1.id).out, `a2.out=${m.get(a2.id).out}`);
check('極端壓縮也允許（只剩 1ms）', near(m.ratioAt(1.5), 0.001, 1e-6), `ratio=${m.ratioAt(1.5)}`);
m.move(a2.id, 500);
check('極端拉長也允許', near(m.ratioAt(1.5), 499), `ratio=${m.ratioAt(1.5)}`);
m.move(a1.id, -5);
check('第一個錨點拖不過 0', m.get(a1.id).out > 0);

// 刪除：錨點之間的段落合併，時間回到沒有伸縮的樣子
m.move(a1.id, 1); m.move(a2.id, 3);
m.remove(a2.id);
check('刪掉被拉動的錨點 → 伸縮回復', near(m.srcToOut(1.5), 1.5) && near(m.srcToOut(10), 10));

// 兩段伸縮、刪中間 → 合併成一段
const n = new TimeMap();
const b1 = n.add(1), b2 = n.add(2), b3 = n.add(3);
n.move(b2.id, 2.5); n.move(b3.id, 4);
n.remove(b2.id);
check('刪中間錨點 → 前後兩段合成一段', near(n.ratioAt(1.2), 1.5) && near(n.ratioAt(2.8), 1.5), `ratio ${n.ratioAt(1.2)} / ${n.ratioAt(2.8)}`);
check('clone 與 equals', n.clone().equals(n) && !new TimeMap().equals(n));
check('同一個位置不能重複加錨點', n.add(n.srcToOut(1)) === null);

// 群組移動
{
	const g = new TimeMap();
	const c1 = g.add(1), c2 = g.add(2), c3 = g.add(3), c4 = g.add(4);
	const base = g.clone();
	let d = g.moveGroup(base, new Set([c2.id, c3.id]), 0.5);
	check('群組一起平移', near(d, 0.5) && near(g.get(c2.id).out, 2.5) && near(g.get(c3.id).out, 3.5) && near(g.get(c4.id).out, 4),
		`${g.anchors.map(a => a.out).join(', ')}`);
	d = g.moveGroup(base, new Set([c2.id, c3.id]), 5);
	check('群組被沒選到的右鄰居擋住（整群一起停）', near(g.get(c3.id).out, 4 - 0.001) && near(g.get(c2.id).out, 3 - 0.001), `位移 ${d}`);
	d = g.moveGroup(base, new Set([c1.id, c4.id]), 100);
	// c1 被沒選到的 c2 擋住（最多 +0.999）；整群同一個位移，所以 c4 也只動 0.999
	check('不相鄰的兩個一起動：被最近的限制擋住，整群同一個位移', near(g.get(c1.id).out, 2 - 0.001) && near(g.get(c4.id).out, 4.999),
		`位移 ${d}、c1=${g.get(c1.id).out}、c4=${g.get(c4.id).out}`);
	d = g.moveGroup(base, new Set([c4.id]), 100);
	check('最後一個錨點可以拖到很遠（沒有上限）', near(g.get(c4.id).out, 104), `out=${g.get(c4.id).out}`);
}

console.log(fails ? `\n${fails} 項失敗` : '\n全部通過');
process.exit(fails ? 1 : 0);
