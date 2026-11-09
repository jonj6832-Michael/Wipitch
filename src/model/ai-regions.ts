import { Curves } from './curves';
import type { CorrectionNote } from './auto-pitch';
export interface AIRegion { id:number; from:number; to:number; kind:string; enabled:boolean; edited:boolean; offset:number; formantOffset:number; original:Float32Array; ai:Float32Array; adjusted:Float32Array; originalFormant:Float32Array; aiFormant:Float32Array; adjustedFormant:Float32Array; recordId:string; feedbackType?:'rejected'|'adjusted'; feedbackKey?: { value:string; label:string; capturedAt:string } }
export interface RegionTimeRange { start:number; end:number }

/** 回傳指定時間所在、且不與既有 AI 黃框重疊的可選取區間。黃框採 [start,end)。 */
export function manualSelectionBoundsAt(time:number,blocked:readonly RegionTimeRange[],duration:number):RegionTimeRange|null {
 if(!Number.isFinite(time)||!Number.isFinite(duration)||duration<=0)return null;
 const t=Math.max(0,Math.min(duration,time));let start=0,end=duration;
 for(const range of [...blocked].sort((a,b)=>a.start-b.start)) {
  const a=Math.max(0,Math.min(duration,range.start)),b=Math.max(a,Math.min(duration,range.end));
  if(t>=a&&t<b)return null;
  if(b<=t)start=Math.max(start,b);
  else if(a>t)end=Math.min(end,a);
 }
 return end>start?{start,end}:null;
}
export function createAIRegions(before:Curves,after:Curves,notes:CorrectionNote[]):AIRegion[] {
 return notes.map(n=>({id:n.id,from:n.from,to:n.to,kind:n.kind??'center',enabled:true,edited:false,offset:0,formantOffset:0,original:before.pitch.slice(n.from,n.to),ai:after.pitch.slice(n.from,n.to),adjusted:after.pitch.slice(n.from,n.to),originalFormant:before.formant.slice(n.from,n.to),aiFormant:after.formant.slice(n.from,n.to),adjustedFormant:after.formant.slice(n.from,n.to),recordId:crypto.randomUUID()}));
}
/** AI 審核期間在框外建立的人工黃框；其提案基準就是人工修改前的目前曲線。 */
export function createManualAIRegion(before:Curves,after:Curves,from:number,to:number,id:number):AIRegion {
 const start=Math.max(0,Math.min(before.length,from)),end=Math.max(start,Math.min(before.length,to));
 const region:AIRegion={id,from:start,to:end,kind:'manual',enabled:true,edited:true,offset:0,formantOffset:0,
  original:before.pitch.slice(start,end),ai:before.pitch.slice(start,end),adjusted:after.pitch.slice(start,end),
  originalFormant:before.formant.slice(start,end),aiFormant:before.formant.slice(start,end),adjustedFormant:after.formant.slice(start,end),
  recordId:crypto.randomUUID(),feedbackType:'adjusted'};
 syncAIRegion(region,after);
 region.feedbackType='adjusted';
 return region;
}
export function resetAIRegionToAI(region:AIRegion) {
 region.edited=false;region.offset=0;region.formantOffset=0;region.adjusted=region.ai.slice();region.adjustedFormant=region.aiFormant.slice();
}
export function regionCurves(base:Curves,region:AIRegion,enabled:boolean,offset=region.offset,formantOffset=region.formantOffset) {
 const out=base.clone();const pitch=enabled?region.adjusted:region.original,formant=enabled?region.adjustedFormant:region.originalFormant;
 out.pitch.set(pitch,region.from);out.formant.set(formant,region.from);
 if(enabled&&(offset!==region.offset||formantOffset!==region.formantOffset)) {
  const fade=Math.max(1,Math.min(15,Math.floor(pitch.length/4)));
  for(let j=0;j<pitch.length;j++) {
   const weight=.5-.5*Math.cos(Math.PI*Math.min(1,Math.min(j,pitch.length-1-j)/fade));
   out.pitch[region.from+j]=pitch[j]+(offset-region.offset)*weight;
   out.formant[region.from+j]=formant[j]+(formantOffset-region.formantOffset)*weight;
  }
 }
 return out;
}
export function syncAIRegion(region:AIRegion,curves:Curves) {
 const samePitch=(a:Float32Array)=>a.every((v,i)=>Math.abs(v-curves.pitch[region.from+i])<1e-6);
 const sameFormant=(a:Float32Array)=>a.every((v,i)=>Math.abs(v-curves.formant[region.from+i])<1e-6);
 if(samePitch(region.original)&&sameFormant(region.originalFormant)){region.enabled=false;resetAIRegionToAI(region);return;}
 region.enabled=true;region.edited=!samePitch(region.ai)||!sameFormant(region.aiFormant);
 region.adjusted=curves.pitch.slice(region.from,region.to);
 region.adjustedFormant=curves.formant.slice(region.from,region.to);
 const a=Math.floor(region.ai.length/4),b=Math.ceil(region.ai.length*3/4);
 const differences=Array.from(region.adjusted.slice(a,b),(v,i)=>v-region.ai[a+i]).sort((x,y)=>x-y);
 const formantDifferences=Array.from(region.adjustedFormant.slice(a,b),(v,i)=>v-region.aiFormant[a+i]).sort((x,y)=>x-y);
 region.offset=region.edited&&differences.length ? Math.round(differences[Math.floor(differences.length/2)]*100)/100 : 0;
 region.formantOffset=region.edited&&formantDifferences.length ? Math.round(formantDifferences[Math.floor(formantDifferences.length/2)]*100)/100 : 0;
}

/** 只有使用者在黃框上做過明確決策，才可成為 AI 回饋訓練資料。 */
export function reviewedAIRegions(regions: readonly AIRegion[]): AIRegion[] {
 return regions.filter(region => region.feedbackType === 'rejected' || region.feedbackType === 'adjusted');
}
