interface PickedAudio {
	path: string;
	name: string;
	size: number;
	lastModified: number;
}

let tokenPromise: Promise<string> | null = null;
async function localToken(): Promise<string> {
	tokenPromise ??= fetch('/__training/config').then(async response => {
		if (!response.ok) throw new Error('請以 npm run dev:local 啟動本機服務；行動裝置請使用一般檔案選擇');
		return String((await response.json()).token);
	});
	return tokenPromise;
}

async function localPost(path: string, body: object): Promise<Response> {
	const token = await localToken();
	return fetch(`/__training/${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-Training-Token': token },
		body: JSON.stringify(body),
	});
}

export async function pickLocalAudio(): Promise<PickedAudio | null> {
	const response = await localPost('pick-audio', {});
	const data = await response.json();
	if (response.status === 409 && data.cancelled) return null;
	if (!response.ok) throw new Error(data.error || '無法開啟本機音訊選擇器');
	return data as PickedAudio;
}

export async function readLocalAudio(audioPath: string, known?: PickedAudio): Promise<File> {
	const response = await localPost('read-audio', { path: audioPath });
	if (!response.ok) {
		const data = await response.json().catch(() => ({}));
		throw new Error(data.error || '無法讀取專案記錄的原始音訊');
	}
	const name = decodeURIComponent(response.headers.get('X-Audio-Name') || '') || known?.name || audioPath.split(/[\\/]/).pop() || 'audio';
	const lastModified = Number(response.headers.get('X-Audio-Last-Modified')) || known?.lastModified || Date.now();
	return new File([await response.blob()], name, { type: response.headers.get('Content-Type') || 'application/octet-stream', lastModified });
}
