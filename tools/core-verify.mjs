import { spawnSync } from 'node:child_process';
const tests = [
 'work-state', 'ai-correction-flow', 'ai-context', 'ai-correction', 'builtin-ai', 'compute-mode',
 'load-lifecycle', 'note-preview', 'zoom-gesture', 'detection-bar',
	'pitch-deviation', 'timemap', 'slope-limit', 'diagnostics', 'training', 'project', 'local-audio', 'audio-segments',
];
for (const name of tests) {
 console.log(`\nChecking ${name}`);
 const result = spawnSync(process.execPath, ['--experimental-transform-types', '--import', './tools/ts-resolve.mjs', `spike/${name}-test.mjs`], {
  cwd: new URL('..', import.meta.url), stdio: 'inherit',
 });
 if (result.error) throw result.error;
 if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(`\n${tests.length} core suites passed`);
