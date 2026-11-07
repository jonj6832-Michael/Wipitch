import fs from 'node:fs';
import path from 'node:path';
import { createReferenceCache, findOnset, trackBars } from '../src/analysis/reference-cache.ts';
import { estimateReferenceTempo } from '../src/analysis/reference-tempo.ts';

const guitarPath = 'A:\\吉他NUX 21_001_3.wav';
const vocalPath = 'A:\\主領25_001_3.wav';
const reportPath = path.resolve('reports/reference-beat-real-audio.json');
const markdownPath = path.resolve('reports/reference-beat-real-audio.md');

function readWavMetadata(filePath) {

  const fd = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(12);
    fs.readSync(fd, header, 0, 12, 0);
    if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error(`${filePath}: 不是 RIFF/WAVE`);
    }
    let offset = 12, fmt = null, data = null;
    while (offset + 8 <= header.readUInt32LE(4) + 8) {
      const chunkHead = Buffer.alloc(8);
      fs.readSync(fd, chunkHead, 0, 8, offset);
      const id = chunkHead.toString('ascii', 0, 4), size = chunkHead.readUInt32LE(4), body = offset + 8;
      if (id === 'fmt ') {
        const b = Buffer.alloc(Math.min(size, 40)); fs.readSync(fd, b, 0, b.length, body);
        fmt = { formatCode:b.readUInt16LE(0), channels:b.readUInt16LE(2), sampleRate:b.readUInt32LE(4), byteRate:b.readUInt32LE(8), blockAlign:b.readUInt16LE(12), bitsPerSample:b.readUInt16LE(14), fmtHex:b.toString('hex') };
      }
      if (id === 'data') data = { offset:body, bytes:size };
      offset = body + size + (size & 1);
    }
    if (!fmt || !data) throw new Error(`${filePath}: 缺少 fmt 或 data chunk`);
    const durationSec = data.bytes / fmt.byteRate;
    return { filePath, fileBytes:fs.statSync(filePath).size, ...fmt, dataBytes:data.bytes, dataOffset:data.offset, durationSec };
  } finally { fs.closeSync(fd); }
}

function decodePcm24Mono(filePath, meta) {
  if (meta.formatCode !== 1 || meta.channels !== 1 || meta.bitsPerSample !== 24 || meta.blockAlign !== 3) {
    throw new Error(`僅支援 PCM24 mono，此檔為 format=${meta.formatCode}, channels=${meta.channels}, bits=${meta.bitsPerSample}`);
  }
  const sampleCount = Math.floor(meta.dataBytes / 3);
  const samples = new Float32Array(sampleCount);
  const fd = fs.openSync(filePath, 'r');
  const chunkBytes = 3 * 1_000_000;
  let readOffset = 0, sampleOffset = 0;
  try {
    while (readOffset < meta.dataBytes) {
      const len = Math.min(chunkBytes, meta.dataBytes - readOffset);
      const raw = Buffer.allocUnsafe(len);
      let got = 0;
      while (got < len) got += fs.readSync(fd, raw, got, len - got, meta.dataOffset + readOffset + got);
      for (let p = 0; p < len; p += 3) samples[sampleOffset++] = raw.readIntLE(p, 3) / 8388608;
      readOffset += len;
      if (readOffset % (30 * 3_000_000) === 0 || readOffset === meta.dataBytes) console.log(`PCM24 解碼：${(readOffset / meta.dataBytes * 100).toFixed(0)}%`);
    }
  } finally { fs.closeSync(fd); }
  return samples;
}

const guitar = readWavMetadata(guitarPath);
const vocal = readWavMetadata(vocalPath);
console.log('吉他 WAV metadata', guitar);
console.log('主領 WAV metadata', vocal);
if (guitar.sampleRate !== 48_000 || guitar.durationSec < 90) throw new Error('吉他 WAV 不符合預期的 48 kHz 長音檔');
const guitarSamples = decodePcm24Mono(guitarPath, guitar);
console.log('建立實際參考節拍 cache…');
const cache = createReferenceCache([guitarSamples], guitar.sampleRate);

// 在前 30 秒（略過最前端）找最強起音；模擬使用者將紅線放在起音後 0.2 秒。
let strongest = { sec:0, score:-1 };
for (let i = 200; i < Math.min(cache.onsets.length, 3000); i++) {
  if (cache.onsets[i] > strongest.score) strongest = { sec:i / 100, score:cache.onsets[i] };
}
const redlineSec = strongest.sec + 0.2;
const onsetAtAnchor = findOnset(cache, redlineSec, 0.5);
if (onsetAtAnchor === null) throw new Error(`紅線 ${redlineSec.toFixed(2)} 秒的 ±0.5 秒範圍內找不到起音`);
const anchorSec = onsetAtAnchor;
const tempo = estimateReferenceTempo([cache.mono16k], 16_000, anchorSec, 120);
const usedBpm = tempo ?? 120;

function summarizeBars(bars, start, end) {
  const intervals = bars.slice(1).map((t, i) => t - bars[i]);
  const sortedIntervals = [...intervals].sort((a,b)=>a-b);
  const median = sortedIntervals.length ? sortedIntervals[Math.floor(sortedIntervals.length / 2)] : null;
  return {
    count:bars.length, firstSec:bars[0] ?? null, lastSec:bars.at(-1) ?? null,
    medianIntervalSec:median,
    validMonotonic:bars.every((t,i)=>Number.isFinite(t) && (i === 0 || t > bars[i-1])),
    validBounds:bars.every(t=>t >= start && t <= end),
  };
}
const fullRange = [0, cache.duration];
const shortRange = [30, 90];
const meterResults = {};
for (const meter of ['4/4','3/4','2/2']) {
  const fullBars = trackBars(cache, anchorSec, usedBpm, meter, ...fullRange);
  const shortBars = trackBars(cache, anchorSec, usedBpm, meter, ...shortRange);
  meterResults[meter] = {
    full: { ...summarizeBars(fullBars, ...fullRange), barStartsSec:fullBars },
    range30to90Sec: { ...summarizeBars(shortBars, ...shortRange), barStartsSec:shortBars },
  };
}
const result = {
  test: 'reference beat tracking on real audio; pitch analysis excluded',
  generatedAt: new Date().toISOString(),
  input: { guitar, vocal, durationDifferenceSec:Math.abs(guitar.durationSec-vocal.durationSec), metadataOnlyForVocal:true },
  method: {
    decoder:'RIFF chunk parser + signed PCM 24-bit little-endian / 8388608',
    cache:'src/analysis/reference-cache.ts createReferenceCache',
    anchorSelection:'strongest onset bin in guitar first 30 s after 2 s; simulated red line placed +0.2 s, then findOnset result becomes confirmed anchor',
    anchorOnsetFinder:'src/analysis/reference-cache.ts findOnset(center=redlineSec, radius=0.5 s); confirmed result is passed to tempo and bar tracking',
    tempoEstimator:'src/analysis/reference-tempo.ts estimateReferenceTempo(roughBpm=120)',
    barTracker:'src/analysis/reference-cache.ts trackBars',
  },
  tempo:{ roughBpm:120, estimatedBpm:tempo, usedBpm, meterNote:'Recorded exactly as passed to current algorithm; results are candidate bar markers.' },
  anchor:{ first30sStrongestOnsetSec:strongest.sec, onsetStrength:strongest.score, redlineSec, searchWindowSec:[Math.max(0,redlineSec-.5),redlineSec+.5], confirmedAnchorSec:anchorSec, anchorSec, foundOnsetSec:onsetAtAnchor, onsetDeltaFromRedlineSec:onsetAtAnchor-redlineSec, foundWithinSearchWindow:Math.abs(onsetAtAnchor-redlineSec)<=.5 },
  ranges:{ fullTrackSec:fullRange, fixed30to90Sec:shortRange },
  meters:meterResults,
  limitations:['拍點皆為演算法候選，沒有人工標註，不能宣稱準確率。','未執行任何音高偵測或音高分析。','主領 WAV 僅讀 RIFF/WAV metadata，未解碼、未分析。','此項是 Node 本機模組測試，非 Chrome UI 測試；UI 測試因 Computer Use 無法確認瀏覽器 URL 而停止。'],
};
for (const [meter, data] of Object.entries(meterResults)) {
  for (const [range, summary] of Object.entries(data)) {
    if (!summary.count || !summary.validMonotonic || !summary.validBounds) throw new Error(`驗證失敗：${meter} ${range} ${JSON.stringify(summary)}`);
  }
}
if (!result.anchor.foundWithinSearchWindow || !result.meters['4/4'].range30to90Sec.count) throw new Error('錨點視窗或 30–90 秒小節結果驗證失敗');
fs.mkdirSync(path.dirname(reportPath), { recursive:true });
fs.writeFileSync(reportPath, JSON.stringify(result, null, 2) + '\n');
const md = [
  '# 實音節拍模組測試', '',
  `- 吉他：${path.basename(guitarPath)}，${guitar.channels} 聲道、${guitar.sampleRate} Hz、PCM ${guitar.bitsPerSample} bit，${guitar.durationSec.toFixed(2)} 秒。`,
  `- 主領：${path.basename(vocalPath)} metadata 時長 ${vocal.durationSec.toFixed(2)} 秒；與吉他相差 ${result.input.durationDifferenceSec.toFixed(4)} 秒。主領音訊未解碼。`,
  `- 模擬紅線：前 30 秒最強起音 ${strongest.sec.toFixed(2)} 秒後 0.20 秒，紅線 ${redlineSec.toFixed(2)} 秒；±0.5 秒找到並確認錨點 ${anchorSec.toFixed(2)} 秒（相對紅線 ${result.anchor.onsetDeltaFromRedlineSec.toFixed(2)} 秒）。BPM 與小節追蹤均使用確認錨點。`,
  `- BPM：粗估輸入 120；演算法估計 ${tempo ?? '無'}；實際追蹤使用 ${usedBpm} BPM。`,
  '', '| 拍號 | 全長小節標記數 | 全長時間範圍 | 30–90 秒標記數 | 30–90 秒範圍 | 單調/界限驗證 |', '|---|---:|---|---:|---|---|',
  ...Object.entries(meterResults).map(([m,d])=>`| ${m} | ${d.full.count} | ${d.full.firstSec?.toFixed(2)}–${d.full.lastSec?.toFixed(2)} s | ${d.range30to90Sec.count} | ${d.range30to90Sec.firstSec?.toFixed(2)}–${d.range30to90Sec.lastSec?.toFixed(2)} s | 通過 |`),
  '', '所有輸出拍點均為演算法候選；沒有人工標註，因此不代表準確率。未執行音高分析。本結果為本機 Node 模組測試，非瀏覽器 UI 測試；UI 測試因 Computer Use 無法確認瀏覽器 URL 而停止。', '', '完整逐點數據見 [`reference-beat-real-audio.json`](./reference-beat-real-audio.json)。',
].join('\n');
fs.writeFileSync(markdownPath, md + '\n');
console.log(`完成：${reportPath}`);
console.log(`完成：${markdownPath}`);
console.log(md);
