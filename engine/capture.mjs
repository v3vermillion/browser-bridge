#!/usr/bin/env node
// browser-bridge capture engine.
// Reads a job spec (JSON) and writes screenshots + page data to an output folder.
// Runs inside GitHub Actions (see .github/workflows/capture.yml), but works anywhere
// Node + Playwright browsers are available.
//
// Inputs (env):
//   JOB_JSON      job spec as a JSON string (see docs/job-spec.md)
//   RUN_LABEL     unique label for this run (used as the results folder name)
//   OUT_DIR       where to write results (default: ./out)
//   CHROMIUM_PATH optional custom Chromium binary (local testing only)

import { chromium, firefox, webkit, devices } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const execFileP = promisify(execFile);
const ENGINE_VERSION = '1.0.0';
const ENGINES = { chromium, firefox, webkit };

// ---------------------------------------------------------------------------
// Presets: starting points, not rules. Any field can be overridden per job or
// per target via `capture: { ... }`.
// ---------------------------------------------------------------------------
const BASE = {
  screenshot: 'full',      // 'none' | 'viewport' | 'full'
  tiles: false,            // also split the full page into screen-sized tiles (sharper detail)
  tileHeight: null,        // px; default = viewport height
  maxTiles: 25,
  format: 'jpeg',          // 'jpeg' | 'png'
  quality: 80,             // jpeg only
  detail: 1,               // device pixel ratio for captures (2 = sharper, bigger files)
  animations: 'disabled',  // 'disabled' freezes CSS animations for stable shots; 'allow' keeps them
  waitMs: 800,             // settle time after load
  timeoutMs: 45000,
  revealLazyContent: true, // scroll through the page first so lazy images / scroll-reveal sections render
  hide: [],                // CSS selectors to hide before capture (cookie banners, chat widgets, ...)
  blockWrites: true,       // abort non-GET requests (form submits, etc.) so nothing is sent
  text: true,              // visible text -> text.md
  meta: true,              // title, description, headings, OG tags, structured data
  html: false,             // rendered DOM -> page.html
  links: false,            // link inventory + flags
  checkLinks: false,       // also request every link and record HTTP status
  images: false,           // image inventory: alt text, resolution vs displayed size, broken
  styles: false,           // fonts, colors, sizes actually used
  forms: false,            // form fields, label associations, where forms submit
  a11y: false,             // axe-core accessibility scan
  aria: false,             // accessibility tree (what a screen reader is given)
  lighthouse: false,       // Lighthouse scores (chromium only, slower)
};

const PRESETS = {
  glance: { ...BASE, screenshot: 'viewport' },
  standard: { ...BASE, tiles: true, html: true, links: true, images: true, styles: true, forms: true },
  deep: {
    ...BASE, tiles: true, html: true, links: true, checkLinks: true, images: true,
    styles: true, forms: true, a11y: true, aria: true, lighthouse: true, detail: 2,
  },
};
const PRESET_DEVICES = { glance: ['desktop'], standard: ['desktop', 'mobile'], deep: ['desktop', 'mobile'] };

const DEVICE_PRESETS = {
  desktop: { viewport: { width: 1440, height: 900 } },
  laptop: { viewport: { width: 1280, height: 800 } },
  tablet: devices['iPad Mini'],
  mobile: devices['iPhone 15'],
  iphone: devices['iPhone 15'],
  android: devices['Pixel 7'],
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (s) => String(s).toLowerCase().replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'page';
const nowIso = () => new Date().toISOString();

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}
async function writeText(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}

function normalizeJob(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Job must be a JSON object.');
  const presetName = raw.preset || 'standard';
  if (!PRESETS[presetName]) throw new Error(`Unknown preset "${presetName}". Use glance | standard | deep.`);

  let targets = [];
  if (raw.url) targets.push({ url: raw.url });
  if (Array.isArray(raw.urls)) targets.push(...raw.urls.map((u) => ({ url: u })));
  if (Array.isArray(raw.targets)) targets.push(...raw.targets.map((t) => (typeof t === 'string' ? { url: t } : t)));
  if (!targets.length) throw new Error('Job needs at least one URL (url, urls, or targets).');
  if (targets.length > 20) throw new Error('Max 20 targets per job; split into several jobs.');

  const usedNames = new Set();
  targets = targets.map((t, i) => {
    if (!t.url || !/^(https?|file):\/\//i.test(t.url)) throw new Error(`Target ${i + 1} has an invalid url: ${t.url}`);
    let name = slug(t.name || t.url);
    while (usedNames.has(name)) name = `${name}-${i + 1}`;
    usedNames.add(name);
    return { ...t, name };
  });

  const browsers = raw.browsers || ['chromium'];
  for (const b of browsers) if (!ENGINES[b]) throw new Error(`Unknown browser "${b}". Use chromium | webkit | firefox.`);

  const deviceList = raw.devices || PRESET_DEVICES[presetName];
  const devicesNorm = deviceList.map((d) => {
    if (typeof d === 'string') {
      if (DEVICE_PRESETS[d]) return { name: d, ...DEVICE_PRESETS[d] };
      if (devices[d]) return { name: slug(d), ...devices[d] };
      throw new Error(`Unknown device "${d}". Use desktop | laptop | tablet | mobile | android, a Playwright device name, or a custom object.`);
    }
    if (!d.viewport && !(d.width && d.height)) throw new Error('Custom device needs width and height.');
    return {
      name: slug(d.name || `${d.width}x${d.height}`),
      viewport: d.viewport || { width: d.width, height: d.height },
      isMobile: !!d.isMobile, hasTouch: !!d.hasTouch,
      ...(d.userAgent ? { userAgent: d.userAgent } : {}),
    };
  });

  const capture = { ...PRESETS[presetName], ...(raw.capture || {}) };
  if (raw.brief !== undefined && typeof raw.brief !== 'string') throw new Error('brief must be a string (markdown).');
  return { preset: presetName, targets, browsers, devices: devicesNorm, capture, steps: raw.steps || [], notes: raw.notes || null, brief: raw.brief || null };
}

// ---------------------------------------------------------------------------
// In-page extractors (run inside the browser)
// ---------------------------------------------------------------------------
const extractMeta = () => {
  const m = (n) => document.querySelector(`meta[name="${n}"]`)?.content ?? null;
  const p = (n) => document.querySelector(`meta[property="${n}"]`)?.content ?? null;
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => ({
    level: Number(h.tagName[1]),
    text: (h.innerText || h.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 200),
    visible: visible(h),
  }));
  const structuredData = [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => {
    try { return JSON.parse(s.textContent); } catch { return { unparseable: true }; }
  });
  return {
    url: location.href,
    title: document.title,
    lang: document.documentElement.lang || null,
    description: m('description'),
    viewport: m('viewport'),
    robots: m('robots'),
    generator: m('generator'),
    canonical: document.querySelector('link[rel="canonical"]')?.href ?? null,
    favicon: document.querySelector('link[rel~="icon"]')?.href ?? null,
    og: { title: p('og:title'), description: p('og:description'), image: p('og:image'), url: p('og:url'), type: p('og:type'), site_name: p('og:site_name') },
    twitter: { card: m('twitter:card'), title: m('twitter:title'), description: m('twitter:description'), image: m('twitter:image') },
    h1Count: headings.filter((h) => h.level === 1).length,
    headings,
    structuredData,
    pageHeight: document.documentElement.scrollHeight,
  };
};

const extractLinks = () => {
  const GENERIC = /^(click here|here|this link|use this link|link|read more|learn more|more|go|this)$/i;
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  return [...document.querySelectorAll('a')].map((a) => {
    const raw = a.getAttribute('href');
    const text = (a.innerText || '').trim().replace(/\s+/g, ' ');
    const name = text || a.getAttribute('aria-label') || a.querySelector('img[alt]')?.getAttribute('alt') || a.getAttribute('title') || '';
    let kind = 'internal';
    if (raw === null) kind = 'no-href';
    else if (raw === '' || raw === '#') kind = 'empty';
    else if (raw.startsWith('#')) kind = 'anchor';
    else if (/^mailto:/i.test(raw)) kind = 'mailto';
    else if (/^tel:/i.test(raw)) kind = 'tel';
    else if (/^javascript:/i.test(raw)) kind = 'javascript';
    else {
      try { kind = new URL(a.href).host === location.host ? 'internal' : 'external'; } catch { kind = 'invalid'; }
    }
    const flags = [];
    if (kind === 'empty' || kind === 'no-href') flags.push('goes-nowhere');
    if (kind === 'anchor' && !document.getElementById(raw.slice(1)) && !document.getElementsByName(raw.slice(1)).length) flags.push('anchor-target-missing');
    if (!name) flags.push('no-accessible-name');
    if (GENERIC.test(text)) flags.push('generic-text');
    return { text: text.slice(0, 120), name: name.slice(0, 120), href: raw, resolved: a.href || null, kind, target: a.target || null, visible: visible(a), flags };
  });
};

const extractImages = async () => {
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const imgs = [...document.querySelectorAll('img')].map((img) => {
    const r = img.getBoundingClientRect();
    const alt = img.getAttribute('alt');
    const ratio = r.width > 0 && img.naturalWidth ? +(img.naturalWidth / r.width).toFixed(2) : null;
    const flags = [];
    if (alt === null) flags.push('missing-alt');
    else if (alt.trim() === '' && visible(img) && r.width > 80) flags.push('empty-alt-on-large-image');
    if (img.complete && img.naturalWidth === 0) flags.push('broken');
    if (ratio !== null && r.width > 80) {
      if (ratio < 1) flags.push('upscaled-blurry');
      else if (ratio < 2) flags.push('below-retina-sharpness');
    }
    return {
      src: img.currentSrc || img.src, alt,
      natural: { w: img.naturalWidth, h: img.naturalHeight },
      displayed: { w: Math.round(r.width), h: Math.round(r.height) },
      naturalToDisplayedRatio: ratio, visible: visible(img), loading: img.getAttribute('loading'), flags,
    };
  });

  const bgEls = [...document.querySelectorAll('body *')].filter((el) => {
    const bg = getComputedStyle(el).backgroundImage;
    if (!bg || !bg.includes('url(')) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 100 && r.height >= 100;
  }).slice(0, 40);

  const loadNatural = (url) => new Promise((resolve) => {
    const i = new Image();
    const t = setTimeout(() => resolve({ w: 0, h: 0, timeout: true }), 5000);
    i.onload = () => { clearTimeout(t); resolve({ w: i.naturalWidth, h: i.naturalHeight }); };
    i.onerror = () => { clearTimeout(t); resolve({ w: 0, h: 0, error: true }); };
    i.src = url;
  });

  const backgrounds = [];
  for (const el of bgEls) {
    const match = getComputedStyle(el).backgroundImage.match(/url\(["']?(.*?)["']?\)/);
    if (!match) continue;
    const url = new URL(match[1], location.href).href;
    const r = el.getBoundingClientRect();
    const natural = await loadNatural(url);
    const ratio = natural.w ? +(natural.w / r.width).toFixed(2) : null;
    const flags = [];
    if (!natural.w) flags.push('broken');
    else if (ratio < 1) flags.push('upscaled-blurry');
    else if (ratio < 2) flags.push('below-retina-sharpness');
    backgrounds.push({
      src: url, element: el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') + (el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).join('.')}` : ''),
      natural, displayed: { w: Math.round(r.width), h: Math.round(r.height) }, naturalToDisplayedRatio: ratio,
      backgroundSize: getComputedStyle(el).backgroundSize, flags,
    });
  }
  return { images: imgs, backgrounds };
};

const extractStyles = () => {
  const tally = (map, key, weight = 1) => { if (key) map.set(key, (map.get(key) || 0) + weight); };
  const fams = new Map(), firstFams = new Map(), sizes = new Map(), weights = new Map(), colors = new Map(), bgs = new Map();
  let upperChars = 0, totalChars = 0;
  const isVisible = (el, cs) => cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity !== 0 && el.getClientRects().length;
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (!isVisible(el, cs)) continue;
    if (cs.backgroundColor && !/rgba\(0, 0, 0, 0\)|transparent/.test(cs.backgroundColor)) tally(bgs, cs.backgroundColor);
    const ownText = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
    if (!ownText) continue;
    const n = ownText.length;
    totalChars += n;
    if (cs.textTransform === 'uppercase' || (ownText === ownText.toUpperCase() && /[A-Z]/.test(ownText))) upperChars += n;
    tally(fams, cs.fontFamily, n);
    tally(firstFams, cs.fontFamily.split(',')[0].replace(/["']/g, '').trim(), n);
    tally(sizes, cs.fontSize, n);
    tally(weights, cs.fontWeight, n);
    tally(colors, cs.color, n);
  }
  const top = (map, k = 15) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([value, weight]) => ({ value, weight }));
  const loadedFonts = [...new Set([...document.fonts].filter((f) => f.status === 'loaded').map((f) => `${f.family.replace(/["']/g, '')} ${f.weight} ${f.style}`))];
  return {
    note: 'weight = number of text characters rendered with that value',
    primaryFontFamilies: top(firstFams),
    fontStacks: top(fams, 10),
    fontSizes: top(sizes, 20),
    fontWeights: top(weights),
    textColors: top(colors),
    backgroundColors: top(bgs),
    loadedWebFonts: loadedFonts,
    uppercaseShare: totalChars ? +(upperChars / totalChars).toFixed(2) : 0,
  };
};

const extractForms = () => {
  const labelFor = (el) => {
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l) return { method: 'label[for]', text: l.innerText.trim() };
    }
    const wrap = el.closest('label');
    if (wrap) return { method: 'wrapping label', text: wrap.innerText.trim() };
    if (el.getAttribute('aria-label')) return { method: 'aria-label', text: el.getAttribute('aria-label') };
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = lb.split(/\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' ').trim();
      if (t) return { method: 'aria-labelledby', text: t };
    }
    if (el.title) return { method: 'title', text: el.title };
    return null;
  };
  const orphanLabels = [...document.querySelectorAll('label[for]')]
    .filter((l) => !document.getElementById(l.getAttribute('for')))
    .map((l) => ({ text: l.innerText.trim().slice(0, 80), for: l.getAttribute('for') }));
  const forms = [...document.querySelectorAll('form')].map((f, i) => {
    const fields = [...f.querySelectorAll('input, select, textarea')]
      .filter((el) => !['hidden', 'submit', 'button', 'reset', 'image'].includes(el.type))
      .map((el) => {
        const label = labelFor(el);
        return {
          tag: el.tagName.toLowerCase(), type: el.type || null, name: el.name || null, id: el.id || null,
          required: el.required, placeholder: el.placeholder || null, label,
          flags: label ? [] : ['no-programmatic-label'],
        };
      });
    const radioGroups = {};
    for (const r of f.querySelectorAll('input[type=radio]')) {
      const g = (radioGroups[r.name] ||= { name: r.name, count: 0, inFieldsetWithLegend: !!r.closest('fieldset')?.querySelector('legend') });
      g.count++;
    }
    return {
      index: i, id: f.id || null, name: f.getAttribute('name'), method: (f.method || 'get').toUpperCase(),
      action: f.getAttribute('action') ? f.action : '(none - handled by script or same page)',
      fields, radioGroups: Object.values(radioGroups),
    };
  });
  return { forms, orphanLabels };
};

// ---------------------------------------------------------------------------
// Page preparation
// ---------------------------------------------------------------------------
async function preparePage(page, cap) {
  try { await page.waitForLoadState('networkidle', { timeout: 10000 }); } catch { /* busy pages never go idle; fine */ }
  try { await page.evaluate(() => document.fonts.ready); } catch {}
  if (cap.hide?.length) await page.addStyleTag({ content: `${cap.hide.join(',')} { visibility: hidden !important; }` });
  if (cap.revealLazyContent) {
    await page.evaluate(async () => {
      const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
      for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 120));
      }
      window.scrollTo(0, document.documentElement.scrollHeight);
      await new Promise((r) => setTimeout(r, 300));
      window.scrollTo(0, 0);
    });
    try { await page.waitForLoadState('networkidle', { timeout: 5000 }); } catch {}
  }
  await sleep(cap.waitMs);
}

function shotOpts(cap, extra = {}) {
  const o = { type: cap.format, animations: cap.animations, ...extra };
  if (cap.format === 'jpeg') o.quality = cap.quality;
  return o;
}

// ---------------------------------------------------------------------------
// Steps (scripted interaction)
// ---------------------------------------------------------------------------
async function runSteps(page, steps, cap, dir, files) {
  const log = [];
  let shotN = 0;
  const ext = cap.format === 'png' ? 'png' : 'jpg';
  const shotPath = (name) => path.join(dir, 'steps', `${String(++shotN).padStart(2, '0')}-${slug(name || 'step')}.${ext}`);
  const loc = (s) => (s.selector ? page.locator(s.selector).first() : s.text ? page.getByText(s.text, { exact: false }).first() : null);

  for (const [i, s] of steps.entries()) {
    const entry = { index: i, action: s.action, ok: true };
    const to = s.timeoutMs ?? (s.optional ? 3000 : 10000); // optional steps give up fast
    try {
      switch (s.action) {
        case 'goto': await page.goto(s.url, { waitUntil: 'load', timeout: cap.timeoutMs }); await preparePage(page, cap); break;
        case 'click': await loc(s).click({ timeout: to }); await sleep(s.waitMs ?? 500); break;
        case 'hover': await loc(s).hover({ timeout: to }); await sleep(s.waitMs ?? 300); break;
        case 'fill': await loc(s).fill(String(s.value ?? ''), { timeout: to }); break;
        case 'select': await loc(s).selectOption(s.value, { timeout: to }); break;
        case 'check': await loc(s).check({ timeout: to }); break;
        case 'press': if (s.selector) await loc(s).press(s.key); else await page.keyboard.press(s.key); await sleep(s.waitMs ?? 200); break;
        case 'scroll':
          if (s.selector || s.text) await loc(s).scrollIntoViewIfNeeded();
          else await page.evaluate((to) => window.scrollTo(0, to === 'bottom' ? document.documentElement.scrollHeight : to === 'top' ? 0 : Number(to)), s.to ?? 'bottom');
          await sleep(s.waitMs ?? 400); break;
        case 'wait': if (s.selector) await page.waitForSelector(s.selector, { timeout: s.ms || to }); else await sleep(s.ms || 1000); break;
        case 'setViewport': await page.setViewportSize({ width: s.width, height: s.height }); await sleep(300); break;
        case 'screenshot': {
          const p = shotPath(s.name || `step-${i}`);
          await fs.mkdir(path.dirname(p), { recursive: true });
          if (s.selector || s.text) await loc(s).screenshot({ path: p, ...shotOpts(cap) });
          else await page.screenshot({ path: p, fullPage: !!s.fullPage, ...shotOpts(cap) });
          files.push(p); entry.file = path.basename(p); break;
        }
        case 'burst': {
          const count = Math.min(s.count || 5, 20);
          entry.files = [];
          for (let k = 0; k < count; k++) {
            const p = shotPath(`${s.name || 'burst'}-${k + 1}`);
            await fs.mkdir(path.dirname(p), { recursive: true });
            await page.screenshot({ path: p, ...shotOpts({ ...cap, animations: 'allow' }) });
            files.push(p); entry.files.push(path.basename(p));
            await sleep(s.intervalMs || 300);
          }
          break;
        }
        case 'tabWalk': {
          const count = Math.min(s.count || 15, 60);
          entry.focus = [];
          for (let k = 0; k < count; k++) {
            await page.keyboard.press('Tab');
            await sleep(150);
            const info = await page.evaluate(() => {
              const el = document.activeElement;
              if (!el || el === document.body) return { tag: 'body' };
              const cs = getComputedStyle(el);
              const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
              const shadow = cs.boxShadow && cs.boxShadow !== 'none';
              return {
                tag: el.tagName.toLowerCase(),
                name: (el.innerText || el.getAttribute('aria-label') || el.value || el.name || '').trim().replace(/\s+/g, ' ').slice(0, 80),
                href: el.getAttribute('href'),
                focusIndicatorDetected: outline || shadow,
              };
            });
            if (s.screenshots !== false) {
              const p = shotPath(`tab-${k + 1}`);
              await fs.mkdir(path.dirname(p), { recursive: true });
              await page.screenshot({ path: p, ...shotOpts(cap) });
              files.push(p); info.file = path.basename(p);
            }
            entry.focus.push(info);
          }
          break;
        }
        case 'evaluate': entry.result = await page.evaluate(s.script); break;
        default: throw new Error(`Unknown step action "${s.action}"`);
      }
    } catch (e) {
      entry.ok = false; entry.error = String(e.message || e).split('\n')[0];
      entry.note = s.optional ? 'Optional step skipped.' : 'Step failed; later steps still attempted.';
    }
    log.push(entry);
  }
  return log;
}

// ---------------------------------------------------------------------------
// Link status checks + Lighthouse (run from Node, not the page)
// ---------------------------------------------------------------------------
async function checkLinkStatuses(links) {
  const urls = [...new Set(links.filter((l) => ['internal', 'external'].includes(l.kind) && l.resolved).map((l) => l.resolved.split('#')[0]))].slice(0, 150);
  const results = {};
  const check = async (u) => {
    const attempt = async (method) => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 12000);
      try {
        const r = await fetch(u, { method, redirect: 'follow', signal: ctrl.signal, headers: { 'user-agent': 'Mozilla/5.0 (browser-bridge link check)' } });
        return { status: r.status, finalUrl: r.url };
      } finally { clearTimeout(t); }
    };
    try {
      let r = await attempt('HEAD');
      if ([403, 405, 501].includes(r.status)) r = await attempt('GET');
      results[u] = r;
    } catch (e) { results[u] = { status: null, error: String(e.message || e) }; }
  };
  const queue = [...urls];
  await Promise.all(Array.from({ length: 6 }, async () => { while (queue.length) await check(queue.shift()); }));
  return results;
}

async function runLighthouse(url, isMobile, dir) {
  const out = path.join(dir, 'lighthouse-full.json');
  const args = ['--yes', 'lighthouse@12', url, '--output=json', `--output-path=${out}`, '--quiet',
    '--chrome-flags=--headless=new --no-sandbox', '--only-categories=performance,accessibility,best-practices,seo'];
  if (!isMobile) args.push('--preset=desktop');
  await execFileP('npx', args, { env: { ...process.env, CHROME_PATH: process.env.CHROMIUM_PATH || chromium.executablePath() }, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  const lhr = JSON.parse(await fs.readFile(out, 'utf8'));
  await fs.rm(out, { force: true }); // full report is large; keep the summary
  const scores = Object.fromEntries(Object.entries(lhr.categories).map(([k, c]) => [k, Math.round((c.score ?? 0) * 100)]));
  const failing = Object.values(lhr.audits)
    .filter((a) => a.score !== null && a.score < 0.9 && a.scoreDisplayMode !== 'informative' && a.scoreDisplayMode !== 'notApplicable')
    .sort((a, b) => a.score - b.score).slice(0, 25)
    .map((a) => ({ id: a.id, title: a.title, score: a.score, displayValue: a.displayValue || null }));
  const metric = (id) => lhr.audits[id]?.displayValue || null;
  return {
    formFactor: isMobile ? 'mobile' : 'desktop', scores,
    metrics: { LCP: metric('largest-contentful-paint'), CLS: metric('cumulative-layout-shift'), TBT: metric('total-blocking-time'), FCP: metric('first-contentful-paint'), SpeedIndex: metric('speed-index') },
    failingAudits: failing,
  };
}

// ---------------------------------------------------------------------------
// One variant = one target x browser x device
// ---------------------------------------------------------------------------
async function captureVariant({ target, browserName, device, job, outDir, browser, lighthouseDone }) {
  const cap = { ...job.capture, ...(target.capture || {}) };
  const dirRel = path.join(target.name, `${browserName}-${device.name}`);
  const dir = path.join(outDir, dirRel);
  await fs.mkdir(dir, { recursive: true });
  const files = [];
  const facts = { target: target.name, url: target.url, browser: browserName, device: device.name, dir: dirRel, status: 'ok', startedAt: nowIso() };
  const network = { failedRequests: [], httpErrors: [], blockedWrites: [], consoleErrors: [], pageErrors: [] };

  const { name: _n, defaultBrowserType: _d, ...ctxDevice } = device;
  const ctxOpts = { ...ctxDevice, deviceScaleFactor: cap.detail || 1, ignoreHTTPSErrors: true };
  if (browserName === 'firefox') { delete ctxOpts.isMobile; delete ctxOpts.hasTouch; }
  const context = await browser.newContext(ctxOpts);
  const page = await context.newPage();

  if (cap.blockWrites) {
    await context.route('**/*', (route) => {
      const req = route.request();
      if (['GET', 'HEAD', 'OPTIONS'].includes(req.method())) return route.continue();
      network.blockedWrites.push({ method: req.method(), url: req.url().slice(0, 300) });
      return route.abort();
    });
  }
  page.on('requestfailed', (r) => {
    const url = r.url().slice(0, 300);
    if (network.blockedWrites.some((b) => b.url === url)) return; // our own safety block, already logged
    if (network.failedRequests.length < 100) network.failedRequests.push({ url, error: r.failure()?.errorText || '' });
  });
  page.on('response', (r) => { if (r.status() >= 400 && network.httpErrors.length < 100) network.httpErrors.push({ status: r.status(), url: r.url().slice(0, 300) }); });
  page.on('console', (m) => { if (m.type() === 'error' && network.consoleErrors.length < 50) network.consoleErrors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => { if (network.pageErrors.length < 50) network.pageErrors.push(String(e.message || e).slice(0, 300)); });

  const ext = cap.format === 'png' ? 'png' : 'jpg';
  try {
    const t0 = Date.now();
    const resp = await page.goto(target.url, { waitUntil: 'load', timeout: cap.timeoutMs });
    facts.httpStatus = resp?.status() ?? null;
    facts.finalUrl = page.url();
    await preparePage(page, cap);
    facts.loadSeconds = +((Date.now() - t0) / 1000).toFixed(1);
    const vp = page.viewportSize();
    facts.viewport = vp;

    // Screenshots
    if (cap.screenshot === 'viewport' || cap.screenshot === 'full') {
      const p = path.join(dir, `${cap.screenshot === 'full' ? 'full' : 'viewport'}.${ext}`);
      await page.screenshot({ path: p, fullPage: cap.screenshot === 'full', ...shotOpts(cap) });
      files.push(p);
    }
    if (cap.tiles) {
      const total = await page.evaluate(() => document.documentElement.scrollHeight);
      const th = cap.tileHeight || vp.height;
      const n = Math.min(Math.ceil(total / th), cap.maxTiles);
      for (let i = 0; i < n; i++) {
        const y = i * th;
        const p = path.join(dir, 'tiles', `tile-${String(i + 1).padStart(2, '0')}.${ext}`);
        await fs.mkdir(path.dirname(p), { recursive: true });
        await page.screenshot({ path: p, fullPage: true, clip: { x: 0, y, width: vp.width, height: Math.min(th, total - y) }, ...shotOpts(cap) });
        files.push(p);
      }
      facts.tiles = { count: n, tileHeight: th, truncated: Math.ceil(total / th) > n };
    }

    // Data
    if (cap.meta) { const meta = await page.evaluate(extractMeta); facts.meta = meta; await writeJson(path.join(dir, 'meta.json'), meta); files.push(path.join(dir, 'meta.json')); }
    if (cap.text) {
      const text = await page.evaluate(() => document.body.innerText);
      const p = path.join(dir, 'text.md');
      await writeText(p, `<!-- visible text of ${target.url} (${browserName}, ${device.name}) -->\n\n${text}\n`); files.push(p);
    }
    if (cap.html) { const p = path.join(dir, 'page.html'); await writeText(p, await page.content()); files.push(p); }
    if (cap.links) {
      const links = await page.evaluate(extractLinks);
      const data = { links, statuses: cap.checkLinks ? await checkLinkStatuses(links) : 'not checked (set capture.checkLinks: true)' };
      if (cap.checkLinks) for (const l of links) { const s = data.statuses[l.resolved?.split('#')[0]]; if (s && (s.status === null || s.status >= 400)) l.flags.push(`http-${s.status ?? 'error'}`); }
      facts.links = data; await writeJson(path.join(dir, 'links.json'), data); files.push(path.join(dir, 'links.json'));
    }
    if (cap.images) { const d = await page.evaluate(extractImages); facts.images = d; await writeJson(path.join(dir, 'images.json'), d); files.push(path.join(dir, 'images.json')); }
    if (cap.styles) { const d = await page.evaluate(extractStyles); facts.styles = d; await writeJson(path.join(dir, 'styles.json'), d); files.push(path.join(dir, 'styles.json')); }
    if (cap.forms) { const d = await page.evaluate(extractForms); facts.forms = d; await writeJson(path.join(dir, 'forms.json'), d); files.push(path.join(dir, 'forms.json')); }
    if (cap.a11y) {
      await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
      const res = await page.evaluate(async () => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] } }));
      const summary = {
        note: 'Automated scans catch only part of accessibility problems; absence of a violation is not proof of compliance.',
        violations: res.violations.map((v) => ({
          id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl, count: v.nodes.length,
          examples: v.nodes.slice(0, 8).map((n) => ({ target: n.target.join(' '), html: n.html.slice(0, 200), why: (n.failureSummary || '').slice(0, 300) })),
        })),
        incompleteNeedsReview: res.incomplete.map((v) => ({ id: v.id, help: v.help, count: v.nodes.length })),
        passesCount: res.passes.length,
      };
      facts.a11y = summary; await writeJson(path.join(dir, 'a11y.json'), summary); files.push(path.join(dir, 'a11y.json'));
    }
    if (cap.aria) {
      const snap = await page.locator('body').ariaSnapshot();
      const p = path.join(dir, 'aria.yaml'); await writeText(p, snap); files.push(p);
    }

    // Scripted interaction (global steps, then target steps)
    const steps = [...(job.steps || []), ...(target.steps || [])];
    if (steps.length) {
      const log = await runSteps(page, steps, cap, dir, files);
      facts.steps = log; await writeJson(path.join(dir, 'steps.json'), log); files.push(path.join(dir, 'steps.json'));
    }

    // Lighthouse: once per target per form factor, chromium only
    if (cap.lighthouse) {
      const ff = device.isMobile ? 'mobile' : 'desktop';
      const key = `${target.name}:${ff}`;
      if (browserName !== 'chromium') facts.lighthouse = { skipped: 'Lighthouse runs only in chromium variants.' };
      else if (lighthouseDone.has(key)) facts.lighthouse = { skipped: `Already measured for ${ff} in another variant.` };
      else {
        lighthouseDone.add(key);
        try { facts.lighthouse = await runLighthouse(target.url, !!device.isMobile, dir); }
        catch (e) { facts.lighthouse = { error: String(e.message || e).split('\n')[0] }; }
      }
      await writeJson(path.join(dir, 'lighthouse.json'), facts.lighthouse); files.push(path.join(dir, 'lighthouse.json'));
    }
  } catch (e) {
    facts.status = 'error';
    facts.error = String(e.message || e).split('\n')[0];
    try { const p = path.join(dir, `error-state.${ext}`); await page.screenshot({ path: p, ...shotOpts(cap) }); files.push(p); } catch {}
  }

  await writeJson(path.join(dir, 'network.json'), network); files.push(path.join(dir, 'network.json'));
  facts.network = network;
  await context.close();
  facts.finishedAt = nowIso();

  const fileInfo = [];
  for (const f of files) {
    try { const st = await fs.stat(f); fileInfo.push({ path: path.relative(outDir, f), bytes: st.size }); } catch {}
  }
  facts.files = fileInfo;
  const summaryMd = variantSummary(facts, cap);
  await writeText(path.join(dir, 'summary.md'), summaryMd);
  facts.files.push({ path: path.join(dirRel, 'summary.md'), bytes: Buffer.byteLength(summaryMd) });
  return facts;
}

// ---------------------------------------------------------------------------
// Summaries: short, factual, read these first.
// ---------------------------------------------------------------------------
function variantSummary(f, cap) {
  const L = [];
  L.push(`## ${f.target} - ${f.browser} / ${f.device}`);
  L.push(`- URL: ${f.url}${f.finalUrl && f.finalUrl !== f.url ? ` -> ${f.finalUrl}` : ''}`);
  L.push(`- Status: ${f.status}${f.error ? ` (${f.error})` : ''}${f.httpStatus ? `, HTTP ${f.httpStatus}` : ''}${f.loadSeconds ? `, ready in ${f.loadSeconds}s` : ''}`);
  if (f.viewport) L.push(`- Viewport: ${f.viewport.width}x${f.viewport.height} at ${cap.detail || 1}x detail`);
  if (f.meta) {
    const m = f.meta;
    L.push(`- Title: ${m.title || '(none)'}`);
    L.push(`- Meta description: ${m.description || '(none)'}`);
    L.push(`- H1 count: ${m.h1Count}; headings total: ${m.headings.length}; page height: ${m.pageHeight}px`);
    L.push(`- Structured data blocks: ${m.structuredData.length}; lang: ${m.lang || '(none)'}; og:image: ${m.og.image ? 'yes' : 'no'}`);
  }
  if (f.images) {
    const all = [...f.images.images, ...f.images.backgrounds];
    const c = (flag) => all.filter((i) => i.flags.includes(flag)).length;
    L.push(`- Images: ${f.images.images.length} <img> + ${f.images.backgrounds.length} large backgrounds; missing alt: ${c('missing-alt')}, empty alt on large: ${c('empty-alt-on-large-image')}, broken: ${c('broken')}, upscaled/blurry: ${c('upscaled-blurry')}, below retina: ${c('below-retina-sharpness')}`);
  }
  if (f.links && Array.isArray(f.links.links)) {
    const ls = f.links.links;
    const c = (flag) => ls.filter((l) => l.flags.some((x) => x.startsWith(flag))).length;
    L.push(`- Links: ${ls.length}; go nowhere: ${c('goes-nowhere')}, no accessible name: ${c('no-accessible-name')}, generic text: ${c('generic-text')}, missing anchor targets: ${c('anchor-target-missing')}${typeof f.links.statuses === 'object' ? `, HTTP errors: ${c('http-')}` : ''}`);
  }
  if (f.styles) {
    L.push(`- Primary font families (by text volume): ${f.styles.primaryFontFamilies.slice(0, 6).map((x) => x.value).join(', ')}`);
    L.push(`- Text colors in use: ${f.styles.textColors.length}; font sizes in use: ${f.styles.fontSizes.length}; uppercase share of text: ${Math.round(f.styles.uppercaseShare * 100)}%`);
  }
  if (f.forms) {
    const fields = f.forms.forms.flatMap((x) => x.fields);
    L.push(`- Forms: ${f.forms.forms.length}; fields: ${fields.length}; without programmatic label: ${fields.filter((x) => x.flags.length).length}; labels pointing at missing ids: ${f.forms.orphanLabels.length}`);
    for (const fm of f.forms.forms) L.push(`  - form ${fm.index + 1}: ${fm.method} -> ${fm.action}`);
  }
  if (f.a11y) {
    const by = {}; for (const v of f.a11y.violations) by[v.impact || 'unknown'] = (by[v.impact || 'unknown'] || 0) + 1;
    L.push(`- Accessibility (axe): ${f.a11y.violations.length} rule violations ${JSON.stringify(by)}; ${f.a11y.incompleteNeedsReview.length} need manual review`);
  }
  if (f.lighthouse) {
    if (f.lighthouse.scores) L.push(`- Lighthouse (${f.lighthouse.formFactor}): ${Object.entries(f.lighthouse.scores).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    else L.push(`- Lighthouse: ${f.lighthouse.skipped || f.lighthouse.error}`);
  }
  if (f.steps) L.push(`- Steps: ${f.steps.length} run, ${f.steps.filter((s) => !s.ok).length} failed`);
  const n = f.network;
  L.push(`- Network: ${n.httpErrors.length} HTTP errors, ${n.failedRequests.length} failed requests, ${n.consoleErrors.length + n.pageErrors.length} JS errors, ${n.blockedWrites.length} write requests blocked`);
  for (const b of n.blockedWrites.slice(0, 5)) L.push(`  - blocked ${b.method} ${b.url}`);
  L.push(`- Files: ${f.files.map((x) => x.path.split('/').slice(2).join('/')).join(', ')}`);
  return L.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const outDir = path.resolve(process.env.OUT_DIR || 'out');
  const label = process.env.RUN_LABEL || `local-${Date.now()}`;
  await fs.mkdir(outDir, { recursive: true });
  const manifest = { label, createdAt: nowIso(), engineVersion: ENGINE_VERSION, status: 'running', variants: [] };

  let job;
  try {
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(label)) throw new Error('RUN_LABEL may only contain letters, numbers, dot, dash, underscore (max 80).');
    job = normalizeJob(JSON.parse(process.env.JOB_JSON || '{}'));
  } catch (e) {
    manifest.status = 'invalid-job'; manifest.error = String(e.message || e);
    await writeJson(path.join(outDir, 'manifest.json'), manifest);
    await writeText(path.join(outDir, 'summary.md'), `# ${label}\n\nJob rejected: ${manifest.error}\n`);
    console.error(manifest.error);
    process.exit(1);
  }
  manifest.job = { ...job, brief: job.brief ? '(saved as brief.md)' : null };
  if (job.brief) await writeText(path.join(outDir, 'brief.md'), job.brief);

  const lighthouseDone = new Set();
  for (const browserName of job.browsers) {
    const launchOpts = {};
    if (browserName === 'chromium' && process.env.CHROMIUM_PATH) {
      launchOpts.executablePath = process.env.CHROMIUM_PATH;
      launchOpts.args = ['--no-sandbox', '--disable-dev-shm-usage'];
    }
    let browser;
    try { browser = await ENGINES[browserName].launch(launchOpts); }
    catch (e) {
      for (const target of job.targets) for (const device of job.devices) {
        manifest.variants.push({ target: target.name, browser: browserName, device: device.name, status: 'error', error: `Browser failed to launch: ${String(e.message).split('\n')[0]}`, files: [] });
      }
      continue;
    }
    for (const target of job.targets) {
      for (const device of job.devices) {
        console.log(`capturing ${target.url} [${browserName} / ${device.name}]`);
        const facts = await captureVariant({ target, browserName, device, job, outDir, browser, lighthouseDone });
        const { meta, links, images, styles, forms, a11y, network, steps, ...lean } = facts;
        manifest.variants.push(lean);
      }
    }
    await browser.close();
  }

  const ok = manifest.variants.filter((v) => v.status === 'ok').length;
  manifest.status = ok === manifest.variants.length ? 'ok' : ok ? 'partial' : 'failed';
  manifest.finishedAt = nowIso();
  await writeJson(path.join(outDir, 'manifest.json'), manifest);

  // Top-level summary stitches the variant summaries together.
  const parts = [`# Run ${label}`, '', `Status: ${manifest.status} (${ok}/${manifest.variants.length} variants ok). Preset: ${job.preset}. Created ${manifest.createdAt}.`, ''];
  if (job.notes) parts.push(`Notes: ${job.notes}`, '');
  for (const v of manifest.variants) {
    try { parts.push(await fs.readFile(path.join(outDir, v.dir, 'summary.md'), 'utf8')); }
    catch { parts.push(`## ${v.target} - ${v.browser} / ${v.device}\n- Status: ${v.status} ${v.error || ''}\n`); }
  }
  await writeText(path.join(outDir, 'summary.md'), parts.join('\n'));
  console.log(`done: ${manifest.status}`);
  if (manifest.status === 'failed') process.exit(1);
}

// Shared pieces reused by the live session runner (session.mjs).
export {
  ENGINES, DEVICE_PRESETS, PRESETS, slug, sleep, writeJson, writeText, shotOpts,
  extractMeta, extractLinks, extractImages, extractStyles, extractForms,
  preparePage, checkLinkStatuses,
};

// Run only when executed directly (not when imported).
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
