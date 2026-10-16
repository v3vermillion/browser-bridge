#!/usr/bin/env node
// Self-test for the live session engine's motion tools (watch, livescroll), run against local fixture pages
// whose motion is known in advance. No GitHub, no network: a local server and a local browser.
//
//   node selftest.mjs                      # chromium
//   BROWSER=webkit node selftest.mjs       # or firefox (screenshot-loop path)
//   NO_CDP=1 node selftest.mjs             # chromium without protocol access (exercises the WebKit/Firefox path)
//   CHROMIUM_PATH=/path/to/chrome ...      # custom Chromium (local runs)

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { startLocal } from './session.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const browserName = process.env.BROWSER || 'chromium';
const noCdp = !!process.env.NO_CDP;
const streaming = browserName === 'chromium' && !noCdp;   // frame stream + protocol features

// Fixture server; /slow.svg arrives 800 ms late, like a lazy hero image.
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="150"><rect width="300" height="150" fill="#2a9d8f"/></svg>';
const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/slow.svg')) { await new Promise((r) => setTimeout(r, 800)); res.setHeader('content-type', 'image/svg+xml'); return res.end(svg); }
  const file = req.url === '/' ? 'index.html' : req.url.slice(1).split('?')[0];
  try { res.setHeader('content-type', 'text/html'); res.end(await fs.readFile(path.join(here, 'test-pages', path.basename(file)))); }
  catch { res.statusCode = 404; res.end('not found'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const out = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-selftest-'));

let failures = 0, seq = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? `  (${detail})` : ''}`);
  if (!cond) failures++;
};
const exists = (p) => fs.stat(p).then(() => true, () => false);
const anim = (r, name) => (r.watch?.animations || []).find((a) => a.name === name);

const s = await startLocal({ url: `${base}/`, outDir: out, browser: browserName, device: 'desktop', detail: 1, cdp: noCdp ? false : undefined });
const run = async (c) => {
  const r = await s.execute({ ...c, seq: ++seq });
  if (!r.ok) console.log(`      ${c.action} error: ${r.error}`);
  return r;
};
try {
  console.log(`browser-bridge selftest: ${browserName}${noCdp ? ' (no protocol)' : ''}, results in ${out}`);
  const obs = await run({ action: 'observe' });
  const cta = (obs.elements || []).find((e) => /Donate now/.test(e.name));
  check('observe maps the call to action', !!cta);

  // 1. Page load: the entrance animation is read from the browser, the load is on the filmstrip.
  let r = await run({ action: 'watch', fresh: 1, ms: 2500 });
  const rise = anim(r, 'rise');
  check('watch load runs', r.ok);
  check('load: entrance animation found with its real settings', rise && rise.duration === 600 && rise.delay === 200 && rise.easing === 'ease-out', JSON.stringify(rise));
  check('load: animation lists what changes (opacity 0 -> 1)', rise && rise.changes.some((x) => x.property === 'opacity' && x.from === '0' && x.to === '1'));
  check('load: element text excludes script/noscript source', rise && rise.text === 'Motion fixture', JSON.stringify(rise?.text));
  const hidden = (r.watch?.animations || []).find((a) => a.target === 'li');
  check('load: animation inside a hidden menu is not counted as on screen', hidden && hidden.visible === false, JSON.stringify(hidden && { target: hidden.target, visible: hidden.visible }));
  check('load: the visible entrance animation is on screen', rise && rise.visible === true);
  check('load: animation start is on the recording clock', rise && rise.startedAt >= 0 && rise.startedAt < 1500, `startedAt ${rise?.startedAt}`);
  check('load: first contentful paint measured', typeof r.watch?.load?.firstContentfulPaint === 'number', JSON.stringify(r.watch?.load));
  if (streaming) {   // screenshot-loop browsers can't picture the first moments of a load (they wait for the page)
    check('load: several frames picked, starting at or after navigation', r.watch?.frames.picked >= 3 && (r.frameFiles || []).length >= 3);
    check('load: motion detected after t=0', r.watch?.motion && r.watch.motion.startsAt >= 0, JSON.stringify(r.watch?.motion));
  } else {
    check('load: frames show the load, or the stretch they missed is reported', !!r.watch?.motion || (r.watch?.notes || []).some((n) => /no frames between/.test(n)), JSON.stringify(r.watch?.notes));
  }
  check('load: filmstrip and data written', await exists(path.join(out, '0002', 'filmstrip.jpg')) && await exists(path.join(out, '0002', 'watch.json')));

  // 2. Hover: the transition is caught, timed from the hover, and the filmstrip is cropped to the button.
  const again = await run({ action: 'observe' });
  const cta2 = (again.elements || []).find((e) => /Donate now/.test(e.name));
  r = await run({ action: 'watch', ms: 1200, after: { action: 'hover', ref: cta2?.ref } });
  const tr = anim(r, 'transform');
  check('watch hover runs', r.ok);
  check('hover: transform transition found (250ms ease)', tr && tr.type === 'CSSTransition' && tr.duration === 250 && tr.easing === 'ease', JSON.stringify(tr));
  check('hover: properties use CSS names', !!anim(r, 'background-color')?.changes.some((x) => x.property === 'background-color'), JSON.stringify(anim(r, 'background-color')?.changes));
  check('hover: transition starts at the hover, not before', tr && tr.firstSeen >= -20 && tr.firstSeen < 300, `firstSeen ${tr?.firstSeen}`);
  check('hover: animation that finished before the recording is left out', !anim(r, 'rise'));
  const below = anim(r, 'spin');
  check('hover: animation running below the fold is marked off screen', below && below.visible === false && (r.watch?.notes || []).some((n) => /off screen/.test(n)), JSON.stringify({ visible: below?.visible, notes: r.watch?.notes }));
  check('hover: on-screen animations listed first', r.watch?.animations?.[0]?.visible === true);
  check('hover: motion settles within ~0.5s', r.watch?.motion && r.watch.motion.endsAt < 700 && !r.watch.motion.stillMovingAtEnd, JSON.stringify(r.watch?.motion));
  const reg = r.watch?.region, [bx, by, bw, bh] = cta2?.box || [];
  check('hover: filmstrip cropped to the area around the button', reg && bx + bw / 2 > reg.x && bx + bw / 2 < reg.x + reg.w && by + bh / 2 > reg.y && by + bh / 2 < reg.y + reg.h, JSON.stringify({ reg, box: cta2?.box }));
  check('hover: change explained by the animation list', r.watch?.explained && r.watch.explained.animatedElements >= 60, JSON.stringify(r.watch?.explained));

  // 3. Slow motion: the same 250ms transition at 0.1x lasts ~2.5s of real time, then speed is restored.
  r = await run({ action: 'watch', ms: 400, slowmo: 0.1, after: { action: 'hover', ref: cta2?.ref } });
  check('watch slowmo runs', r.ok);
  check('slowmo: transition stretched to >1.5s real time', r.watch?.motion && r.watch.motion.endsAt > 1500, JSON.stringify(r.watch?.motion));
  const slow = anim(r, 'transform');
  check('slowmo: start time in real time, close to when it was first seen', slow && slow.startedAt !== null && Math.abs(slow.startedAt - slow.firstSeen) < 100, JSON.stringify(slow && { startedAt: slow.startedAt, firstSeen: slow.firstSeen }));
  r = await run({ action: 'watch', ms: 1000, after: { action: 'hover', ref: cta2?.ref } });
  check('slowmo: normal speed restored afterwards', r.watch?.motion && r.watch.motion.endsAt < 700, JSON.stringify(r.watch?.motion));

  // 4. Reduced motion: the entrance animation is gone.
  r = await run({ action: 'watch', fresh: 1, ms: 1500, reduced: 1 });
  check('watch reduced=1 runs', r.ok);
  check('reduced motion: entrance animation not run', r.ok && !anim(r, 'rise'), JSON.stringify((r.watch?.animations || []).map((a) => a.name)));

  // 5. Throttled load (Chromium): the late image arrives later than on a fast connection.
  if (streaming) {
    r = await run({ action: 'watch', fresh: 1, ms: 2500, network: '3g' });
    check('watch network=3g runs', r.ok);
    check('throttled: load reported with the condition', (r.watch?.conditions || []).includes('network 3g'));
  }

  // 6. Live scroll still works, and its frames are on the page clock.
  r = await run({ action: 'livescroll', to: 'bottom', mode: 'wheel', speed: 1800 });
  check('livescroll runs', r.ok);
  const mj = JSON.parse(await fs.readFile(path.join(out, String(seq).padStart(4, '0'), 'motion.json'), 'utf8'));
  const ts = mj.frameMeta.map((f) => f.t);
  check('livescroll: frames saved', ts.length >= 3, `frames ${ts.length}`);
  check('livescroll: frame times ascend from ~0', ts.every((t, i) => i === 0 || t >= ts[i - 1]) && ts[0] > -500 && ts[0] < 3000, ts.slice(0, 5).join(','));
  const expected = Math.min((mj.to - mj.from) / 1800 * 1000, 20000);
  check('livescroll: keeps its speed (duration close to distance / speed)', mj.durationMs < expected + 2500, `took ${mj.durationMs}ms for ${mj.to - mj.from}px at 1800px/s`);

  // 7. Loops: an infinite CSS animation plus a canvas spinner drawn by script.
  await run({ action: 'goto', url: `${base}/loops.html` });
  r = await run({ action: 'watch', ms: 2000 });
  const pulse = anim(r, 'pulse');
  check('watch (hold still) runs', r.ok);
  check('loops: infinite animation reported', pulse && pulse.iterations === 'infinite' && pulse.duration === 1200, JSON.stringify(pulse));
  check('loops: keyframe values listed (scale up and back)', pulse && pulse.changes.some((x) => x.property === 'transform' && (x.values || []).length === 3), JSON.stringify(pulse?.changes));
  check('loops: canvas and script library flagged', r.watch?.media?.canvases >= 1 && (r.watch?.media?.libraries || []).includes('GSAP'), JSON.stringify(r.watch?.media));
  check('loops: still moving at the end', r.watch?.motion?.stillMovingAtEnd === true);
  check('loops: change split between animated elements and canvas', r.watch?.explained && r.watch.explained.animatedElements > 0 && r.watch.explained.media > 0, JSON.stringify(r.watch?.explained));

  // 7b. An action next to background motion: the crop follows what the action set moving, not the canvas.
  r = await run({ action: 'watch', ms: 1000, after: { action: 'hover', selector: '#tipbtn' } });
  const fade = anim(r, 'opacity');
  const rg = r.watch?.region;
  check('hover beside a canvas: tooltip transition found', fade && fade.duration === 300 && fade.easing === 'ease-out', JSON.stringify(fade));
  check('hover beside a canvas: crop is the tooltip, not the canvas', rg && rg.x > 700 && rg.y < 300, JSON.stringify(rg));
  check('hover beside a canvas: motion timed inside the crop (starts after the hover, settles)', r.watch?.motion && r.watch.motion.startsAt >= 0 && !r.watch.motion.stillMovingAtEnd, JSON.stringify(r.watch?.motion));

  // 8. Batch: watch inside a batch, then observe.
  r = await run({ actions: [{ action: 'watch', ms: 400 }, { action: 'observe' }] });
  check('batch with watch runs', r.ok && r.results.length === 2);
} finally {
  await s.close().catch(() => {});
  server.close();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
