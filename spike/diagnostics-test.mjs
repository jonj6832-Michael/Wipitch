import assert from 'node:assert/strict';
import { installDiagnostics } from '../src/dev/diagnostics.ts';
import { Curves } from '../src/model/curves.ts';
const target = {}, seeks = [];
let curves = null;
const state = {
 get curves() { return curves; }, source: null, pitchMidi: null, curveVoiced: null,
 view: { secPerPx: 1, startSec: 0, xToTime: x => x, timeToX: t => t },
 player: { seek: t => seeks.push(t) }, renderer: { sampleRate: 1000, rendered: [new Float32Array([1, 2, 3])] },
 el: { pianoroll: { clientWidth: 100 } }, toSrc: t => t,
 waitBackground: async () => {},
};
const diagnostic = installDiagnostics(state, target, '?t=2&span=5');
assert.equal(Object.keys(target).length, 12);
assert.equal(target.__debug(), null);
assert.equal(target.__laneAtX('pitch', 0), null);
curves = new Curves(100);
curves.pitch.fill(2);
assert.deepEqual(target.__laneAtX('pitch', 0), { v: 2, abs: null });
curves = new Curves(100); // Replaced after undo or a new load, never captured once.
assert.equal(target.__laneAtX('pitch', 0).v, 0);
diagnostic.applyViewParams();
assert.equal(state.view.secPerPx, .05);
assert.deepEqual(seeks, [2]);
assert.equal(target.__snapRendered('a', 0, .003), 3);
assert.equal(target.__compareSnap('a', 0).corr, 1);
const compare = target.__compareSnap;
const replacement = () => {};
target.__debug = replacement;
diagnostic.dispose();
assert.deepEqual(Object.keys(target), ['__debug']);
assert.equal(target.__debug, replacement);
assert.equal(compare('a', 0), null); // Audio snapshots released on disposal.
const invalid = installDiagnostics(state, {}, '?t=no&span=-1');
invalid.applyViewParams();
assert.equal(state.view.secPerPx, .06);
assert.equal(state.view.startSec, 0);
invalid.dispose();
console.log('diagnostics: live state, hooks, view parameters, snapshots and disposal passed');
