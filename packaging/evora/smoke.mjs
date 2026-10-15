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
// Thème imposé (patch E2), vérifié au rendu : SMOKE_THEME est passé en `?theme=` ; avec
// SMOKE_EXPECT_BAR=<rrggbb>, la couleur dominante du haut de l'iframe (barre d'application) doit
// valoir cette couleur, à ±3 par canal.
// Stockage du moteur hébergé (patch E5) : SMOKE_HOST=evora ajoute `host=evora` ; avec SMOKE_SEED=1,
// une page de l'origine A sème d'abord dans le localStorage une copie de récupération et une clé
// témoin, puis charge le moteur. Sans pont admis (evora-host.json de l'artefact, vide), le seul
// paramètre d'URL ne doit RIEN effacer : la copie semée et le témoin restent (correctif d'E5,
// EVORA-SIN-17), et la page parente ne reçoit aucun message.
//
// Pont EHP (patch E4), SMOKE_EHP=1, scénario « pont-ehp » : l'origine A sert un evora-host.json qui
// admet l'origine B (ce qu'écrit le provisionnement d'Evora) ; la page parente porte une coquille
// minimale (`harness`, contrôle source et origine, journal et conformité de chaque enveloppe), un
// relais servi par une troisième origine C (non admise) et un relais de l'origine B dans une autre
// fenêtre (source non parente). Le déroulé (`ehpScenario`) exige : un seul evora:ready conforme aux
// capacités attendues ; aucune purge avant evora:init ; aucune réponse aux messages de version 2,
// mal corrélés, hors schéma ou venus d'une origine ou d'une fenêtre non admises (un témoin de la
// page parente, lui, reçoit sa réponse) ; init acquitté, restes purgés, langue et thème appliqués
// au rendu ; refus codés (url, plafond + 1 octet, second docRef, en octets comme en document neuf) ;
// ouverture d'un SVG reçu en octets, dirty false, modification (collage), dirty true,
// evora:request-save → evora:save conforme (document natif non vide), dirty false, puis « clean » ;
// réouverture des octets enregistrés ; evora:theme et evora:lang à chaud ; evora:purge acquitté après
// effacement, stockage du moteur (localStorage, sessionStorage, IndexedDB, OPFS, Cache API) vide et
// qui le reste. SMOKE_EHP_NEW=1 (scénario « pont-ehp-neuf ») : même déroulé, mais le document s'ouvre
// vierge, sans octets (evora:open {docRef, name, new: true}, ce que la coquille envoie pour un document
// qui n'a pas encore de fichier Drive, HOST-PROTOCOL §7.1), et son evora:save porte le nom de l'hôte
// avec l'extension native. La page parente encadre le moteur avec le sandbox de la coquille
// (public/js/creative/host.js : ni allow-downloads ni allow-popups). SMOKE_SABOTAGE=origin
// (evora-host.json admet une autre origine : le pont doit rester muet) et SMOKE_SABOTAGE=detectors
// (un message légitime compté comme étranger, une clé semée après la purge) sont les témoins
// sabordés : le banc doit y rougir, pour les raisons attendues.
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
const SMOKE_HOST = process.env.SMOKE_HOST || '';
const SMOKE_THEME = process.env.SMOKE_THEME || '';
const SMOKE_EXPECT_BAR = (process.env.SMOKE_EXPECT_BAR || '').toLowerCase();
const SMOKE_SEED = process.env.SMOKE_SEED === '1';
const SMOKE_EHP = process.env.SMOKE_EHP === '1';
const SMOKE_SABOTAGE = process.env.SMOKE_SABOTAGE || '';
const SMOKE_EHP_NEW = process.env.SMOKE_EHP_NEW === '1';
// Le sandbox de l'iframe que pose la coquille d'Evora (public/js/creative/host.js, SANDBOX_TOKENS).
const HOST_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-modals allow-pointer-lock';
// Ce que le moteur doit annoncer dans evora:ready (patch E4, EVORA-SIN-17).
const EXPECTED_APP = 'sinopia-pro';
const EXPECTED_CAPS = ['doc.dirty', 'doc.open', 'doc.request-save', 'doc.save', 'live.lang', 'live.theme', 'storage.purge'];
// Plafond transmis par evora:init ; la fixture « trop grande » en est dérivée (plafond + 1 octet).
const MAX_DOC = 1048576;
const EHP_STEP_MS = 15_000;
const QUERY_PARTS = [];
if (SMOKE_LANG) QUERY_PARTS.push(`lang=${encodeURIComponent(SMOKE_LANG)}`);
if (SMOKE_HOST) QUERY_PARTS.push(`host=${encodeURIComponent(SMOKE_HOST)}`);
if (SMOKE_THEME) QUERY_PARTS.push(`theme=${encodeURIComponent(SMOKE_THEME)}`);
const ENGINE_QUERY = QUERY_PARTS.length ? `?${QUERY_PARTS.join('&')}` : '';
const SEED_RECOVERY_KEY = 'vectorcraft-recovery/temoin-zone/temoin.vectorcraft';
const SEED_LATE_KEY = 'vectorcraft-recovery/autre-compte/copie.vectorcraft';
const SEED_WITNESS_KEY = 'evora-temoin-intact';
const SEED_HTML = `<!doctype html><meta charset="utf-8"><title>semis</title><script>
localStorage.setItem(${JSON.stringify(SEED_RECOVERY_KEY)}, 'QUJD');
localStorage.setItem(${JSON.stringify(SEED_WITNESS_KEY)}, '1');
location.replace('/index.html' + location.search);
</script>`;

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
  theme: { requested: SMOKE_THEME || null, expectedBar: SMOKE_EXPECT_BAR || null, dominantBar: null },
  storage: { host: SMOKE_HOST || null, seeded: SMOKE_SEED ? [SEED_RECOVERY_KEY, SEED_WITNESS_KEY] : [], after: null },
  parentMessages: [],
  ehp: null,
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
// Ce que le provisionnement d'Evora écrirait à côté d'index.html (HOST-PROTOCOL §2.3) ; null : le
// fichier de l'artefact (livré vide) est servi tel quel.
let hostConfig = null;

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
  if (hostConfig && url.pathname === '/evora-host.json') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(hostConfig));
    return;
  }
  if (url.pathname === '/__evora-seed') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(SEED_HTML);
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

// Relais (origine C non admise, ou fenêtre de l'origine B qui n'est pas la parente) : sur ordre de la
// page parente, il poste au moteur (parent.frames[0]) les messages qu'on lui donne, comme le ferait un
// tiers. Le moteur doit les ignorer (HOST-PROTOCOL §5.1).
function relay() {
  addEventListener('message', (e) => {
    if (e.source !== parent || !e.data || e.data.cmd !== 'fire') return;
    for (const m of e.data.msgs) parent.frames[0].postMessage(m, '*');
  });
  parent.postMessage({ frameReady: location.pathname }, '*');
}

const RELAY_HTML = `<!doctype html><meta charset="utf-8"><title>relais</title><script>(${relay.toString()})();</script>`;

// Coquille minimale de la page parente (scénario « pont-ehp ») : elle ne garde que les messages dont
// la source est l'iframe du moteur ET l'origine celle du moteur, journalise chacun avec les écarts à
// la norme (enveloppe et schéma de charge utile par type, HOST-PROTOCOL §3, §4) et expose de quoi
// poster des messages (window.__ehp), conformes ou non.
function harness(cfg) {
  const A32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let n = 0;
  const ulid = () => {
    n += 1;
    let x = n;
    let s = '';
    for (let i = 0; i < 6; i += 1) {
      s = A32[x % 32] + s;
      x = Math.floor(x / 32);
    }
    return '01JZZZZZZZZZZZZZZZZZ' + s;
  };
  const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
  const ACK = ['clean', 'cancelled', 'conflict', 'too_large', 'quota', 'forbidden', 'not_found', 'invalid_content', 'unsupported',
    'rate_limited', 'read_only', 'busy', 'capability', 'network', 'server', 'timeout'];
  const FAIL = ['no_webgl2', 'wasm', 'memory', 'panic', 'unsupported_browser', 'protocol', 'init'];
  const CAPS = ['doc.open', 'doc.save', 'doc.saved-ack', 'doc.dirty', 'doc.multi', 'doc.request-save', 'export.drive', 'media.need',
    'media.ranges', 'pick.drive', 'command', 'storage.ns', 'storage.memory', 'storage.purge', 'live.lang', 'live.theme', 'font.inject', 'author'];
  const frame = () => document.getElementById('engine');
  const H = { log: [], others: [], framesReady: {}, saved: null, ids: { ignored: [], foreign: [] } };
  window.__ehp = H;
  const describe = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v, (k, x) => {
    if (x instanceof ArrayBuffer) return { arrayBuffer: x.byteLength };
    if (ArrayBuffer.isView(x)) return { view: x.constructor.name };
    return x;
  }));
  function conform(d) {
    const p = [];
    const keys = Object.keys(d);
    if (d.v !== 1) p.push('v différent de 1');
    if (keys.some((k) => !['v', 'type', 'id', 're', 'payload'].includes(k))) p.push(`champ d'enveloppe inconnu : ${keys.join(',')}`);
    if (typeof d.id !== 'string' || !ULID.test(d.id)) p.push('id non ULID');
    if ('re' in d && (typeof d.re !== 'string' || !ULID.test(d.re))) p.push('re non ULID');
    const pl = d.payload;
    if (pl === null || typeof pl !== 'object' || Object.getPrototypeOf(pl) !== Object.prototype) {
      p.push('payload non objet simple');
      return p;
    }
    const only = (...allowed) => {
      const extra = Object.keys(pl).filter((k) => !allowed.includes(k));
      if (extra.length) p.push(`champ de payload inconnu : ${extra.join(',')}`);
    };
    const needRe = (want) => {
      if (want !== ('re' in d)) p.push(want ? 're absent' : 're inattendu');
    };
    switch (d.type) {
      case 'evora:ready': {
        only('app', 'version', 'ehp', 'capabilities');
        needRe(false);
        if (pl.app !== cfg.app) p.push(`app ${pl.app}`);
        if (typeof pl.version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$/.test(pl.version)) p.push(`version ${pl.version}`);
        if (typeof pl.ehp !== 'string' || !/^1\.[0-9]+$/.test(pl.ehp)) p.push(`ehp ${pl.ehp}`);
        const c = pl.capabilities;
        if (!Array.isArray(c) || new Set(c).size !== c.length || c.some((x) => !CAPS.includes(x))) p.push(`capacités ${JSON.stringify(c)}`);
        break;
      }
      case 'evora:failed':
        only('code');
        needRe(false);
        if (!FAIL.includes(pl.code)) p.push(`code ${pl.code}`);
        break;
      case 'evora:ack':
        only('ok', 'code', 'result');
        needRe(true);
        if (typeof pl.ok !== 'boolean') p.push('ok non booléen');
        if ('code' in pl && !ACK.includes(pl.code)) p.push(`code ${pl.code}`);
        if (pl.ok === false && !('code' in pl)) p.push('ok:false sans code');
        break;
      case 'evora:dirty':
        only('dirty', 'docRef');
        needRe(false);
        if (typeof pl.dirty !== 'boolean') p.push('dirty non booléen');
        if ('docRef' in pl && (typeof pl.docRef !== 'string' || !ULID.test(pl.docRef))) p.push('docRef non ULID');
        break;
      case 'evora:save':
        only('docRef', 'name', 'saveAs', 'bytes');
        if (typeof pl.docRef !== 'string' || !ULID.test(pl.docRef)) p.push('docRef non ULID');
        if (typeof pl.name !== 'string' || pl.name.length < 1 || [...pl.name].length > 255 || /[\/\\\u0000-\u001f\u007f]/.test(pl.name)) p.push('name hors schéma');
        if (typeof pl.saveAs !== 'boolean') p.push('saveAs non booléen');
        if (!(pl.bytes instanceof ArrayBuffer) || pl.bytes.byteLength < 1 || pl.bytes.byteLength > cfg.maxDoc) p.push('bytes hors schéma (ArrayBuffer de 1 octet au plafond)');
        break;
      default:
        p.push(`type inattendu ${d.type}`);
    }
    return p;
  }
  addEventListener('message', (e) => {
    const d = e.data;
    const plain = d !== null && typeof d === 'object' && Object.getPrototypeOf(d) === Object.prototype;
    const engine = frame();
    const fromEngine = !!engine && e.source === engine.contentWindow && e.origin === cfg.engine;
    if (!fromEngine) {
      if (plain && typeof d.frameReady === 'string' && Object.keys(d).length === 1) {
        H.framesReady[d.frameReady] = true;
      } else {
        H.others.push({ origin: e.origin, data: describe(d) });
      }
      return;
    }
    H.log.push({
      t: Math.round(performance.now()),
      type: plain ? d.type : null,
      id: plain ? d.id : null,
      re: plain && 're' in d ? d.re : null,
      payload: plain ? describe(d.payload) : describe(d),
      problems: plain ? conform(d) : ['message non objet simple'],
    });
    if (plain && d.type === 'evora:save' && d.payload && d.payload.bytes instanceof ArrayBuffer) H.saved = d.payload.bytes.slice(0);
  });
  // Poste un message au moteur, avec l'origine du moteur comme targetOrigin → son id.
  H.post = (type, payload, o = {}) => {
    const m = { v: o.v === undefined ? 1 : o.v, type, id: ulid(), payload };
    if (o.re) m.re = o.re;
    if (o.extra) Object.assign(m, o.extra);
    frame().contentWindow.postMessage(m, cfg.engine, o.transfer || []);
    if (o.ignored) H.ids.ignored.push(m.id);
    return m.id;
  };
  // Fait poster un message par un relais (origine C, ou autre fenêtre de l'origine B) → son id.
  H.fire = (frameId, type, payload) => {
    const m = { v: 1, type, id: ulid(), payload };
    H.ids.foreign.push(m.id);
    document.getElementById(frameId).contentWindow.postMessage({ cmd: 'fire', msgs: [m] }, '*');
    return m.id;
  };
  H.find = (type, re) => H.log.find((m) => m.type === type && (re === undefined || m.re === re)) || null;
  H.all = (type) => H.log.filter((m) => m.type === type);
  H.readyId = () => (H.all('evora:ready')[0] || {}).id || null;
  H.text = (t) => new TextEncoder().encode(t).buffer;
  H.ulid = ulid;
}

function parentHandler(origins) {
  const engineSrc = `${origins.a}/${SMOKE_SEED ? '__evora-seed' : 'index.html'}${ENGINE_QUERY}`;
  const cfg = { engine: origins.a, app: EXPECTED_APP, maxDoc: MAX_DOC };
  const head = SMOKE_EHP
    ? `<script>(${harness.toString()})(${JSON.stringify(cfg)});</script>`
    : `<script>window.__evoraMessages = []; addEventListener('message', (e) => { window.__evoraMessages.push({ origin: e.origin, type: (e.data && typeof e.data === 'object' && typeof e.data.type === 'string') ? e.data.type : null }); });</script>`;
  const relays = SMOKE_EHP
    ? `<iframe id="foreign" src="${origins.c}/foreign" title="relais C" style="width:10px;height:10px"></iframe><iframe id="witness" src="/witness" title="relais B" style="width:10px;height:10px"></iframe>`
    : '';
  const html = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Evora : page parente du test de fumée</title>
<link rel="icon" href="data:,">
<style>html,body{margin:0;background:#fff}iframe{display:block;border:0;width:${VIEW.width}px;height:${VIEW.height}px}</style>
${head}
</head><body><iframe id="engine" src="${engineSrc}" title="moteur"
allow="fullscreen; clipboard-read; clipboard-write"
sandbox="${SMOKE_EHP ? HOST_SANDBOX : 'allow-scripts allow-same-origin allow-downloads allow-popups'}"></iframe>${relays}</body></html>`;
  return async (req, res) => {
    const url = new URL(req.url, 'http://parent.invalid');
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    } else if (SMOKE_EHP && url.pathname === '/witness') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(RELAY_HTML);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    }
  };
}

async function foreignHandler(req, res) {
  const url = new URL(req.url, 'http://tiers.invalid');
  if (url.pathname === '/foreign') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(RELAY_HTML);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
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

/// La couleur la plus fréquente d'une bande de `rows` lignes en haut de `rect`.
function dominantTop(png, rect, rows) {
  const counts = new Map();
  const x0 = Math.max(0, Math.floor(rect.x));
  const x1 = Math.min(png.width, Math.floor(rect.x + rect.width));
  const y0 = Math.max(0, Math.floor(rect.y) + 2);
  const y1 = Math.min(png.height, y0 + rows);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * png.width + x) * png.bpp;
      const key = (png.data[i] << 16) | (png.data[i + 1] << 8) | png.data[i + 2];
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  let best = 0;
  let bestN = -1;
  for (const [k, n] of counts) if (n > bestN) [best, bestN] = [k, n];
  return best.toString(16).padStart(6, '0');
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
    storageKeys: (() => { try { return Object.keys(localStorage).sort(); } catch (e) { return ['(localStorage illisible)']; } })(),
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

// ---- scénario « pont-ehp » (patch E4) -----------------------------------------------------------

let pageSession = null;

async function parentEval(expression, awaitPromise = false) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, pageSession);
  if (r.exceptionDetails) throw new Error(`page parente : ${(r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text}`);
  return r.result ? r.result.value : undefined;
}

async function engineEval(expression, awaitPromise = false) {
  const candidates = [...contexts.values()].filter((c) => c.origin === report.originA && c.isDefault);
  for (const c of candidates) {
    try {
      const r = await send('Runtime.evaluate', { expression, contextId: c.id, returnByValue: true, awaitPromise }, c.session);
      if (r && r.result && !r.exceptionDetails) return r.result.value;
    } catch {
      // contexte détruit entre-temps : candidat suivant
    }
  }
  throw new Error("aucun contexte de l'origine A pour évaluer dans le moteur");
}

/// Attend que `expression` (page parente) rende une valeur vraie → elle, ou null au délai.
async function waitParent(expression, ms = EHP_STEP_MS) {
  const end = Date.now() + ms;
  while (Date.now() < end && !report.crashed) {
    const v = await parentEval(expression).catch(() => null);
    if (v) return v;
    await sleep(150);
  }
  return null;
}

const ENGINE_KEYS = "JSON.stringify((() => { try { return Object.keys(localStorage).sort(); } catch (e) { return ['(illisible) ' + e]; } })())";
const ENGINE_STORES = `(async () => {
  const out = {};
  try { out.indexedDB = indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name) : null; } catch (e) { out.indexedDB = 'erreur ' + e; }
  try {
    if (navigator.storage && navigator.storage.getDirectory) {
      const root = await navigator.storage.getDirectory();
      const names = [];
      for await (const [name] of root.entries()) names.push(name);
      out.opfs = names;
    } else out.opfs = null;
  } catch (e) { out.opfs = 'erreur ' + e; }
  try { out.caches = typeof caches !== 'undefined' ? await caches.keys() : null; } catch (e) { out.caches = 'erreur ' + e; }
  try { out.sessionStorage = Object.keys(sessionStorage).sort(); } catch (e) { out.sessionStorage = 'erreur ' + e; }
  return JSON.stringify(out);
})()`;
const PASTE = `(() => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="15" fill="#4338CA"/></svg>';
  const dt = new DataTransfer();
  dt.items.add(new File([svg], 'evora-colle.svg', { type: 'image/svg+xml' }));
  const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
  window.dispatchEvent(ev);
  return ev.defaultPrevented;
})()`;
const SMOKE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120" viewBox="0 0 200 120"><rect x="10" y="10" width="180" height="100" fill="#4F46E5"/></svg>';

async function engineKeys() {
  return JSON.parse(await engineEval(ENGINE_KEYS));
}

/// Couleur dominante du haut de l'iframe du moteur (barre d'application), au rendu.
async function barColor() {
  const rect = JSON.parse(await parentEval("JSON.stringify(document.getElementById('engine').getBoundingClientRect())"));
  const shot = await send('Page.captureScreenshot', { format: 'png' }, pageSession);
  return dominantTop(decodePng(Buffer.from(shot.data, 'base64')), rect, 10);
}

const luma = (hex) => 0.2126 * parseInt(hex.slice(0, 2), 16) + 0.7152 * parseInt(hex.slice(2, 4), 16) + 0.0722 * parseInt(hex.slice(4, 6), 16);
const near = (got, want) => got.length === 6 && [0, 2, 4].every((i) => Math.abs(parseInt(got.slice(i, i + 2), 16) - parseInt(want.slice(i, i + 2), 16)) <= 3);

async function waitBar(test, ms = EHP_STEP_MS) {
  const end = Date.now() + ms;
  let got = null;
  while (Date.now() < end) {
    got = await barColor().catch(() => null);
    if (got && test(got)) return { ok: true, got };
    await sleep(300);
  }
  return { ok: false, got };
}

async function ehpScenario() {
  const ehp = { mode: SMOKE_SABOTAGE || (SMOKE_EHP_NEW ? 'document neuf' : 'normal'), originC: report.originC, steps: [], messages: [], others: [], storage: {} };
  report.ehp = ehp;
  const step = (name, ok, detail = '') => {
    ehp.steps.push({ name, ok: !!ok, detail });
    if (!ok) report.reasons.push(`[ehp] ${name}${detail ? ' : ' + detail : ''}`);
    return !!ok;
  };
  const J = (v) => JSON.stringify(v);
  const ack = (id) => `__ehp.find('evora:ack', ${J(id)})`;
  const waitAck = (id, ms) => waitParent(ack(id), ms);
  // Un accusé reçu, de ce `ok`, avec ce `code` (aucun code quand il n'en est pas donné).
  const ackIs = (a, ok, code) => !!a && !!a.payload && a.payload.ok === ok && (code === undefined ? !('code' in a.payload) : a.payload.code === code);

  // 1. Un evora:ready, conforme, avec les capacités attendues, avant toute requête de l'hôte.
  const ready = await waitParent("__ehp.all('evora:ready')[0]", 20_000);
  if (!step('evora:ready', ready, ready ? '' : 'evora:ready reçu 0 fois (pont muet)')) return finishEhp(ehp);
  const caps = [...(ready.payload.capabilities || [])].sort();
  step('capacités annoncées', J(caps) === J(EXPECTED_CAPS), `${J(caps)} au lieu de ${J(EXPECTED_CAPS)}`);
  step('evora:ready conforme', ready.problems.length === 0 && ready.payload.app === EXPECTED_APP && ready.payload.ehp === '1.0', J(ready));

  // 2. Correctif d'E5 : rien n'est effacé avant un evora:init vérifié.
  let keys = await engineKeys();
  step('aucune purge avant evora:init', keys.includes(SEED_RECOVERY_KEY) && keys.includes(SEED_WITNESS_KEY), J(keys));

  // 3. evora:init : d'abord des variantes à ignorer (version 2, champ d'enveloppe en trop, re non
  //    corrélé, storageNs hors schéma), puis l'init valide (français, sombre).
  const init = { lang: 'fr', engineLang: 'fr', theme: 'dark', accent: '#4F46E5', readOnly: false, storageNs: 'ab'.repeat(32),
    capabilities: ready.payload.capabilities, prefs: {}, limits: { maxDocumentBytes: MAX_DOC, maxExportBytes: MAX_DOC } };
  const readyId = J(ready.id);
  await parentEval(`__ehp.post('evora:init', {}, { v: 2, re: ${readyId}, ignored: true })`);
  await parentEval(`__ehp.post('evora:init', ${J(init)}, { re: ${readyId}, extra: { extra: 1 }, ignored: true })`);
  await parentEval(`__ehp.post('evora:init', ${J(init)}, { re: __ehp.ulid(), ignored: true })`);
  await parentEval(`__ehp.post('evora:init', ${J({ ...init, storageNs: 'ab' })}, { re: ${readyId}, ignored: true })`);
  const initId = await parentEval(`__ehp.post('evora:init', ${J(init)}, { re: ${readyId} })`);
  const initAck = await waitAck(initId);
  if (!step('evora:init acquitté', ackIs(initAck, true), J(initAck))) return finishEhp(ehp);
  keys = await engineKeys();
  ehp.storage.afterInit = keys;
  step('evora:init : restes des sessions antérieures purgés, témoin intact', !keys.some((k) => k.startsWith('vectorcraft-recovery/')) && keys.includes(SEED_WITNESS_KEY), J(keys));
  let htmlLang = null;
  for (let i = 0; i < 50 && htmlLang !== 'fr'; i += 1) {
    htmlLang = await engineEval('document.documentElement.lang').catch(() => null);
    if (htmlLang !== 'fr') await sleep(200);
  }
  step('evora:init : langue fr', htmlLang === 'fr', `lang « ${htmlLang} »`);
  const dark = await waitBar((hex) => luma(hex) < 0x80);
  step('evora:init : thème sombre au rendu', dark.ok, `barre #${dark.got}`);

  // 4. Messages à ignorer : origine C non admise, autre fenêtre de l'origine B, version 2, requête
  //    portant re, raison hors schéma, champ de charge utile en trop, type inconnu. Un témoin de la
  //    page parente doit, lui, recevoir sa réponse (« clean » : aucun document ouvert).
  if (!step('relais prêts', await waitParent("__ehp.framesReady['/foreign'] && __ehp.framesReady['/witness']"))) return finishEhp(ehp);
  await parentEval(`__ehp.fire('foreign', 'evora:request-save', { reason: 'user' })`);
  await parentEval(`__ehp.fire('witness', 'evora:request-save', { reason: 'user' })`);
  await parentEval(`__ehp.post('evora:request-save', { reason: 'user' }, { v: 2, ignored: true })`);
  await parentEval(`__ehp.post('evora:request-save', { reason: 'user' }, { re: __ehp.ulid(), ignored: true })`);
  await parentEval(`__ehp.post('evora:request-save', { reason: 'nope' }, { ignored: true })`);
  await parentEval(`__ehp.post('evora:request-save', { reason: 'user', extra: 1 }, { ignored: true })`);
  await parentEval(`__ehp.post('evora:export', { name: 'x.png', mime: 'image/png', bytes: __ehp.text('x') }, { ignored: true })`);
  const controlId = await parentEval(`__ehp.post('evora:request-save', { reason: 'user' })`);
  const control = await waitAck(controlId);
  step('témoin : evora:request-save de la page parente → clean', ackIs(control, true, 'clean'), J(control));

  // 5. Refus codés : url (media.ranges non déclarée), plafond + 1 octet.
  const refusals = [
    ['url', 'capability', `__ehp.post('evora:open', { docRef: __ehp.ulid(), name: 'x.vectorcraft', url: 'https://medias.invalid/x' })`],
    ['plafond + 1 octet', 'too_large', `(() => { const b = new ArrayBuffer(${MAX_DOC + 1}); return __ehp.post('evora:open', { docRef: __ehp.ulid(), name: 'x.svg', bytes: b }, { transfer: [b] }); })()`],
  ];
  for (const [what, code, expr] of refusals) {
    const id = await parentEval(expr);
    const a = await waitAck(id);
    step(`evora:open (${what}) → ${code}`, ackIs(a, false, code), J(a));
  }

  // 6. Ouverture d'un document reçu en octets (ou, dans « pont-ehp-neuf », d'un document vierge
  //    sans octets : evora:open {new: true}, HOST-PROTOCOL §7.1), puis dirty false.
  const docRef = await parentEval('__ehp.ulid()');
  const docName = SMOKE_EHP_NEW ? 'evora-neuf' : 'evora-smoke.svg';
  const savedName = SMOKE_EHP_NEW ? 'evora-neuf.vectorcraft' : 'evora-smoke.vectorcraft';
  const openId = SMOKE_EHP_NEW
    ? await parentEval(`__ehp.post('evora:open', { docRef: ${J(docRef)}, name: ${J(docName)}, new: true })`)
    : await parentEval(`(() => { const b = __ehp.text(${J(SMOKE_SVG)}); return __ehp.post('evora:open', { docRef: ${J(docRef)}, name: ${J(docName)}, bytes: b }, { transfer: [b] }); })()`);
  const opened = await waitAck(openId);
  if (!step(SMOKE_EHP_NEW ? 'evora:open (document neuf) acquitté' : 'evora:open (octets) acquitté', ackIs(opened, true), J(opened))) return finishEhp(ehp);
  const clean0 = await waitParent(`__ehp.all('evora:dirty').filter((m) => m.payload.dirty === false && m.payload.docRef === ${J(docRef)}).length >= 1`);
  step('evora:dirty false après ouverture', clean0);
  const otherId = await parentEval(`(() => { const b = __ehp.text(${J(SMOKE_SVG)}); return __ehp.post('evora:open', { docRef: __ehp.ulid(), name: 'autre.svg', bytes: b }, { transfer: [b] }); })()`);
  step('second docRef (octets) → busy (un document à la fois)', ackIs(await waitAck(otherId), false, 'busy'));
  const otherNewId = await parentEval(`__ehp.post('evora:open', { docRef: __ehp.ulid(), name: 'autre', new: true })`);
  const otherNew = await waitAck(otherNewId);
  step('second docRef (document neuf) → busy (un document à la fois)', ackIs(otherNew, false, 'busy'), J(otherNew));

  // 7. Une modification (collage d'un SVG dans le moteur) → dirty true.
  const pasted = await engineEval(PASTE).catch((e) => String(e));
  step('collage pris par le moteur', pasted === true, J(pasted));
  const dirty = await waitParent(`__ehp.all('evora:dirty').some((m) => m.payload.dirty === true && m.payload.docRef === ${J(docRef)})`);
  if (!step('evora:dirty true après modification', dirty)) return finishEhp(ehp);

  // 8. evora:request-save → evora:save (document natif, non vide), puis dirty false, puis clean.
  const rsId = await parentEval(`__ehp.post('evora:request-save', { reason: 'user', docRef: ${J(docRef)} })`);
  const save = await waitParent(`__ehp.find('evora:save', ${J(rsId)})`);
  const sp = save ? save.payload : {};
  step('evora:request-save → evora:save conforme',
    !!save && save.problems.length === 0 && sp.docRef === docRef && sp.name === savedName && sp.saveAs === false && sp.bytes && sp.bytes.arrayBuffer >= 1,
    J(save));
  const cleaned = await waitParent(`(() => { const d = __ehp.all('evora:dirty'); const s = d.findIndex((m) => m.payload.dirty === true); return s >= 0 && d.slice(s + 1).some((m) => m.payload.dirty === false); })()`);
  step('evora:dirty false après evora:save', cleaned);
  const again = await waitAck(await parentEval(`__ehp.post('evora:request-save', { reason: 'autosave', docRef: ${J(docRef)} })`));
  step('evora:request-save sans modification → clean', ackIs(again, true, 'clean'), J(again));
  const unknown = await waitAck(await parentEval(`__ehp.post('evora:request-save', { reason: 'user', docRef: __ehp.ulid() })`));
  step("evora:request-save d'un autre docRef → not_found", ackIs(unknown, false, 'not_found'), J(unknown));

  // 9. Réouverture des octets enregistrés (même docRef : rechargement de la version du serveur).
  if (save) {
    const before = await parentEval("__ehp.all('evora:dirty').length");
    const reopenId = await parentEval(`(() => { const b = __ehp.saved.slice(0); return __ehp.post('evora:open', { docRef: ${J(docRef)}, name: ${J(savedName)}, bytes: b }, { transfer: [b] }); })()`);
    step('réouverture du document enregistré', ackIs(await waitAck(reopenId), true));
    step('evora:dirty false après réouverture', await waitParent(`__ehp.all('evora:dirty').slice(${before}).some((m) => m.payload.dirty === false)`));
  }

  // 10. Thème et langue à chaud.
  const themeAck = await waitAck(await parentEval(`__ehp.post('evora:theme', { theme: 'light', accent: '#4F46E5' })`));
  step('evora:theme acquitté', ackIs(themeAck, true), J(themeAck));
  const light = await waitBar((hex) => near(hex, 'e4e4e4'));
  step('evora:theme clair au rendu', light.ok, `barre #${light.got}`);
  for (const [payload, want] of [[{ lang: 'de', engineLang: 'de' }, 'de'], [{ lang: 'pt', engineLang: null }, 'en']]) {
    const a = await waitAck(await parentEval(`__ehp.post('evora:lang', ${J(payload)})`));
    let got = null;
    for (let i = 0; i < 50 && got !== want; i += 1) {
      got = await engineEval('document.documentElement.lang').catch(() => null);
      if (got !== want) await sleep(200);
    }
    step(`evora:lang ${payload.engineLang} → ${want}`, ackIs(a, true) && got === want, `accusé ${J(a)}, lang « ${got} »`);
  }

  // 11. evora:purge : accusé après effacement ; stockage du moteur vide, et qui le reste.
  await engineEval(`localStorage.setItem(${J(SEED_LATE_KEY)}, 'QUJD')`);
  keys = await engineKeys();
  step('copie semée avant la purge', keys.includes(SEED_LATE_KEY), J(keys));
  const purgeAck = await waitAck(await parentEval(`__ehp.post('evora:purge', { scope: 'current' })`));
  step('evora:purge acquitté', ackIs(purgeAck, true), J(purgeAck));
  if (SMOKE_SABOTAGE === 'detectors') {
    // Témoin sabordé : une copie réapparaît après la purge ; le contrôle doit la voir.
    await engineEval(`localStorage.setItem(${J(SEED_LATE_KEY)}, 'QUJD')`);
  }
  for (const when of ['aussitôt', 'deux secondes plus tard']) {
    if (when !== 'aussitôt') await sleep(2000);
    keys = await engineKeys();
    const stores = JSON.parse(await engineEval(ENGINE_STORES, true));
    ehp.storage[`afterPurge (${when})`] = { localStorage: keys, ...stores };
    const leftovers = [
      ...keys.filter((k) => k !== SEED_WITNESS_KEY),
      ...(Array.isArray(stores.indexedDB) ? stores.indexedDB.map((n) => `indexedDB:${n}`) : []),
      ...(Array.isArray(stores.opfs) ? stores.opfs.map((n) => `opfs:${n}`) : []),
      ...(Array.isArray(stores.caches) ? stores.caches.map((n) => `caches:${n}`) : []),
      ...(Array.isArray(stores.sessionStorage) ? stores.sessionStorage.map((n) => `sessionStorage:${n}`) : []),
      // Un stockage illisible ne prouve pas qu'il est vide.
      ...['indexedDB', 'opfs', 'caches', 'sessionStorage'].filter((k) => typeof stores[k] === 'string').map((k) => `${k}:${stores[k]}`),
    ];
    step(`stockage du moteur vide après evora:purge (${when})`, leftovers.length === 0, J(leftovers));
    step(`témoin intact après evora:purge (${when})`, keys.includes(SEED_WITNESS_KEY), J(keys));
  }

  if (SMOKE_SABOTAGE === 'detectors') {
    // Témoin sabordé : la demande d'enregistrement légitime est comptée comme étrangère ; sa
    // réponse doit être vue comme une réponse interdite.
    await parentEval(`__ehp.ids.foreign.push(${J(rsId)})`);
  }
  await sleep(500);
  return finishEhp(ehp);
}

async function finishEhp(ehp) {
  const state = await parentEval('JSON.stringify({ log: __ehp.log, ids: __ehp.ids, others: __ehp.others })').then(JSON.parse).catch((e) => ({ error: String(e) }));
  const log = state.log || [];
  ehp.messages = log.map((m) => ({ type: m.type, id: m.id, re: m.re, payload: m.payload, problems: m.problems }));
  ehp.others = state.others || [];
  ehp.ids = state.ids || {};
  const fail = (why) => report.reasons.push(`[ehp] ${why}`);
  if (state.error) fail(`journal de la page parente illisible : ${state.error}`);
  const readies = log.filter((m) => m.type === 'evora:ready').length;
  if (readies !== 1) fail(`evora:ready reçu ${readies} fois (attendu : 1)`);
  for (const m of log) if (m.problems.length) fail(`enveloppe hors norme (${m.type}) : ${m.problems.join(' ; ')}`);
  const ids = log.map((m) => m.id);
  if (new Set(ids).size !== ids.length) fail('id réutilisé par le moteur');
  const forbidden = new Set([...(ehp.ids.ignored || []), ...(ehp.ids.foreign || [])]);
  const answered = log.filter((m) => m.re && forbidden.has(m.re));
  if (answered.length) fail(`réponse à un message qui devait être ignoré : ${JSON.stringify(answered.map((m) => ({ type: m.type, re: m.re })))}`);
  if (ehp.others.length) fail(`messages d'une autre source reçus par la page parente : ${JSON.stringify(ehp.others).slice(0, 300)}`);
}

async function main() {
  const serverA = await listen(engineHandler);
  report.originA = `http://127.0.0.1:${serverA.address().port}`;
  const serverC = SMOKE_EHP ? await listen(foreignHandler) : null;
  report.originC = serverC ? `http://127.0.0.1:${serverC.address().port}` : null;
  let serverB = null;
  let handlerB = null;
  serverB = await listen((req, res) => handlerB(req, res));
  report.originB = `http://127.0.0.1:${serverB.address().port}`;
  handlerB = parentHandler({ a: report.originA, c: report.originC });
  if (SMOKE_EHP) {
    // Ce qu'écrit le provisionnement d'Evora ; sabordé, une autre origine que la page parente.
    hostConfig = { parentOrigins: [SMOKE_SABOTAGE === 'origin' ? 'http://127.0.0.1:1' : report.originB] };
  }
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
  pageSession = sessionId;
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
      const png = decodePng(Buffer.from(shot.data, 'base64'));
      report.pixels = pixelStats(png, rect);
      report.theme.dominantBar = dominantTop(png, rect, 10);
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
  report.storage.after = p ? p.storageKeys : null;
  if (SMOKE_EXPECT_BAR && report.ready) {
    const got = report.theme.dominantBar || '';
    const near = got.length === 6 && [0, 2, 4].every((i) => Math.abs(parseInt(got.slice(i, i + 2), 16) - parseInt(SMOKE_EXPECT_BAR.slice(i, i + 2), 16)) <= 3);
    if (!near) report.reasons.push(`thème imposé : barre d'application #${got || '?'} au lieu de #${SMOKE_EXPECT_BAR}`);
  }
  if (SMOKE_SEED && report.ready) {
    // Correctif d'E5 : le seul paramètre d'URL (?host=evora) n'efface rien ; la purge n'a lieu que
    // sur un evora:init ou un evora:purge vérifiés (scénario « pont-ehp »).
    const after = report.storage.after || [];
    if (!after.includes(SEED_RECOVERY_KEY)) report.reasons.push(`stockage hébergé : la copie semée a disparu sans evora:init ni evora:purge (purge sur simple paramètre d'URL) ; clés : ${after.join(', ') || 'aucune'}`);
    if (!after.includes(SEED_WITNESS_KEY)) report.reasons.push('stockage hébergé : la clé témoin a disparu');
  }
  if (SMOKE_HOST === 'evora' && !SMOKE_EHP && report.ready) {
    // evora-host.json de l'artefact (vide) : le pont reste muet.
    try {
      const r = await send('Runtime.evaluate', { expression: 'JSON.stringify(window.__evoraMessages || [])', returnByValue: true }, sessionId);
      report.parentMessages = JSON.parse(r.result.value);
    } catch (e) {
      report.parentMessages = [{ error: String(e) }];
    }
    if (report.parentMessages.length) report.reasons.push(`pont sans origine admise : ${report.parentMessages.length} message(s) reçus par la page parente (attendu : aucun)`);
  }
  if (SMOKE_EHP && report.ready) await ehpScenario();
  if (SMOKE_EXPECT_LANG && report.lang.got !== SMOKE_EXPECT_LANG) {
    report.reasons.push(`langue imposée : attendu « ${SMOKE_EXPECT_LANG} », obtenu « ${report.lang.got} »`);
  }
  report.ok = report.reasons.length === 0;

  await send('Browser.close').catch(() => {});
  await sleep(500);
  if (chrome.exitCode === null) chrome.kill('SIGKILL');
  serverA.close();
  serverB.close();
  if (serverC) serverC.close();
}

const watchdog = setTimeout(() => {
  report.reasons.push('délai global dépassé');
  finish(1);
}, READY_TIMEOUT_MS + (SMOKE_EHP ? 300_000 : 60_000));

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
