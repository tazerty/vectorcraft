// Test de fumée Evora du build web (écrit par Evora, EVORA-SIN-04, CI ; aucune dépendance, aucune
// action tierce). Il sert le site du moteur sur une origine A (127.0.0.1, port libre) et une page
// parente sur une origine B (127.0.0.1, autre port libre), charge la page parente dans le Chrome du
// runner, sans interface, piloté par le protocole DevTools sur un tube (--remote-debugging-pipe), et
// exige que le moteur démarre dans l'iframe :
//   - voile de chargement retiré par le moteur, canvas présent et dimensionné ;
//   - aucune exception de page (iframe comprise), aucun plantage ;
//   - aucune requête en échec sur l'origine A.
// Le document du moteur est servi avec la CSP visée par ARCHITECTURE §3.6 en Report-Only
// (empreintes de csp-hashes.txt, frame-ancestors = origine B) : les violations sont comptées et
// imprimées, sans bloquer. Le démarrage à froid est mesuré dans l'iframe (performance.now() au
// retrait du voile), puis une capture d'écran donne une mesure du rendu (couleurs distinctes).
//
// Langue imposée (patch E3) : SMOKE_LANG est passé au moteur en `?lang=` et, si SMOKE_EXPECT_LANG
// est donné, l'attribut `lang` de la page du moteur doit valoir ce code (porte bloquante).
//
// Usage : node smoke.mjs <site> <rapport.json> [binaire chrome]

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const [siteArg, reportPath, chromeArg] = process.argv.slice(2);
if (!siteArg || !reportPath) {
  console.error('usage : node smoke.mjs <site> <rapport.json> [chrome]');
  process.exit(2);
}
const SITE = path.resolve(siteArg);
const CHROME = chromeArg || process.env.CHROME_BIN || 'google-chrome';
const READY_TIMEOUT_MS = 180_000;
const SETTLE_MS = 3_000;
const POLL_MS = 100;
const VIEW = { width: 1280, height: 800 };
const BACKGROUND = [0x26, 0x26, 0x26]; // fond de index.html
const SMOKE_LANG = process.env.SMOKE_LANG || '';
const SMOKE_EXPECT_LANG = process.env.SMOKE_EXPECT_LANG || '';
const ENGINE_QUERY = SMOKE_LANG ? `?lang=${encodeURIComponent(SMOKE_LANG)}` : '';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const report = {
  ok: false,
  reasons: [],
  chrome: null,
  originA: null,
  originB: null,
  ready: false,
  coldStartMs: null,
  parentToReadyMs: null,
  probe: null,
  exceptions: [],
  failedRequestsA: [],
  failedRequestsOther: [],
  consoleErrors: [],
  consoleTail: [],
  backend: null,
  cspReportOnly: { policy: null, violations: [] },
  requestsA: 0,
  bytesA: 0,
  pixels: null,
  lang: { requested: SMOKE_LANG || null, expected: SMOKE_EXPECT_LANG || null, got: null },
  timeline: { contextA: null, firstProbe: null, polls: 0 },
  crashed: false,
  chromeStderrTail: [],
};

// ---- serveurs ------------------------------------------------------------------------------

function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      handler(req, res).catch((e) => {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(String(e));
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function cspPolicy(originB) {
  let hashes = [];
  try {
    const text = await readFile(path.join(SITE, 'csp-hashes.txt'), 'utf8');
    hashes = text.split('\n').filter((l) => l.startsWith('script-src ')).map((l) => l.slice('script-src '.length).trim());
  } catch {
    hashes = [];
  }
  return [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval' ${hashes.join(' ')}`.trim(),
    "worker-src 'self' blob:",
    "connect-src 'self'",
    "img-src 'self' data: blob:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    `frame-ancestors ${originB}`,
    "object-src 'none'",
    "base-uri 'none'",
    'report-uri /__csp-report',
  ].join('; ');
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

let policy = '';

async function engineHandler(req, res) {
  const url = new URL(req.url, 'http://moteur.invalid');
  if (req.method === 'POST' && url.pathname === '/__csp-report') {
    const body = await readBody(req);
    try {
      const r = JSON.parse(body)['csp-report'] || {};
      report.cspReportOnly.violations.push({
        directive: r['violated-directive'] || r['effective-directive'] || null,
        blocked: r['blocked-uri'] || null,
        sample: r['script-sample'] || null,
      });
    } catch {
      report.cspReportOnly.violations.push({ raw: body.slice(0, 300) });
    }
    res.writeHead(204);
    res.end();
    return;
  }
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(SITE, '.' + rel);
  if (!file.startsWith(SITE + path.sep)) {
    res.writeHead(403);
    res.end();
    return;
  }
  report.requestsA += 1;
  let data;
  try {
    data = await readFile(file);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  const ext = path.extname(file).toLowerCase();
  const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' };
  if (ext === '.html') headers['Content-Security-Policy-Report-Only'] = policy;
  report.bytesA += data.length;
  res.writeHead(200, headers);
  res.end(data);
}

function parentHandler(originA) {
  const html = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Evora : page parente du test de fumée</title>
<link rel="icon" href="data:,">
<style>html,body{margin:0;background:#fff}iframe{display:block;border:0;width:${VIEW.width}px;height:${VIEW.height}px}</style>
</head><body><iframe id="engine" src="${originA}/index.html${ENGINE_QUERY}" title="moteur"
allow="fullscreen; clipboard-read; clipboard-write"
sandbox="allow-scripts allow-same-origin allow-downloads allow-popups"></iframe></body></html>`;
  return async (req, res) => {
    const url = new URL(req.url, 'http://parent.invalid');
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    }
  };
}

// ---- protocole DevTools sur tube -------------------------------------------------------------

let chrome;
let navStart = 0;
let nextId = 1;
const pending = new Map();
const contexts = new Map(); // `${session}:${id}` -> { session, id, origin, isDefault }
const requestUrls = new Map(); // `${session}:${requestId}` -> url

function send(method, params = {}, sessionId) {
  const id = nextId++;
  const msg = { id, method, params };
  if (sessionId) msg.sessionId = sessionId;
  chrome.stdio[3].write(JSON.stringify(msg) + '\0');
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject, method }));
}

function remember(list, item, max = 200) {
  list.push(item);
  if (list.length > max) list.shift();
}

function argText(a) {
  if (a === undefined || a === null) return '';
  if (a.value !== undefined) return typeof a.value === 'string' ? a.value : JSON.stringify(a.value);
  return a.description || a.type || '';
}

async function enable(session, child) {
  const steps = [
    send('Runtime.enable', {}, session),
    send('Log.enable', {}, session),
    send('Network.enable', {}, session),
  ];
  if (!child) steps.push(send('Page.enable', {}, session));
  await Promise.allSettled(steps);
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, session).catch(() => {});
  if (child) await send('Runtime.runIfWaitingForDebugger', {}, session).catch(() => {});
}

function onEvent(method, params, session) {
  switch (method) {
    case 'Target.attachedToTarget':
      enable(params.sessionId, true).catch(() => {});
      break;
    case 'Runtime.executionContextCreated': {
      const c = params.context;
      if (c.origin === report.originA && report.timeline.contextA === null && navStart) report.timeline.contextA = Date.now() - navStart;
      contexts.set(`${session}:${c.id}`, { session, id: c.id, origin: c.origin, isDefault: !!(c.auxData && c.auxData.isDefault) });
      break;
    }
    case 'Runtime.executionContextDestroyed':
      contexts.delete(`${session}:${params.executionContextId}`);
      break;
    case 'Runtime.executionContextsCleared':
      for (const k of [...contexts.keys()]) if (k.startsWith(`${session}:`)) contexts.delete(k);
      break;
    case 'Runtime.exceptionThrown': {
      const d = params.exceptionDetails || {};
      remember(report.exceptions, { text: (d.exception && d.exception.description) || d.text || '?', url: d.url || null });
      break;
    }
    case 'Runtime.consoleAPICalled': {
      const text = (params.args || []).map(argText).join(' ').slice(0, 500);
      if (text.includes('wgpu backend')) report.backend = text;
      remember(report.consoleTail, `${params.type}: ${text}`, 40);
      if (params.type === 'error' || params.type === 'assert') remember(report.consoleErrors, text);
      break;
    }
    case 'Log.entryAdded': {
      const e = params.entry || {};
      if (e.level === 'error') remember(report.consoleErrors, `[${e.source}] ${e.text}${e.url ? ' ' + e.url : ''}`.slice(0, 500));
      break;
    }
    case 'Network.requestWillBeSent':
      requestUrls.set(`${session}:${params.requestId}`, params.request.url);
      break;
    case 'Network.responseReceived': {
      const r = params.response || {};
      if (r.status >= 400) failed({ url: r.url, status: r.status });
      break;
    }
    case 'Network.loadingFailed':
      if (!params.canceled) failed({ url: requestUrls.get(`${session}:${params.requestId}`) || '?', error: params.errorText, blocked: params.blockedReason || null });
      break;
    case 'Inspector.targetCrashed':
    case 'Target.targetCrashed':
      report.crashed = true;
      break;
    default:
      break;
  }
}

function failed(item) {
  if (report.originA && item.url && item.url.startsWith(report.originA) && !item.url.includes('/__csp-report')) {
    remember(report.failedRequestsA, item);
  } else {
    remember(report.failedRequestsOther, item);
  }
}

function startChrome() {
  return mkdtemp(path.join(tmpdir(), 'evora-chrome-')).then((profile) => {
    const args = [
      '--headless=new',
      '--remote-debugging-pipe',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--mute-audio',
      '--hide-scrollbars',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      `--window-size=${VIEW.width + 40},${VIEW.height + 40}`,
      'about:blank',
    ];
    chrome = spawn(CHROME, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
    chrome.stderr.on('data', (d) => {
      for (const line of d.toString().split('\n')) if (line.trim()) remember(report.chromeStderrTail, line.slice(0, 300), 30);
    });
    let buf = Buffer.alloc(0);
    chrome.stdio[4].on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let at;
      while ((at = buf.indexOf(0)) >= 0) {
        const raw = buf.subarray(0, at).toString('utf8');
        buf = buf.subarray(at + 1);
        let msg;
        try {
          msg = JSON.parse(raw);
        } catch {
          continue;
        }
        if (msg.id && pending.has(msg.id)) {
          const p = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
          else p.resolve(msg.result);
        } else if (msg.method) {
          onEvent(msg.method, msg.params || {}, msg.sessionId);
        }
      }
    });
    chrome.on('exit', (code, signal) => {
      for (const p of pending.values()) p.reject(new Error(`chrome terminé (${code ?? signal})`));
      pending.clear();
    });
  });
}

// ---- PNG (8 bits, RVB ou RVBA, non entrelacé) --------------------------------------------------

function decodePng(buf) {
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error('PNG non pris en charge');
      colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!bpp) throw new Error(`type de couleur PNG ${colorType} non pris en charge`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? row[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v = src[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      row[x] = v & 0xff;
    }
  }
  return { width, height, bpp, data: out };
}

function pixelStats(png, rect) {
  const colors = new Set();
  let other = 0;
  let total = 0;
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(png.width, Math.floor(rect.x + rect.width));
  const y1 = Math.min(png.height, Math.floor(rect.y + rect.height));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * png.width + x) * png.bpp;
      const r = png.data[i];
      const g = png.data[i + 1];
      const b = png.data[i + 2];
      if (colors.size < 100000) colors.add((r << 16) | (g << 8) | b);
      if (r !== BACKGROUND[0] || g !== BACKGROUND[1] || b !== BACKGROUND[2]) other += 1;
      total += 1;
    }
  }
  return { region: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, distinctColors: colors.size, nonBackgroundRatio: total ? Number((other / total).toFixed(4)) : 0 };
}

// ---- déroulé ----------------------------------------------------------------------------------

const PROBE = `(() => {
  const l = document.getElementById('vectorcraft_loading');
  const c = document.getElementById('vectorcraft_canvas');
  return JSON.stringify({
    ready: !l && !!c,
    loading: l ? l.textContent : null,
    canvas: !!c,
    width: c ? c.width : 0,
    height: c ? c.height : 0,
    clientWidth: c ? c.clientWidth : 0,
    clientHeight: c ? c.clientHeight : 0,
    t: Math.round(performance.now()),
    title: document.title,
    htmlLang: document.documentElement.lang,
    href: location.href,
    webgpu: !!navigator.gpu,
  });
})()`;

async function probeEngine() {
  const candidates = [...contexts.values()].filter((c) => c.origin === report.originA && c.isDefault);
  for (const c of candidates) {
    try {
      const r = await send('Runtime.evaluate', { expression: PROBE, contextId: c.id, returnByValue: true }, c.session);
      if (r && r.result && typeof r.result.value === 'string') return JSON.parse(r.result.value);
    } catch {
      // contexte détruit entre-temps : on réessaie au tour suivant
    }
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const serverA = await listen(engineHandler);
  report.originA = `http://127.0.0.1:${serverA.address().port}`;
  let serverB = null;
  serverB = await listen((req, res) => parentHandler(report.originA)(req, res));
  report.originB = `http://127.0.0.1:${serverB.address().port}`;
  policy = await cspPolicy(report.originB);
  report.cspReportOnly.policy = policy;
  if (report.originA === report.originB) report.reasons.push('origines A et B identiques');

  await startChrome();
  const version = await send('Browser.getVersion');
  report.chrome = version.product;
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await enable(sessionId, false);
  await send('Emulation.setDeviceMetricsOverride', { width: VIEW.width + 20, height: VIEW.height + 20, deviceScaleFactor: 1, mobile: false }, sessionId);
  const t0 = Date.now();
  navStart = t0;
  await send('Page.navigate', { url: `${report.originB}/` }, sessionId);

  let probe = null;
  while (Date.now() - t0 < READY_TIMEOUT_MS && !report.crashed) {
    probe = await probeEngine();
    report.timeline.polls += 1;
    if (probe && report.timeline.firstProbe === null) report.timeline.firstProbe = { atMs: Date.now() - t0, probe };
    if (probe && probe.ready) break;
    if (probe && probe.loading && /fail|required|lost/i.test(probe.loading)) break;
    await sleep(POLL_MS);
  }
  report.probe = probe;
  if (probe && probe.ready) {
    report.ready = true;
    report.coldStartMs = probe.t;
    report.parentToReadyMs = Date.now() - t0;
    await sleep(SETTLE_MS);
    report.probe = (await probeEngine()) || probe;
    try {
      const frame = await send('Runtime.evaluate', {
        expression: "JSON.stringify(document.getElementById('engine').getBoundingClientRect())",
        returnByValue: true,
      }, sessionId);
      const rect = JSON.parse(frame.result.value);
      const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
      report.pixels = pixelStats(decodePng(Buffer.from(shot.data, 'base64')), rect);
    } catch (e) {
      report.pixels = { error: String(e) };
    }
  }

  if (!report.ready) report.reasons.push(`moteur non démarré dans l'iframe (dernier état : ${JSON.stringify(probe)})`);
  if (report.crashed) report.reasons.push('plantage du rendu');
  if (report.exceptions.length) report.reasons.push(`${report.exceptions.length} exception(s) de page`);
  if (report.failedRequestsA.length) report.reasons.push(`${report.failedRequestsA.length} requête(s) en échec sur l'origine A`);
  const p = report.probe;
  if (report.ready && !(p && p.canvas && p.width > 0 && p.height > 0)) report.reasons.push('canvas absent ou sans dimension');
  report.lang.got = p ? p.htmlLang : null;
  if (SMOKE_EXPECT_LANG && report.lang.got !== SMOKE_EXPECT_LANG) {
    report.reasons.push(`langue imposée : attendu « ${SMOKE_EXPECT_LANG} », obtenu « ${report.lang.got} »`);
  }
  report.ok = report.reasons.length === 0;

  await send('Browser.close').catch(() => {});
  await sleep(500);
  if (chrome.exitCode === null) chrome.kill('SIGKILL');
  serverA.close();
  serverB.close();
}

const watchdog = setTimeout(() => {
  report.reasons.push('délai global dépassé');
  finish(1);
}, READY_TIMEOUT_MS + 60_000);

async function finish(code) {
  clearTimeout(watchdog);
  try {
    if (chrome && chrome.exitCode === null) chrome.kill('SIGKILL');
  } catch {
    // déjà arrêté
  }
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  process.exit(code);
}

main()
  .then(() => finish(report.ok ? 0 : 1))
  .catch((e) => {
    report.reasons.push(`erreur du test : ${e && e.stack ? e.stack : e}`);
    finish(1);
  });
