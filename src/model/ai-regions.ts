import { Curves } from './curves';
import type { CorrectionNote } from './auto-pitch';
export interface AIRegion { id:number; from:number; to:number; kind:string; enabled:boolean; edited:boolean; offset:number; original:Float32Array; ai:Float32Array; adjusted:Float32Array; recordId:string; feedbackType?:'rejected'|'adjusted'; feedbackKey?: { value:string; label:string; capturedAt:string } }
export function createAIRegions(before:Curves,after:Curves,notes:CorrectionNote[]):AIRegion[] {
 return notes.map(n=>({id:n.id,from:n.from,to:n.to,kind:n.kind??'center',enabled:true,edited:false,offset:0,original:before.pitch.slice(n.from,n.to),ai:after.pitch.slice(n.from,n.to),adjusted:after.pitch.slice(n.from,n.to),recordId:crypto.randomUUID()}));
}
export function resetAIRegionToAI(region:AIRegion) {
 region.edited=false;region.offset=0;region.adjusted=region.ai.slice();
}
export function regionCurves(base:Curves,region:AIRegion,enabled:boolean,offset=region.offset) {
 const out=base.clone();const pitch=enabled?region.adjusted:region.original;
 out.pitch.set(pitch,region.from);
 if(enabled&&offset!==region.offset) {
  const fade=Math.max(1,Math.min(15,Math.floor(pitch.length/4)));
  for(let j=0;j<pitch.length;j++) {
   const weight=.5-.5*Math.cos(Math.PI*Math.min(1,Math.min(j,pitch.length-1-j)/fade));
   out.pitch[region.from+j]=pitch[j]+(offset-region.offset)*weight;
  }
 }
 return out;
}
export function syncAIRegion(region:AIRegion,curves:Curves) {
 const same=(a:Float32Array)=>a.every((v,i)=>Math.abs(v-curves.pitch[region.from+i])<1e-6);
 if(same(region.original)){region.enabled=false;resetAIRegionToAI(region);return;}
 region.enabled=true;region.edited=!same(region.ai);
 region.adjusted=curves.pitch.slice(region.from,region.to);
 const a=Math.floor(region.ai.length/4),b=Math.ceil(region.ai.length*3/4);
 const differences=Array.from(region.adjusted.slice(a,b),(v,i)=>v-region.ai[a+i]).sort((x,y)=>x-y);
 region.offset=region.edited&&differences.length ? Math.round(differences[Math.floor(differences.length/2)]*100)/100 : 0;
}

/** 只有使用者在黃框上做過明確決策，才可成為 AI 回饋訓練資料。 */
export function reviewedAIRegions(regions: readonly AIRegion[]): AIRegion[] {
 return regions.filter(region => region.feedbackType === 'rejected' || region.feedbackType === 'adjusted');
}
