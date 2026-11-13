import { CURVE_HOP_SEC, CURVE_SUB } from './curves';
import type { TimeMap } from './timemap';
import { correctionNotes, type CorrectionNote } from './auto-pitch';
import { isInKey, type KeySignature } from './keys';
const median = (a: number[]) => [...a].sort((x,y) => x-y)[Math.floor(a.length/2)];
/** Conservative context rules, not a trained predictor. All edits stay inside range. */
type CorrectionCurveView = { length: number; pitch: Float32Array; timeMap: TimeMap };
export function contextCorrectionNotes(curves: CorrectionCurveView, midi: Float32Array, voiced: Uint8Array, key: KeySignature, range: { start:number; end:number }): CorrectionNote[] {
 const first = Math.max(0, Math.ceil(curves.timeMap.outToSrc(range.start)/CURVE_HOP_SEC));
 const last = Math.min(curves.length, midi.length, voiced.length, Math.ceil(curves.timeMap.outToSrc(range.end)/CURVE_HOP_SEC));
 const pts: { frame:number; value:number; smooth:number; target:number|null }[] = [];
 const contextFirst = Math.max(0, first - 1500), contextLast = Math.min(curves.length, midi.length, voiced.length, last + 1500);
 for (let frame=contextFirst; frame<contextLast; frame+=CURVE_SUB) {
  const value = voiced[frame] ? midi[frame]+curves.pitch[frame] : NaN;
  pts.push({frame,value,smooth:value,target:null});
 }
 for(let i=0;i<pts.length;i++) {
  const window=pts.slice(Math.max(0,i-2),i+3).map(p=>p.value).filter(Number.isFinite);
  pts[i].smooth=Number.isFinite(pts[i].value)&&window.length ? median(window):NaN;
  const values=pts.slice(i,i+10).map(p=>p.value);
  if(values.length===10 && values.every(Number.isFinite)) {
   const center=median(values), target=Math.round(center);
   if(isInKey(target,key)&&Math.abs(center-target)<=.2&&Math.max(...values)-Math.min(...values)<=.3) pts[i].target=target;
  }
 }
 const result: CorrectionNote[]=[];
 function emit(a:number,b:number,target:number,kind:'onset'|'drift') {
  // 候選的「偏離中心」不等於音符的完整範圍。漂移規則常在長音的中段
  // 才成立；若直接使用 a～b，前後仍可辨識為同一音高的部分就會被切掉。
  // 往左右延伸時只接受連續、有聲、且仍落在同一音高容許帶內的資料，
  // 因此不會跨過無聲或明顯換音。
  const initialValues=pts.slice(a,b).map(p=>p.smooth).filter(Number.isFinite);
  const initialCenter=initialValues.length?median(initialValues):NaN;
  const initialSpread=initialValues.length?Math.max(...initialValues)-Math.min(...initialValues):0;
  const tolerance=Math.max(.45,Math.min(.8,initialSpread+.18));
  let expandedA=a,expandedB=b;
  const correctionSign=Math.sign(initialCenter-target);
  const samePitch=(point:{frame:number;smooth:number})=>Number.isFinite(point.smooth)
   &&Math.abs(point.smooth-initialCenter)<=tolerance
   // 不把「已經回準的同音高」誤併入修正區；只有仍在同一偏離方向
   // 的連續資料才算是這個需要修正的長音。
   &&(correctionSign===0 || (Math.abs(point.smooth-target)>=.12
    &&Math.sign(point.smooth-target)===correctionSign));
  while(expandedA>0&&pts[expandedA-1].frame>=first&&samePitch(pts[expandedA-1]))expandedA--;
  while(expandedB<pts.length&&pts[expandedB].frame<last&&samePitch(pts[expandedB]))expandedB++;
  const from=Math.max(first,pts[expandedA].frame),to=Math.min(last,pts[expandedB-1].frame+CURVE_SUB);
  if(to<=from || (to-from)*CURVE_HOP_SEC<.024)return;
  if(result.some(n=>n.from<to&&n.to>from))return;
  const values=pts.slice(expandedA,expandedB).filter(p=>p.frame>=from&&p.frame<to).map(p=>p.smooth);
  const center=median(values);
  if(!Number.isFinite(center)||Math.abs(center-target)<.08||Math.abs(center-target)>1.2)return;
  result.push({id:0,from,to,center,spread:Math.max(...values)-Math.min(...values),targets:[target],defaultTarget:target,kind});
 }
 // An onset must begin at a voiced boundary and converge toward a following stable target.
 for(let a=0;a<pts.length;a++) {
  if(!Number.isFinite(pts[a].value)||(a>0&&Number.isFinite(pts[a-1].value)))continue;
  for(let b=a+2;b<Math.min(pts.length,a+20);b++) {
   const target=pts[b].target;if(target===null)continue;
   const segment=pts.slice(a,b);
   if(!segment.every(p=>Number.isFinite(p.value)))break;
   const distances=segment.map(p=>p.smooth-target);
   if(Math.abs(distances[0])<.18||Math.abs(distances.at(-1)!)>Math.abs(distances[0])+.05)break;
   if(distances.some(v=>v*distances[0]<-.02))break;
   emit(a,b,target,'onset');break;
  }
 }
 // Sustained drift needs the same stable note on both sides; repeated alternating excursions are vibrato.
 for(let a=1;a<pts.length-10;a++) {
  const target=pts[a-10]?.target ?? null;
  if(target===null||!Number.isFinite(pts[a].smooth)||Math.abs(pts[a].smooth-target)<.18||Math.abs(pts[a-1].smooth-target)>=.18)continue;
  let b=a;
  while(b<pts.length && b-a<32 && Number.isFinite(pts[b].smooth)&&Math.abs(pts[b].smooth-target)>.1)b++;
  if(b-a<3||b>=pts.length||pts[b].target!==target)continue;
  const surrounding=pts.slice(Math.max(0,a-30),Math.min(pts.length,b+30));
  let crossings=0,sign=0;
  for(const p of surrounding) { const v=p.smooth-target;if(!Number.isFinite(v)||Math.abs(v)<.08)continue;const next=Math.sign(v);if(sign&&next!==sign)crossings++;sign=next; }
  if(crossings>2)continue;
  emit(a,b,target,'drift');a=b;
 }
 // 檢測範圍尾端可能沒有下一個穩定音；單方向一路漂到範圍結束時仍要保留。
 for(let a=1;a<pts.length-6;a++) {
  const target=pts[a-10]?.target ?? null;
  if(target===null||!Number.isFinite(pts[a-1].smooth)||!Number.isFinite(pts[a].smooth))continue;
  const firstError=pts[a].smooth-target, previousError=pts[a-1].smooth-target;
  const sign=Math.sign(firstError);
  if(!sign||Math.abs(firstError)<.12||Math.abs(firstError)<Math.abs(previousError)+.01)continue;
  let b=a+1;
  while(b<pts.length&&b-a<80&&Number.isFinite(pts[b].smooth)) {
   const error=pts[b].smooth-target;
   if(Math.sign(error)!==sign||Math.abs(error)+.05<Math.abs(pts[b-1].smooth-target))break;
   b++;
  }
  const finalIndex=Math.min(pts.length-1,b-1);
  if(b-a>=6&&pts[finalIndex].frame>=last-CURVE_HOP_SEC&&Math.abs(pts[finalIndex].smooth-target)>=.18) {
   emit(a,b,target,'drift');
  }
 }
 // Retain steady, uniformly off-center note correction; context candidates take precedence.
 const fallback=correctionNotes(curves,midi,voiced,key,range).filter(n=>!result.some(r=>r.from<n.to&&r.to>n.from));
 return [...result,...fallback.map(n=>({...n,kind:'center' as const}))].sort((a,b)=>a.from-b.from).map((n,id)=>({...n,id}));
}
