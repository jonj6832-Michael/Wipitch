import assert from 'node:assert/strict';
import { DetectionBar } from '../src/ui/detection-bar.ts';
import { ViewState } from '../src/view/viewstate.ts';
import { PianoRollView } from '../src/view/pianoroll.ts';
import { KEY_OPTIONS } from '../src/model/keys.ts';
import { Curves, CURVE_SUB } from '../src/model/curves.ts';
import { midiToHz } from '../src/analysis/swiftf0.ts';

const buttons = ['start', 'end'].map(edge => ({dataset:{edge},setAttribute(){}}));
const thumb = {style:{},hidden:true,querySelectorAll:()=>buttons};
const events = new Map();
const root = {firstElementChild:thumb,addEventListener:(name,fn)=>events.set(name,fn),getBoundingClientRect:()=>({left:72}),setPointerCapture(){},hasPointerCapture:()=>true,releasePointerCapture(){}};
const view = new ViewState(); view.duration=10;view.secPerPx=.01;
let duration=10;let changed=null;
const bar = new DetectionBar(root,view,()=>duration,r=>changed=r);
const send = (name,props={}) => events.get(name)({button:0,pointerId:1,preventDefault(){},stopPropagation(){},target:{dataset:{}},...props});
send('pointerdown',{clientX:272});send('pointermove',{clientX:572});send('pointerup');
assert.deepEqual(changed,{start:2,end:5});
send('pointerdown',{clientX:272,target:buttons[0]});send('pointermove',{clientX:172});send('pointerup');
assert.deepEqual(changed,{start:1,end:5});
thumb.dataset={};send('pointerdown',{clientX:372,target:thumb});send('pointermove',{clientX:472});send('pointerup');
assert.deepEqual(changed,{start:2,end:6});
send('keydown',{key:'ArrowRight',target:buttons[1]});assert.equal(changed.end,6.1);
send('pointerdown',{clientX:372});send('pointermove',{clientX:472});send('pointercancel');assert.equal(changed.end,6.1);
view.startSec=1;bar.sync();assert.equal(thumb.style.left,'100px');
duration=3;bar.sync();assert.deepEqual(changed,{start:2,end:3});
bar.set(null);assert.equal(thumb.hidden,true);

let strokes=[];let path=[];
const ctx={strokeStyle:'',beginPath(){path=[]},moveTo(x,y){path.push(['M',x,y])},lineTo(x,y){path.push(['L',x,y])},stroke(){strokes.push({color:this.strokeStyle,path:[...path]})}};
const pv=new ViewState();pv.duration=1;pv.secPerPx=.001;
const piano=new PianoRollView({getContext:()=>ctx},pv,{setAttribute(){}});
const n=20;
const track={f0:new Float32Array(n).fill(midiToHz(60.75)),confidence:new Float32Array(n).fill(1),voiced:new Uint8Array(n).fill(1),length:n};
piano.setTrack(track);piano.setKeyFilter(KEY_OPTIONS.find(k=>k.id==='major-0'));
piano.detectionRange={start:.04,end:.09};
function draw(curves=null,map=null,detect=true){strokes=[];piano.drawContour(400,200,curves,'#5ac8fa',2,map,detect);return strokes.filter(s=>s.path.some(p=>p[0]==='L'));}
let result=draw();let red=result.filter(s=>s.color==='#ff6b6b');assert.ok(red.length);
for(const stroke of red)for(const [,x] of stroke.path)assert.ok(x>=40-1e-8&&x<=90+1e-8);
assert.ok(result.some(s=>s.color==='#5ac8fa'));
assert.ok(draw(null,null,false).every(s=>s.color==='#5ac8fa')); // 原始對照線不染色
const edits=new Curves(n*CURVE_SUB);edits.pitch.fill(-.75);
assert.ok(draw(edits).every(s=>s.color==='#5ac8fa')); // 修正後回到原色
track.f0.fill(midiToHz(61.25));piano.setTrack(track);
assert.ok(draw().some(s=>s.color==='#65d68c'));
const map={srcToOut:t=>t*2,outToSrc:t=>t/2,ratioAt:()=>2};
for(const stroke of draw(null,map).filter(s=>s.color!=='#5ac8fa'))for(const [,x] of stroke.path)assert.ok(x>=40-1e-8&&x<=90+1e-8);
piano.setKeyFilter(null);assert.ok(draw().every(s=>s.color==='#5ac8fa'));
piano.setKeyFilter(KEY_OPTIONS[0]);track.voiced.fill(0);piano.setTrack(track);assert.equal(draw().length,0);
console.log('PASS: independent range, endpoint/move/keyboard/cancel, zoom alignment, clamp/clear, red/green, boundaries, corrected pitch, time stretch, all-notes bypass, silence');
