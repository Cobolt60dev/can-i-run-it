// Can I Run It? — zero-dependency local server.
// Serves the browser UI, talks to Ollama and the Hugging Face Hub, and runs a
// download queue that writes into ./llms. Runs from source (node server.js) or as a
// single-file executable built with scripts/build.js (Node SEA, UI files embedded).
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

// Inside a single-file executable the UI and data files are embedded assets.
let sea = null;
try { const s = require('node:sea'); if (s.isSea()) sea = s; } catch { /* running from source */ }

const PORT = Number(process.env.PORT) || 5180;
const ROOT = sea ? path.dirname(process.execPath) : __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const LLMS = path.resolve(process.env.LLMS_DIR || path.join(ROOT, 'llms'));
const HF_DIR = path.join(LLMS, 'huggingface');
const OLLAMA_DIR = path.join(LLMS, 'ollama');
const UNC_DIR = path.join(LLMS, 'uncensored');
// Uncensored / abliterated fine-tunes are kept apart from the mainstream models.
const UNCENSORED_RE = /uncensor|abliterat|heretic|nsfw|unfilter|unalign|dolphin|lexi-/i;
const isUncensored = s => UNCENSORED_RE.test(s || '');
const OLLAMA = normalizeHost(process.env.OLLAMA_HOST || '127.0.0.1:11434');
const HF_TOKEN = process.env.HF_TOKEN || '';
const MAX_PARALLEL = Math.max(1, Number(process.env.MAX_PARALLEL) || 2);
const APP_NAME = 'Can I Run It?';
const VERSION = '1.0.0';
const UA = `CanIRunIt/${VERSION}`;

let spawnedOllama = null; // child process if we started `ollama serve` ourselves

function normalizeHost(h) {
  if (!/^https?:\/\//.test(h)) h = 'http://' + h;
  return h.replace('0.0.0.0', '127.0.0.1').replace(/\/$/, '');
}

// ---------------------------------------------------------------- helpers

function sendJson(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

async function statOr(p) {
  try { return await fsp.stat(p); } catch { return null; }
}

function run(cmd, args, timeout = 4000) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

async function fetchTimeout(url, opts = {}, ms = 2000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); } finally { clearTimeout(t); }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  });
  await Promise.all(workers);
  return out;
}

function hfHeaders() {
  const h = { 'user-agent': UA };
  if (HF_TOKEN) h.authorization = 'Bearer ' + HF_TOKEN;
  return h;
}

async function hfJson(url) {
  const res = await fetch(url, { headers: hfHeaders() });
  if (!res.ok) throw new Error(`Hugging Face returned ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------- system info

const vendorOf = name => /nvidia|geforce|quadro|tesla|rtx|gtx/i.test(name) ? 'nvidia'
  : /amd|radeon|instinct/i.test(name) ? 'amd' : /intel|arc/i.test(name) ? 'intel' : /apple/i.test(name) ? 'apple' : 'other';

// Like run(), but returns stdout + stderr (llama.cpp prints its version to stderr).
function runAll(cmd, args, timeout = 4000) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) =>
      resolve(err && err.code === 'ENOENT' ? null : `${stdout || ''}${stderr || ''}`.trim() || (err ? null : '')));
  });
}

async function detectNvidia() {
  // compute_cap needs a reasonably recent driver; fall back to the basic query on old ones.
  let out = await run('nvidia-smi', ['--query-gpu=name,memory.total,driver_version,compute_cap', '--format=csv,noheader,nounits']);
  const hasCc = !!out;
  if (!out) out = await run('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits']);
  if (!out) return [];
  const header = await run('nvidia-smi', []);
  const cudaMax = (header?.match(/CUDA Version:\s*([\d.]+)/) || [])[1] || null;
  return out.trim().split(/\r?\n/).filter(Boolean).map(line => {
    const [name, mem, driver, cc] = line.split(',').map(s => s.trim());
    return { vendor: 'nvidia', name, vramMiB: Number(mem) || null, driver, cc: hasCc && cc && cc !== '[N/A]' ? cc : null, cudaMax };
  });
}

// Windows: the display-adapter registry keys hold the real VRAM size (WMI's AdapterRAM caps at 4 GB).
async function detectWindowsAdapters() {
  const ps = "Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' -ErrorAction SilentlyContinue | ForEach-Object { '{0}|{1}|{2}' -f $_.DriverDesc, $_.'HardwareInformation.qwMemorySize', $_.DriverVersion }";
  const out = await run('powershell', ['-NoProfile', '-Command', ps], 8000);
  if (!out) return [];
  return out.trim().split(/\r?\n/).map(l => l.split('|')).filter(([n]) => n && !/basic|remote|virtual|parsec|meta|indirect|displaylink/i.test(n))
    .map(([name, mem, driver]) => ({ vendor: vendorOf(name), name: name.trim(), vramMiB: Number(mem) ? Math.round(Number(mem) / 1048576) : null, driver }));
}

// Linux AMD/Intel: VRAM from sysfs, names + gfx targets from rocminfo when ROCm is installed.
async function detectLinuxAdapters() {
  const gpus = [];
  let cards = [];
  try { cards = (await fsp.readdir('/sys/class/drm')).filter(d => /^card\d+$/.test(d)); } catch { return gpus; }
  const rocm = await run('rocminfo', [], 6000);
  const agents = rocm ? rocm.split(/\n\*+\s*\nAgent \d+/).filter(a => /Device Type:\s+GPU/.test(a)).map(a => ({
    name: (a.match(/Marketing Name:\s+(.+)/) || [])[1]?.trim(), gfx: (a.match(/Name:\s+(gfx[0-9a-f]+)/) || [])[1],
  })) : [];
  for (const c of cards) {
    const dev = `/sys/class/drm/${c}/device`;
    const vendor = (await fsp.readFile(`${dev}/vendor`, 'utf8').catch(() => '')).trim();
    if (vendor !== '0x1002' && vendor !== '0x8086') continue;
    const vram = Number((await fsp.readFile(`${dev}/mem_info_vram_total`, 'utf8').catch(() => '0')).trim());
    if (vendor === '0x8086' && !vram) continue; // integrated Intel graphics
    const a = vendor === '0x1002' ? agents[gpus.filter(g => g.vendor === 'amd').length] : null;
    gpus.push({ vendor: vendor === '0x1002' ? 'amd' : 'intel', name: a?.name || (vendor === '0x1002' ? 'AMD GPU' : 'Intel GPU'), gfx: a?.gfx || null, vramMiB: vram ? Math.round(vram / 1048576) : null, rocm: !!rocm });
  }
  return gpus;
}

async function detectGpus() {
  const nvidia = await detectNvidia();
  if (process.platform === 'darwin') {
    const chip = await run('sysctl', ['-n', 'machdep.cpu.brand_string']);
    if (chip && /Apple/i.test(chip)) return [{ vendor: 'apple', name: chip.trim(), vramMiB: Math.round(os.totalmem() / 1048576) }];
  }
  let others = [];
  if (process.platform === 'win32') others = await detectWindowsAdapters();
  if (process.platform === 'linux') others = await detectLinuxAdapters();
  others = others.filter(g => g.vendor !== 'nvidia' && g.vendor !== 'other' && (g.vramMiB == null || g.vramMiB >= 3000 || !nvidia.length));
  return [...nvidia, ...others];
}

async function detectCpu() {
  const cpu = { model: os.cpus()[0]?.model?.trim(), cores: os.cpus().length, arch: process.arch, flags: null };
  if (process.platform === 'linux') {
    const info = await fsp.readFile('/proc/cpuinfo', 'utf8').catch(() => '');
    const flags = new Set(((info.match(/^flags\s*:\s*(.+)$/m) || [])[1] || '').split(/\s+/));
    if (flags.size > 1) cpu.flags = ['avx2', 'avx512f', 'avx512_vnni', 'avx_vnni', 'amx_tile'].filter(f => flags.has(f));
  } else if (process.arch === 'arm64') {
    cpu.flags = ['neon'];
  }
  return cpu;
}

async function detectOs() {
  const o = { platform: process.platform, release: os.release(), arch: process.arch, name: null };
  if (process.platform === 'win32') o.name = `Windows ${Number(os.release().split('.')[2]) >= 22000 ? '11' : '10'} (build ${os.release().split('.')[2]})`;
  if (process.platform === 'darwin') o.name = 'macOS ' + ((await run('sw_vers', ['-productVersion'])) || '').trim();
  if (process.platform === 'linux') {
    const rel = await fsp.readFile('/etc/os-release', 'utf8').catch(() => '');
    o.name = (rel.match(/PRETTY_NAME="?([^"\n]+)/) || [])[1] || 'Linux';
    o.wsl = /microsoft/i.test(os.release());
  }
  return o;
}

async function detectTools() {
  const home = os.homedir();
  const exists = async ps => { for (const p of ps) if (await statOr(p)) return true; return false; };
  // Avoid bare `python3` on Windows: the Microsoft Store stub opens the Store instead of answering.
  const py = (await runAll('python', ['--version'])) || (process.platform !== 'win32' ? await runAll('python3', ['--version']) : null);
  const llama = (await runAll('llama-server', ['--version'])) || (await runAll('llama-cli', ['--version']));
  const ollamaCli = await runAll('ollama', ['--version']);
  return {
    ollama: ollamaCli != null ? (ollamaCli.match(/(\d+\.\d+\.\d+)/) || [])[1] || 'installed' : null,
    llamacpp: llama != null ? (llama.match(/version:\s*(\d+)/) || [])[1] || 'installed' : null,
    lmstudio: await exists([
      path.join(home, '.lmstudio'), path.join(home, '.cache', 'lm-studio'), '/Applications/LM Studio.app',
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'LM Studio'), path.join(process.env.LOCALAPPDATA || '', 'Programs', 'lm-studio'),
    ]),
    python: py ? (py.match(/(\d+\.\d+(\.\d+)?)/) || [])[1] : null,
    docker: (await runAll('docker', ['--version']))?.match(/(\d+\.\d+\.\d+)/)?.[1] || null,
  };
}

async function ollamaStatus() {
  try {
    const r = await fetchTimeout(OLLAMA + '/api/version', {}, 1500);
    const j = await r.json();
    return { running: true, version: j.version };
  } catch {
    return { running: false };
  }
}

function ollamaModelsDir() {
  if (spawnedOllama) return process.env.OLLAMA_MODELS || OLLAMA_DIR;
  if (process.env.OLLAMA_MODELS) return process.env.OLLAMA_MODELS;
  return path.join(os.homedir(), '.ollama', 'models');
}

async function diskFree() {
  try {
    const s = await fsp.statfs(LLMS);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch { return null; }
}

// Hardware/tool detection is slow-ish, so it is cached until the UI asks for a re-detect.
let hwCache = null;
async function systemInfo(refresh) {
  if (!hwCache || refresh) {
    const [gpus, cpu, osInfo, tools] = await Promise.all([detectGpus(), detectCpu(), detectOs(), detectTools()]);
    hwCache = { gpus, cpu, os: osInfo, tools };
  }
  return {
    platform: process.platform,
    cpu: hwCache.cpu.model,
    cpuInfo: hwCache.cpu,
    os: hwCache.os,
    tools: hwCache.tools,
    node: process.versions.node,
    ramGB: Math.round(os.totalmem() / 1073741824),
    gpus: hwCache.gpus,
    disk: await diskFree(),
    llmsDir: LLMS,
    dirs: { huggingface: HF_DIR, uncensored: UNC_DIR, ollama: OLLAMA_DIR },
    ollama: { ...(await ollamaStatus()), host: OLLAMA, modelsDir: ollamaModelsDir(), managedByApp: !!spawnedOllama },
    hfToken: !!HF_TOKEN,
    maxParallel: MAX_PARALLEL,
  };
}

async function startOllama() {
  if ((await ollamaStatus()).running) return { ok: true, already: true };
  await fsp.mkdir(OLLAMA_DIR, { recursive: true });
  try {
    // Detached so it keeps running (and keeps serving pulls) when this app restarts or closes.
    spawnedOllama = spawn('ollama', ['serve'], {
      env: { ...process.env, OLLAMA_MODELS: process.env.OLLAMA_MODELS || OLLAMA_DIR },
      windowsHide: true, stdio: 'ignore', detached: true, cwd: os.homedir(), // never lock the app folder
    });
    spawnedOllama.unref();
    spawnedOllama.on('exit', () => { spawnedOllama = null; });
    spawnedOllama.on('error', () => { spawnedOllama = null; });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 300));
    if ((await ollamaStatus()).running) return { ok: true };
  }
  return { ok: false, error: 'Ollama did not start. Is it installed? https://ollama.com/download' };
}

// ---------------------------------------------------------------- hugging face

const treeCache = new Map(); // repo -> { at, files }
const TREE_TTL = 6 * 3600 * 1000;

async function hfTree(repo) {
  const hit = treeCache.get(repo);
  if (hit && Date.now() - hit.at < TREE_TTL) return hit.files;
  const url = `https://huggingface.co/api/models/${repo.split('/').map(encodeURIComponent).join('/')}/tree/main?recursive=true`;
  const files = (await hfJson(url))
    .filter(f => f.type === 'file')
    .map(f => ({ path: f.path, size: f.lfs?.size ?? f.size }));
  treeCache.set(repo, { at: Date.now(), files });
  return files;
}

const QUANT_RE = /(UD-)?(IQ[1-4]_(?:XXS|XS|NL|S|M)|Q[2-8]_K(?:_XL|_XXL|_[SML])?|Q[4-8]_[01]|TQ[12]_0|MXFP4(?:_MOE)?|BF16|F16|F32)/i;

function groupGguf(files) {
  const groups = new Map();
  let mmproj = null;
  for (const f of files) {
    if (!/\.gguf$/i.test(f.path)) continue;
    if (/mmproj/i.test(f.path)) {
      // Prefer the F16 projector; it is what most runtimes expect.
      if (!mmproj || /f16/i.test(f.path)) mmproj = f;
      continue;
    }
    // Skip helper files that aren't standalone models: importance matrices, MTP heads, draft models.
    if (/imatrix|(^|\/)mtp[-_/]|draft/i.test(f.path)) continue;
    const key = f.path.replace(/-\d{5}-of-\d{5}(?=\.gguf$)/i, '');
    const m = key.match(QUANT_RE);
    // quant = normalised name for ranking; qtag = the label Ollama accepts in hf.co/<repo>:<qtag>
    const g = groups.get(key) || { key, quant: m ? m[2].toUpperCase() : path.basename(key, '.gguf'), qtag: m ? m[0] : null, size: 0, files: [] };
    g.size += f.size || 0;
    g.files.push(f);
    groups.set(key, g);
  }
  const list = [...groups.values()];
  for (const g of list) g.files.sort((a, b) => a.path.localeCompare(b.path));
  return { quants: list, mmproj };
}

// GGUF is also used for image, video and speech models; those aren't chat LLMs, so hide them.
const NON_LLM = /text-to-image|image-to-image|to-video|text-to-speech|text-to-audio|speech-recognition|audio|segmentation|object-detection|depth-estimation|unconditional/;

async function hfSearch(q, limit, sort) {
  const u = new URL('https://huggingface.co/api/models');
  u.searchParams.set('filter', 'gguf');
  if (q) u.searchParams.set('search', q);
  u.searchParams.set('sort', sort === 'trending' ? 'trendingScore' : sort === 'recent' ? 'lastModified' : sort === 'likes' ? 'likes' : 'downloads');
  u.searchParams.set('direction', '-1');
  u.searchParams.set('limit', String(limit));
  const models = await hfJson(u);
  const rows = await mapLimit(models, 8, async m => {
    try {
      const { quants, mmproj } = groupGguf(await hfTree(m.id));
      if (!quants.length || NON_LLM.test(m.pipeline_tag || '')) return null;
      return {
        repo: m.id, downloads: m.downloads, likes: m.likes, pipeline: m.pipeline_tag, uncensored: isUncensored(m.id),
        updated: m.lastModified || m.createdAt, gated: !!m.gated, quants, mmproj,
      };
    } catch { return null; }
  });
  return rows.filter(Boolean);
}

// ---------------------------------------------------------------- ollama.com library sync
// ollama.com has no public catalog API, so we read the library + tags pages and cache the result.

const LIB_CACHE = path.join(LLMS, '.cache', 'ollama-library.json');
const LIB_TTL = 24 * 3600 * 1000;
const LIB_FAMILIES = Number(process.env.OLLAMA_LIBRARY_SIZE) || 80;
const lib = { status: 'idle', data: null, error: null, progress: 0 };

const strip = s => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function ageDays(text) {
  const m = text.match(/(\d+|an?|yesterday)\s*(minute|hour|day|week|month|year)s?\s+ago/i) || (/yesterday/i.test(text) && ['', '1', 'day']);
  if (!m) return null;
  const n = /^an?$/i.test(m[1]) ? 1 : Number(m[1]) || 1;
  return n * { minute: 1 / 1440, hour: 1 / 24, day: 1, week: 7, month: 30, year: 365 }[m[2].toLowerCase()];
}

function parseParams(chip) {
  let m = chip.match(/^(\d+)x(\d+(?:\.\d+)?)([mb])$/i);
  if (m) return { params: Number(m[1]) * Number(m[2]) * 0.8, active: Number(m[2]) };
  m = chip.match(/^e?(\d+(?:\.\d+)?)([mbt])$/i);
  if (!m) return {};
  return { params: Number(m[1]) * ({ m: 0.001, b: 1, t: 1000 }[m[2].toLowerCase()]) };
}

function parseLibrary(html) {
  const out = [];
  const parts = html.split(/<li\s+class="flex items-baseline/).slice(1);
  parts.forEach((card, rank) => {
    const name = (card.match(/href="\/library\/([^"]+)"/) || [])[1];
    if (!name) return;
    const desc = strip((card.match(/<p[^>]*>([\s\S]*?)<\/p>/) || [])[1] || '');
    const caps = [...card.matchAll(/bg-indigo-50[^>]*>([^<]+)</g)].map(m => m[1].trim().toLowerCase());
    const cloud = /bg-cyan-50[^>]*>\s*cloud/.test(card);
    const sizes = [...card.matchAll(/bg-\[#ddf4ff\][^>]*>([^<]+)</g)].map(m => m[1].trim().toLowerCase());
    const text = strip(card);
    const pulls = (text.match(/([\d.]+[KMB]?)\s*Pulls/i) || [])[1] || '';
    const updated = (text.match(/Updated\s+(.+?ago)/i) || [])[1] || '';
    out.push({ name, desc, caps, cloud, sizes, pulls, updated, age: ageDays(updated), rank });
  });
  return out;
}

function parseTags(html, fam) {
  const tags = fam.sizes.length ? fam.sizes : ['latest'];
  const variants = [];
  for (const size of tags) {
    const tag = `${fam.name}:${size}`;
    const i = html.search(new RegExp(`href="/library/${reEsc(tag)}"`));
    if (i < 0) continue;
    const seg = strip(html.slice(i, i + 1500));
    const m = seg.match(/([\d.]+)\s*(KB|MB|GB|TB)/);
    if (!m) continue; // cloud-only tags have no size
    const gb = Number(m[1]) * { KB: 1e-6, MB: 1e-3, GB: 1, TB: 1000 }[m[2]];
    const ctx = (seg.match(/(\d+K)\s+context/i) || [])[1];
    const p = parseParams(size);
    const moe = html.match(new RegExp(`/library/${reEsc(tag)}-a(\\d+(?:\\.\\d+)?)b`, 'i'));
    variants.push({ tag, size: Math.round(gb * 100) / 100, params: p.params, active: p.active ?? (moe ? Number(moe[1]) : undefined), ctx });
  }
  return variants;
}

function libCats(f) {
  const cats = new Set();
  if (f.caps.includes('embedding')) cats.add('embedding'); else cats.add('chat');
  if (f.caps.includes('thinking')) cats.add('reasoning');
  if (f.caps.includes('vision')) cats.add('vision');
  if (f.caps.includes('tools')) cats.add('tools');
  if (/code|coder|devstral|starcoder|codestral/i.test(f.name + ' ' + f.desc)) cats.add('code');
  if (f.variants.length && f.variants.every(v => (v.params ?? 99) <= 4)) cats.add('small');
  return [...cats];
}

async function syncLibrary(force) {
  if (lib.status === 'syncing') return;
  if (!force && !lib.data) {
    try {
      const cached = JSON.parse(await fsp.readFile(LIB_CACHE, 'utf8'));
      lib.data = cached;
      if (Date.now() - cached.syncedAt < LIB_TTL) { lib.status = 'ready'; return; }
    } catch { /* no cache yet */ }
  }
  lib.status = 'syncing'; lib.error = null; lib.progress = 0;
  try {
    const res = await fetch('https://ollama.com/library?sort=popular', { headers: { 'user-agent': UA } });
    if (!res.ok) throw new Error('ollama.com returned ' + res.status);
    const all = parseLibrary(await res.text());
    const local = all.filter(f => f.sizes.length || !f.cloud).slice(0, LIB_FAMILIES);
    let done = 0;
    await mapLimit(local, 6, async f => {
      try {
        const r = await fetch(`https://ollama.com/library/${encodeURIComponent(f.name)}/tags`, { headers: { 'user-agent': UA } });
        f.variants = r.ok ? parseTags(await r.text(), f) : [];
      } catch { f.variants = []; }
      lib.progress = ++done / local.length;
    });
    const families = local.filter(f => f.variants.length).map(f => ({
      name: f.name, title: f.name, vendor: '', desc: f.desc, cats: libCats(f), caps: f.caps,
      pulls: f.pulls, updated: f.updated, age: f.age, rank: f.rank, variants: f.variants, live: true,
    }));
    lib.data = { syncedAt: Date.now(), total: all.length, families };
    lib.status = 'ready';
    await fsp.mkdir(path.dirname(LIB_CACHE), { recursive: true });
    await fsp.writeFile(LIB_CACHE, JSON.stringify(lib.data));
  } catch (e) {
    lib.status = lib.data ? 'ready' : 'error';
    lib.error = e.message;
  }
}

// "Scan for uncensored": run several searches for the common naming conventions, merge and rank.
const UNCENSORED_TERMS = ['uncensored', 'abliterated', 'heretic', 'dolphin'];
async function hfUncensoredScan(q, limit, sort) {
  const terms = UNCENSORED_TERMS.map(t => (q ? `${q} ${t}` : t));
  const lists = await Promise.all(terms.map(t => hfSearch(t, Math.ceil(limit / 2), sort).catch(() => [])));
  const merged = new Map();
  for (const r of lists.flat()) if (r.uncensored && !merged.has(r.repo)) merged.set(r.repo, r);
  const key = sort === 'likes' ? 'likes' : sort === 'recent' ? 'updated' : 'downloads';
  return [...merged.values()].sort((a, b) => (b[key] > a[key] ? 1 : b[key] < a[key] ? -1 : 0)).slice(0, limit);
}

// ---------------------------------------------------------------- installed

async function walk(dir, out = []) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (/\.gguf$/i.test(e.name)) out.push({ path: p, size: (await fsp.stat(p)).size });
  }
  return out;
}

async function installed() {
  let ollama = [];
  try {
    const r = await fetchTimeout(OLLAMA + '/api/tags', {}, 2500);
    ollama = (await r.json()).models.map(m => ({ name: m.name, size: m.size, modified: m.modified_at, family: m.details?.family, params: m.details?.parameter_size, quant: m.details?.quantization_level }));
  } catch { /* ollama offline */ }
  const hf = [];
  for (const [dir, uncensored] of [[HF_DIR, false], [UNC_DIR, true]]) {
    for (const f of await walk(dir)) {
      const [folder, ...rest] = path.relative(dir, f.path).split(path.sep);
      hf.push({ repo: folder.replace('__', '/'), file: rest.join('/'), size: f.size, fullPath: f.path, uncensored });
    }
  }
  return { ollama, hf };
}

// ---------------------------------------------------------------- download queue

const jobs = [];
let seq = 0;
let dirty = true;

// The queue is saved next to the models so unfinished downloads resume after a restart
// (Ollama and the HF downloader both continue from their partial files).
const QUEUE_FILE = path.join(LLMS, '.queue.json');
let saveTimer = null;
function saveQueue() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const keep = jobs.map(({ ctrl, lastBytes, lastAt, speed, ...j }) => j);
    fsp.writeFile(QUEUE_FILE, JSON.stringify({ seq, jobs: keep })).catch(() => {});
  }, 400);
}
async function loadQueue() {
  try {
    const q = JSON.parse((await fsp.readFile(QUEUE_FILE, 'utf8')).replace(/^﻿/, ''));
    seq = q.seq || 0;
    for (const j of q.jobs || []) {
      if (j.status === 'running' || j.status === 'queued') { j.status = 'queued'; j.message = 'Resuming after restart'; }
      j.speed = 0;
      jobs.push(j);
    }
  } catch { /* first run */ }
}

function jobKey(j) {
  return j.source === 'hf' ? `hf:${j.repo}:${j.quant}` : `ollama:${j.tag}`;
}

function publicJob(j) {
  const { ctrl, lastBytes, lastAt, ...rest } = j;
  return rest;
}

function addJob(spec) {
  const key = jobKey(spec);
  const existing = jobs.find(j => j.key === key && (j.status === 'queued' || j.status === 'running'));
  if (existing) return existing;
  const job = {
    id: ++seq, key, source: spec.source, label: spec.label || spec.tag || `${spec.repo} · ${spec.quant}`,
    tag: spec.tag, repo: spec.repo, quant: spec.quant, files: spec.files,
    status: 'queued', message: 'Queued', done: 0, total: Number(spec.total) || 0, speed: 0, error: null,
    created: Date.now(),
  };
  jobs.push(job);
  dirty = true;
  pump();
  return job;
}

function pump() {
  let running = jobs.filter(j => j.status === 'running').length;
  for (const j of jobs) {
    if (running >= MAX_PARALLEL) break;
    if (j.status === 'queued') { running++; startJob(j); }
  }
}

async function startJob(job) {
  job.status = 'running';
  job.message = 'Starting…';
  job.error = null;
  job.ctrl = new AbortController();
  job.lastBytes = job.done;
  job.lastAt = Date.now();
  dirty = true;
  try {
    if (job.source === 'hf') await downloadHf(job);
    else await pullOllama(job);
    job.status = 'done';
    job.message = 'Complete';
    if (job.total) job.done = job.total;
    job.finished = Date.now();
  } catch (e) {
    if (job.ctrl?.signal.aborted) { job.status = 'cancelled'; job.message = 'Cancelled — partial data kept for resume'; }
    else { job.status = 'error'; job.error = e.message; job.message = e.message; }
  } finally {
    job.ctrl = null;
    job.speed = 0;
    dirty = true;
    pump();
  }
}

async function pullOllama(job) {
  if (!(await ollamaStatus()).running) {
    const s = await startOllama();
    if (!s.ok) throw new Error('Ollama is not running and could not be started. Install it from ollama.com');
  }
  const res = await fetch(OLLAMA + '/api/pull', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: job.tag, stream: true }), signal: job.ctrl.signal,
  });
  if (!res.ok) throw new Error(`Ollama returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const layers = new Map();
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const m = JSON.parse(line);
      if (m.error) throw new Error(m.error);
      job.message = m.status;
      if (m.digest && m.total) {
        layers.set(m.digest, { t: m.total, c: m.completed || 0 });
        let t = 0, c = 0;
        for (const l of layers.values()) { t += l.t; c += l.c; }
        job.total = t;
        job.done = c;
      }
      if (m.status === 'success') return;
    }
  }
  throw new Error('Pull ended before Ollama reported success');
}

async function downloadHf(job) {
  const base = path.join(isUncensored(job.repo) ? UNC_DIR : HF_DIR, job.repo.replace('/', '__'));
  const repoUrl = `https://huggingface.co/${job.repo.split('/').map(encodeURIComponent).join('/')}/resolve/main/`;
  job.total = job.files.reduce((s, f) => s + (f.size || 0), 0);
  let completed = 0;
  for (const f of job.files) {
    const dest = path.resolve(base, f.path);
    if (!dest.startsWith(base + path.sep)) throw new Error('Refusing unsafe path ' + f.path);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const have = await statOr(dest);
    if (have && have.size === f.size) { completed += f.size; job.done = completed; continue; }

    const part = dest + '.part';
    let start = (await statOr(part))?.size || 0;
    if (start > f.size) start = 0;
    const headers = hfHeaders();
    if (start) headers.range = `bytes=${start}-`;
    job.message = `${start ? 'Resuming' : 'Downloading'} ${path.basename(f.path)}`;
    const res = await fetch(repoUrl + f.path.split('/').map(encodeURIComponent).join('/'), { headers, signal: job.ctrl.signal, redirect: 'follow' });
    if (res.status === 416) { await fsp.rename(part, dest); completed += f.size; job.done = completed; continue; }
    if (res.status === 401 || res.status === 403) throw new Error(`Access denied (HTTP ${res.status}) — the repo is gated or no longer exists. For gated repos, accept the licence on huggingface.co and start the app with HF_TOKEN set`);
    if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${f.path}`);
    if (start && res.status !== 206) start = 0;

    job.done = completed + start;
    const src = Readable.fromWeb(res.body);
    src.on('data', c => { job.done += c.length; });
    await pipeline(src, fs.createWriteStream(part, { flags: start ? 'a' : 'w' }), { signal: job.ctrl.signal });
    await fsp.rename(part, dest);
    completed += f.size;
    job.done = completed;
  }
}

// Speed sampling + SSE broadcast
const sseClients = new Set();
let lastSig = '';
setInterval(() => {
  const now = Date.now();
  for (const j of jobs) {
    if (j.status !== 'running') continue;
    const dt = (now - j.lastAt) / 1000;
    if (dt <= 0) continue;
    const inst = Math.max(0, (j.done - j.lastBytes) / dt);
    j.speed = j.speed ? j.speed * 0.7 + inst * 0.3 : inst;
    j.lastBytes = j.done;
    j.lastAt = now;
    dirty = true;
  }
  const sig = jobs.map(j => j.id + j.status).join();
  if (sig !== lastSig) { lastSig = sig; saveQueue(); }
  if (!dirty || !sseClients.size) return;
  dirty = false;
  const payload = `data: ${JSON.stringify(jobs.map(publicJob))}\n\n`;
  for (const res of sseClients) res.write(payload);
}, 700);

// ---------------------------------------------------------------- http

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

async function serveStatic(res, dir, rel) {
  const file = path.resolve(dir, '.' + path.posix.normalize('/' + rel));
  if (!file.startsWith(dir)) { res.writeHead(403); return res.end(); }
  try {
    // Packaged build: assets are keyed by their project-relative path, e.g. "public/app.js".
    const data = sea ? Buffer.from(sea.getAsset(path.relative(ROOT, file).split(path.sep).join('/'))) : await fsp.readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (p === '/api/system') return sendJson(res, 200, await systemInfo(url.searchParams.has('refresh')));
    if (p === '/api/installed') return sendJson(res, 200, await installed());
    if (p === '/api/jobs' && req.method === 'GET') return sendJson(res, 200, jobs.map(publicJob));

    if (p === '/api/hf/search') {
      const limit = Math.min(60, Number(url.searchParams.get('limit')) || 30);
      const sort = url.searchParams.get('sort');
      if (url.searchParams.has('uncensored')) return sendJson(res, 200, await hfUncensoredScan(url.searchParams.get('q') || '', limit, sort));
      return sendJson(res, 200, await hfSearch(url.searchParams.get('q') || '', limit, sort));
    }

    if (p === '/api/ollama/start' && req.method === 'POST') return sendJson(res, 200, await startOllama());
    if (p === '/api/ollama/library') return sendJson(res, 200, { status: lib.status, progress: lib.progress, error: lib.error, data: lib.data });
    if (p === '/api/ollama/library/refresh' && req.method === 'POST') { syncLibrary(true); return sendJson(res, 200, { ok: true }); }

    if (p === '/api/jobs' && req.method === 'POST') {
      const { items = [] } = await readBody(req);
      const added = items.map(addJob).map(publicJob);
      return sendJson(res, 200, added);
    }

    let m;
    if ((m = p.match(/^\/api\/jobs\/(\d+)\/(cancel|retry|remove)$/)) && req.method === 'POST') {
      const job = jobs.find(j => j.id === Number(m[1]));
      if (!job) return sendJson(res, 404, { error: 'No such job' });
      if (m[2] === 'cancel') {
        if (job.status === 'queued') { job.status = 'cancelled'; job.message = 'Cancelled'; }
        else job.ctrl?.abort();
      } else if (m[2] === 'retry' && (job.status === 'error' || job.status === 'cancelled')) {
        job.status = 'queued'; job.message = 'Queued'; job.error = null; pump();
      } else if (m[2] === 'remove' && job.status !== 'running') {
        jobs.splice(jobs.indexOf(job), 1);
      }
      dirty = true;
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/jobs/clear' && req.method === 'POST') {
      for (let i = jobs.length - 1; i >= 0; i--) if (['done', 'cancelled', 'error'].includes(jobs[i].status)) jobs.splice(i, 1);
      dirty = true;
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(jobs.map(publicJob))}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (p.startsWith('/data/')) return serveStatic(res, DATA, p.slice(6));
    return serveStatic(res, PUBLIC, p === '/' ? 'index.html' : p.slice(1));
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
});

(async () => {
  await fsp.mkdir(HF_DIR, { recursive: true });
  await fsp.mkdir(UNC_DIR, { recursive: true });
  await loadQueue();
  syncLibrary(); // background: refresh the live Ollama catalog (cached for 24h)
  // If Ollama isn't already running, start it with its model store inside ./llms/ollama.
  if (!(await ollamaStatus()).running && process.env.AUTO_START_OLLAMA !== '0') await startOllama();
  server.listen(PORT, '127.0.0.1', () => {
    const url = `http://localhost:${PORT}`;
    console.log(`\n  ${APP_NAME} v${VERSION} running at ${url}`);
    console.log(`  GGUF downloads  -> ${HF_DIR}`);
    console.log(`  Uncensored      -> ${UNC_DIR}`);
    console.log(`  Ollama models   -> ${ollamaModelsDir()}${spawnedOllama ? ' (Ollama started by this app)' : ''}`);
    const pending = jobs.filter(j => j.status === 'queued').length;
    console.log(pending ? `  Resuming ${pending} unfinished download${pending === 1 ? '' : 's'}\n` : '');
    pump();
    console.log('  Keep this window open while you use the app. Close it (or Ctrl+C) to stop.\n');
    if (process.argv.includes('--open') || (sea && !process.argv.includes('--no-open'))) openBrowser(url);
  });
})();

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).unref(); } catch { /* no desktop: just use the URL */ }
}

// Port already taken: if it's another copy of this app, just open it; otherwise say so clearly.
server.on('error', async e => {
  if (e.code !== 'EADDRINUSE') throw e;
  const url = `http://localhost:${PORT}`;
  try {
    const r = await fetchTimeout(url + '/api/system', {}, 2000);
    if (r.ok) {
      console.log(`\n  ${APP_NAME} is already running at ${url} - opening it.\n`);
      if (!process.argv.includes('--no-open')) openBrowser(url);
      return setTimeout(() => process.exit(0), 500);
    }
  } catch { /* something else owns the port */ }
  console.error(`\n  Port ${PORT} is in use by another program. Start with a different port, e.g. PORT=5190.\n`);
  process.exit(1);
});

// Ollama is left running on purpose; the saved queue resumes any unfinished downloads next start.
function shutdown() {
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
