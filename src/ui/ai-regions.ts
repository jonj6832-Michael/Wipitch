import type { AIRegion } from '../model/ai-regions';
import { Curves } from '../model/curves';
export class AIRegionOverlay {
 private root:HTMLDivElement;
 private items=new Map<number,{box:HTMLDivElement;check:HTMLInputElement;pendingEnabled:null|boolean;pendingEdited:null|boolean}>();
 private range={lo:0,hi:1};
 private height=1;
 constructor(parent:HTMLElement,private change:(r:AIRegion,enabled:boolean,offset:number)=>Promise<void>,
  private preview?:(r:AIRegion|null,enabled?:boolean,offset?:number)=>void) {
  this.root=document.createElement('div');this.root.className='ai-regions';parent.appendChild(this.root);
 }
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
    tools.append(label);box.appendChild(tools);box.tabIndex=0;box.setAttribute('role','group');
    box.setAttribute('aria-label','AI 修正區域；上下拖曳調整音高');
    this.root.appendChild(box);item={box,check,pendingEnabled:null,pendingEdited:null};this.items.set(region.id,item);
    check.addEventListener('change',()=>{
     const enabled=check.checked,offset=enabled?region.offset:0;
     item!.pendingEnabled=enabled;item!.pendingEdited=false;this.preview?.(region,enabled,offset);
     void this.change(region,enabled,offset).finally(()=>{item!.pendingEnabled=item!.pendingEdited=null;this.preview?.(null);});
    });
    let drag:{pointerId:number;startY:number;startOffset:number}|null=null;
    box.addEventListener('pointerdown',event=>{
     if((event.target as Element).closest('.ai-region-tools')||check.disabled||!region.enabled)return;
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
     if(offset!==region.offset)void this.change(region,true,offset).finally(()=>{item!.pendingEdited=null;this.preview?.(null);});
     else {item!.pendingEdited=null;this.preview?.(null);}
    });
    box.addEventListener('pointercancel',()=>{drag=null;delete box.dataset.drag;box.classList.remove('dragging');item!.pendingEdited=null;this.preview?.(null);});
    box.addEventListener('keydown',event=>{
     if(check.disabled||!region.enabled||!['ArrowUp','ArrowDown'].includes(event.key))return;
     event.preventDefault();const step=event.shiftKey?1:.1;
     const offset=Math.max(-12,Math.min(12,Math.round((region.offset+(event.key==='ArrowUp'?step:-step))*100)/100));
     item!.pendingEdited=Math.abs(offset)>1e-6;this.preview?.(region,true,offset);
     void this.change(region,true,offset).finally(()=>{item!.pendingEdited=null;this.preview?.(null);});
    });
   }
   const left=x(curves.timeMap.srcToOut(Curves.frameToTime(region.from))),right=x(curves.timeMap.srcToOut(Curves.frameToTime(region.to)));
   Object.assign(item.box.style,{left:`${left}px`,width:`${Math.max(2,right-left)}px`,top:'0px',height:`${height}px`});
   const enabled=item.pendingEnabled??region.enabled,edited=item.pendingEdited??region.edited;
   item.check.checked=enabled;item.check.disabled=locked;
   item.box.classList.toggle('disabled',locked||!enabled);
   item.box.classList.toggle('human-edited',edited);item.box.classList.toggle('rejected',!enabled);
  }
 }
}
