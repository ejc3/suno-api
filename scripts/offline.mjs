#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

export class UsageError extends Error {}
export function publicError(error) {
  if (error instanceof UsageError) return { ok: false, code: 'INVALID_INPUT', message: error.message };
  if (error?.message === 'SUNO_CAPTCHA_REQUIRED') return {
    ok: false, code: 'CAPTCHA_REQUIRED',
    message: 'Suno requires an interactive challenge. Offline submission stopped before generation; use another provider for this batch.',
  };
  if (error?.code === 'CREDENTIALS_UNAVAILABLE') return {
    ok: false, code: 'CREDENTIALS_UNAVAILABLE',
    message: 'A verified Suno login is unavailable. Set SUNO_COOKIE in memory or populate games/suno-cookie in AWS Secrets Manager.',
  };
  const status = error?.response?.status;
  return {
    ok: false, code: 'REQUEST_FAILED',
    ...(Number.isInteger(status) ? { http_status: status } : {}),
    message: 'Request failed. Provider errors and credential-bearing request details are suppressed. Reconcile a submitted job before retrying.',
  };
}
export function validateSpec(input) {
  if (!input || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 5000)
    throw new UsageError('The job specification needs a nonempty prompt of at most 5000 characters.');
  if (typeof input.model !== 'string' || !/^[a-zA-Z0-9_.-]{1,80}$/.test(input.model))
    throw new UsageError('Set an explicit model verified for the paid account; no legacy model is selected automatically.');
  if (input.instrumental !== undefined && typeof input.instrumental !== 'boolean')
    throw new UsageError('instrumental must be true or false.');
  return { prompt: input.prompt, model: input.model, instrumental: input.instrumental ?? true };
}
async function saveJob(directory, job) {
  const destination = path.join(directory, 'job.json');
  const temporary = destination + '.tmp';
  await writeFile(temporary, JSON.stringify(job, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, destination);
}
export async function submitJob(client, specification, directory, now = () => new Date().toISOString()) {
  const spec = validateSpec(specification);
  // mkdir is deliberately exclusive: an interrupted or completed job is never silently submitted again.
  await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  const job = { version: 1, ...spec, created_at: now(), state: 'submitting', clips: [] };
  await saveJob(directory, job);
  let clips;
  try {
    // Exactly one paid submission. Network failure can still mean Suno accepted it.
    clips = await client.generate(spec.prompt, spec.instrumental, spec.model, false);
  } catch (error) {
    job.state = error?.message === 'SUNO_CAPTCHA_REQUIRED' ? 'challenge_required' : 'submission_unknown';
    await saveJob(directory, job);
    throw error;
  }
  if (!Array.isArray(clips) || clips.length === 0 || clips.length > 8 ||
      clips.some(clip => typeof clip.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(clip.id))) {
    job.state = 'submission_unknown';
    await saveJob(directory, job);
    throw new UsageError('Suno returned an unexpected submission result. Inspect the account before trying another paid request.');
  }
  job.clips = clips.map(clip => ({ id: clip.id, status: clip.status ?? 'queued' }));
  job.state = 'submitted';
  await saveJob(directory, job);
  return job;
}
export function validateAudioUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
      !['suno.ai', 'suno.com'].some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain)))
    throw new UsageError('The download URL is outside the supported Suno HTTPS CDN domains.');
  return url;
}
async function downloadAudio(url, destination) {
  const response = await fetch(validateAudioUrl(url), { redirect: 'error', signal: AbortSignal.timeout(60000) });
  if (!response.ok || !response.body) throw new Error('Download failed');
  const maximum = 100 * 1024 * 1024;
  const size = Number(response.headers.get('content-length'));
  if (size > maximum) throw new UsageError('The audio download exceeds 100 MiB.');
  const handle = await open(destination + '.part', 'w', 0o600);
  let received = 0;
  try {
    for await (const chunk of Readable.fromWeb(response.body)) {
      received += chunk.length;
      if (received > maximum) throw new UsageError('The audio download exceeds 100 MiB.');
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
        if (!bytesWritten) throw new Error('Audio write made no progress');
        offset += bytesWritten;
      }
    }
  } finally { await handle.close(); }
  if (!received) throw new Error('Empty audio download');
  await rename(destination + '.part', destination);
}
export async function collectJob(client, directory, download = downloadAudio) {
  const job = JSON.parse(await readFile(path.join(directory, 'job.json'), 'utf8'));
  if (job.version !== 1 || !Array.isArray(job.clips) || !job.clips.length)
    throw new UsageError('This job has no recorded clip IDs. Reconcile the account; collect never starts another generation.');
  if (job.clips.some(clip => typeof clip.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(clip.id)))
    throw new UsageError('Invalid saved clip ID.');
  const current = await client.get(job.clips.map(clip => clip.id));
  for (const saved of job.clips) {
    const clip = current.find(candidate => candidate.id === saved.id);
    if (!clip) continue;
    saved.status = clip.status;
    if (clip.status === 'complete' && !saved.file) {
      const filename = saved.id + '.mp3';
      await download(clip.audio_url, path.join(directory, filename));
      saved.file = filename;
      if (typeof clip.model_name === 'string') saved.actual_model = clip.model_name;
      if (typeof clip.duration === 'number') saved.duration_seconds = clip.duration;
    }
  }
  job.state = job.clips.every(clip => clip.file) ? 'complete'
    : job.clips.some(clip => clip.status === 'error') ? 'failed' : 'pending';
  await saveJob(directory, job);
  return job;
}
async function cookieAtUse() {
  if (process.env.SUNO_COOKIE) return process.env.SUNO_COOKIE;
  try {
    const value = execFileSync('aws', [
      'secretsmanager', 'get-secret-value', '--region', 'us-west-1',
      '--secret-id', 'games/suno-cookie', '--query', 'SecretString', '--output', 'text',
      '--no-cli-pager',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 }).trim();
    if (!value.includes('__client=')) throw new Error('Missing client cookie');
    return value;
  } catch {
    const error = new Error('Missing verified Suno login');
    error.code = 'CREDENTIALS_UNAVAILABLE';
    throw error;
  }
}
async function clientAtUse() {
  // Set this before loading upstream modules: no payload/token logs or CAPTCHA browser runs.
  process.env.SUNO_OFFLINE = '1';
  const cookie = await cookieAtUse();
  const { sunoApi } = await import('../src/lib/SunoApi.ts');
  return sunoApi(cookie);
}
async function withSubmitLock(action) {
  const directory = path.join(homedir(), '.cache', 'suno-offline');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, 'submit.lock');
  let lock;
  try { lock = await open(filename, 'wx', 0o600); }
  catch { throw new UsageError('Another submission holds the account lock. If its process crashed, inspect and remove ~/.cache/suno-offline/submit.lock.'); }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid }) + '\n');
    return await action();
  } finally { await lock.close(); await unlink(filename); }
}
export async function main(args = process.argv.slice(2)) {
  const [command, first, second, ...extra] = args;
  if (!command || command === 'help' || command === '--help') {
    console.log('suno-assets quota\nsuno-assets submit SPEC.json NEW_JOB_DIRECTORY\nsuno-assets collect JOB_DIRECTORY\n\nNo web server. Each submit sends one paid request; collect only polls/downloads.\nA verified renewable login and an explicit account-supported model are required.\nCookies are read from memory or games/suno-cookie, never command arguments/files.');
    return;
  }
  if (extra.length || (command === 'quota' && first) ||
      (command === 'submit' && (!first || !second)) ||
      (command === 'collect' && (!first || second)) ||
      !['quota', 'submit', 'collect'].includes(command))
    throw new UsageError('Invalid arguments. Run suno-assets help; credentials are never accepted as command arguments.');
  if (command === 'quota') {
    const client = await clientAtUse();
    console.log(JSON.stringify({ ok: true, quota: await client.get_credits() }));
  } else if (command === 'submit') {
    const spec = validateSpec(JSON.parse(await readFile(first, 'utf8')));
    const result = await withSubmitLock(async () => submitJob(await clientAtUse(), spec, path.resolve(second)));
    console.log(JSON.stringify({ ok: true, state: result.state, clips: result.clips, directory: path.resolve(second) }));
  } else {
    const result = await collectJob(await clientAtUse(), path.resolve(first));
    console.log(JSON.stringify({ ok: true, state: result.state, clips: result.clips }));
    if (result.state !== 'complete') process.exitCode = result.state === 'failed' ? 1 : 2;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(JSON.stringify(publicError(error))); process.exitCode = 1; });
}
