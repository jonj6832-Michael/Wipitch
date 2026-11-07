import type { AIRegion } from '../model/ai-regions';
import { Curves } from '../model/curves';
export class AIRegionOverlay {
 private root:HTMLDivElement;
 private items=new Map<number,{box:HTMLDivElement;check:HTMLInputElement;formant:HTMLInputElement;formantOut:HTMLOutputElement;pendingEnabled:null|boolean;pendingEdited:null|boolean}>();
 private range={lo:0,hi:1};
 private height=1;
 constructor(parent:HTMLElement,private change:(r:AIRegion,enabled:boolean,offset:number,formantOffset:number)=>Promise<void>,
  private preview?:(r:AIRegion|null,enabled?:boolean,offset?:number,formantOffset?:number)=>void) {
  this.root=document.createElement('div');this.root.className='ai-regions';parent.appendChild(this.root);
 }
 /** 黃框收到的滾輪／觸控板事件會冒泡到這裡，供應用層沿用時間軸縮放手勢。 */
 get gestureTarget(): HTMLElement { return this.root; }
 clear(){this.preview?.(null);this.root.replaceChildren();this.items.clear();}
 draw(regions:AIRegion[],curves:Curves,_midi:Float32Array,x:(t:number)=>number,range:{lo:number;hi:number},height:number,locked:boolean) {
  this.range=range;this.height=height;
  for(const region of regions) {
   let item=this.items.get(region.id);
   if(!item){
    const box=document.createElement('div');box.className='ai-region';
    const tools=document.createElement('div');tools.className='ai-region-tools';
    const label=document.createElement('label');const check=document.createElement('input');check.type='checkbox';check.setAttribute('aria-label',`${region.kind==='onset'?'起音':region.kind==='drift'?'長音':'音高'}修正`);
    const mark=document.createElement('span');mark.className='ai-region-edited-mark';mark.textContent='●';mark.title='此區域已人工修改';mark.setAttribute('aria-label','已人工修改');label.append(check,mark);
    tools.append(label);
    const formantBox=document.createElement('label');formantBox.className='ai-region-formant';formantBox.title='左右拖曳調整此區域的 Formant';
    const formantLabel=document.createElement('span');formantLabel.textContent='F';
    const formant=document.createElement('input');formant.type='range';formant.min='-12';formant.max='12';formant.step='.1';formant.setAttribute('aria-label','此 AI 修正區域的 Formant');
    const formantOut=document.createElement('output');formantBox.append(formantLabel,formant,formantOut);
    box.append(tools,formantBox);box.tabIndex=0;box.setAttribute('role','group');
    box.setAttribute('aria-label','AI 修正區域；上下拖曳調整音高，底部滑桿調整 Formant');
    this.root.appendChild(box);item={box,check,formant,formantOut,pendingEnabled:null,pendingEdited:null};this.items.set(region.id,item);
    check.addEventListener('change',()=>{
     const enabled=check.checked,offset=enabled?region.offset:0,formantOffset=enabled?region.formantOffset:0;
     item!.pendingEnabled=enabled;item!.pendingEdited=false;this.preview?.(region,enabled,offset,formantOffset);
     void this.change(region,enabled,offset,formantOffset).finally(()=>{item!.pendingEnabled=item!.pendingEdited=null;this.preview?.(null);});
    });
    formant.addEventListener('input',()=>{
     const value=Number.parseFloat(formant.value)||0;formantOut.textContent=`${value>=0?'+':''}${value.toFixed(1)}`;
     item!.pendingEdited=Math.abs(value)>1e-6;this.preview?.(region,true,region.offset,value);
    });
    formant.addEventListener('change',()=>{
     const value=Number.parseFloat(formant.value)||0;
     void this.change(region,true,region.offset,value).finally(()=>{item!.pendingEdited=null;this.preview?.(null);});
    });
    let drag:{pointerId:number;startY:number;startOffset:number}|null=null;
    box.addEventListener('pointerdown',event=>{
     if((event.target as Element).closest('.ai-region-tools,.ai-region-formant')||check.disabled||!region.enabled)return;
     drag={pointerId:event.pointerId,startY:event.clientY,startOffset:region.offset};
     box.setPointerCapture(event.pointerId);box.classList.add('dragging');event.preventDefault();
    });
    box.addEventListener('pointermove',event=>{
     if(!drag||event.pointerId!==drag.pointerId)return;
     const semitones=(drag.startY-event.clientY)/Math.max(1,this.height)*(this.range.hi-this.range.lo);
     const offset=Math.max(-12,Math.min(12,Math.round((drag.startOffset+semitones)*100)/100));
     box.dataset.drag=`${offset>=0?'+':''}${offset.toFixed(2)} 半音`;
     item!.pendingEdited=Math.abs(offset)>1e-6;this.preview?.(region,true,offset);
    });
    box.addEventListener('pointerup',event=>{
     if(!drag||event.pointerId!==drag.pointerId)return;
     const semitones=(drag.startY-event.clientY)/Math.max(1,this.height)*(this.range.hi-this.range.lo);
     const offset=Math.max(-12,Math.min(12,Math.round((drag.startOffset+semitones)*100)/100));
     drag=null;delete box.dataset.drag;box.classList.remove('dragging');box.releasePointerCapture(event.pointerId);
     if(offset!==region.offset)void this.change(region,true,offset,region.formantOffset).finally(()=>{item!.pendingEdited=null;this.preview?.(null);});
     else {item!.pendingEdited=null;this.preview?.(null);}
    });
    box.addEventListener('pointercancel',()=>{drag=null;delete box.dataset.drag;box.classList.remove('dragging');item!.pendingEdited=null;this.preview?.(null);});
    box.addEventListener('keydown',event=>{
     if(check.disabled||!region.enabled||!['ArrowUp','ArrowDown'].includes(event.key))return;
     event.preventDefault();const step=event.shiftKey?1:.1;
     const offset=Math.max(-12,Math.min(12,Math.round((region.offset+(event.key==='ArrowUp'?step:-step))*100)/100));
     item!.pendingEdited=Math.abs(offset)>1e-6;this.preview?.(region,true,offset);
     void this.change(region,true,offset,region.formantOffset).finally(()=>{item!.pendingEdited=null;this.preview?.(null);});
    });
   }
   const left=x(curves.timeMap.srcToOut(Curves.frameToTime(region.from))),right=x(curves.timeMap.srcToOut(Curves.frameToTime(region.to)));
   Object.assign(item.box.style,{left:`${left}px`,width:`${Math.max(2,right-left)}px`,top:'0px',height:`${height}px`});
   const enabled=item.pendingEnabled??region.enabled,edited=item.pendingEdited??region.edited;
   item.check.checked=enabled;item.check.disabled=locked;
   if(document.activeElement!==item.formant)item.formant.value=String(region.formantOffset);
   item.formant.disabled=locked||!enabled;item.formantOut.textContent=`${region.formantOffset>=0?'+':''}${region.formantOffset.toFixed(1)}`;
   item.box.classList.toggle('disabled',locked||!enabled);
   item.box.classList.toggle('human-edited',edited);item.box.classList.toggle('rejected',!enabled);
  }
 }
}
