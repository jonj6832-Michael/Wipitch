import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
const audioPath=process.argv[2],mode=process.argv[3]??'wasm';if(!audioPath)throw new Error('usage: node spike/pitch-large-browser-test.mjs <audio.wav> [wasm|gpu]');
const browser=await puppeteer.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
try{
 const page=await browser.newPage();const errors=[],warnings=[];
 page.on('pageerror',error=>errors.push(error.message));
 page.on('console',message=>{if(message.type()==='error'){const text=message.text();text.includes('[W:onnxruntime:')?warnings.push(text):errors.push(text);}});
 await page.goto('http://127.0.0.1:5180/',{waitUntil:'domcontentloaded'});
 await page.select('#compute-mode',mode==='gpu'?'gpu':'wasm');
 await page.$eval('#compute-mode',element=>element.dispatchEvent(new Event('change',{bubbles:true})));
 const started=Date.now();const input=await page.$('#file');await input.uploadFile(audioPath);
 await page.waitForFunction(()=>!document.querySelector('#export')?.disabled,{timeout:240000,polling:500});
 const report=await page.$eval('#load-timings pre',element=>element.textContent||'');
 const plan=report.match(/音高分段：(\d+) 段／(\d+) Worker（瀏覽器回報 (\d+) CPU 工作槽）/);
 assert.ok(plan,'missing pitch plan');if(mode==='wasm'){assert.equal(plan[1],plan[2]);assert.equal(plan[2],plan[3]);}assert.deepEqual(errors,[]);
 console.log(`PASS: ${mode} WAV completed in ${((Date.now()-started)/1000).toFixed(2)}s (${warnings.length} ONNX provider warnings)\n${report}`);
}finally{await browser.close();}
