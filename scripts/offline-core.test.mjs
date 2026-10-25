import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
process.env.SUNO_OFFLINE = '1';
const { SunoApi } = await import('../src/lib/SunoApi.ts');
test('offline challenges stop before any browser or paid solver starts', async () => {
  const client = new SunoApi('__client=fixture-cookie');
  let browsers = 0;
  client.captchaRequired = async () => true;
  client.launchBrowser = async () => { browsers++; throw new Error('browser must not run'); };
  await assert.rejects(client.getCaptcha(), /SUNO_CAPTCHA_REQUIRED/);
  assert.equal(browsers, 0);
});
test('offline core emits no generation payload or response logs', () => {
  const script = [
    "process.env.SUNO_OFFLINE='1';",
    "const {SunoApi}=await import('./src/lib/SunoApi.ts');",
    "const c=new SunoApi('__client=fixture-cookie');",
    "c.keepAlive=async()=>{};",
    "c.generateSongs=async()=>[{id:'fixture-private-response'}];",
    "await c.generate('fixture-private-prompt',true,'verified-model',false);",
    "console.log('ok');",
  ].join('');
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, 'ok\n');
});
