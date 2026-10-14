import assert from 'node:assert/strict';
import { WorkState } from '../src/application/work-state.ts';
import { ProgressView } from '../src/ui/progress.ts';

const work = new WorkState();
const seen = [];
const unsubscribe = work.subscribe(state => seen.push(state));
assert.equal(work.isBusy, false);
for (const kind of ['load', 'project', 'reference', 'render', 'ai', 'export']) {
	const task = work.tryBegin(kind, kind);
	assert.ok(task);
	assert.equal(work.blocksEditing, true);
	for (const conflict of ['load', 'project', 'reference', 'render', 'ai', 'export']) {
		assert.equal(work.tryBegin(conflict, 'duplicate'), null);
	}
	task.update('half', .5);
	assert.equal(work.snapshot.progress.fraction, .5);
	task.finish('failed', true);
	assert.equal(work.blocksEditing, false);
	assert.equal(work.snapshot.progress.error, true);
	task.finish('stale success'); task.update('stale progress', 1);
	assert.equal(work.snapshot.progress.label, 'failed');
}

const bg = work.tryBegin('background', '背景等待中');
assert.equal(work.blocksEditing, false);
assert.equal(work.isBusy, true);
assert.equal(work.canStart('ai'), false);
assert.equal(work.canStart('load'), false);
const render = work.tryBegin('render', '局部算繪');
assert.ok(render);
bg.update('背景 90%', .9);
assert.equal(work.snapshot.progress.label, '局部算繪');
render.finish('算繪完成');
assert.equal(work.snapshot.progress.label, '背景 90%');
assert.equal(work.isBusy, true);

// 匯出等待背景精算時，不能阻止精算開始，也不能允許新的編輯。
const exporting = work.tryBegin('export', '等待精算後匯出');
assert.ok(exporting);
assert.equal(work.blocksEditing, true);
assert.equal(work.blocksBackground, false);
assert.equal(work.snapshot.progress.label, '等待精算後匯出');
bg.finish('精算完成');
assert.equal(work.isBusy, true);
const lastBackground = work.tryBegin('background', '下一段精算');
assert.ok(lastBackground);
lastBackground.finish('精算完成');
exporting.finish('匯出完成');
assert.equal(work.isBusy, false);

// 專案與其子算繪各自完成，不能互相提早解鎖。
const project = work.tryBegin('project', '讀取專案');
const child = work.begin('render', '專案算繪');
project.finish('專案解析完成');
assert.equal(work.blocksEditing, true);
child.update('running', Infinity);
assert.equal(work.snapshot.progress.fraction, null);
child.update('running', 2);
assert.equal(work.snapshot.progress.fraction, 1);
child.finish('完成');
assert.equal(work.isBusy, false);
const old = seen.at(-1);
assert.throws(() => old.kinds.push('load'));
assert.throws(() => { old.progress.label = 'mutated'; });
unsubscribe();
const count = seen.length;
work.begin('reference', '新工作').finish('完成');
assert.equal(seen.length, count);

// 進度條只畫快照；即使沒有掛載畫面，工作管理仍然有效。
const nodes = new Map(['progress', '#progress-label', '.progress-value'].map(k => [k, {
	removeAttribute(name) { delete this[name]; },
}]));
const attributes = new Map(), classes = new Map();
const view = new ProgressView({
	querySelector: key => nodes.get(key),
	setAttribute: (key, value) => attributes.set(key, value),
	classList: { toggle: (key, value) => classes.set(key, value) },
});
assert.equal('begin' in view, false);
assert.equal('isBusy' in view, false);
const stopView = work.subscribe(state => view.render(state.progress));
const task = work.begin('load', '載入');
assert.equal(attributes.get('aria-busy'), 'true');
assert.equal(nodes.get('.progress-value').textContent, '處理中…');
task.update('分析', .5);
assert.equal(nodes.get('.progress-value').textContent, '50%');
task.finish('失敗', true);
assert.equal(attributes.get('aria-busy'), 'false');
assert.equal(classes.get('error'), true);
stopView();
const invisible = work.tryBegin('load', '沒有 UI 也能鎖定');
assert.equal(work.blocksEditing, true);
invisible.finish('完成');
assert.equal(work.isBusy, false);
console.log('PASS: centralized work admission, overlapping lifetimes, background/export policy, immutable snapshots, stale callbacks and presentation-only progress');
