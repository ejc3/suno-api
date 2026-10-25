import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { submitJob, collectJob, publicError, validateSpec, validateAudioUrl } from './offline.mjs';

const spec = { prompt: 'A calm instrumental scene', model: 'verified-account-model', instrumental: true };
test('paid submissions are not retried after an ambiguous failure; their state survives', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'suno-test-'));
  const directory = path.join(root, 'job');
  let submissions = 0;
  const error = Object.assign(new Error('private request headers and fixture-cookie'), {
    response: { status: 503 }, config: { headers: { Cookie: 'fixture-cookie', Authorization: 'fixture-token' } },
  });
  try {
    await assert.rejects(submitJob({ generate: async () => { submissions++; throw error; } }, spec, directory));
    assert.equal(submissions, 1);
    const saved = JSON.parse(await readFile(path.join(directory, 'job.json'), 'utf8'));
    assert.equal(saved.state, 'submission_unknown');
    assert.deepEqual(saved.clips, []);
    const output = JSON.stringify(publicError(error));
    assert.equal(output.includes('fixture-cookie'), false);
    assert.equal(output.includes('fixture-token'), false);
    assert.equal(output.includes('private request'), false);
    assert.equal(publicError(error).http_status, 503);
    await assert.rejects(submitJob({ generate: async () => { submissions++; return []; } }, spec, directory));
    assert.equal(submissions, 1, 'the same job directory cannot be silently resubmitted');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('collect resumes saved IDs and downloads completed clips without starting generation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'suno-test-'));
  const directory = path.join(root, 'job');
  let submissions = 0; let reads = 0; let downloads = 0;
  const client = {
    generate: async () => { submissions++; return [{ id: 'test-clip', status: 'queued' }]; },
    get: async ids => { reads++; assert.deepEqual(ids, ['test-clip']); return [{ id: 'test-clip', status: reads === 1 ? 'streaming' : 'complete', audio_url: 'https://cdn1.suno.ai/test-clip.mp3' }]; },
  };
  try {
    await submitJob(client, spec, directory);
    assert.equal((await collectJob(client, directory, async () => { downloads++; })).state, 'pending');
    assert.equal(downloads, 0, 'streaming is not treated as a completed audio file');
    assert.equal((await collectJob(client, directory, async () => { downloads++; })).state, 'complete');
    assert.equal(downloads, 1); assert.equal(submissions, 1);
    await collectJob(client, directory, async () => { downloads++; });
    assert.equal(downloads, 1, 'saved completed assets are not downloaded again');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('generation requires an explicit model and CDN downloads cannot reach arbitrary hosts', () => {
  assert.throws(() => validateSpec({ prompt: 'music' }));
  assert.equal(validateSpec(spec).model, 'verified-account-model');
  for (const url of ['http://cdn1.suno.ai/a.mp3', 'https://127.0.0.1/a', 'https://suno.ai.attacker.example/a', 'https://user:pass@cdn1.suno.ai/a'])
    assert.throws(() => validateAudioUrl(url));
  assert.equal(validateAudioUrl('https://cdn1.suno.ai/a.mp3').hostname, 'cdn1.suno.ai');
});
test('challenge failures clearly pause the offline provider without credential-bearing errors', () => {
  const error = new Error('SUNO_CAPTCHA_REQUIRED');
  assert.equal(publicError(error).code, 'CAPTCHA_REQUIRED');
});
