import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { inspectLocalAudio, streamLocalAudio } from '../tools/local-audio.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'wipitch-local-audio-'));
try {
	const wavPath = path.join(root, '聲音.wav');
	const bytes = Buffer.from('RIFF-test-audio');
	await writeFile(wavPath, bytes);
	const audio = await inspectLocalAudio(wavPath);
	assert.equal(audio.path, await realpath(wavPath));
	assert.equal(audio.name, '聲音.wav');
	assert.equal(audio.type, 'audio/wav');
	assert.equal(audio.size, bytes.length);
	await assert.rejects(inspectLocalAudio('relative.wav'), /絕對路徑/);
	const textPath = path.join(root, 'secret.txt');
	await writeFile(textPath, 'secret');
	await assert.rejects(inspectLocalAudio(textPath), /不是支援的音訊格式/);
	await assert.rejects(inspectLocalAudio(path.join(root, 'missing.wav')), /找不到原始音訊/);

	const response = new PassThrough();
	response.statusCode = 0;
	const headers = new Map();
	response.setHeader = (key, value) => { headers.set(key.toLowerCase(), String(value)); };
	const chunks = [];
	response.on('data', chunk => chunks.push(chunk));
	const ended = new Promise((resolve, reject) => { response.on('end', resolve); response.on('error', reject); });
	streamLocalAudio(response, audio);
	await ended;
	assert.equal(response.statusCode, 200);
	assert.equal(headers.get('content-type'), 'audio/wav');
	assert.equal(decodeURIComponent(headers.get('x-audio-name')), '聲音.wav');
	assert.deepEqual(Buffer.concat(chunks), bytes);
	console.log('local audio: absolute-path validation, audio-only restriction, missing-file error and byte stream passed');
} finally {
	await rm(root, { recursive: true, force: true });
}
