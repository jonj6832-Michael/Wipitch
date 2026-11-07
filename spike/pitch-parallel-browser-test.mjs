import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
	const page = await browser.newPage();
	const errors=[];page.on('pageerror',error=>errors.push(error.message));
	page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
	await page.goto('http://127.0.0.1:5180/',{waitUntil:'domcontentloaded'});
	const result=await page.evaluate(async()=>{
		const {detectPitchParallel}=await import('/src/analysis/pitch-parallel.ts');
		const rate=16000,duration=4,audio=new Float32Array(rate*duration);
		for(let i=0;i<audio.length;i++)audio[i]=.2*Math.sin(2*Math.PI*440*i/rate);
		// Make three full one-second quiet regions so the tiny test exercises four real Workers.
		audio.fill(0,Math.round(.75*rate),Math.round(1.75*rate));
		audio.fill(0,Math.round(1.75*rate),Math.round(2.75*rate));
		audio.fill(0,Math.round(2.75*rate),Math.round(3.75*rate));
		let plan;
		const started=performance.now();
		const track=await detectPitchParallel(audio,{mode:'wasm',segmentCount:4,minWorkSeconds:.5,
			forceSegmentCount:true,workerLimit:4,onPlan:value=>{plan=value;}});
		return{plan,length:track.length,expected:Math.floor((audio.length-256)/256)+1,
			finite:Array.from(track.f0).every(Number.isFinite),ms:performance.now()-started};
	});
	assert.equal(result.plan.workers,4);assert.equal(result.plan.segments,4);
	assert.equal(result.length,result.expected);assert.equal(result.finite,true);
	assert.deepEqual(errors,[]);
	console.log(`PASS: ${result.plan.workers} persistent SwiftF0 Workers merged ${result.plan.segments} segments in ${(result.ms/1000).toFixed(2)}s`);
}finally{await browser.close();}
