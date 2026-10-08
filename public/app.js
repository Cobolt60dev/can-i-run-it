'use strict';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const GB = 1e9;
const RAM_BW = 64;          // GB/s — typical dual-channel DDR5 for the CPU-offloaded part
// KV cache at 8K context grows roughly with sqrt(model size) for modern GQA models (8B ≈ 1 GB, 70B ≈ 2.5 GB)
const kvCache = (size, ctx, kv = 1) => 0.35 * Math.sqrt(size) * (ctx / 8192) * kv;
const needFor = (size, kv = 1) => size + 0.4 + kvCache(size, S.ctx, kv);
// Same naming conventions the server uses to route GGUFs into llms/uncensored.
const UNC_RE = /uncensor|abliterat|heretic|nsfw|unfilter|unalign|dolphin|lexi-/i;
const TIER_LABEL = { gpu: 'Full GPU', offload: 'GPU + CPU', cpu: 'CPU', no: 'Too large' };
const QORDER = ['Q8_K_XL', 'Q8_K_L', 'Q8_0', 'Q6_K_XL', 'Q6_K_L', 'Q6_K_M', 'Q6_K', 'Q5_K_XL', 'Q5_K_M', 'Q5_K_S', 'Q4_K_XL', 'Q4_K_M', 'MXFP4', 'MXFP4_MOE', 'Q4_K_S', 'IQ4_NL', 'IQ4_XS', 'Q4_1', 'Q4_0',
  'Q3_K_XL', 'Q3_K_L', 'Q3_K_M', 'IQ3_M', 'IQ3_XS', 'IQ3_XXS', 'Q3_K_S', 'Q2_K_XL', 'Q2_K', 'IQ2_M', 'IQ2_S', 'IQ2_XS', 'IQ2_XXS', 'IQ1_M', 'IQ1_S', 'BF16', 'F16', 'F32'];

const S = {
  hwGroups: [], hwById: {}, hwId: null, custom: { vram: 16, bw: 500 },
  pool: [{ id: 'rtx4090', n: 2 }], poolLink: 'pcie', poolOptions: [], vendorOf: {},
  ram: 32, ctx: 8192, offload: true,
  families: [], system: null,
  inst: { ollama: [], hf: [] }, instOllama: new Set(), instHf: new Set(),
  jobs: [], sel: new Map(),
  o: { q: '', cat: 'all', fit: 'fits' },
  hf: { results: null, q: '', sort: 'downloads', target: 'file', loading: false, choice: {}, mode: 'search' },
  adv: null,
};

// ------------------------------------------------------------ utilities

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function fmtGB(gb) {
  if (gb == null || isNaN(gb)) return '—';
  if (gb >= 1000) return (gb / 1000).toFixed(2) + ' TB';
  if (gb >= 100) return gb.toFixed(0) + ' GB';
  if (gb >= 10) return gb.toFixed(1) + ' GB';
  if (gb >= 1) return gb.toFixed(2) + ' GB';
  return Math.round(gb * 1000) + ' MB';
}
const fmtBytes = b => fmtGB(b / GB);
const fmtNum = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n ?? 0);
const fmtParams = p => p == null ? '' : p < 1 ? Math.round(p * 1000) + 'M' : (p % 1 ? p.toFixed(1) : p) + 'B';
function fmtEta(s) {
  if (!isFinite(s) || s <= 0) return '';
  if (s < 60) return Math.round(s) + 's left';
  if (s < 3600) return Math.round(s / 60) + ' min left';
  return (s / 3600).toFixed(1) + ' h left';
}
const fmtTps = t => !t ? '—' : t >= 200 ? '200+ tok/s' : '~' + (t >= 10 ? Math.round(t) : t.toFixed(1)) + ' tok/s';

async function api(path, opts) {
  const r = await fetch(path, opts && opts.body ? { method: 'POST', headers: { 'content-type': 'application/json' }, ...opts, body: JSON.stringify(opts.body) } : opts);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

const store = {
  // 'lld.' was the prefix before the rename to Can I Run It?; still read so saved settings carry over.
  get(k, d) { try { const v = localStorage.getItem('ciri.' + k) ?? localStorage.getItem('lld.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ciri.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

// ------------------------------------------------------------ fit model

const MAX_POOL = 16;
const poolable = i => i.kind === 'gpu' && !i.custom && !i.pool;

// Expand the pool ([{ id, n }]) into one entry per physical card, fastest first.
function poolCards() {
  return S.pool.flatMap(p => Array(p.n).fill(S.hwById[p.id]).filter(Boolean)).sort((a, b) => b.bw - a.bw);
}

function hw() {
  const h = S.hwById[S.hwId] || S.hwById.rtx5080;
  if (h.custom) return { ...h, vram: Number(S.custom.vram) || 0, bw: Number(S.custom.bw) || 1 };
  if (h.pool) {
    const cards = poolCards();
    const name = S.pool.map(p => `${p.n}× ${S.hwById[p.id]?.name}`).join(' + ');
    return { ...h, name, cards, vram: cards.reduce((s, c) => s + c.vram, 0), bw: Math.max(...cards.map(c => c.bw), 1) };
  }
  return h;
}

function budget() {
  const h = hw();
  if (h.kind === 'unified') return { kind: 'unified', gpu: h.usable ?? h.vram * 0.72, ram: 0, bw: h.bw };
  if (h.kind === 'cpu') return { kind: 'cpu', gpu: 0, ram: S.ram * 0.7, bw: RAM_BW };
  const ram = S.offload ? S.ram * 0.6 : 0;
  if (h.cards) {
    // Display card loses ~0.8 GB to the desktop; every other card ~0.5 GB to its CUDA/ROCm context.
    const cards = h.cards.map((c, i) => ({ name: c.name, bw: c.bw, usable: Math.max(0, c.vram - (i ? 0.5 : 0.8)) }));
    return { kind: 'gpu', gpu: cards.reduce((s, c) => s + c.usable, 0), ram, bw: h.bw, cards, link: S.poolLink };
  }
  return { kind: 'gpu', gpu: Math.max(0, h.vram - 0.8), ram, bw: h.bw };
}

// Effective bandwidth for the GPU-resident part of a model.
// Ollama keeps a model on one GPU when it fits; otherwise it splits layers across all GPUs in
// proportion to their free VRAM and runs them one after another, so each card's time adds up.
function gpuPlacement(b, need) {
  if (!b.cards || b.cards.length < 2) return { bw: b.bw, gpus: 1 };
  const single = b.cards.find(c => need <= c.usable); // cards are sorted fastest first
  if (single) return { bw: single.bw, gpus: 1 };
  const total = b.gpu || 1;
  const eff = 1 / b.cards.reduce((s, c) => s + c.usable / total / c.bw, 0);
  return { bw: eff * (b.link === 'network' ? 0.6 : 0.92), gpus: b.cards.length };
}

// size in GB (weights on disk), activeFrac < 1 for MoE models
function assess(size, activeFrac = 1, kv = 1) {
  const b = budget();
  const need = needFor(size, kv);
  const place = gpuPlacement(b, need);
  let tier;
  if (b.kind === 'cpu') tier = need <= b.ram ? 'cpu' : 'no';
  else if (need <= b.gpu) tier = 'gpu';
  else if (need <= b.gpu + b.ram) tier = 'offload';
  else tier = 'no';

  // Token generation is memory-bandwidth bound: every token reads the active weights once.
  let tps = 0;
  if (tier !== 'no') {
    const bytes = Math.max(0.05, size * activeFrac);
    if (b.kind === 'cpu') tps = (RAM_BW * 0.55) / bytes;
    else {
      const share = Math.min(1, b.gpu / need);
      tps = 1 / ((bytes * share) / (place.bw * (S.adv?.eff ?? 0.65)) + (bytes * (1 - share)) / (RAM_BW * 0.55));
    }
    // Fixed per-token cost: ~1 ms of kernel launches, plus a hand-off for every extra GPU
    // (PCIe ≈ 1.5 ms, over the network ≈ 12 ms).
    const hop = (place.gpus - 1) * (b.link === 'network' ? 0.012 : 0.0015);
    tps = 1 / (1 / tps + 0.001 + hop);
  }
  const scale = b.kind === 'cpu' ? b.ram : (b.gpu + b.ram) || 1;
  return { tier, need, tps, gpus: place.gpus, pct: Math.min(100, (need / scale) * 100), cap: Math.min(100, (b.gpu / scale) * 100) };
}

function meter(a) {
  const split = a.gpus > 1 && a.tier !== 'no' ? ` · split across ${a.gpus} GPUs` : '';
  return `<div class="meter" style="--cap:${a.cap}%" title="Needs ~${fmtGB(a.need)} incl. context${split}"><i class="${a.tier}" style="width:${a.pct}%"></i></div>`;
}
const badge = a => `<span class="badge ${a.tier}">${TIER_LABEL[a.tier]}</span>`;

// ------------------------------------------------------------ hardware panel

function renderHwSelect() {
  $('#sel-gpu').innerHTML = S.hwGroups.map(g =>
    `<optgroup label="${esc(g.label)}">${g.items.map(i => `<option value="${i.id}">${esc(i.name)}${i.kind === 'cpu' || i.custom || i.pool ? '' : ` — ${i.vram} GB`}</option>`).join('')}</optgroup>`).join('');
  S.poolOptions = S.hwGroups
    .map(g => ({ label: g.label, items: g.items.filter(poolable) }))
    .filter(g => g.items.length);
}

function renderPool() {
  const count = S.pool.reduce((s, p) => s + p.n, 0);
  const opts = id => S.poolOptions.map(g =>
    `<optgroup label="${esc(g.label)}">${g.items.map(i => `<option value="${i.id}" ${i.id === id ? 'selected' : ''}>${esc(i.name)} — ${i.vram} GB</option>`).join('')}</optgroup>`).join('');
  $('#pool-rows').innerHTML = S.pool.map((p, i) => `
    <div class="pool-row" data-i="${i}">
      <select data-pool-gpu aria-label="GPU model">${opts(p.id)}</select>
      <div class="stepper">
        <button data-step="-1" ${p.n <= 1 ? 'disabled' : ''} aria-label="One fewer">−</button>
        <output>${p.n}</output>
        <button data-step="1" ${count >= MAX_POOL ? 'disabled' : ''} aria-label="One more">+</button>
      </div>
      <button class="icon-btn" data-remove ${S.pool.length <= 1 ? 'disabled' : ''} aria-label="Remove">
        <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>
      </button>
    </div>`).join('');
  $('#pool-add').disabled = count >= MAX_POOL;
  $('#pool-link').value = S.poolLink;

  const h = hw();
  $('#pool-total').textContent = `${count} GPU${count === 1 ? '' : 's'} · ${h.vram} GB`;

  const notes = [];
  const vendors = new Set(h.cards.map(c => Advisor.archOf(c.name).vendor));
  if (vendors.size > 1) notes.push(['warn', 'Ollama can’t pool NVIDIA with AMD / Intel cards. llama.cpp’s Vulkan build can, using the GGUF files from the Hugging Face tab.']);
  if (S.poolLink === 'network') {
    notes.push(['warn', 'Ollama can’t split one model across PCs. Run llama.cpp <code>rpc-server</code> on each machine, or use exo / GPUStack. The GGUF files in <code>llms/huggingface</code> work with them as-is. Speeds include a network penalty.']);
  } else if (count > 1) {
    notes.push(['', 'A model that fits on one card stays on the fastest card that fits it. Bigger models are split by layers across all cards and run one card after another, so a slower card pulls the average speed down.']);
  }
  $('#pool-notes').innerHTML = notes.map(([cls, t]) => `<p class="note ${cls}">${t}</p>`).join('');
}

function syncHwInputs() {
  const h = hw();
  $('#sel-gpu').value = S.hwId;
  $('#custom-fields').hidden = !h.custom;
  $('#pool').hidden = !h.pool;
  if (h.pool) renderPool();
  $('#in-vram').value = S.custom.vram;
  $('#in-bw').value = S.custom.bw;
  $('#ram-field').hidden = h.kind === 'unified';
  $('#chk-offload').closest('.switch').hidden = h.kind !== 'gpu';
  $('#chk-offload').checked = S.offload;
  $('#sel-ram').value = String(S.ram);
  $$('#seg-ctx button').forEach(b => b.classList.toggle('on', Number(b.dataset.v) === S.ctx));
}

function largestFitting(limit) {
  let lo = 0, hi = 2000;
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (needFor(m) <= limit) lo = m; else hi = m; }
  return lo;
}

function renderBudget() {
  const h = hw(), b = budget();
  const total = b.gpu + b.ram;
  const maxQ4 = gb => gb / 0.62; // weights GB → rough billions of params at Q4_K_M
  const fitGpu = largestFitting(b.gpu);
  const fitAll = largestFitting(total);
  const primary = b.kind === 'cpu' ? b.ram : b.gpu;
  $('#budget').innerHTML = `
    <div class="label">${b.kind === 'cpu' ? 'Usable RAM for models' : b.kind === 'unified' ? 'GPU-addressable memory' : 'Usable VRAM'}</div>
    <div class="big">${fmtGB(primary)} <small>${b.ram && b.kind === 'gpu' ? `+ ${fmtGB(b.ram)} RAM offload` : ''}</small></div>
    <div class="bar">
      ${b.cards
        ? b.cards.map(c => `<i class="card" title="${esc(c.name)} · ${fmtGB(c.usable)}" style="width:${(c.usable / (total || 1)) * 100}%;background:var(--good)"></i>`).join('')
        : b.kind !== 'cpu' ? `<i style="width:${(b.gpu / (total || 1)) * 100}%;background:var(--good)"></i>` : ''}
      ${b.ram ? `<i style="width:${(b.ram / (total || 1)) * 100}%;background:var(--warn)"></i>` : ''}
    </div>
    <div class="legend">
      ${b.kind !== 'cpu' ? '<span style="--c:var(--good)">Fast (GPU)</span>' : ''}
      ${b.ram ? '<span style="--c:var(--warn)">Slower (CPU offload)</span>' : ''}
    </div>
    <dl>
      <dt>Device</dt><dd>${esc(h.name)}</dd>
      ${b.cards ? `<dt>GPUs</dt><dd>${b.cards.length}${b.link === 'network' ? ' (networked)' : ''}</dd>` : ''}
      <dt>Memory bandwidth</dt><dd>${b.cards && Math.min(...b.cards.map(c => c.bw)) !== b.bw ? `${Math.min(...b.cards.map(c => c.bw))}–${b.bw}` : b.bw} GB/s</dd>
      <dt>Largest at full speed</dt><dd>~${fmtParams(Math.max(0, Math.floor(maxQ4(b.kind === 'cpu' ? 0 : fitGpu))))} @ Q4</dd>
      <dt>Largest it will run</dt><dd>~${fmtParams(Math.max(0, Math.floor(maxQ4(fitAll))))} @ Q4</dd>
    </dl>`;
}

// ------------------------------------------------------------ setup advisor

function computeAdvice() {
  S.adv = Advisor.advise({ hw: hw(), system: S.system, ramGB: S.ram, poolLink: S.poolLink });
  S.adv.fromSystem = !!S.system;
  $('#guide').innerHTML = Advisor.render(S.adv, { system: S.system });
  const g = $('#cnt-guide');
  g.hidden = S.adv.verdict[0] === 'ok';
  g.textContent = '!';
  const ollama = S.adv.engines.find(e => e.name === 'Ollama');
  const llama = S.adv.engines.find(e => e.name === 'llama.cpp');
  $('#o-banner').innerHTML = ollama && (ollama.level === 'no' || ollama.level === 'limited')
    ? `<div class="banner"><span><b>Ollama ${ollama.level === 'no' ? 'can’t use' : 'has limited support for'} this GPU.</b> ${esc(ollama.note)} GGUF files from the Hugging Face tab with llama.cpp${llama?.build ? ' (' + esc(llama.build) + ')' : ''} are the better route. <button data-goto="guide">Open the setup guide</button></span></div>`
    : '';
}

function onHwChange() {
  computeAdvice();
  store.set('hw', { id: S.hwId, ram: S.ram, ctx: S.ctx, offload: S.offload, custom: S.custom, pool: S.pool, poolLink: S.poolLink });
  syncHwInputs();
  renderBudget();
  renderOllama();
  renderHf();
}

function matchHardware(gpu) {
  const name = gpu.name.toLowerCase().replace(/nvidia|geforce|amd|radeon|intel|\(tm\)|\(r\)/g, ' ').replace(/\s+/g, ' ').trim();
  const items = S.hwGroups.flatMap(g => g.items).filter(i => !i.custom && i.kind !== 'cpu');
  const cands = items.filter(i => {
    const base = i.name.toLowerCase().replace(/\s*\d+gb$/, '').replace(' laptop', '');
    const laptop = /laptop/i.test(i.name);
    return name.includes(base) && laptop === /laptop/i.test(gpu.name);
  });
  if (!cands.length) return null;
  const longest = Math.max(...cands.map(c => c.name.replace(/\s*\d+GB$/, '').length));
  const best = cands.filter(c => c.name.replace(/\s*\d+GB$/, '').length === longest);
  if (gpu.vramMiB) best.sort((a, b) => Math.abs(a.vram - gpu.vramMiB / 1024) - Math.abs(b.vram - gpu.vramMiB / 1024));
  return best[0];
}

async function detect(silent) {
  try {
    const sys = await api('/api/system?refresh');
    S.system = sys;
    renderStatus();
    const opts = [...$('#sel-ram').options].map(o => Number(o.value));
    S.ram = opts.reduce((a, b) => Math.abs(b - sys.ramGB) < Math.abs(a - sys.ramGB) ? b : a);
    const gpu = sys.gpus[0];
    const matched = sys.gpus.map(matchHardware);
    let msg;
    if (sys.gpus.length > 1 && matched.every(Boolean)) {
      // Several GPUs: build the pool from what nvidia-smi reports.
      const counts = new Map();
      for (const m of matched) counts.set(m.id, (counts.get(m.id) || 0) + 1);
      S.pool = [...counts].map(([id, n]) => ({ id, n }));
      S.poolLink = 'pcie';
      S.hwId = 'pool';
      msg = `Detected ${sys.gpus.length} GPUs (${S.pool.map(p => `${p.n}× ${S.hwById[p.id].name}`).join(' + ')}) · ${sys.ramGB} GB RAM`;
    } else if (gpu) {
      const m = matchHardware(gpu);
      if (m) { S.hwId = m.id; msg = `Detected ${gpu.name}${gpu.vramMiB ? ` (${(gpu.vramMiB / 1024).toFixed(0)} GB)` : ''} · ${sys.ramGB} GB RAM`; }
      else if (gpu.vramMiB) { S.hwId = 'custom'; S.custom.vram = Math.round(gpu.vramMiB / 1024); msg = `Detected ${gpu.name} — set as custom, check bandwidth`; }
      else msg = `Found ${gpu.name} but couldn't read its VRAM — pick it from the list`;
    } else {
      S.hwId = 'cpu';
      msg = `No GPU detected · ${sys.ramGB} GB RAM`;
    }
    $('#detected').textContent = '✓ ' + msg;
    $('#detected').hidden = false;
    onHwChange();
  } catch (e) {
    if (!silent) toast('Detection failed: ' + e.message);
  }
}

// ------------------------------------------------------------ status bar

function renderStatus() {
  const s = S.system;
  if (!s) return;
  const o = $('#chip-ollama');
  if (s.ollama.running) {
    o.className = 'chip ok';
    o.innerHTML = `<i class="dot"></i>Ollama <b>${esc(s.ollama.version)}</b>`;
    o.title = 'Models stored in ' + s.ollama.modelsDir;
  } else {
    o.className = 'chip bad';
    o.innerHTML = `<i class="dot"></i>Ollama offline <button id="btn-start-ollama">Start</button>`;
    o.title = '';
  }
  const d = $('#chip-disk');
  if (s.disk) {
    const free = s.disk.free / GB;
    d.className = 'chip ' + (free < 50 ? 'bad' : free < 150 ? 'warn' : 'ok');
    d.innerHTML = `<i class="dot"></i><b>${fmtGB(free)}</b> free`;
    d.title = s.llmsDir;
  }
  renderSelbar();
}

async function refreshSystem() {
  try {
    S.system = await api('/api/system');
    renderStatus();
    if (!S.adv?.fromSystem) { computeAdvice(); renderOllama(); }
  } catch { /* server restarting */ }
}

// ------------------------------------------------------------ installed + jobs state

async function refreshInstalled() {
  try {
    S.inst = await api('/api/installed');
    S.instOllama = new Set(S.inst.ollama.flatMap(m => [m.name, m.name.replace(/:latest$/, '')]));
    S.instHf = new Set(S.inst.hf.map(f => f.repo));
    renderOllama();
    renderHf();
    renderInstalled();
  } catch { /* ignore */ }
}

function activeJobFor(key) {
  return S.jobs.find(j => j.key === key && (j.status === 'queued' || j.status === 'running'));
}

function rowState(installed, jobKey) {
  const j = activeJobFor(jobKey);
  if (j) return `<span class="state queued">${j.status === 'running' ? 'Downloading' : 'Queued'}</span>`;
  if (installed) return '<span class="state inst">✓ Installed</span>';
  return '<span class="state"></span>';
}

// ------------------------------------------------------------ Ollama library

const activeFrac = v => (v.active ? v.active / v.params : 1);
const assessV = v => assess(v.size, activeFrac(v), v.kv);

function visibleVariants() {
  const { q, cat, fit } = S.o;
  const out = [];
  for (const f of S.families) {
    if (cat !== 'all' && !f.cats.includes(cat)) continue;
    if (q && !`${f.name} ${f.title} ${f.vendor} ${f.desc}`.toLowerCase().includes(q)) continue;
    const rows = f.variants
      .map(v => ({ v, a: assessV(v) }))
      .filter(({ a }) => fit === 'all' || (fit === 'gpu' ? a.tier === 'gpu' : a.tier !== 'no'));
    if (rows.length) out.push({ f, rows });
  }
  return out;
}

function renderOllama() {
  if (!S.families.length) return;
  const groups = visibleVariants();
  const fitGpu = S.families.reduce((n, f) => n + f.variants.filter(v => assessV(v).tier === 'gpu').length, 0);
  $('#cnt-ollama').textContent = fitGpu;
  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  $('#o-summary').textContent = `${total} variants shown · ${fitGpu} run fully on your GPU`;

  if (!groups.length) {
    $('#o-list').innerHTML = `<div class="empty"><b>Nothing matches</b>Try "Show everything" or another category.</div>`;
    return;
  }
  $('#o-list').innerHTML = groups.map(({ f, rows }) => `
    <article class="family">
      <div class="family-head">
        <div>
          <h3>${esc(f.title)} <span class="vendor">${esc(f.vendor)}</span>
            ${f.rec ? '<span class="tag star">Recommended</span>' : ''}
            ${f.age != null && f.age <= 45 ? '<span class="tag new">New</span>' : ''}
            ${f.cats.map(c => `<span class="tag ${c === 'uncensored' ? 'unc' : ''}">${c}</span>`).join('')}
          </h3>
          <p>${esc(f.desc)}</p>
          ${f.live ? `<div class="family-meta">${f.pulls ? esc(f.pulls) + ' pulls · ' : ''}updated ${esc(f.updated || '—')} · <a href="https://ollama.com/library/${esc(f.name)}" target="_blank" rel="noopener">ollama.com</a></div>` : ''}
        </div>
      </div>
      <div class="variants">
        ${rows.map(({ v, a }) => {
          const key = 'o:' + v.tag;
          const sel = S.sel.has(key);
          const inst = S.instOllama.has(v.tag);
          return `<div class="vrow ${sel ? 'sel' : ''} ${a.tier === 'no' ? 'dim' : ''}" data-otag="${esc(v.tag)}">
            <input type="checkbox" ${sel ? 'checked' : ''} ${a.tier === 'no' ? 'disabled' : ''} aria-label="Select ${esc(v.tag)}">
            <span class="name" title="${esc(v.tag)}">${esc(v.tag)}</span>
            <span class="num">${fmtParams(v.params)}${v.active ? `<br><small>${fmtParams(v.active)} act.</small>` : ''}</span>
            <span class="num">${fmtGB(v.size)}</span>
            ${meter(a)}
            ${badge(a)}
            ${inst || activeJobFor('ollama:' + v.tag) ? rowState(inst, 'ollama:' + v.tag) : `<span class="tps">${fmtTps(a.tps)}</span>`}
          </div>`;
        }).join('')}
      </div>
    </article>`).join('');
}

function toggleOllama(tag, force) {
  const key = 'o:' + tag;
  const v = S.families.flatMap(f => f.variants).find(x => x.tag === tag);
  const on = force ?? !S.sel.has(key);
  if (on) S.sel.set(key, { key, source: 'ollama', tag, label: tag, size: v ? v.size : 0 });
  else S.sel.delete(key);
}

// For each recommended family: the largest variant that runs well (full GPU, or a fast MoE with
// partial offload). Then keep only the newest generation per line that has such a variant.
function smartPicks() {
  const cpu = budget().kind === 'cpu';
  const runsWell = a => cpu ? a.tier === 'cpu' && a.tps >= 4 : (a.tier === 'gpu' && a.tps >= 12) || (a.tier === 'offload' && a.tps >= 25);
  const byLine = new Map();
  for (const f of S.families.filter(f => f.rec)) {
    const fits = f.variants.filter(v => runsWell(assessV(v)));
    if (!fits.length) continue;
    const v = fits.reduce((x, y) => ((y.params ?? y.size) > (x.params ?? x.size) ? y : x));
    const k = lineage(f.name), cur = byLine.get(k);
    if (!cur || version(f.name) > version(cur.f.name)) byLine.set(k, { f, v });
  }
  return [...byLine.values()]
    .sort((a, b) => (a.f.rank ?? 999) - (b.f.rank ?? 999))
    .slice(0, MAX_PICKS)
    .map(x => x.v.tag)
    .filter(t => !S.instOllama.has(t));
}

// ---- live library (ollama.com) merged with the curated catalog

const lineage = name => name.replace(/\d+(\.\d+)?/g, '').replace(/[-.]+$/, '');
const version = name => parseFloat((name.match(/\d+(\.\d+)?/) || [0])[0]);
const MAX_PICKS = 8;

// Recommended = curated favourites + popular families updated in the last ~6 months.
// smartPicks() later keeps only the newest generation of each line that fits the hardware.
function withRecommendations(families) {
  for (const f of families) {
    if (UNC_RE.test(`${f.name} ${f.desc}`) && !f.cats.includes('uncensored')) f.cats = [...f.cats, 'uncensored'];
    f.rec = !f.cats.includes('uncensored') && !!(f.featured || (f.rank < 40 && f.age != null && f.age <= 180 && !f.cats.includes('embedding')));
  }
  return families.sort((a, b) => (b.rec - a.rec) || ((a.rank ?? 999) - (b.rank ?? 999)));
}

function mergeLibrary(live) {
  const curated = new Map(S.curated.map(f => [f.name, f]));
  const out = live.families.map(lf => {
    const c = curated.get(lf.name);
    curated.delete(lf.name);
    if (!c) return { ...lf, title: lf.name };
    const cv = new Map(c.variants.map(v => [v.tag, v]));
    const variants = lf.variants.map(v => ({ ...cv.get(v.tag), ...v, active: v.active ?? cv.get(v.tag)?.active, params: v.params ?? cv.get(v.tag)?.params }));
    return { ...c, variants, live: true, pulls: lf.pulls, updated: lf.updated, age: lf.age, rank: lf.rank, cats: [...new Set([...c.cats, ...lf.cats])] };
  });
  return withRecommendations([...out, ...[...curated.values()].map(f => ({ ...f }))]);
}

const ago = ms => { const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago'; };

async function pollLibrary() {
  let s;
  try { s = await api('/api/ollama/library'); } catch { return; }
  const el = $('#o-sync');
  if (s.data) {
    S.families = mergeLibrary(s.data);
    renderOllama();
  }
  if (s.status === 'syncing') {
    el.innerHTML = `<i class="dot" style="background:var(--accent)"></i>Syncing live library from ollama.com… ${Math.round(s.progress * 100)}%`;
    setTimeout(pollLibrary, 1500);
  } else if (s.data) {
    el.innerHTML = `<i class="dot" style="background:var(--good)"></i>Live from ollama.com · ${s.data.families.length} most popular families · synced ${ago(s.data.syncedAt)} · <button data-sync>Refresh</button>`;
  } else {
    el.innerHTML = `<i class="dot" style="background:var(--warn)"></i>Offline catalog only${s.error ? ' (' + esc(s.error) + ')' : ''} · <button data-sync>Retry</button>`;
  }
}

function applyPreset(p) {
  if (p === 'none') {
    for (const k of [...S.sel.keys()]) if (k.startsWith('o:')) S.sel.delete(k);
  } else if (p === 'smart') {
    smartPicks().forEach(t => toggleOllama(t, true));
  } else if (p === 'gpu') {
    for (const { rows } of visibleVariants())
      for (const { v, a } of rows) if (a.tier === 'gpu' && !S.instOllama.has(v.tag)) toggleOllama(v.tag, true);
  }
  renderOllama();
  renderSelbar();
}

// ------------------------------------------------------------ Hugging Face

const KNOWN_MOE = { 'gpt-oss-20b': [3.6, 21], 'gpt-oss-120b': [5.1, 117] };
const hfKv = repo => (/gpt-oss/i.test(repo) ? 0.3 : 1); // sliding-window attention keeps its KV cache small
const assessHf = (r, g) => assess(g.size / GB, hfActiveFrac(r.repo), hfKv(r.repo));

function hfActiveFrac(repo) {
  const m = repo.match(/(\d+(?:\.\d+)?)B-A(\d+(?:\.\d+)?)B/i);
  if (m) return Number(m[2]) / Number(m[1]);
  for (const k in KNOWN_MOE) if (repo.toLowerCase().includes(k)) return KNOWN_MOE[k][0] / KNOWN_MOE[k][1];
  return 1;
}
const qrank = q => { const i = QORDER.indexOf(q); return i < 0 ? 40 : i; };

function groupSize(r, g) {
  return (g.size + (r.mmproj && S.hf.target === 'file' ? r.mmproj.size : 0)) / GB;
}

// Highest-quality quant that runs fully on GPU. If nothing 4-bit+ fits, accept offload but aim
// for a Q4_K_M-class file — with offload every extra GB costs speed, so bigger quants rarely pay.
// Then anything that fits on GPU, then anything that runs at all.
function bestQuant(r) {
  const minOk = qrank('Q4_0');
  const target = qrank('Q4_K_M');
  const scored = r.quants.map(g => ({ g, a: assessHf(r, g), q: qrankFor(g.quant) })).sort((x, y) => x.q - y.q);
  const offload = scored
    .filter(s => s.a.tier !== 'no' && s.q <= minOk && s.a.tps >= 8)
    .sort((x, y) => Math.abs(x.q - target) - Math.abs(y.q - target) || x.g.size - y.g.size);
  const pick = scored.find(s => s.a.tier === 'gpu' && s.q <= minOk)
    || offload[0]
    || scored.find(s => s.a.tier === 'gpu')
    || scored.find(s => s.a.tier !== 'no');
  return pick ? pick.g : [...r.quants].sort((a, b) => a.size - b.size)[0];
}

function chosenQuant(r) {
  const k = S.hf.choice[r.repo];
  return r.quants.find(g => g.key === k) || bestQuant(r);
}

// Older GPUs, Intel and CPUs run I-quants (IQ*) noticeably slower than K-quants.
const qrankFor = q => qrank(q) + (S.adv?.quantPref === 'k' && /^IQ/.test(q) ? 12 : 0);

async function hfSearch() {
  const req = (S.hf.req = (S.hf.req || 0) + 1); // only the newest search may update the list
  S.hf.loading = true;
  renderHf();
  let results;
  try {
    results = await api(`/api/hf/search?q=${encodeURIComponent(S.hf.q)}&sort=${S.hf.sort}&limit=30${S.hf.mode === 'uncensored' ? '&uncensored' : ''}`);
  } catch (e) {
    results = [];
    if (req === S.hf.req) toast('Hugging Face search failed: ' + e.message);
  }
  if (req !== S.hf.req) return;
  S.hf.results = results;
  S.hf.loading = false;
  renderHf();
}

function renderHf() {
  const el = $('#hf-list');
  $$('#hf-quick button').forEach(b => b.classList.toggle('on', S.hf.mode !== 'uncensored' && b.dataset.q === S.hf.q));
  $('#hf-unc').classList.toggle('on', S.hf.mode === 'uncensored');
  if (S.hf.loading) { el.innerHTML = `<div class="loading">${'<div class="skel"></div>'.repeat(6)}</div>`; return; }
  if (!S.hf.results) { el.innerHTML = ''; return; }
  if (!S.hf.results.length) { el.innerHTML = `<div class="empty"><b>No GGUF repos found</b>Try a different search.</div>`; return; }

  let fitting = 0;
  el.innerHTML = S.hf.results.map(r => {
    const af = hfActiveFrac(r.repo);
    const g = chosenQuant(r);
    const a = assessHf(r, g);
    if (a.tier === 'gpu') fitting++;
    const key = 'h:' + r.repo;
    const sel = S.sel.has(key);
    const jobKey = S.hf.target === 'file' ? `hf:${r.repo}:${g.quant}` : `ollama:hf.co/${r.repo}:${g.qtag}`;
    const inst = S.instHf.has(r.repo);
    const opts = [...r.quants].sort((x, y) => x.size - y.size).map(q => {
      const qa = assessHf(r, q);
      const mark = qa.tier === 'gpu' ? '●' : qa.tier === 'no' ? '✕' : '◐';
      return `<option value="${esc(q.key)}" ${q.key === g.key ? 'selected' : ''}>${mark} ${esc(q.quant)} · ${fmtBytes(q.size)}${q.files.length > 1 ? ` (${q.files.length} parts)` : ''}</option>`;
    }).join('');
    return `<div class="hfrow ${sel ? 'sel' : ''}" data-repo="${esc(r.repo)}">
      <input type="checkbox" ${sel ? 'checked' : ''} ${a.tier === 'no' ? 'disabled' : ''} aria-label="Select ${esc(r.repo)}">
      <div class="repo">
        <a href="https://huggingface.co/${esc(r.repo)}" target="_blank" rel="noopener">${esc(r.repo)}</a>
        <div class="meta">
          <span>↓ ${fmtNum(r.downloads)}</span><span>♥ ${fmtNum(r.likes)}</span>
          <span>${r.quants.length} quants</span>
          ${af < 1 ? '<span>MoE</span>' : ''}${r.mmproj ? '<span>vision</span>' : ''}${r.gated ? '<span>🔒 gated</span>' : ''}${r.uncensored ? '<span class="tag unc">Uncensored</span>' : ''}
          ${inst ? '<span style="color:var(--good)">✓ have files</span>' : ''}
        </div>
      </div>
      <select data-quant aria-label="Quantisation">${opts}</select>
      ${badge(a)}
      ${activeJobFor(jobKey) ? rowState(false, jobKey) : `<span class="tps">${fmtTps(a.tps)}</span>`}
    </div>`;
  }).join('');
  $('#hf-summary').textContent = `${S.hf.results.length} repos · ${fitting} have a quant that fits fully on GPU · ● fits ◐ offload ✕ too big`;
}

function hfItem(r) {
  const g = chosenQuant(r);
  if (S.hf.target === 'ollama') {
    return { key: 'h:' + r.repo, source: 'ollama', tag: `hf.co/${r.repo}:${g.qtag || g.quant}`, label: `hf.co/${r.repo}:${g.qtag || g.quant}`, size: g.size / GB, repo: r.repo };
  }
  const files = r.mmproj ? [...g.files, r.mmproj] : g.files;
  return { key: 'h:' + r.repo, source: 'hf', repo: r.repo, quant: g.quant, files, label: `${r.repo} · ${g.quant}`, size: groupSize(r, g), uncensored: r.uncensored };
}

function toggleHf(repo, force) {
  const r = S.hf.results.find(x => x.repo === repo);
  const key = 'h:' + repo;
  const on = force ?? !S.sel.has(key);
  if (on) S.sel.set(key, hfItem(r)); else S.sel.delete(key);
}

// ------------------------------------------------------------ selection + confirm

function renderSelbar() {
  const n = S.sel.size;
  $('#selbar').hidden = n === 0;
  if (!n) return;
  const total = [...S.sel.values()].reduce((s, i) => s + i.size, 0);
  $('#sel-count').textContent = n;
  $('#sel-size').textContent = fmtGB(total);
  const free = S.system?.disk ? S.system.disk.free / GB : null;
  const d = $('#sel-disk');
  if (free == null) d.textContent = '';
  else if (total > free * 0.95) { d.textContent = `· only ${fmtGB(free)} free!`; d.className = 'warn'; }
  else { d.textContent = `· ${fmtGB(free)} free`; d.className = 'muted'; }
}

function confirmDownload(items, title) {
  return new Promise(resolve => {
    const total = items.reduce((s, i) => s + i.size, 0);
    const free = S.system?.disk ? S.system.disk.free / GB : null;
    $('#dlg-title').textContent = title;
    $('#dlg-body').innerHTML = `
      <p class="muted">These will be downloaded ${S.system ? `— GGUF files into <span class="mono">llms/huggingface</span>, Ollama models into <span class="mono">${esc(S.system.ollama.modelsDir)}</span>` : ''}.</p>
      <div class="dlg-list">${items.map(i => `<div><span class="mono">${esc(i.label)}${i.uncensored && i.source === 'hf' ? ' <span class="tag unc">→ llms/uncensored</span>' : ''}</span><span>${fmtGB(i.size)}</span></div>`).join('')}</div>
      <div class="dlg-total"><span>${items.length} model${items.length === 1 ? '' : 's'}</span><span>${fmtGB(total)}</span></div>
      ${free != null && total > free * 0.95 ? `<div class="dlg-warn">Only ${fmtGB(free)} free on this drive — some downloads will fail.</div>` : ''}`;
    const dlg = $('#dlg');
    dlg.onclose = () => resolve(dlg.returnValue === 'ok');
    dlg.returnValue = '';
    dlg.showModal();
  });
}

async function queue(items) {
  const body = items.map(i => i.source === 'hf'
    ? { source: 'hf', repo: i.repo, quant: i.quant, files: i.files, label: i.label, total: Math.round(i.size * GB) }
    : { source: 'ollama', tag: i.tag, label: i.label, total: Math.round(i.size * GB) });
  await api('/api/jobs', { body: { items: body } });
  toast(`Queued ${items.length} download${items.length === 1 ? '' : 's'}`);
  switchTab('jobs');
}

async function downloadSelected() {
  const items = [...S.sel.values()];
  if (!items.length) return;
  if (!(await confirmDownload(items, 'Download selected models'))) return;
  await queue(items);
  S.sel.clear();
  renderOllama(); renderHf(); renderSelbar();
}

async function autoPull() {
  const picks = smartPicks();
  if (!picks.length) {
    toast(S.instOllama.size ? 'You already have the best picks for this hardware' : 'Nothing in the recommended list fits this hardware');
    return;
  }
  picks.forEach(t => toggleOllama(t, true));
  switchTab('ollama');
  renderOllama(); renderSelbar();
  const items = picks.map(t => S.sel.get('o:' + t));
  if (!(await confirmDownload(items, `Best models for ${hw().name}`))) return;
  await queue(items);
  picks.forEach(t => S.sel.delete('o:' + t));
  renderOllama(); renderSelbar();
}

// ------------------------------------------------------------ downloads

function renderJobs() {
  const active = S.jobs.filter(j => j.status === 'queued' || j.status === 'running').length;
  const c = $('#cnt-jobs');
  c.hidden = !active;
  c.textContent = active;
  const speed = S.jobs.reduce((s, j) => s + (j.status === 'running' ? j.speed : 0), 0);
  $('#jobs-summary').textContent = S.jobs.length ? `${active} active${speed ? ` · ${fmtBytes(speed)}/s total` : ''}` : '';

  if (!S.jobs.length) {
    $('#jobs-list').innerHTML = `<div class="empty"><b>No downloads yet</b>Select models in the Ollama or Hugging Face tabs, or hit “Auto-pull best models”.</div>`;
    return;
  }
  $('#jobs-list').innerHTML = [...S.jobs].reverse().map(j => {
    const pct = j.total ? Math.min(100, (j.done / j.total) * 100) : 0;
    const eta = j.status === 'running' && j.speed > 0 && j.total ? fmtEta((j.total - j.done) / j.speed) : '';
    const actions = j.status === 'running' || j.status === 'queued'
      ? `<button class="btn sm ghost" data-job="${j.id}" data-act="cancel">${j.status === 'running' ? 'Pause' : 'Cancel'}</button>`
      : `${j.status !== 'done' ? `<button class="btn sm" data-job="${j.id}" data-act="retry">${j.status === 'cancelled' ? 'Resume' : 'Retry'}</button>` : ''}<button class="btn sm ghost" data-job="${j.id}" data-act="remove">Remove</button>`;
    return `<div class="job ${j.status}">
      <div class="job-top">
        <div><span class="src">${j.source === 'hf' ? 'GGUF' : 'Ollama'}</span><span class="name">${esc(j.label)}</span></div>
        <div class="job-actions">${actions}</div>
      </div>
      <div class="progress"><i style="width:${j.status === 'done' ? 100 : pct}%"></i></div>
      <div class="job-info">
        <span class="msg">${esc(j.message)}</span>
        <span>${j.total ? `${fmtBytes(j.done)} / ${fmtBytes(j.total)} · ${pct.toFixed(0)}%` : ''}${j.status === 'running' && j.speed ? ` · ${fmtBytes(j.speed)}/s` : ''}${eta ? ` · ${eta}` : ''}</span>
      </div>
    </div>`;
  }).join('');
}

function connectEvents() {
  const es = new EventSource('/api/events');
  es.onmessage = e => {
    const prev = new Map(S.jobs.map(j => [j.id, j.status]));
    S.jobs = JSON.parse(e.data);
    renderJobs();
    const finished = S.jobs.some(j => j.status === 'done' && prev.get(j.id) && prev.get(j.id) !== 'done');
    if (finished) { refreshInstalled(); refreshSystem(); }
    else if (S.jobs.some(j => prev.get(j.id) !== j.status)) { renderOllama(); renderHf(); }
  };
  es.onerror = () => { es.close(); setTimeout(connectEvents, 3000); };
}

// ------------------------------------------------------------ installed tab

function renderInstalled() {
  const { ollama, hf } = S.inst;
  $('#cnt-installed').textContent = ollama.length + hf.length || '';
  const ollamaDir = S.system?.ollama.modelsDir || '';
  const hfDir = S.system?.dirs?.huggingface || 'llms/huggingface';
  const uncDir = S.system?.dirs?.uncensored || 'llms/uncensored';
  const ggufTable = list => `<table class="inst-table"><tr><th>Repo</th><th>File</th><th class="r">Size</th></tr>
        ${list.map(f => `<tr><td class="mono">${esc(f.repo)}</td><td class="mono">${esc(f.file)}</td><td class="r">${fmtBytes(f.size)}</td></tr>`).join('')}</table>`;
  const main = hf.filter(f => !f.uncensored), unc = hf.filter(f => f.uncensored);
  $('#inst-list').innerHTML = `
    <section class="inst-group">
      <h3>Ollama models <small>${esc(ollamaDir)}</small></h3>
      ${ollama.length ? `<table class="inst-table"><tr><th>Model</th><th>Params</th><th>Quant</th><th class="r">Size</th></tr>
        ${ollama.map(m => `<tr><td class="mono">${esc(m.name)}</td><td>${esc(m.params || '')}</td><td>${esc(m.quant || '')}</td><td class="r">${fmtBytes(m.size)}</td></tr>`).join('')}</table>`
        : `<div class="empty"><b>No Ollama models</b>${S.system?.ollama.running ? 'Pull something from the library tab.' : 'Ollama is not running.'}</div>`}
    </section>
    <section class="inst-group">
      <h3>GGUF files <small>${esc(hfDir)}</small></h3>
      ${main.length ? ggufTable(main) : `<div class="empty"><b>No GGUF files yet</b>Download from the Hugging Face tab. Files work with llama.cpp, LM Studio, KoboldCpp and Jan.</div>`}
    </section>
    <section class="inst-group">
      <h3>Uncensored GGUF files <small>${esc(uncDir)}</small></h3>
      ${unc.length ? ggufTable(unc) : `<div class="empty"><b>None yet</b>Use “Scan for uncensored models” in the Hugging Face tab.</div>`}
    </section>`;
}

// ------------------------------------------------------------ wiring

function switchTab(name) {
  store.set('tab', name);
  $$('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $$('.panel').forEach(p => p.classList.toggle('active', p.dataset.panel === name));
  if (name === 'hf' && !S.hf.results && !S.hf.loading) hfSearch();
  if (name === 'installed') refreshInstalled();
}

function wire() {
  $('#sel-gpu').onchange = e => { S.hwId = e.target.value; $('#detected').hidden = true; onHwChange(); };
  $('#sel-ram').onchange = e => { S.ram = Number(e.target.value); onHwChange(); };
  $('#in-vram').oninput = e => { S.custom.vram = Number(e.target.value); onHwChange(); };
  $('#in-bw').oninput = e => { S.custom.bw = Number(e.target.value); onHwChange(); };
  $('#chk-offload').onchange = e => { S.offload = e.target.checked; onHwChange(); };
  $('#seg-ctx').onclick = e => { const b = e.target.closest('button'); if (b) { S.ctx = Number(b.dataset.v); onHwChange(); } };
  $('#btn-detect').onclick = () => detect(false);

  // Multi-GPU pool editor
  $('#pool-rows').addEventListener('change', e => {
    if (!e.target.matches('[data-pool-gpu]')) return;
    const i = Number(e.target.closest('.pool-row').dataset.i);
    const id = e.target.value;
    const dup = S.pool.findIndex((p, j) => p.id === id && j !== i);
    if (dup >= 0) { S.pool[dup].n += S.pool[i].n; S.pool.splice(i, 1); } // merge same-model rows
    else S.pool[i].id = id;
    onHwChange();
  });
  $('#pool-rows').addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (!btn || btn.disabled) return;
    const i = Number(btn.closest('.pool-row').dataset.i);
    if (btn.dataset.step) S.pool[i].n = Math.max(1, S.pool[i].n + Number(btn.dataset.step));
    else if (btn.hasAttribute('data-remove')) S.pool.splice(i, 1);
    onHwChange();
  });
  $('#pool-add').onclick = () => {
    const used = new Set(S.pool.map(p => p.id));
    const next = ['rtx3090', 'rtx4090', 'rtx5090', 'rtx3060', 'p40'].find(id => !used.has(id)) || S.pool[S.pool.length - 1].id;
    if (used.has(next)) S.pool.find(p => p.id === next).n++;
    else S.pool.push({ id: next, n: 1 });
    onHwChange();
  };
  $('#pool-link').onchange = e => { S.poolLink = e.target.value; onHwChange(); };
  $('#btn-auto').onclick = autoPull;

  $('.tabs').onclick = e => { const b = e.target.closest('button'); if (b) switchTab(b.dataset.tab); };

  $('#o-q').oninput = e => { S.o.q = e.target.value.trim().toLowerCase(); renderOllama(); };
  $('#o-cats').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    S.o.cat = b.dataset.v;
    $$('#o-cats button').forEach(x => x.classList.toggle('on', x === b));
    renderOllama();
  };
  $('#o-fit').onchange = e => { S.o.fit = e.target.value; renderOllama(); };
  $('#o-sync').onclick = async e => {
    if (!e.target.matches('[data-sync]')) return;
    await api('/api/ollama/library/refresh', { method: 'POST' });
    setTimeout(pollLibrary, 300);
  };
  $$('[data-preset]').forEach(b => { b.onclick = () => applyPreset(b.dataset.preset); });
  $('#o-list').onclick = e => {
    const row = e.target.closest('.vrow');
    if (!row || row.classList.contains('dim')) return;
    toggleOllama(row.dataset.otag);
    renderOllama(); renderSelbar();
  };
  const customPull = async () => {
    const tag = $('#o-custom').value.trim();
    if (!tag) return;
    await queue([{ source: 'ollama', tag, label: tag, size: 0 }]);
    $('#o-custom').value = '';
  };
  $('#o-custom-btn').onclick = customPull;
  $('#o-custom').onkeydown = e => { if (e.key === 'Enter') customPull(); };

  $('#hf-form').onsubmit = e => { e.preventDefault(); S.hf.q = $('#hf-q').value.trim(); hfSearch(); };
  $('#hf-unc').onclick = () => { S.hf.mode = S.hf.mode === 'uncensored' ? 'search' : 'uncensored'; S.hf.q = $('#hf-q').value.trim(); hfSearch(); };
  $('#guide').onclick = async e => {
    const b = e.target.closest('[data-copy]');
    if (!b) return;
    try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy'; }, 1500); }
    catch { toast('Copy failed — select the text instead'); }
  };
  $('#o-banner').onclick = e => { if (e.target.matches('[data-goto]')) switchTab(e.target.dataset.goto); };
  $('#hf-quick').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    S.hf.mode = 'search'; S.hf.q = b.dataset.q; $('#hf-q').value = S.hf.q; hfSearch();
  };
  $('#hf-sort').onchange = e => { S.hf.sort = e.target.value; hfSearch(); };
  $('#hf-target').onchange = e => {
    S.hf.target = e.target.value;
    store.set('hfTarget', S.hf.target);
    for (const k of [...S.sel.keys()]) if (k.startsWith('h:')) toggleHf(k.slice(2), true); // rebuild with new target
    renderHf(); renderSelbar();
  };
  $('#hf-list').addEventListener('change', e => {
    if (!e.target.matches('[data-quant]')) return;
    const repo = e.target.closest('.hfrow').dataset.repo;
    S.hf.choice[repo] = e.target.value;
    if (S.sel.has('h:' + repo)) toggleHf(repo, true);
    renderHf(); renderSelbar();
  });
  $('#hf-list').addEventListener('click', e => {
    if (e.target.closest('a, select')) return;
    const row = e.target.closest('.hfrow');
    if (!row || row.querySelector('input[type=checkbox]').disabled) return;
    if (e.target.matches('input[type=checkbox]')) e.preventDefault();
    toggleHf(row.dataset.repo);
    renderHf(); renderSelbar();
  });
  $('#hf-pick').onclick = () => {
    for (const r of S.hf.results || []) {
      const g = bestQuant(r);
      if (assessHf(r, g).tier !== 'no') { S.hf.choice[r.repo] = g.key; toggleHf(r.repo, true); }
    }
    renderHf(); renderSelbar();
  };

  $('#sel-clear').onclick = () => { S.sel.clear(); renderOllama(); renderHf(); renderSelbar(); };
  $('#sel-go').onclick = downloadSelected;

  $('#jobs-list').onclick = async e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    await api(`/api/jobs/${b.dataset.job}/${b.dataset.act}`, { method: 'POST' });
  };
  $('#jobs-clear').onclick = () => api('/api/jobs/clear', { method: 'POST' });

  $('#status').onclick = async e => {
    if (e.target.id !== 'btn-start-ollama') return;
    e.target.textContent = 'Starting…';
    const r = await api('/api/ollama/start', { method: 'POST' });
    if (!r.ok) toast(r.error);
    await refreshSystem();
    refreshInstalled();
  };
}

async function init() {
  const [hwData, cat] = await Promise.all([fetch('/data/hardware.json').then(r => r.json()), fetch('/data/ollama-catalog.json').then(r => r.json())]);
  S.hwGroups = hwData.groups;
  for (const g of S.hwGroups) for (const i of g.items) {
    S.hwById[i.id] = i;
    S.vendorOf[i.id] = (g.label.match(/NVIDIA|AMD|Intel|Apple/) || ['other'])[0].toLowerCase();
  }
  S.curated = cat.families;
  S.families = withRecommendations(cat.families.map(f => ({ ...f })));
  S.hf.target = store.get('hfTarget', 'file');
  $('#hf-target').value = S.hf.target;

  renderHwSelect();
  const saved = store.get('hw', null);
  if (saved && S.hwById[saved.id]) Object.assign(S, { hwId: saved.id, ram: saved.ram, ctx: saved.ctx, offload: saved.offload, custom: saved.custom || S.custom });
  if (saved?.pool?.length && saved.pool.every(p => S.hwById[p.id])) S.pool = saved.pool;
  if (saved?.poolLink) S.poolLink = saved.poolLink;
  else S.hwId = 'rtx5080';

  wire();
  onHwChange();
  switchTab(store.get('tab', 'guide'));
  renderJobs();
  connectEvents();
  pollLibrary();
  if (!saved) await detect(true); else await refreshSystem();
  refreshInstalled();
  setInterval(refreshSystem, 15000);
}

init();
