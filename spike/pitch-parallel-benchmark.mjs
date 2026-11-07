import puppeteer from 'puppeteer';
const browser=await puppeteer.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
try{
 const page=await browser.newPage();
 await page.goto('http://127.0.0.1:5180/',{waitUntil:'domcontentloaded'});
 const rows=await page.evaluate(async()=>{
  const {detectPitchParallel}=await import('/src/analysis/pitch-parallel.ts');
  const audio=new Float32Array(360*16000);
  const configs=[[1,1],[2,2],[4,4],[8,4]],rows=[];
  for(const [segmentCount,workerLimit] of configs){let plan;const start=performance.now();
   await detectPitchParallel(audio,{mode:'wasm',segmentCount,workerLimit,forceSegmentCount:true,onPlan:value=>plan=value});
   rows.push({segmentCount,seconds:(performance.now()-start)/1000,segments:plan.segments,workers:plan.workers});
  }
  return rows;
 });
 console.table(rows);
}finally{await browser.close();}
