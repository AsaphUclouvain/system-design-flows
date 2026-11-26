/* System Design Flows: the app engine. Flows themselves live in the FLOWS data (see flow({...}) calls).
   You normally never need to edit this file to add or change a flow. */
(function () {
'use strict';

const FLOWS = window.SD_FLOWS, GLOSSARY = window.SD_GLOSSARY;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = $('#app');
const reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

const CATEGORY_ORDER = ['Web & networking', 'Infrastructure foundations', 'Databases & replication', 'Distributed systems', 'Messaging & events', 'Identity & security', 'Real-time', 'Product systems', 'Search & discovery', 'Commerce & money', 'Data at scale', 'AI & machine learning'];
const KIND_LABEL = { client: 'Client', edge: 'Edge', service: 'Service', worker: 'Worker', db: 'Database', cache: 'Cache', queue: 'Queue / log', storage: 'Object storage', external: 'Third party', ai: 'AI model' };

/* ---------- icons ---------- */
const ICON = {
  client: '<path d="M4 5h16v10H4z"/><path d="M9 19h6M12 15v4"/>',
  phone: '<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M11 18h2"/>',
  edge: '<path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z"/>',
  lb: '<circle cx="12" cy="5" r="2"/><path d="M12 7v4M12 11l-6 6M12 11l6 6M12 11v6"/><circle cx="6" cy="19" r="1.6"/><circle cx="12" cy="19" r="1.6"/><circle cx="18" cy="19" r="1.6"/>',
  cdn: '<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c2.5 2.5 2.5 13.5 0 16M12 4c-2.5 2.5-2.5 13.5 0 16"/>',
  service: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>',
  worker: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  db: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/>',
  cache: '<path d="M13 2L5 13h6l-1 9 8-11h-6z"/>',
  queue: '<rect x="3" y="6" width="4" height="12" rx="1"/><rect x="10" y="6" width="4" height="12" rx="1"/><rect x="17" y="6" width="4" height="12" rx="1"/>',
  storage: '<path d="M4 7h16l-1.5 13h-13z"/><path d="M3 7l2-3h14l2 3"/>',
  external: '<path d="M7 18a5 5 0 010-10 6 6 0 0111.3 1.5A4 4 0 0117 18z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4.5-6 8-6s7 2 8 6"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
  bell: '<path d="M6 16V11a6 6 0 0112 0v5l2 2H4z"/><path d="M10 20a2 2 0 004 0"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>',
  card: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18M7 15h3"/>',
  map: '<path d="M9 4l6 2 6-2v14l-6 2-6-2-6 2V6z"/><path d="M9 4v14M15 6v14"/>',
  chart: '<path d="M4 20V4M4 20h16"/><path d="M8 16v-5M12 16V8M16 16v-8"/>',
  spider: '<circle cx="12" cy="12" r="3"/><path d="M12 9V3M12 15v6M9 12H3M15 12h6M9.8 9.8L5 5M14.2 9.8L19 5M9.8 14.2L5 19M14.2 14.2L19 19"/>',
  dns: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="7" cy="6" r=".6"/><circle cx="7" cy="12" r=".6"/><circle cx="7" cy="18" r=".6"/>',
  play: '<circle cx="12" cy="12" r="9"/><path d="M10 8.5v7l6-3.5z"/>',
  tree: '<circle cx="12" cy="5" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/><path d="M12 7v4M12 11l-6 5M12 11l6 5"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M15 8l2 2"/>',
  cart: '<path d="M3 4h2l2.5 11h11L21 7H6.2"/><circle cx="9" cy="19" r="1.5"/><circle cx="17" cy="19" r="1.5"/>',
  car: '<path d="M5 16V11l2-5h10l2 5v5"/><path d="M3 16h18v3H3z"/><circle cx="7.5" cy="13" r="1"/><circle cx="16.5" cy="13" r="1"/>',
  doc: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
  gauge: '<path d="M4 18a8 8 0 1116 0"/><path d="M12 18l4-6"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
  flag: '<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>',
  trophy: '<path d="M8 4h8v5a4 4 0 01-8 0z"/><path d="M8 6H5v1a3 3 0 003 3M16 6h3v1a3 3 0 01-3 3M12 13v4M8 21h8M9 17h6v4H9z"/>',
  pen: '<path d="M4 20l4-1 11-11-3-3L5 16z"/><path d="M14 6l3 3"/>',
  hash: '<path d="M9 3L7 21M17 3l-2 18M4 8h17M3 16h17"/>',
  server: '<rect x="4" y="4" width="16" height="7" rx="1.5"/><rect x="4" y="13" width="16" height="7" rx="1.5"/><path d="M8 7.5h.01M8 16.5h.01"/>',
  ticket: '<path d="M3 8a2 2 0 002-2h14a2 2 0 002 2v2a2 2 0 000 4v2a2 2 0 00-2 2H5a2 2 0 00-2-2v-2a2 2 0 000-4z"/><path d="M14 6v12"/>',
  ring: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="4" r="1.6"/><circle cx="19" cy="15" r="1.6"/><circle cx="5" cy="15" r="1.6"/>',
  pulse: '<path d="M3 12h4l2-6 4 12 2-6h6"/>',
  video: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3"/>',
  laptop: '<rect x="5" y="5" width="14" height="10" rx="1.5"/><path d="M2.5 19h19l-2-4h-15z"/>',
  browser: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/><path d="M6 6.5h.01M8.5 6.5h.01M11 6.5h.01"/>',
  pin: '<path d="M12 21s-6-5.5-6-11a6 6 0 0112 0c0 5.5-6 11-6 11z"/><circle cx="12" cy="10" r="2.2"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5"/><path d="M5 20h14"/>',
  plug: '<path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 01-12 0zM12 17v4"/>',
  box: '<path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4M12 11v10"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.6 2.6L16 9.5"/>',
  split: '<path d="M4 12h6l4-6h6M10 12l4 6h6"/><path d="M18 4l2 2-2 2M18 16l2 2-2 2"/>',
  wallet: '<path d="M4 7h14a2 2 0 012 2v9a2 2 0 01-2 2H5a1 1 0 01-1-1V6a2 2 0 012-2h11"/><circle cx="16" cy="13.5" r="1.3"/>',
  building: '<path d="M5 21V4h10v17M15 9h4v12M3 21h18"/><path d="M8 7.5h1M11 7.5h1M8 11h1M11 11h1M8 14.5h1M11 14.5h1"/>',
  inbox: '<path d="M3 13l3-8h12l3 8v6H3z"/><path d="M3 13h5l1.5 2.5h5L16 13h5"/>',
  route: '<circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="6" r="2.2"/><path d="M8 18h7a3 3 0 000-6H9a3 3 0 010-6h7"/>',
  log: '<path d="M6 3h9l4 4v14H6z"/><path d="M9 10h7M9 14h7M9 18h4"/>',
  vote: '<path d="M4 11l3 3 6-7"/><path d="M11 20h9M14 15h6"/>',
  brain: '<path d="M9 4a3 3 0 00-3 3 3 3 0 00-2 5 3 3 0 002 5 3 3 0 003 3h1V4z"/><path d="M15 4a3 3 0 013 3 3 3 0 012 5 3 3 0 01-2 5 3 3 0 01-3 3h-1V4z"/>',
  spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
  vector: '<circle cx="5" cy="18" r="1.6"/><circle cx="9" cy="8" r="1.6"/><circle cx="15" cy="14" r="1.6"/><circle cx="19" cy="5" r="1.6"/><path d="M4 21V3M2 19h20" opacity=".6"/>',
  tool: '<path d="M14.5 6.5a4 4 0 01-5.3 5.3L4 17l3 3 5.2-5.2a4 4 0 005.3-5.3l-2.4 2.4-2.4-.6-.6-2.4z"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0013 0M12 17.5V21M8.5 21h7"/>',
  speaker: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16.5 8.5a5 5 0 010 7M19 6a8.5 8.5 0 010 12"/>',
  doc: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
  gpu: '<rect x="3" y="6" width="18" height="12" rx="1.5"/><rect x="7" y="9" width="6" height="6"/><path d="M16 9h2M16 12h2M16 15h2M7 18v3M11 18v3M15 18v3"/>',
  robot: '<rect x="5" y="8" width="14" height="11" rx="2.5"/><path d="M12 4v4M9.5 13h.01M14.5 13h.01M9.5 16.5h5"/><circle cx="12" cy="3.5" r="1"/>',
  chart: '<path d="M4 20V4M4 20h16"/><path d="M7 15l4-4 3 3 5-6"/>',
  cloud: '<path d="M7 18h10a4 4 0 00.6-7.95A6 6 0 006.2 9.2 4.5 4.5 0 007 18z"/>',
  api: '<path d="M8 7l-5 5 5 5M16 7l5 5-5 5M13.5 5l-3 14"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5" opacity=".7"/>',
  folder: '<path d="M3 6.5A1.5 1.5 0 014.5 5H10l2 2h7.5A1.5 1.5 0 0121 8.5v9a1.5 1.5 0 01-1.5 1.5h-15A1.5 1.5 0 013 17.5z"/>',
  ai: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>'
};
const svgIcon = (k) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + (ICON[k] || ICON.service) + '</svg>';
const UI = {
  prev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
  next: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5v14l12-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>',
  restart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12a8 8 0 108-8H8"/><path d="M10 1L7 4l3 3"/></svg>',
  search: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>',
  theme: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 000 16z" fill="currentColor"/></svg>'
};
const nodeIcon = n => svgIcon(n.icon || ({ edge: 'edge', external: 'external' }[n.kind] || n.kind));
const kc = kind => 'var(--k-' + (kind || 'service') + ')';

/* ---------- progress (stored on this device only) ---------- */
const STORE = 'sdflows:v1';
let progress = {};
try { progress = JSON.parse(localStorage.getItem(STORE)) || {}; } catch (e) { progress = {}; }
function markSeen(id, i) {
  const s = new Set(progress[id] || []); s.add(i); progress[id] = Array.from(s);
  try { localStorage.setItem(STORE, JSON.stringify(progress)); } catch (e) {}
}

/* ---------- rich text: `code`, **bold**, [[nodeId]] chips, {{glossary term}} ---------- */
let currentFlow = null;
function rich(s, flow) {
  flow = flow || currentFlow;
  let h = esc(s);
  h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
  h = h.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  h = h.replace(/\[\[([\w-]+)(?:\|([^\]]+))?\]\]/g, (m, id, label) => {
    const n = flow && flow.nodes.find(x => x.id === id);
    if (!n) return label || id;
    return '<button type="button" class="sd-n" data-node="' + esc(id) + '" style="--kc:' + kc(n.kind) + '"><i></i>' + (label || esc(n.label)) + '</button>';
  });
  h = h.replace(/\{\{([^}|]+)(?:\|([^}]+))?\}\}/g, (m, t, label) => {
    const key = t.trim().toLowerCase();
    return GLOSSARY[key] ? '<button type="button" class="sd-term" data-term="' + esc(key) + '">' + (label || t) + '</button>' : (label || t);
  });
  return h;
}
const paras = (v, flow) => (Array.isArray(v) ? v : [v]).filter(Boolean).map(p => '<p>' + rich(p, flow) + '</p>').join('');

/* ---------- code highlighting ---------- */
const KW = {
  python: 'def class return if elif else for while in not and or is None True False import from as with async await try except finally raise lambda yield pass break continue assert del',
  ts: 'const let var function return if else for while of in new class extends import from export default async await try catch finally throw typeof interface type enum implements null undefined true false this switch case break continue as',
  sql: 'select from where insert into values update set delete create table index unique primary key references not null default on conflict do nothing returning join left inner group by order limit for skip locked and or as begin commit in is with case when then else end text bigint int integer timestamptz jsonb uuid boolean now interval bigserial serial check alter add desc asc exists using partition over smallint numeric char varchar date gin btree concurrently if replace function language trigger',
  redis: 'set get incr incrby expire hset hget hgetall hincrby zadd zrange zrevrange zincrby zrem zrangebyscore zcard zscore xadd xreadgroup xack xautoclaim eval evalsha publish subscribe del ex nx px exat multi exec lpush rpush brpop lrange sadd srem smembers sismember pexpire ttl geoadd geosearch scard exists setnx incrbyfloat',
  bash: 'curl export echo if then fi for do done',
  yaml: 'true false null',
  http: ''
};
KW.tsx = KW.ts; KW.js = KW.ts;
const COMMENT = { python: '#', bash: '#', yaml: '#', redis: '#', ts: '//', tsx: '//', js: '//', sql: '--', http: null, json: null };
function highlight(src, lang) {
  lang = lang || 'text';
  const kws = new Set((KW[lang] || '').split(' ').filter(Boolean));
  const ci = lang === 'sql' || lang === 'redis';
  const cm = COMMENT[lang];
  const parts = [];
  if (cm) parts.push('(' + cm.replace(/[/]/g, '\\/') + '[^\\n]*)'); else parts.push('(\\u0000NEVER)');
  parts.push('("""[\\s\\S]*?"""|\'\'\'[\\s\\S]*?\'\'\'|"(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\')');
  parts.push('(@[\\w.]+)');
  parts.push('(\\b\\d+(?:\\.\\d+)?\\b)');
  parts.push('([A-Za-z_][\\w]*)(?=\\s*\\()');
  parts.push('([A-Za-z_][\\w-]*)');
  const re = new RegExp(parts.join('|'), 'g');
  let out = '', last = 0, m;
  if (lang === 'text' || lang === 'json') return esc(src);
  while ((m = re.exec(src))) {
    out += esc(src.slice(last, m.index)); last = re.lastIndex;
    const t = m[0];
    if (m[1]) out += '<span class="c">' + esc(t) + '</span>';
    else if (m[2]) out += '<span class="s">' + esc(t) + '</span>';
    else if (m[3] && lang !== 'sql') out += '<span class="de">' + esc(t) + '</span>';
    else if (m[4]) out += '<span class="nu">' + esc(t) + '</span>';
    else if (m[5]) out += kws.has(ci ? t.toLowerCase() : t) ? '<span class="kw">' + esc(t) + '</span>' : '<span class="fn">' + esc(t) + '</span>';
    else if (m[6]) out += kws.has(ci ? t.toLowerCase() : t) ? '<span class="kw">' + esc(t) + '</span>' : esc(t);
    else out += esc(t);
  }
  return out + esc(src.slice(last));
}

/* ---------- JSON payload with automatic diff against the previous step ---------- */
function flatten(v, p, out) {
  out = out || {};
  if (v && typeof v === 'object') {
    const ks = Array.isArray(v) ? v.map((_, i) => i) : Object.keys(v);
    if (!ks.length) out[p] = JSON.stringify(v);
    ks.forEach(k => flatten(v[k], p === '' ? String(k) : p + '.' + k, out));
  } else out[p] = JSON.stringify(v);
  return out;
}
function fmtVal(v) {
  if (typeof v === 'string') return '<span class="s">' + esc(JSON.stringify(v)) + '</span>';
  if (typeof v === 'number') return '<span class="n">' + v + '</span>';
  return '<span class="b">' + esc(JSON.stringify(v)) + '</span>';
}
function renderJSON(val, prev, fields) {
  const pf = prev ? flatten(prev, '') : null;
  const pkeys = pf ? Object.keys(pf) : [];
  const fx = fields || {};
  const lines = [];
  const status = (path, leaf, v) => {
    if (!pf) return '';
    if (leaf) { if (!(path in pf)) return 'add'; return pf[path] !== JSON.stringify(v) ? 'chg' : ''; }
    return pkeys.some(k => k === path || k.startsWith(path + '.')) ? '' : 'add';
  };
  const fieldFor = (path, key) => fx[path] != null ? path : (key != null && fx[key] != null ? String(key) : null);
  function walk(v, key, path, depth, last) {
    const ind = '  '.repeat(depth);
    const kh = (key === null || typeof key === 'number') ? '' : '<span class="k">' + esc(JSON.stringify(key)) + '</span>: ';
    const comma = last ? '' : ',';
    const f = key === null ? null : fieldFor(path, typeof key === 'number' ? null : key);
    const push = (st, html) => lines.push({ st, html, f });
    if (v && typeof v === 'object') {
      const arr = Array.isArray(v), ents = arr ? v.map((x, i) => [i, x]) : Object.entries(v);
      const st = path === '' ? '' : status(path, false);
      if (!ents.length) { push(st, ind + kh + (arr ? '[]' : '{}') + comma); return; }
      push(st, ind + kh + (arr ? '[' : '{'));
      ents.forEach(([k, x], i) => walk(x, arr ? i : k, path === '' ? String(k) : path + '.' + k, depth + 1, i === ents.length - 1));
      lines.push({ st, html: ind + (arr ? ']' : '}') + comma, f: null });
    } else push(status(path, true, v), ind + kh + fmtVal(v) + comma);
  }
  walk(val, null, '', 0, true);
  let removed = [];
  if (pf) {
    const cur = flatten(val, '');
    const ckeys = Object.keys(cur);
    const exists = p => ckeys.some(k => k === p || k.startsWith(p + '.'));
    const set = new Set();
    pkeys.filter(k => !(k in cur)).forEach(k => {
      const segs = k.split('.'); let p = '';
      for (let i = 0; i < segs.length; i++) { p = i ? p + '.' + segs[i] : segs[i]; if (!exists(p)) { set.add(p); break; } }
    });
    removed = Array.from(set);
  }
  const html = lines.map(l => {
    const mark = l.st === 'add' ? '+' : l.st === 'chg' ? '~' : '';
    const cls = 'ln' + (l.st ? ' ' + l.st : '') + (l.f ? ' fx' : '');
    return '<span class="' + cls + '"' + (l.f ? ' data-field="' + esc(l.f) + '"' : '') + '><i>' + mark + '</i>' + l.html + '</span>';
  }).join('');
  const counts = { add: lines.filter(l => l.st === 'add' && l.f !== undefined).length, chg: lines.filter(l => l.st === 'chg').length };
  return { html, removed, counts };
}

/* ---------- tiny architecture thumbnail for the home cards ---------- */
function thumb(f) {
  const W = 300, H = 112, g = f.grid, pad = 22;
  const pos = n => [pad + (n.x + .5) * (W - 2 * pad) / g.cols, 12 + (n.y + .5) * (H - 24) / g.rows];
  const pairs = new Map();
  f.steps.forEach(s => { if (s.from !== s.to) { const k = [s.from, s.to].sort().join('|'); pairs.set(k, s); } });
  let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet" aria-hidden="true">';
  pairs.forEach((s, k) => {
    const [a, b] = k.split('|').map(id => f.nodes.find(n => n.id === id));
    if (!a || !b) return; const [x1, y1] = pos(a), [x2, y2] = pos(b);
    svg += '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" stroke="var(--rule2)" stroke-width="1.5"/>';
  });
  f.nodes.forEach(n => { const [x, y] = pos(n); svg += '<rect x="' + (x - 13) + '" y="' + (y - 9) + '" width="26" height="18" rx="5" fill="' + kc(n.kind) + '"/>'; });
  return svg + '</svg>';
}

/* ---------- routing ---------- */
function route() {
  stopAll();
  const h = location.hash.replace(/^#\/?/, '').split('/');
  window.scrollTo(0, 0);
  if (h[0] === 'flow' && h[1]) {
    const f = FLOWS.find(x => x.id === h[1]);
    if (f) return renderFlow(f, Math.max(0, Math.min(f.steps.length - 1, (parseInt(h[2], 10) || 1) - 1)));
  }
  if (h[0] === 'glossary') return renderGlossary();
  if (h[0] === 'edit') return renderEdit();
  renderHome();
}
function setNav(which) { $$('.sd-nav a').forEach(a => a.classList.toggle('on', a.dataset.nav === which)); }

/* ---------- home ---------- */
let homeState = { q: '', cat: 'All' };
function renderHome() {
  currentFlow = null; setNav('flows'); document.title = 'System Design Flows';
  $('.sd-progressbar').style.width = '0';
  const cats = ['All'].concat(CATEGORY_ORDER.filter(c => FLOWS.some(f => f.category === c)));
  const totalSteps = FLOWS.reduce((a, f) => a + f.steps.length, 0);
  app.innerHTML =
    '<section class="sd-hero"><div class="sd-eyebrow">Interactive system design</div>' +
    '<h1>Watch real systems move, one hop at a time.</h1>' +
    '<p>' + FLOWS.length + ' flows and ' + totalSteps + ' steps. Pick a flow, step through it, and see what each component does, the exact payload at that point, the fields that change, what fails, and the code behind it in Next.js, FastAPI, PostgreSQL and Redis.</p>' +
    '<div class="sd-legend">' + Object.keys(KIND_LABEL).map(k => '<span><i style="background:' + kc(k) + '"></i>' + KIND_LABEL[k] + '</span>').join('') + '</div></section>' +
    '<div class="sd-tools"><label class="sd-search">' + UI.search + '<input id="q" type="search" placeholder="Search flows, components, terms" value="' + esc(homeState.q) + '" autocomplete="off"></label>' +
    '<div class="sd-chips" id="cats">' + cats.map(c => '<button class="sd-chip' + (c === homeState.cat ? ' on' : '') + '" data-cat="' + esc(c) + '">' + esc(c) + '</button>').join('') + '</div></div>' +
    '<div id="list"></div>';
  const draw = () => {
    const q = homeState.q.trim().toLowerCase();
    const match = f => (homeState.cat === 'All' || f.category === homeState.cat) && (!q || [f.title, f.summary, f.category, (f.tags || []).join(' '), f.nodes.map(n => n.label).join(' '), f.steps.map(s => s.title).join(' ')].join(' ').toLowerCase().includes(q));
    const list = FLOWS.filter(match);
    if (!list.length) { $('#list').innerHTML = '<p class="sd-empty">No flow matches "' + esc(homeState.q) + '".</p>'; return; }
    $('#list').innerHTML = CATEGORY_ORDER.concat(Array.from(new Set(FLOWS.map(f => f.category))).filter(c => !CATEGORY_ORDER.includes(c))).map(c => {
      const fl = list.filter(f => f.category === c); if (!fl.length) return '';
      return '<div class="sd-cat"><h2>' + esc(c) + '</h2><span class="sd-count">' + fl.length + ' flows</span></div><div class="sd-grid">' + fl.map(card).join('') + '</div>';
    }).join('');
  };
  const card = f => {
    const seen = (progress[f.id] || []).length;
    return '<a class="sd-card" href="#/flow/' + f.id + '">' + (seen ? '<span class="sd-done">' + (seen >= f.steps.length ? 'Done' : seen + '/' + f.steps.length) + '</span>' : '') +
      '<div class="sd-thumb">' + thumb(f) + '</div><div class="sd-card-b"><h3>' + esc(f.title) + '</h3><p>' + esc(f.summary) + '</p>' +
      '<div class="sd-meta"><span>' + f.steps.length + ' steps</span>' + (f.tags || []).slice(0, 3).map(t => '<span class="sd-tag">' + esc(t) + '</span>').join('') + '</div></div></a>';
  };
  draw();
  $('#q').addEventListener('input', e => { homeState.q = e.target.value; draw(); });
  $('#cats').addEventListener('click', e => { const b = e.target.closest('[data-cat]'); if (!b) return; homeState.cat = b.dataset.cat; $$('#cats .sd-chip').forEach(x => x.classList.toggle('on', x === b)); draw(); });
}

/* ---------- flow page ---------- */
let S = null; // state of the open flow
function renderFlow(f, start) {
  currentFlow = f; setNav(''); document.title = f.title + ' · System Design Flows';
  const tabsMemo = (S && S.tab) || 'explain';
  S = { f, i: start, tab: tabsMemo, playing: false, speed: 1, raf: 0, timer: 0, hist: [], choice: {} };
  const sec = [];
  if (f.requirements) sec.push(['req', 'Requirements']);
  if (f.estimates) sec.push(['est', 'Scale']);
  sec.push(['sim', 'Walkthrough']);
  if (f.api) sec.push(['api', 'API']);
  if (f.schema) sec.push(['data', 'Data model']);
  if (f.decisions) sec.push(['deep', 'Deep dives']);
  sec.push(['steps', 'All steps']);
  if (f.refs) sec.push(['refs', 'References']);
  let h = '<nav class="sd-crumb"><a href="#/">Flows</a><span>›</span><span>' + esc(f.category) + '</span></nav>' +
    '<header class="sd-fhead"><h1>' + esc(f.title) + '</h1><p>' + rich(f.summary) + '</p>' +
    '<div class="sd-fmeta"><span class="sd-tag">' + f.steps.length + ' steps</span><span class="sd-tag">' + f.nodes.length + ' components</span>' + (f.tags || []).map(t => '<span class="sd-tag">' + esc(t) + '</span>').join('') + '</div></header>' +
    '<nav class="sd-jump">' + sec.map(s => '<a href="#' + s[0] + '" data-jump="' + s[0] + '">' + s[1] + '</a>').join('') + '</nav>';

  if (f.requirements) {
    h += '<section class="sd-sec" id="sec-req"><h2>Requirements</h2><p class="sub">What the system must do, and the qualities it must keep while doing it.</p><div class="sd-two">' +
      '<div class="sd-box sd-pad"><h3>Functional</h3><ul class="sd-list">' + f.requirements.functional.map(x => '<li>' + rich(x) + '</li>').join('') + '</ul></div>' +
      '<div class="sd-box sd-pad"><h3>Non-functional</h3><ul class="sd-list">' + f.requirements.nonFunctional.map(x => '<li>' + rich(x) + '</li>').join('') + '</ul></div></div></section>';
  }
  if (f.estimates) {
    h += '<section class="sd-sec" id="sec-est"><h2>Scale, back of the envelope</h2><p class="sub">Illustrative assumptions so the design has numbers to push against. Change them and the design changes.</p><div class="sd-est">' +
      f.estimates.map(e => '<div class="sd-box"><span>' + esc(e.label) + '</span><b>' + esc(e.value) + '</b>' + (e.note ? '<p>' + rich(e.note) + '</p>' : '') + '</div>').join('') + '</div></section>';
  }
  h += '<section class="sd-sec" id="sec-sim"><h2>Walkthrough</h2><p class="sub">Tap a component to see its role. Use the arrows, swipe, or press ← → on a keyboard. Payload lines marked <b>+</b> were added at this step, <b>~</b> changed.</p>' +
    '<div class="sd-sim"><div class="sd-stage sd-box">' +
    '<div class="sd-diagram" id="dg"><div class="sd-canvas" id="cv"><svg class="sd-wires" id="wires"></svg>' +
    f.nodes.map(n => '<button type="button" class="sd-node" data-node="' + n.id + '" style="--kc:' + kc(n.kind) + '" aria-label="' + esc(n.label) + '"><span class="ic">' + nodeIcon(n) + '</span><span class="tx"><b>' + esc(n.label) + '</b>' + (n.sub ? '<small>' + esc(n.sub) + '</small>' : '') + '</span></button>').join('') +
    '</div></div>' +
    '<div class="sd-legend2"><span><svg viewBox="0 0 28 8"><line x1="0" y1="4" x2="28" y2="4" stroke="currentColor" stroke-width="2"/></svg>request</span><span><svg viewBox="0 0 28 8"><line x1="0" y1="4" x2="28" y2="4" stroke="currentColor" stroke-width="2" stroke-dasharray="6 5"/></svg>async / queued</span><span><svg viewBox="0 0 28 8"><line x1="0" y1="4" x2="28" y2="4" stroke="currentColor" stroke-width="2" stroke-dasharray="2 4" stroke-linecap="round"/></svg>response</span>' +
    (hasBranch(f) ? '<span><svg viewBox="0 0 28 8"><line x1="0" y1="4" x2="28" y2="4" stroke="currentColor" stroke-width="1.6" stroke-dasharray="1 3" opacity=".7"/></svg>other branch</span>' : '') +
    '<span><i class="sd-pbadge" style="position:static;transform:none">1</i>earlier step</span></div>' +
    '<div class="sd-ninfo" id="ninfo"></div></div>' +
    '<div class="sd-cappane sd-box"><div class="sd-caption" id="cap"></div><div class="sd-fork" id="fork"></div>' +
    '<div class="sd-ctrl"><button class="sd-btn" id="bPrev" aria-label="Previous step">' + UI.prev + '</button><button class="sd-btn pri" id="bNext">Next ' + UI.next + '</button><button class="sd-btn" id="bPlay" aria-label="Play">' + UI.play + '</button><button class="sd-btn" id="bRestart" aria-label="Restart">' + UI.restart + '</button>' +
    '<label class="sd-speed">speed <input id="speed" type="range" min="0.5" max="2" step="0.25" value="1"></label></div>' +
    '<div class="sd-dots" id="dots">' + f.steps.map((s, i) => '<button class="sd-dot' + (s.path ? ' alt' : '') + '" data-i="' + i + '" title="' + esc((s.path ? '[' + s.path + '] ' : '') + s.title) + '">' + (i + 1) + '</button>').join('') + '</div>' +
    (f.pseudo ? pseudoHTML(f) : '') +
    '</div>' +
    '<div class="sd-panel sd-box" id="panel"><div class="sd-tabs" id="tabs"></div><div class="sd-tabbody" id="tabbody"></div></div></div></section>';

  if (f.api) {
    h += '<section class="sd-sec" id="sec-api"><h2>API</h2><p class="sub">The contract between the pieces. Illustrative, versioned paths.</p><div class="sd-box sd-api">' +
      f.api.map(a => '<div class="sd-ep"><span class="sd-verb ' + esc(a.verb) + '">' + esc(a.verb) + '</span><div><code>' + esc(a.path) + '</code><p>' + rich(a.desc) + '</p></div></div>').join('') + '</div></section>';
  }
  if (f.schema) {
    h += '<section class="sd-sec" id="sec-data"><h2>Data model</h2><p class="sub">' + rich(f.schemaNote || 'Tables, keys and indexes the flow relies on (PostgreSQL unless noted).') + '</p><div class="sd-codeblock"><div class="sd-codehead"><span class="sd-lang ' + (f.schemaLang || 'sql') + '">' + (f.schemaLang || 'sql') + '</span><span class="sd-codetitle">Schema</span><button class="sd-copy" data-copy="schema">Copy</button></div><pre class="sd-code"><code>' + highlight(f.schema.trim(), f.schemaLang || 'sql') + '</code></pre></div></section>';
  }
  if (f.decisions) {
    h += '<section class="sd-sec" id="sec-deep"><h2>Deep dives</h2><p class="sub">The questions an interviewer pushes on, with the options weighed. Verdicts are for this flow\'s requirements, not universal rules.</p>' +
      f.decisions.map((d, i) => '<details class="sd-dd"' + (i === 0 ? ' open' : '') + '><summary>' + rich(d.q) + '</summary><div class="sd-ddb">' +
        d.options.map(o => '<div class="sd-opt ' + o.verdict + '"><div class="vh"><span class="sd-verdict ' + o.verdict + '">' + o.verdict + '</span>' + rich(o.name) + '</div><p>' + rich(o.why) + '</p></div>').join('') + '</div></details>').join('') + '</section>';
  }
  h += '<section class="sd-sec" id="sec-steps"><h2>All steps</h2><p class="sub">The whole flow at a glance. Tap one to jump there.</p><div class="sd-box"><ol class="sd-steplist" id="steplist">' +
    f.steps.map((s, i) => { const a = f.nodes.find(n => n.id === s.from), b = f.nodes.find(n => n.id === s.to); return '<li data-i="' + i + '"><button data-i="' + i + '"><span class="no">' + (i + 1) + '</span><span>' + esc(s.title) + '</span><span class="hop">' + esc(a.label) + (s.from === s.to ? '' : ' → ' + esc(b.label)) + '</span></button></li>'; }).join('') + '</ol></div></section>';
  if (f.refs) {
    h += '<section class="sd-sec" id="sec-refs"><h2>References</h2><p class="sub">Primary sources to go deeper. Payloads and code on this page are illustrative.</p><ol class="sd-refs">' +
      f.refs.map(r => '<li><a href="' + esc(r.url) + '" target="_blank" rel="noopener">' + esc(r.label) + '</a>' + (r.note ? ' <span>' + esc(r.note) + '</span>' : '') + '</li>').join('') + '</ol>' +
      (f.verify ? '<div class="sd-verify">' + (f.verify.checked ? '<div><h3>How this flow was checked</h3><ul class="sd-list">' + f.verify.checked.map(x => '<li>' + rich(x) + '</li>').join('') + '</ul></div>' : '') +
        (f.verify.uncertain ? '<div class="unc"><h3>Simplified or not verified</h3><ul class="sd-list">' + f.verify.uncertain.map(x => '<li>' + rich(x) + '</li>').join('') + '</ul></div>' : '') + '</div>' : '') + '</section>';
  }
  h += '<div class="sd-bar" id="bar"><button id="mPrev" aria-label="Previous step">' + UI.prev + 'Back</button><span class="mid" id="mCount"></span><button id="mNext" aria-label="Next step">Next' + UI.next + '</button></div>';
  app.innerHTML = h;

  // events
  $('#bPrev').onclick = () => back();
  $('#bNext').onclick = () => forward();
  $('#mPrev').onclick = () => back(true);
  $('#mNext').onclick = () => forward(true);
  $('#bRestart').onclick = () => { setPlaying(false); go(0, true); };
  $('#bPlay').onclick = () => setPlaying(!S.playing);
  $('#speed').oninput = e => { S.speed = parseFloat(e.target.value); if (S.playing) { setPlaying(false); setPlaying(true); } };
  $('#fork').onclick = e => { const b = e.target.closest('[data-go]'); if (!b) return; if (b.dataset.bi !== undefined) S.choice[+b.dataset.bi] = +b.dataset.opt; go(+b.dataset.go, true); };
  const pcEl = $('#pc'); if (pcEl) pcEl.onclick = e => { const l = e.target.closest('[data-l]'); if (!l) return; const n = +l.dataset.l; const k = f.steps.findIndex(st => pcLines(st).includes(n)); if (k >= 0) go(k, true); };
  $('#dots').onclick = e => { const b = e.target.closest('[data-i]'); if (b) go(+b.dataset.i, true); };
  $('#steplist').onclick = e => { const b = e.target.closest('button[data-i]'); if (b) { go(+b.dataset.i, true); $('#sec-sim').scrollIntoView({ behavior: 'smooth' }); } };
  $('#cv').addEventListener('click', e => { const n = e.target.closest('.sd-node'); if (n) showNode(n.dataset.node); });
  $$('.sd-jump a').forEach(a => a.onclick = e => { e.preventDefault(); const t = $('#sec-' + a.dataset.jump); if (t) t.scrollIntoView({ behavior: 'smooth' }); });
  const cs = $('[data-copy=schema]'); if (cs) cs.onclick = () => copyText(f.schema.trim(), cs);
  swipe($('#panel')); swipe($('#dg'));
  layout();
  go(start, false);
}

function swipe(el) {
  let x0 = null, y0 = null;
  el.addEventListener('touchstart', e => { const t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; }, { passive: true });
  el.addEventListener('touchend', e => {
    if (x0 === null) return; const t = e.changedTouches[0]; const dx = t.clientX - x0, dy = t.clientY - y0; x0 = null;
    if (e.target.closest('pre')) return;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.6) { if (dx < 0) forward(); else back(); }
  }, { passive: true });
}

/* layout: positions nodes on a grid; transposes on narrow screens so wide diagrams become tall */
let L = null;
function layout() {
  if (!S) return;
  const f = S.f, cv = $('#cv'); if (!cv) return;
  const W = cv.clientWidth;
  const narrow = W < 560 && f.grid.cols > f.grid.rows;
  const cols = narrow ? f.grid.rows : f.grid.cols, rows = narrow ? f.grid.cols : f.grid.rows;
  const rowH = W < 560 ? 108 : (W > 1000 ? 162 : 134);
  const H = rows * rowH;
  cv.style.height = H + 'px';
  const colW = W / cols;
  const nw = Math.max(70, Math.min(W < 560 ? 100 : 158, colW * (W < 560 ? 0.78 : (W > 1000 ? 0.6 : 0.66))));
  const P = {};
  f.nodes.forEach(n => {
    const gx = narrow ? n.y : n.x, gy = narrow ? n.x : n.y;
    const x = (gx + .5) * colW, y = (gy + .5) * rowH;
    const el = cv.querySelector('[data-node="' + n.id + '"]');
    el.style.left = x + 'px'; el.style.top = y + 'px'; el.style.setProperty('--nw', nw + 'px');
    P[n.id] = { x, y, el };
  });
  f.nodes.forEach(n => { const p = P[n.id]; p.w = p.el.offsetWidth; p.h = p.el.offsetHeight; });
  L = { W, H, P };
  drawWires();
}

function edgeGeom(a, b, off) {
  const A = L.P[a], B = L.P[b];
  let dx = B.x - A.x, dy = B.y - A.y; const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len * off, ny = dx / len * off;
  const clip = (P, tx, ty) => { const ddx = tx, ddy = ty; const sx = (P.w / 2 + 7) / Math.abs(ddx || 1e-9), sy = (P.h / 2 + 7) / Math.abs(ddy || 1e-9); const s = Math.min(sx, sy); return [P.x + ddx * s, P.y + ddy * s]; };
  const [x1, y1] = clip(A, dx, dy); const [x2, y2] = clip(B, -dx, -dy);
  return { x1: x1 + nx, y1: y1 + ny, x2: x2 + nx, y2: y2 + ny };
}
/* ---------- branches: steps may carry id / next / end / path / branch ---------- */
function hasBranch(f) { return f.steps.some(s => s.branch); }
function idxOf(id) { return S.f.steps.findIndex(s => s.id === id); }
function nextIndex(i) {
  const f = S.f, s = f.steps[i];
  if (!s || s.end) return -1;
  if (s.branch) return idxOf(s.branch.options[S.choice[i] || 0].goto);
  if (s.next) return idxOf(s.next);
  return i + 1 < f.steps.length ? i + 1 : -1;
}
// the path from step 0 to step t, honouring the branch choices already made, else defaults, else any option that reaches t
function pathTo(t) {
  const f = S.f, seen = new Set();
  const succ = i => { const s = f.steps[i]; if (s.end) return [];
    if (s.branch) { const ch = S.choice[i] || 0; const o = s.branch.options.map((x, k) => [k, idxOf(x.goto)]); o.sort((a, b) => (a[0] === ch ? -1 : 0) - (b[0] === ch ? -1 : 0)); return o; }
    const n = s.next ? idxOf(s.next) : (i + 1 < f.steps.length ? i + 1 : -1); return n >= 0 ? [[null, n]] : []; };
  const dfs = (i, acc) => {
    if (i === t) return acc; if (seen.has(i)) return null; seen.add(i);
    for (const [k, n] of succ(i)) { const r = dfs(n, acc.concat([[i, k]])); if (r) return r; }
    return null;
  };
  const r = dfs(0, []) || [];
  r.forEach(([i, k]) => { if (k !== null) S.choice[i] = k; });
  return r.map(x => x[0]);
}
function forward(fromBar) { const n = nextIndex(S.i); if (n >= 0) go(n, true, fromBar); }
function back(fromBar) { if (S.hist.length) go(S.hist[S.hist.length - 1], true, fromBar); }

/* ---------- pseudocode that follows the steps ---------- */
// pc entries: a line number, a range '3-5', or a piece of text found in the line ('def commit')
function pcLines(s) {
  const out = [], f = S.f;
  if (!f._pl) f._pl = (f.pseudo || '').replace(/^\n+|\s+$/g, '').split('\n');
  (s.pc || []).forEach(v => { if (typeof v === 'number') out.push(v); else if (!/^\d+(-\d+)?$/.test(v)) { const k = f._pl.findIndex(l => l.includes(v)); if (k >= 0) out.push(k + 1); } else { const [a, b] = String(v).split('-').map(Number); for (let k = a; k <= (b || a); k++) out.push(k); } });
  return out;
}
function pseudoHTML(f) {
  const lines = f.pseudo.replace(/^\n+|\s+$/g, '').split('\n');
  return '<div class="sd-pseudo"><div class="sd-phead"><span>Pseudocode</span><small>the highlighted lines run at this step · tap a line to jump</small></div>' +
    '<pre class="sd-code" id="pc"><code>' + lines.map((l, k) => '<span class="pl" data-l="' + (k + 1) + '"><i>' + (k + 1) + '</i>' + (highlight(l, f.pseudoLang || 'python') || ' ') + '</span>').join('') + '</code></pre></div>';
}
function updatePseudo() {
  const box = $('#pc'); if (!box) return;
  const f = S.f, s = f.steps[S.i], cur = new Set(pcLines(s)), past = new Set();
  S.hist.forEach(k => pcLines(f.steps[k]).forEach(n => past.add(n)));
  const col = kc(f.nodes.find(n => n.id === s.to).kind);
  let first = null;
  $$('.pl', box).forEach(el => { const n = +el.dataset.l; const on = cur.has(n); el.classList.toggle('on', on); el.classList.toggle('done', !on && past.has(n)); if (on) { el.style.setProperty('--kc', col); if (!first) first = el; } });
  if (first) box.scrollTo({ top: Math.max(0, first.offsetTop - box.clientHeight / 3), behavior: reduceMotion ? 'auto' : 'smooth' });
}

function drawWires() {
  if (!S || !L) return;
  const f = S.f, svg = $('#wires'); if (!svg) return;
  svg.setAttribute('viewBox', '0 0 ' + L.W + ' ' + L.H);
  const dirs = new Set(f.steps.filter(s => s.from !== s.to).map(s => s.from + '>' + s.to));
  const offFor = s => dirs.has(s.to + '>' + s.from) ? 5 : 0;
  const seenNums = new Map();
  S.hist.forEach(k => { const st = f.steps[k]; if (st.from === st.to) return; const key = st.from + '>' + st.to; if (!seenNums.has(key)) seenNums.set(key, []); seenNums.get(key).push(k + 1); });
  let out = '';
  const done = new Set();
  f.steps.forEach(s => {
    if (s.from === s.to) return; const k = s.from + '>' + s.to; if (done.has(k)) return; done.add(k);
    const g = edgeGeom(s.from, s.to, offFor(s));
    out += '<line class="sd-wire' + (seenNums.has(k) ? ' past' : '') + '" x1="' + g.x1 + '" y1="' + g.y1 + '" x2="' + g.x2 + '" y2="' + g.y2 + '"/>';
  });
  const s = f.steps[S.i];
  $$('.sd-wlabel,.sd-busychip,.sd-pbadge,.sd-altlabel', $('#cv')).forEach(x => x.remove());
  const curKey = s.from + '>' + s.to;
  // numbered badges on edges already travelled, so the diagram keeps the story
  seenNums.forEach((nums, key) => {
    if (key === curKey) return;
    const [a, b] = key.split('>'); const g = edgeGeom(a, b, offFor({ from: a, to: b }));
    const t = (dirs.has(b + '>' + a) && a > b) ? 0.38 : 0.5;
    const bd = document.createElement('i'); bd.className = 'sd-pbadge';
    bd.style.left = (g.x1 + (g.x2 - g.x1) * t) + 'px'; bd.style.top = (g.y1 + (g.y2 - g.y1) * t) + 'px';
    const shown = nums.slice(-2); bd.textContent = shown.join(',');
    bd.title = shown.map(n => n + '. ' + (f.steps[n - 1].label || f.steps[n - 1].title)).join('\n');
    $('#cv').appendChild(bd);
  });
  // the other outcomes of a branch, drawn faintly with their labels
  if (s.branch) {
    s.branch.options.forEach((o, k) => {
      const t = f.steps[idxOf(o.goto)]; if (!t || t.from === t.to) return;
      const g = edgeGeom(t.from, t.to, offFor(t));
      out += '<line class="sd-wire alt" x1="' + g.x1 + '" y1="' + g.y1 + '" x2="' + g.x2 + '" y2="' + g.y2 + '"/>';
      const lb = document.createElement('div'); lb.className = 'sd-altlabel' + ((S.choice[S.i] || 0) === k ? ' on' : '');
      lb.style.left = ((g.x1 + g.x2) / 2) + 'px'; lb.style.top = ((g.y1 + g.y2) / 2) + 'px';
      lb.textContent = 'if ' + o.label; $('#cv').appendChild(lb);
    });
  }
  if (s.from !== s.to) {
    const g = edgeGeom(s.from, s.to, offFor(s));
    const col = kc(f.nodes.find(n => n.id === s.from).kind);
    const ang = Math.atan2(g.y2 - g.y1, g.x2 - g.x1), ah = 10;
    const p1 = [g.x2 - ah * Math.cos(ang - .45), g.y2 - ah * Math.sin(ang - .45)], p2 = [g.x2 - ah * Math.cos(ang + .45), g.y2 - ah * Math.sin(ang + .45)];
    out += '<line class="sd-wire active' + (s.async ? ' async' : '') + (s.reply ? ' reply' : '') + '" style="stroke:' + col + '" x1="' + g.x1 + '" y1="' + g.y1 + '" x2="' + g.x2 + '" y2="' + g.y2 + '"/>' +
      '<path d="M' + g.x2 + ',' + g.y2 + 'L' + p1[0] + ',' + p1[1] + 'L' + p2[0] + ',' + p2[1] + 'z" style="fill:' + col + '"/>' +
      '<circle id="pk" class="sd-packet" r="5.5" cx="' + g.x1 + '" cy="' + g.y1 + '" style="fill:' + col + ';color:' + col + '"/>';
    svg.innerHTML = out;
    const lab = document.createElement('div');
    lab.className = 'sd-wlabel'; lab.style.color = col;
    lab.innerHTML = '<b><span>' + (S.i + 1) + '</span></b>' + esc(s.label || s.title);
    lab.title = s.label || s.title;
    $('#cv').appendChild(lab);
    const mx = (g.x1 + g.x2) / 2, my = (g.y1 + g.y2) / 2;
    const free = Math.hypot(g.x2 - g.x1, g.y2 - g.y1);
    const horizontal = Math.abs(g.x2 - g.x1) >= Math.abs(g.y2 - g.y1);
    lab.style.left = mx + 'px'; lab.style.top = my + 'px';
    // a long label on a short horizontal hop sits just above the line instead of hiding its text
    if (horizontal && lab.offsetWidth > free - 10) { lab.classList.add('above'); lab.style.maxWidth = Math.min(L.W - 12, Math.max(free + 120, 160)) + 'px'; }
    // keep the label inside the canvas
    const half = lab.offsetWidth / 2; lab.style.left = Math.min(L.W - half - 4, Math.max(half + 4, mx)) + 'px';
    animatePacket(g);
  } else {
    svg.innerHTML = out;
    const n = f.nodes.find(x => x.id === s.from), P = L.P[s.from];
    const chip = document.createElement('div');
    chip.className = 'sd-busychip'; chip.style.color = kc(n.kind);
    const below = P.y + P.h / 2 + 30 < L.H;
    chip.textContent = (S.i + 1) + ' · ' + (s.label || s.title);
    $('#cv').appendChild(chip);
    const half = chip.offsetWidth / 2;
    chip.style.left = Math.min(L.W - half - 4, Math.max(half + 4, P.x)) + 'px'; chip.style.top = (below ? P.y + P.h / 2 + 8 : P.y - P.h / 2 - 30) + 'px';
    cancelAnimationFrame(S.raf);
  }
}
// the packet travels the arrow once and settles: the arrow, its label and the payload carry the meaning
function animatePacket(g) {
  cancelAnimationFrame(S.raf);
  const pk = $('#pk'); if (!pk) return;
  if (reduceMotion) { pk.setAttribute('opacity', 0); return; }
  const dur = 1100 / S.speed; let t0 = null;
  const ease = t => t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  const tick = ts => {
    if (t0 === null) t0 = ts; const e = ts - t0; const t = ease(Math.min(1, e / dur));
    pk.setAttribute('cx', g.x1 + (g.x2 - g.x1) * t); pk.setAttribute('cy', g.y1 + (g.y2 - g.y1) * t);
    pk.setAttribute('opacity', e > dur ? Math.max(0, 1 - (e - dur) / 300) : 1);
    if (e < dur + 300) S.raf = requestAnimationFrame(tick);
  };
  S.raf = requestAnimationFrame(tick);
}

function go(i, user, fromBar) {
  const f = S.f; if (i < 0 || i >= f.steps.length) return;
  S.i = i; S.hist = pathTo(i); markSeen(f.id, i);
  const s = f.steps[i];
  history.replaceState(null, '', '#/flow/' + f.id + '/' + (i + 1));
  const visited = new Set(); S.hist.concat([i]).forEach(k => { visited.add(f.steps[k].from); visited.add(f.steps[k].to); });
  $$('.sd-node', $('#cv')).forEach(el => {
    const id = el.dataset.node;
    el.classList.toggle('src', id === s.from && s.from !== s.to);
    el.classList.toggle('dst', id === s.to);
    el.classList.toggle('busy', id === s.to);
    el.classList.toggle('dim', !visited.has(id));
  });
  drawWires();
  const a = f.nodes.find(n => n.id === s.from), b = f.nodes.find(n => n.id === s.to);
  $('#cap').innerHTML = '<div class="sn"><span>Step ' + (i + 1) + ' of ' + f.steps.length + '</span><span>·</span><span>' + esc(a.label) + (s.from === s.to ? ' (internal)' : ' → ' + esc(b.label)) + '</span>' + (s.async ? '<span class="sd-tag">async</span>' : '') + (s.path ? '<span class="sd-tag sd-pathtag">if ' + esc(s.path) + '</span>' : '') + '</div><h2>' + rich(s.title) + '</h2><p>' + rich(s.caption) + '</p>';
  // fork: choose the outcome at a branch, or come back to try the other one at the end of a path
  let fk = '';
  if (s.branch) {
    fk = '<span class="q">' + rich(s.branch.q) + '</span>' + s.branch.options.map((o, k) => '<button class="sd-chip' + ((S.choice[i] || 0) === k ? ' on' : '') + '" data-bi="' + i + '" data-opt="' + k + '" data-go="' + idxOf(o.goto) + '">' + esc(o.label) + ' →</button>').join('');
  } else if (nextIndex(i) < 0) {
    const bi = S.hist.slice().reverse().find(k => f.steps[k].branch);
    if (bi !== undefined) { const br = f.steps[bi].branch, ch = S.choice[bi] || 0;
      fk = '<span class="q">End of this path. Other outcome' + (br.options.length > 2 ? 's' : '') + ' of step ' + (bi + 1) + ':</span>' + br.options.map((o, k) => k === ch ? '' : '<button class="sd-chip" data-bi="' + bi + '" data-opt="' + k + '" data-go="' + idxOf(o.goto) + '">if ' + esc(o.label) + ' →</button>').join(''); }
  }
  $('#fork').innerHTML = fk; $('#fork').classList.toggle('show', !!fk);
  const nx = nextIndex(i);
  $('#bPrev').disabled = !S.hist.length; $('#bNext').disabled = nx < 0;
  $('#mPrev').disabled = !S.hist.length; $('#mNext').disabled = nx < 0;
  $('#mCount').textContent = (i + 1) + ' / ' + f.steps.length;
  $$('#dots .sd-dot').forEach((d, k) => { d.classList.toggle('on', k === i); d.classList.toggle('seen', (progress[f.id] || []).includes(k)); });
  $$('#steplist li').forEach((li, k) => li.classList.toggle('on', k === i));
  $('.sd-progressbar').style.width = ((i + 1) / f.steps.length * 100) + '%';
  renderTabs();
  updatePseudo();
  $('#ninfo').classList.remove('show');
  if (user && fromBar) {
    const st = $('.sd-stage'); const top = st.getBoundingClientRect().top;
    if (top < 0) window.scrollTo({ top: window.scrollY + top - 60, behavior: reduceMotion ? 'auto' : 'smooth' });
  }
}

function renderTabs() {
  const f = S.f, s = f.steps[S.i];
  const codes = s.code ? (Array.isArray(s.code) ? s.code : [s.code]) : [];
  const tabs = [['explain', 'What happens']];
  if (s.payload !== undefined) tabs.push(['payload', 'Payload']);
  if (codes.length) tabs.push(['code', 'Code', codes.length]);
  if (s.failure) tabs.push(['failure', 'When it fails']);
  if (!tabs.some(t => t[0] === S.tab)) S.tab = 'explain';
  $('#tabs').innerHTML = tabs.map(t => '<button class="sd-tab' + (t[0] === S.tab ? ' on' : '') + '" data-tab="' + t[0] + '">' + t[1] + (t[2] > 1 ? ' <span class="ct">' + t[2] + '</span>' : '') + '</button>').join('');
  $('#tabs').onclick = e => { const b = e.target.closest('[data-tab]'); if (!b) return; S.tab = b.dataset.tab; renderTabs(); };
  let h = '';
  if (S.tab === 'explain') {
    h += '<h3>What happens</h3>' + paras(s.text || s.caption);
    if (s.details) h += '<h3>Under the hood</h3><ul class="sd-list">' + s.details.map(d => '<li>' + rich(d) + '</li>').join('') + '</ul>';
    const tn = f.nodes.find(n => n.id === s.to);
    if (tn.desc) h += '<h3>About ' + esc(tn.label) + '</h3><p>' + rich(tn.desc) + '</p>';
  } else if (S.tab === 'payload') {
    h += payloadHTML(s);
  } else if (S.tab === 'code') {
    h += codes.map((c, k) => '<div class="sd-codeblock"><div class="sd-codehead"><span class="sd-lang ' + esc(c.lang) + '">' + esc(c.lang) + '</span><span class="sd-codetitle">' + esc(c.title || '') + '</span><button class="sd-copy" data-ci="' + k + '">Copy</button></div>' +
      (c.note ? '<p class="sd-note" style="margin:0 0 8px">' + rich(c.note) + '</p>' : '') + '<pre class="sd-code"><code>' + highlight(c.src.replace(/^\n+|\s+$/g, ''), c.lang) + '</code></pre></div>').join('') +
      '<p class="sd-illus">Illustrative code: focused on this step, with imports and error handling trimmed. Library APIs change, so check the docs linked under References.</p>';
  } else if (S.tab === 'failure') {
    h += '<div class="sd-fail">' + paras(s.failure) + '</div>';
  }
  $('#tabbody').innerHTML = h;
  $$('#tabbody [data-ci]').forEach(b => b.onclick = () => copyText(codes[+b.dataset.ci].src.trim(), b));
  $$('#tabbody .ln.fx').forEach(l => l.onclick = e => { const k = l.dataset.field; popover(l, k, (s.fields || {})[k]); e.stopPropagation(); });
}
function payloadHTML(s) {
  const f = S.f;
  let h = '';
  let prev = null;
  if (s.diff !== false) {
    for (let j = S.hist.length - 1; j >= 0; j--) { const p = f.steps[S.hist[j]].payload; if (p !== undefined) { prev = p; break; } }
    if (prev && (typeof prev !== 'object' || typeof s.payload !== 'object')) prev = null;
    if (prev) { // only diff when the two payloads are recognisably the same message
      const pf = flatten(prev, ''), cf = Object.keys(flatten(s.payload, ''));
      const shared = cf.filter(k => k in pf).length;
      if (shared / Math.max(1, cf.length) < 0.35) prev = null;
    }
  }
  h += '<div class="sd-plhead"><span class="sd-plkind">' + esc(s.payloadKind || (typeof s.payload === 'string' ? 'Message' : 'JSON')) + '</span>';
  if (typeof s.payload === 'object' && prev) h += '<span class="sd-diffkey"><span><i class="sd-json" style="background:var(--add-bg);color:var(--add-ink);border:0;padding:0">+</i>added</span><span><i style="background:var(--chg-bg);color:var(--chg-ink)">~</i>changed</span></span>';
  else if (typeof s.payload === 'object') h += '<span class="sd-diffkey">new message shape</span>';
  h += '</div>';
  if (typeof s.payload === 'string') {
    h += '<pre class="sd-code"><code>' + highlight(s.payload.replace(/^\n+|\s+$/g, ''), s.payloadLang || 'http') + '</code></pre>';
  } else {
    const r = renderJSON(s.payload, prev, s.fields);
    h += '<pre class="sd-json">' + r.html + '</pre>';
    if (r.removed.length) h += '<div class="sd-removed">Dropped at this hop: ' + r.removed.map(x => '<s>' + esc(x) + '</s>').join(', ') + '</div>';
  }
  if (s.fields) h += '<h3>Fields that matter here</h3><dl class="sd-fields">' + Object.keys(s.fields).map(k => '<dt>' + esc(k) + '</dt><dd>' + rich(s.fields[k]) + '</dd>').join('') + '</dl>';
  h += '<p class="sd-illus">Illustrative payload: real systems name and shape these differently.</p>';
  return h;
}

function showNode(id) {
  const f = S.f, n = f.nodes.find(x => x.id === id), box = $('#ninfo');
  const idx = f.steps.map((s, i) => (s.from === id || s.to === id) ? i : -1).filter(i => i >= 0);
  box.style.setProperty('--kc', kc(n.kind));
  box.innerHTML = '<b>' + esc(n.label) + '</b> <span class="sd-tag" style="font:11px var(--mono)">' + esc(KIND_LABEL[n.kind] || n.kind) + (n.sub ? ' · ' + esc(n.sub) : '') + '</span><div style="margin-top:4px">' + rich(n.desc || '') + '</div>' +
    (idx.length ? '<div class="lk">' + idx.map(i => '<button class="sd-dot' + (i === S.i ? ' on' : '') + '" data-i="' + i + '" title="' + esc(f.steps[i].title) + '">' + (i + 1) + '</button>').join('') + '</div>' : '');
  box.classList.add('show');
  box.onclick = e => { const b = e.target.closest('[data-i]'); if (b) go(+b.dataset.i, true); };
  const el = $('#cv [data-node="' + id + '"]'); el.classList.add('hl'); setTimeout(() => el.classList.remove('hl'), 900);
}

function setPlaying(on) {
  S.playing = on; clearInterval(S.timer);
  $('#bPlay').innerHTML = on ? UI.pause : UI.play; $('#bPlay').setAttribute('aria-label', on ? 'Pause' : 'Play');
  if (on) { if (nextIndex(S.i) < 0) go(0, true); S.timer = setInterval(() => { if (nextIndex(S.i) < 0) setPlaying(false); else forward(); }, 4200 / S.speed); }
}
function stopAll() { if (S) { clearInterval(S.timer); cancelAnimationFrame(S.raf); } }

/* ---------- glossary & edit pages ---------- */
function termUsage() {
  const use = {};
  FLOWS.forEach(f => { const blob = JSON.stringify(f).toLowerCase(); Object.keys(GLOSSARY).forEach(t => { if (blob.includes('{{' + t)) (use[t] = use[t] || []).push(f); }); });
  return use;
}
function renderGlossary() {
  currentFlow = null; setNav('glossary'); document.title = 'Glossary · System Design Flows'; $('.sd-progressbar').style.width = '0';
  const use = termUsage();
  const terms = Object.keys(GLOSSARY).sort();
  app.innerHTML = '<div class="sd-prose"><div class="sd-eyebrow">Glossary</div><h1>The words, explained plainly</h1><p>' + terms.length + ' terms used across the flows. Underlined words inside a flow open these definitions.</p>' +
    '<label class="sd-search" style="margin-top:14px">' + UI.search + '<input id="gq" type="search" placeholder="Search terms" autocomplete="off"></label><div class="sd-gl" id="gl"></div></div>';
  const draw = q => {
    q = (q || '').toLowerCase();
    $('#gl').innerHTML = terms.filter(t => !q || t.includes(q) || GLOSSARY[t].toLowerCase().includes(q)).map(t =>
      '<div class="sd-box" id="t-' + esc(t.replace(/\W+/g, '-')) + '"><b>' + esc(t.charAt(0).toUpperCase() + t.slice(1)) + '</b><p>' + esc(GLOSSARY[t]) + '</p>' +
      (use[t] ? '<small>Used in: ' + use[t].map(f => '<a href="#/flow/' + f.id + '">' + esc(f.title) + '</a>').join(', ') + '</small>' : '') + '</div>').join('');
  };
  draw(''); $('#gq').oninput = e => draw(e.target.value);
}
function renderEdit() {
  currentFlow = null; setNav('edit'); document.title = 'Edit and host · System Design Flows'; $('.sd-progressbar').style.width = '0';
  app.innerHTML = $('#edit-guide').innerHTML;
  $$('#app pre code[data-lang]').forEach(c => { c.innerHTML = highlight(c.textContent, c.dataset.lang); });
}

/* ---------- popover, copy, theme ---------- */
const pop = document.createElement('div'); pop.className = 'sd-pop'; document.body.appendChild(pop);
function popover(anchor, title, body) {
  if (!body) return;
  pop.innerHTML = '<b>' + esc(title) + '</b>' + rich(body);
  pop.classList.add('show');
  const r = anchor.getBoundingClientRect(), pw = Math.min(340, window.innerWidth - 20);
  pop.style.maxWidth = pw + 'px';
  let left = Math.min(Math.max(10, r.left), window.innerWidth - pw - 10);
  pop.style.left = left + 'px';
  const below = r.bottom + 10 + pop.offsetHeight < window.innerHeight;
  pop.style.top = (below ? r.bottom + 8 : r.top - pop.offsetHeight - 8) + 'px';
}
document.addEventListener('click', e => {
  const t = e.target.closest('.sd-term');
  if (t) { popover(t, t.textContent, GLOSSARY[t.dataset.term]); e.stopPropagation(); return; }
  const n = e.target.closest('.sd-n');
  if (n && S) { showNode(n.dataset.node); const dg = $('#dg'); if (dg && dg.getBoundingClientRect().bottom < 0) dg.scrollIntoView({ behavior: 'smooth' }); return; }
  if (!e.target.closest('.sd-pop')) pop.classList.remove('show');
});
window.addEventListener('scroll', () => pop.classList.remove('show'), { passive: true });
function copyText(t, btn) {
  const done = () => { const o = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => btn.textContent = o, 1200); };
  if (navigator.clipboard) navigator.clipboard.writeText(t).then(done, done); else done();
}
document.addEventListener('keydown', e => {
  if (!S || !$('#cv') || e.target.closest('input,textarea')) return;
  if (e.key === 'ArrowRight') { forward(); e.preventDefault(); }
  else if (e.key === 'ArrowLeft') { back(); e.preventDefault(); }
  else if (e.key === ' ' && !e.target.closest('button')) { setPlaying(!S.playing); e.preventDefault(); }
});
let rz = 0; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(layout, 120); });
$('#themeBtn').onclick = () => {
  const r = document.documentElement, dark = r.dataset.theme ? r.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  r.dataset.theme = dark ? 'light' : 'dark'; try { localStorage.setItem('sdflows:theme', r.dataset.theme); } catch (e) {}
  if (S && $('#cv')) drawWires();
};
try { const t = localStorage.getItem('sdflows:theme'); if (t) document.documentElement.dataset.theme = t; } catch (e) {}

window.addEventListener('hashchange', () => { const cur = location.hash; if (S && $('#cv') && cur.startsWith('#/flow/' + S.f.id + '/')) { const n = parseInt(cur.split('/')[3], 10) - 1; if (n !== S.i && n >= 0) go(n, false); return; } route(); });
window.SD_APP = { go: i => go(i, true), state: () => S, flows: FLOWS };
route();
})();
