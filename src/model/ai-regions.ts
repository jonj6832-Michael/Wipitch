import { Curves } from './curves';
import type { CorrectionNote } from './auto-pitch';
export interface AIRegion { id:number; from:number; to:number; kind:string; enabled:boolean; edited:boolean; offset:number; formantOffset:number; original:Float32Array; ai:Float32Array; adjusted:Float32Array; originalFormant:Float32Array; aiFormant:Float32Array; adjustedFormant:Float32Array; recordId:string; feedbackType?:'rejected'|'adjusted'; feedbackKey?: { value:string; label:string; capturedAt:string } }
export function createAIRegions(before:Curves,after:Curves,notes:CorrectionNote[]):AIRegion[] {
 return notes.map(n=>({id:n.id,from:n.from,to:n.to,kind:n.kind??'center',enabled:true,edited:false,offset:0,formantOffset:0,original:before.pitch.slice(n.from,n.to),ai:after.pitch.slice(n.from,n.to),adjusted:after.pitch.slice(n.from,n.to),originalFormant:before.formant.slice(n.from,n.to),aiFormant:after.formant.slice(n.from,n.to),adjustedFormant:after.formant.slice(n.from,n.to),recordId:crypto.randomUUID()}));
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
