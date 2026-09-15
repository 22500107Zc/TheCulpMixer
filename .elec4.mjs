import { _electron as electron } from 'playwright-core';
import { readFileSync } from 'node:fs';
const KEY = (readFileSync('/tmp/claude-0/-home-user-yes/2683b0ac-cd60-5992-9277-8cfa94ba0cf2/scratchpad/culp-key.txt','utf8')
  .split('\n').map(l=>l.trim()).find(l=>/^[A-Za-z0-9_-]{40,}\.[A-Za-z0-9_-]+$/.test(l)));
const a = await electron.launch({
  args: ['electron/main.cjs', '--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--disable-gpu'],
  env: { ...process.env, DISPLAY: process.env.DISPLAY || ':99' },
});
const page = await a.firstWindow({ timeout: 45000 });
page.on('dialog', (d) => d.dismiss().catch(()=>{}));   // ignore any native prompt
await page.waitForFunction(() => !!window.kline?.editor, null, { timeout: 40000 });
await page.waitForTimeout(1200);
const r = await page.evaluate(async (k) => {
  const ed = window.kline.editor;
  const out = await ed.applyLicenceKey(k);
  let modelled = false;
  if (out.ok) { const b = ed.scene.objects.size; window.kline.run('add.cube'); modelled = ed.scene.objects.size > b; }
  return { origin: location.origin, ok: out.ok, message: out.message, licence: ed.licence.status, canUse: ed.canUse, canExport: ed.canExport, modelled };
}, KEY);
console.log('[DESKTOP]', JSON.stringify(r));
console.log('RESULT desktop app:', r.ok && r.canUse && r.canExport && r.modelled);
await a.close();
