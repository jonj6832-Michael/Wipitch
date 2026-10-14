interface Entry { category?: string; assetId: string; id: string; name: string; operation?: string; key?: string; createdAt?: string; clip?: { start: number; end: number }; error?: string; review: { status: string; note: string } }
async function request(data: object) {
 const config = await fetch('/__training/config');
 if (!config.ok) throw new Error('請使用本機啟動檔開啟資料庫管理');
 const { token } = await config.json();
 const response = await fetch('/__training/library', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Training-Token': token }, body: JSON.stringify(data) });
 const result = await response.json(); if (!response.ok) throw new Error(result.error ?? '讀取失敗'); return result;
}
export function installTrainingLibrary(button: HTMLElement) {
 const dialog = document.createElement('dialog'); dialog.id = 'training-library';
 dialog.setAttribute('aria-label', '訓練資料庫管理');
 dialog.innerHTML = `<div class="library-heading"><h2>訓練資料庫管理</h2><button data-close>關閉</button></div>
 <p>檢視已正式保存的記錄：灰色為修改前，藍／紅／綠為修改後。MP3 與圖片依記錄時間對應；此處不自動判定音高正確性。</p>
 <div class="library-toolbar"><input type="search" placeholder="搜尋音檔、Key 或操作" aria-label="搜尋訓練記錄"><button data-refresh>重新整理</button></div>
 <p data-message role="status"></p><div class="library-body"><nav aria-label="訓練記錄"></nav><section data-detail>請選擇一筆記錄</section></div>`;
 document.body.appendChild(dialog);
 const message = dialog.querySelector<HTMLElement>('[data-message]')!;
 const list = dialog.querySelector('nav')!;
 const detail = dialog.querySelector<HTMLElement>('[data-detail]')!;
 const search = dialog.querySelector<HTMLInputElement>('input')!;
 let entries: Entry[] = [], revision = 0;
 const urls: string[] = [];
 function release() { detail.querySelectorAll('audio').forEach(audio => audio.pause()); urls.splice(0).forEach(url => URL.revokeObjectURL(url)); }
 function mediaUrl(encoded: string, type: string) {
  const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type })); urls.push(url); return url;
 }
 function text(tag: string, value: string, parent: HTMLElement = detail) { const el = document.createElement(tag); el.textContent = value; parent.appendChild(el); return el; }
 async function select(entry: Entry) {
  const current = ++revision; release(); detail.replaceChildren(); text('p', '讀取記錄…');
  try {
   const data = await request({ action: 'get', assetId: entry.assetId, id: entry.id, category: entry.category });
   if (current !== revision || !dialog.open) return;
   detail.replaceChildren();
   const record = data.record;
   text('h3', entry.name);
   text('p', `${record.operation ?? '手動修音'} · Key：${record.keySelection?.label ?? record.key?.label ?? '全部音'} · ${record.clip?.start?.toFixed(3)}～${record.clip?.end?.toFixed(3)} 秒`);
   text('p', `記錄：${entry.id} · ${record.createdAt ?? ''}`);
   const audioRow = text('div', ''); audioRow.className = 'library-audio';
   for (const [file, label] of [['before.mp3', '修改前聲音'], ['after.mp3', '修改後聲音']]) {
    const box = text('div', '', audioRow); text('h4', label, box);
    if (data.media[file]) { const audio = document.createElement('audio'); audio.controls = true; audio.preload = 'metadata'; audio.src = mediaUrl(data.media[file], 'audio/mpeg');
     audio.addEventListener('play', () => detail.querySelectorAll('audio').forEach(other => { if (other !== audio) other.pause(); })); box.appendChild(audio); }
    else text('p', '缺少音訊', box);
   }
   for (const file of ['pitch.png', 'before.png', 'after.png']) if (data.media[file]) {
    text('h4', file === 'pitch.png' ? '修改前後音高疊圖' : file === 'before.png' ? '修改前音高圖' : '修改後音高圖');
    const img = document.createElement('img'); img.alt = file; img.src = mediaUrl(data.media[file], 'image/png'); detail.appendChild(img);
   }
   if (record.image) text('p', `圖片時間：${record.image.start ?? record.clip.start}～${record.image.end ?? record.clip.end} 秒；音訊時間從 ${record.clip.start} 秒開始。`);
   if (data.missing.length) text('p', `檔案不完整：${data.missing.join('、')}`);
   const table = document.createElement('table'); table.innerHTML = '<thead><tr><th>y 像素</th><th>音名</th><th>MIDI</th><th>Hz</th></tr></thead>';
   const body = document.createElement('tbody');
   for (const row of record.image?.rows ?? []) { const tr = document.createElement('tr'); for (const value of [Number(row.y).toFixed(1), row.note, row.midi, Number(row.frequencyHz).toFixed(2)]) { const td = document.createElement('td'); td.textContent = String(value); tr.appendChild(td); } body.appendChild(tr); }
   table.appendChild(body); detail.appendChild(table);
   const statusLabel = text('label', '訓練審核狀態 ');
   const status = document.createElement('select');
   for (const [value, label] of [['unreviewed','尚未審核'],['approved','認可作為訓練參考'],['excluded','排除訓練']]) status.add(new Option(label, value));
   status.value = data.review.status; statusLabel.appendChild(status);
   const note = document.createElement('textarea'); note.placeholder = '記錄這次修正的原因或聽感'; note.setAttribute('aria-label', '修正經驗備註'); note.maxLength = 4000; note.value = data.review.note; detail.appendChild(note);
   const save = document.createElement('button'); save.textContent = '儲存審核與備註'; detail.appendChild(save);
   save.addEventListener('click', async () => { save.disabled = true; try { await request({ action:'review', assetId:entry.assetId, id:entry.id, category:entry.category, status:status.value, note:note.value }); entry.review = { status:status.value, note:note.value }; renderList(); message.textContent = '審核與備註已保存'; } catch(e) { message.textContent = String(e); } finally { save.disabled = false; } });
   const extra = document.createElement('details'); text('summary', '詳細對應資料（含選取範圍、Key 與逐點音高）', extra); text('pre', JSON.stringify(record, null, 2), extra); detail.appendChild(extra);
  } catch(e) { if (current === revision) { detail.replaceChildren(); text('p', `讀取失敗：${String(e)}`); } }
 }
 function renderList() {
  list.replaceChildren(); const query = search.value.trim().toLowerCase();
  for (const entry of entries.filter(e => `${e.name} ${e.key} ${e.operation}`.toLowerCase().includes(query))) {
   const item = document.createElement('button'); item.textContent = `${entry.category ? (entry.category==='rejected'?'[取消 AI] ':'[人工調整 AI] ') : ''}${entry.name}\n${entry.key ?? ''} · ${entry.clip?.start?.toFixed(2) ?? '?'}s · ${entry.operation ?? ''}\n${({ approved:'已認可', excluded:'已排除', unreviewed:'待審核' } as Record<string,string>)[entry.review.status] ?? '待審核'}${entry.error ? ' · 資料異常' : ''}`;
   item.addEventListener('click', () => { void select(entry); }); list.appendChild(item);
  }
 }
 async function refresh() { message.textContent = '讀取資料庫…'; try { entries = (await request({ action:'list' })).records; renderList(); message.textContent = entries.length ? `共 ${entries.length} 筆正式記錄` : '尚無正式記錄，請先匯出 WAV 將暫存資料搬入資料庫'; } catch(e) { message.textContent = String(e); } }
 search.addEventListener('input', renderList);
 dialog.querySelector('[data-refresh]')!.addEventListener('click', () => { void refresh(); });
 dialog.querySelector('[data-close]')!.addEventListener('click', () => dialog.close());
 dialog.addEventListener('close', () => { revision++; release(); detail.replaceChildren(); });
 window.addEventListener('wipitch-training-committed', () => { if (dialog.open) void refresh(); });
 button.addEventListener('click', () => { dialog.showModal(); void refresh(); });
}
