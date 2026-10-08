'use strict';
// Setup advisor: turns a GPU (detected or picked from the list) into concrete advice — which
// runtimes work, which build to download, driver requirements, and caveats for older cards.
// Rules are deliberately data-like so they are easy to update as vendors change support.

const Advisor = (() => {
  // First match wins, so specific patterns come before general ones.
  const ARCH = [
    // ---- NVIDIA (cc = CUDA compute capability)
    { re: /DGX Spark|GB10/i, vendor: 'nvidia', arch: 'Blackwell (GB10)', cc: 12.1 },
    { re: /\bB[12]00\b|GB200/i, vendor: 'nvidia', arch: 'Blackwell (data centre)', cc: 10.0 },
    { re: /RTX 50\d0|RTX PRO \d+ Blackwell|Blackwell/i, vendor: 'nvidia', arch: 'Blackwell', cc: 12.0 },
    { re: /H100|H200|GH200/i, vendor: 'nvidia', arch: 'Hopper', cc: 9.0 },
    { re: /RTX 40\d0|RTX \d000 Ada|L40S?\b|\bL4\b/i, vendor: 'nvidia', arch: 'Ada Lovelace', cc: 8.9 },
    { re: /A100|\bA30\b/i, vendor: 'nvidia', arch: 'Ampere (data centre)', cc: 8.0 },
    { re: /RTX 30\d0|RTX A\d000|\bA40\b|\bA10G?\b/i, vendor: 'nvidia', arch: 'Ampere', cc: 8.6 },
    { re: /RTX 20\d0|Titan RTX|GTX 16\d0|Quadro RTX|\bT4\b/i, vendor: 'nvidia', arch: 'Turing', cc: 7.5 },
    { re: /V100|Titan V\b/i, vendor: 'nvidia', arch: 'Volta', cc: 7.0 },
    { re: /P100/i, vendor: 'nvidia', arch: 'Pascal (GP100)', cc: 6.0 },
    { re: /GTX 10\d0|Titan Xp|Titan X \(Pascal\)|\bP40\b|\bP4\b|P[56]000|Quadro P/i, vendor: 'nvidia', arch: 'Pascal', cc: 6.1 },
    { re: /GTX 750|GTX 745/i, vendor: 'nvidia', arch: 'Maxwell', cc: 5.0 },
    { re: /GTX 9\d0|\bM40\b|\bM60\b|Titan X\b|Quadro M/i, vendor: 'nvidia', arch: 'Maxwell', cc: 5.2 },
    { re: /K80/i, vendor: 'nvidia', arch: 'Kepler', cc: 3.7 },
    { re: /GTX (6|7)\d0|GTX Titan\b|\bK[1-4]0\b|Quadro K/i, vendor: 'nvidia', arch: 'Kepler', cc: 3.5 },
    // ---- AMD (gfx = ROCm target)
    { re: /RX 906\d/i, vendor: 'amd', arch: 'RDNA 4', gfx: 'gfx1200' },
    { re: /R9700|RX 907\d/i, vendor: 'amd', arch: 'RDNA 4', gfx: 'gfx1201' },
    { re: /Ryzen AI Max|Strix Halo|8060S/i, vendor: 'amd', arch: 'RDNA 3.5 (Strix Halo)', gfx: 'gfx1151' },
    { re: /RX 79\d0|W79\d0|W78\d0/i, vendor: 'amd', arch: 'RDNA 3', gfx: 'gfx1100' },
    { re: /RX 7[78]\d0/i, vendor: 'amd', arch: 'RDNA 3', gfx: 'gfx1101' },
    { re: /RX 76\d0/i, vendor: 'amd', arch: 'RDNA 3', gfx: 'gfx1102' },
    { re: /RX 6[89]\d0|W6800/i, vendor: 'amd', arch: 'RDNA 2', gfx: 'gfx1030' },
    { re: /RX 67\d0/i, vendor: 'amd', arch: 'RDNA 2', gfx: 'gfx1031' },
    { re: /RX 66\d0/i, vendor: 'amd', arch: 'RDNA 2', gfx: 'gfx1032' },
    { re: /RX 5[67]\d0/i, vendor: 'amd', arch: 'RDNA 1', gfx: 'gfx1010' },
    { re: /MI3\d\d/i, vendor: 'amd', arch: 'CDNA 3', gfx: 'gfx942' },
    { re: /MI2\d0/i, vendor: 'amd', arch: 'CDNA 2', gfx: 'gfx90a' },
    { re: /MI100/i, vendor: 'amd', arch: 'CDNA 1', gfx: 'gfx908' },
    { re: /MI50|MI60|Radeon VII|Vega 20/i, vendor: 'amd', arch: 'Vega 20 (GCN 5)', gfx: 'gfx906' },
    { re: /Vega (56|64)/i, vendor: 'amd', arch: 'Vega (GCN 5)', gfx: 'gfx900' },
    { re: /RX ?[45][5-9]0|Polaris/i, vendor: 'amd', arch: 'Polaris (GCN 4)', gfx: 'gfx803' },
    // ---- Intel
    { re: /Arc B\d{3}|Battlemage/i, vendor: 'intel', arch: 'Xe2 (Battlemage)' },
    { re: /Arc A\d{3}|Alchemist/i, vendor: 'intel', arch: 'Xe-HPG (Alchemist)' },
    { re: /Arc|Iris Xe|Intel/i, vendor: 'intel', arch: 'Intel Xe (integrated)' },
    // ---- Apple
    { re: /(?:^|Apple )M(\d+)\b/i, vendor: 'apple', arch: 'Apple silicon' },
  ];

  const LEVEL = { best: 'Recommended', ok: 'Works', limited: 'Limited', no: 'Not supported' };

  function archOf(name, detected) {
    const rule = ARCH.find(r => r.re.test(name || ''));
    const a = rule ? { vendor: rule.vendor, arch: rule.arch, cc: rule.cc, gfx: rule.gfx } : { vendor: 'other', arch: 'Unknown' };
    if (a.vendor === 'apple') {
      const m = name.match(/M(\d+)\s*(Pro|Max|Ultra)?/i);
      a.gen = Number(m[1]);
      a.arch = `Apple M${m[1]}${m[2] ? ' ' + m[2] : ''}`;
    }
    if (detected?.cc) a.cc = Number(detected.cc); // nvidia-smi knows better than a name match
    if (detected?.gfx) a.gfx = detected.gfx;
    return a;
  }

  // How much of the theoretical memory bandwidth token generation typically reaches.
  function efficiency(a) {
    if (a.vendor === 'nvidia') return a.cc < 5 ? 0.35 : a.cc < 6 ? 0.45 : a.cc < 7 ? 0.5 : a.cc < 7.5 ? 0.6 : 0.65;
    if (a.vendor === 'amd') return /RDNA [34]|CDNA [23]/.test(a.arch) ? 0.55 : /RDNA 2|CDNA 1/.test(a.arch) ? 0.5 : 0.45;
    if (a.vendor === 'intel') return 0.45;
    return 0.65;
  }

  // ------------------------------------------------------------------ engines per vendor

  function nvidiaEngines(a, ctx) {
    const cc = a.cc ?? 0;
    const cuda13 = cc >= 7.5;
    const cudaMax = ctx.det?.cudaMax ? parseFloat(ctx.det.cudaMax) : null;
    const build = cc < 5 ? 'Vulkan build' : cuda13 && (cudaMax == null || cudaMax >= 13) ? 'CUDA 13.x build' : 'CUDA 12.4 build';
    const linuxOnly = ctx.os === 'win32' ? ' (on Windows: WSL2 or Docker)' : ctx.os === 'darwin' ? '' : '';
    return [
      { name: 'Ollama', level: cc >= 5 ? 'best' : 'no',
        note: cc >= 5 ? (cuda13 ? 'Uses its CUDA backend automatically.' : 'Uses its bundled CUDA 12 runtime — CUDA 13 dropped Maxwell, Pascal and Volta.')
          + (cc >= 12 ? ' Blackwell needs a 2025-or-newer Ollama release.' : '')
          : 'Ollama needs compute capability 5.0+. This card is too old — use llama.cpp’s Vulkan build or CPU.' },
      { name: 'llama.cpp', level: cc < 5 ? 'best' : 'ok', build,
        note: cc < 5 ? 'Current CUDA no longer supports Kepler; the Vulkan build still runs on it (needs the 470 legacy driver).'
          : cc < 7.5 ? 'Pick the CUDA 12.x build. CUDA 13 builds will not see this GPU.'
            : 'Most control: split modes, flash attention, speculative decoding.' },
      { name: 'LM Studio', level: cc >= 5 ? 'ok' : 'limited', note: cc >= 5 ? 'GUI app; downloads the right CUDA runtime itself.' : 'Select its Vulkan runtime; CUDA runtimes will not load.' },
      { name: 'vLLM', level: cc >= 8 ? 'ok' : cc >= 7 ? 'limited' : 'no',
        note: cc >= 7 ? `High-throughput server for many users${linuxOnly}.${cc < 8 ? ' Volta/Turing: no BF16 or FlashAttention-2, use FP16 models.' : ''}${cc >= 12 ? ' Blackwell needs CUDA 12.8+ wheels.' : ''}` : 'Needs compute capability 7.0+.' },
      { name: 'ExLlamaV2 / V3', level: cc >= 8 ? 'ok' : cc >= 7.5 ? 'limited' : 'no',
        note: cc >= 8 ? 'Fastest single-user GPU inference with EXL2/EXL3 quants (via TabbyAPI or text-generation-webui).' : cc >= 7.5 ? 'Runs, but without the Ampere+ kernels it is slower.' : 'Needs Turing or newer.' },
    ];
  }

  function amdEngines(a, ctx) {
    const g = a.gfx || '';
    const win = ctx.os === 'win32';
    const rocmGood = /gfx120[01]|gfx110[0-2]|gfx1151|gfx1030|gfx90[8a]|gfx942/.test(g);
    const overrideable = /gfx103[12]/.test(g);
    const ollamaWin = /gfx120[01]|gfx110[0-2]|gfx1030|gfx1151/.test(g);
    let ollama;
    if (win) ollama = ollamaWin ? { level: 'best', note: 'Uses its bundled ROCm/HIP runtime on Windows.' }
      : { level: 'limited', note: 'Not on Ollama’s Windows ROCm list — it falls back to CPU unless your Ollama has the Vulkan backend (OLLAMA_VULKAN=1).' };
    else ollama = rocmGood ? { level: 'best', note: 'The Linux installer sets up ROCm for you.' }
      : overrideable ? { level: 'ok', note: 'Set HSA_OVERRIDE_GFX_VERSION=10.3.0 so ROCm treats it as a supported RDNA 2 card.' }
        : g === 'gfx906' ? { level: 'limited', note: 'gfx906 is end-of-life in ROCm; older Ollama builds work, newer ones may not. Vulkan llama.cpp is the safe bet.' }
          : { level: 'limited', note: 'ROCm no longer supports this GPU; Ollama will use CPU unless its Vulkan backend is enabled.' };
    const vulkanBest = !rocmGood || win || g === 'gfx1151';
    return [
      { name: 'Ollama', ...ollama },
      { name: 'llama.cpp', level: vulkanBest ? 'best' : 'ok', build: vulkanBest ? 'Vulkan build' : `ROCm/HIP build (${g || 'gfx…'})`,
        note: vulkanBest ? 'Vulkan works on every Radeon with a current driver and is often as fast as ROCm.' : 'HIP build for best prompt speed; the Vulkan build is a no-hassle alternative.' },
      { name: 'LM Studio', level: 'ok', note: 'Ships Vulkan and ROCm runtimes; pick Vulkan if ROCm fails.' },
      { name: 'vLLM', level: !win && /gfx110[0-2]|gfx120[01]|gfx90a|gfx942/.test(g) ? 'limited' : 'no', note: 'ROCm build on Linux only; best on Instinct / RX 7900 / RX 9070.' },
      { name: 'ExLlamaV2 / V3', level: 'no', note: 'NVIDIA-focused; use llama.cpp instead.' },
    ];
  }

  function intelEngines(a, ctx) {
    const integrated = /integrated/.test(a.arch);
    return [
      { name: 'Ollama', level: 'limited', note: 'Official builds don’t accelerate Intel GPUs. Use the IPEX-LLM “Ollama portable” zip, or OLLAMA_VULKAN=1 on recent Ollama builds.' },
      { name: 'llama.cpp', level: 'best', build: 'SYCL build (or Vulkan)', note: 'SYCL (oneAPI) is fastest on Arc; Vulkan is simpler to set up.' },
      { name: 'LM Studio', level: 'ok', note: 'Uses its Vulkan runtime on Intel.' },
      { name: 'vLLM', level: integrated ? 'no' : 'limited', note: 'XPU backend on Linux only.' },
      { name: 'OpenVINO', level: 'ok', note: 'Intel’s own runtime (openvino-genai) — good on Arc and Core Ultra NPUs.' },
    ];
  }

  function appleEngines(a) {
    return [
      { name: 'Ollama', level: 'best', note: 'Metal acceleration out of the box.' },
      { name: 'MLX', level: 'best', build: 'mlx-lm', note: `Apple’s own framework — usually the fastest on Mac.${a.gen >= 5 ? ' M5/M6 GPU Neural Accelerators speed up prompt processing with recent MLX.' : ''}` },
      { name: 'LM Studio', level: 'best', note: 'Runs both GGUF (llama.cpp) and MLX models.' },
      { name: 'llama.cpp', level: 'ok', build: 'Metal (brew install llama.cpp)', note: 'GGUF with Metal.' },
      { name: 'vLLM', level: 'no', note: 'CUDA/ROCm only — use MLX or Ollama.' },
    ];
  }

  function cpuEngines(ctx) {
    const noAvx2 = ctx.cpu?.flags && !ctx.cpu.flags.includes('avx2') && ctx.cpu.arch === 'x64';
    return [
      { name: 'Ollama', level: 'ok', note: 'Runs on CPU automatically.' },
      { name: 'llama.cpp', level: 'best', build: 'CPU build', note: 'Picks AVX2 / AVX-512 / AMX kernels for your CPU at runtime.' },
      { name: 'LM Studio', level: noAvx2 ? 'no' : 'ok', note: noAvx2 ? 'Needs AVX2.' : 'GUI app with a CPU runtime.' },
      { name: 'vLLM', level: 'no', note: 'GPU-oriented; use llama.cpp.' },
    ];
  }

  // ------------------------------------------------------------------ features + driver checks

  function features(a) {
    if (a.vendor === 'nvidia') {
      const cc = a.cc ?? 0;
      return [
        ['Tensor cores', cc >= 7], ['DP4A int8 (llama.cpp quant kernels)', cc >= 6.1], ['BF16', cc >= 8],
        ['FlashAttention-2 (vLLM / ExLlama)', cc >= 8], ['FP8', cc >= 8.9], ['FP4 (NVFP4 / MXFP4 native)', cc >= 10],
      ];
    }
    if (a.vendor === 'amd') {
      const r = a.arch;
      return [['Matrix cores (WMMA)', /RDNA [34]|RDNA 3\.5|CDNA/.test(r)], ['BF16', /RDNA [34]|RDNA 3\.5|CDNA [23]/.test(r)], ['FP8', /RDNA 4|CDNA 3/.test(r)], ['ROCm support', !!a.gfx && !/gfx803|gfx900|gfx1010/.test(a.gfx)]];
    }
    if (a.vendor === 'intel') return [['XMX matrix engines', !/integrated/.test(a.arch)], ['BF16', true], ['FP8', false]];
    if (a.vendor === 'apple') return [['Metal', true], ['BF16', a.gen >= 2], ['GPU Neural Accelerators', a.gen >= 5], ['Unified memory', true]];
    return [];
  }

  function driverChecks(a, det, os) {
    const out = [];
    if (a.vendor !== 'nvidia' || !det?.driver) return out;
    const major = parseInt(det.driver, 10);
    const cc = a.cc ?? 0;
    if (cc < 5) out.push(['warn', `Installed driver: ${det.driver}. Kepler needs the 470 legacy branch.`]);
    else if (cc < 7.5) {
      out.push([major >= 551 ? 'ok' : 'bad', `Driver ${det.driver}: ${major >= 551 ? 'new enough for CUDA 12.4 builds' : 'too old for CUDA 12.4 builds — install 551 or newer'}.`]);
      if (major > 580) out.push(['warn', `Driver ${det.driver} is newer than the 580 branch — make sure it still lists ${a.arch} cards; otherwise go back to 580.xx.`]);
    } else {
      if (cc >= 12 && major < 570) out.push(['bad', `Blackwell needs driver 570 or newer (you have ${det.driver}).`]);
      else if (major >= 580) out.push(['ok', `Driver ${det.driver} supports CUDA ${det.cudaMax || '13'}.`]);
      else if (major >= 551) out.push(['warn', `Driver ${det.driver} supports CUDA ${det.cudaMax || '12.x'}. Update to 580+ to use CUDA 13 builds.`]);
      else out.push(['bad', `Driver ${det.driver} is too old for current builds — install 580 or newer.`]);
    }
    return out;
  }

  // Caveats that depend on the GPU itself, whether or not it is in this PC.
  function legacyChecks(g) {
    const out = [];
    if (g.vendor === 'nvidia') {
      const cc = g.cc ?? 0;
      if (cc < 5) out.push(['bad', `${g.arch} (compute ${cc.toFixed(1)}) has no support in current CUDA, Ollama or PyTorch. Use llama.cpp’s Vulkan build with the 470 legacy driver, or run on CPU.`]);
      else if (cc < 7.5) out.push(['warn', `${g.arch} is a legacy architecture: CUDA 13 dropped Maxwell, Pascal and Volta, so use CUDA 12.x builds (llama.cpp, PyTorch). NVIDIA’s 580 driver branch is the last to support it.`]);
      if (/P40|P4\b|P100|GTX 10|Titan X/i.test(g.name)) out.push(['info', 'Pascal has slow FP16 (P40/P4/GTX 10 especially). llama.cpp uses FP32 / int8 paths automatically. Avoid FP16 / BF16 / AWQ / GPTQ models and stick to GGUF K-quants.']);
    }
    if (g.vendor === 'amd' && /gfx803|gfx900|gfx1010/.test(g.gfx || '')) out.push(['warn', `${g.arch} is not supported by ROCm any more. Use llama.cpp’s Vulkan build (or LM Studio on Vulkan).`]);
    if (g.vendor === 'amd' && g.gfx === 'gfx906') out.push(['warn', 'gfx906 (MI50 / Radeon VII) is end-of-life in ROCm. Vulkan llama.cpp works well and is the safest route.']);
    if (g.vendor === 'apple' && g.gen === 1) out.push(['info', 'M1 has no hardware BF16. Use GGUF Q4/Q5 or MLX 4-bit models.']);
    return out;
  }

  // ------------------------------------------------------------------ setup steps

  function steps(a, ctx, engines) {
    const { os, tools, llmsDir, pool } = ctx;
    const win = os === 'win32', mac = os === 'darwin';
    const s = [];
    const gguf = (llmsDir || 'llms') + (win ? '\\huggingface\\<repo>\\<model>.gguf' : '/huggingface/<repo>/<model>.gguf');
    const llama = engines.find(e => e.name === 'llama.cpp');
    const ollama = engines.find(e => e.name === 'Ollama');

    if (ollama && ollama.level !== 'no') {
      if (tools?.ollama) s.push({ title: `Ollama ${tools.ollama} is installed`, done: true });
      else s.push({ title: 'Install Ollama', cmd: win ? 'winget install --id Ollama.Ollama' : mac ? 'brew install ollama' : 'curl -fsSL https://ollama.com/install.sh | sh', text: 'Or download it from https://ollama.com/download' });
      if (a.vendor === 'amd' && /gfx103[12]/.test(a.gfx || '') && !win) s.push({ title: 'Make ROCm accept this card', cmd: 'sudo systemctl edit ollama   # add: Environment="HSA_OVERRIDE_GFX_VERSION=10.3.0"' });
    }

    if (a.vendor === 'apple') {
      s.push({ title: 'Install MLX for the fastest Mac inference', cmd: 'pip install -U mlx-lm\nmlx_lm.chat --model mlx-community/Qwen3-8B-4bit' });
      s.push({ title: 'Let the GPU use more unified memory (optional, resets on reboot)', cmd: `sudo sysctl iogpu.wired_limit_mb=${Math.round((ctx.ramGB || 32) * 1024 * 0.8)}`, text: 'macOS normally caps GPU memory at about two-thirds to three-quarters of RAM.' });
    }

    if (llama) {
      if (tools?.llamacpp) s.push({ title: `llama.cpp build ${tools.llamacpp} is installed`, done: true });
      else if (mac) s.push({ title: 'Install llama.cpp', cmd: 'brew install llama.cpp' });
      else if (win) {
        const asset = /SYCL/.test(llama.build) ? 'win-sycl-x64' : /Vulkan/.test(llama.build) ? 'win-vulkan-x64' : /HIP/.test(llama.build) ? 'win-hip-radeon-x64' : /CUDA 13/.test(llama.build) ? 'win-cuda-13.x-x64' : /CUDA 12/.test(llama.build) ? 'win-cuda-12.4-x64' : 'win-cpu-x64';
        s.push({ title: `Get llama.cpp — ${llama.build}`, text: `From https://github.com/ggml-org/llama.cpp/releases, download llama-bXXXX-bin-${asset}.zip${/cuda/.test(asset) ? ` plus the matching cudart-llama-bin-${asset}.zip` : ''} and unzip both into one folder.` });
      } else {
        const flag = /SYCL/.test(llama.build) ? '-DGGML_SYCL=ON' : /Vulkan/.test(llama.build) ? '-DGGML_VULKAN=ON' : /HIP/.test(llama.build) ? `-DGGML_HIP=ON -DAMDGPU_TARGETS=${a.gfx || 'gfx1100'}` : /CUDA/.test(llama.build) ? '-DGGML_CUDA=ON' : '';
        s.push({ title: `Build llama.cpp — ${llama.build}`, cmd: `git clone https://github.com/ggml-org/llama.cpp && cd llama.cpp\ncmake -B build ${flag}\ncmake --build build --config Release -j` });
      }
      const ngl = a.vendor === 'other' ? '' : ' -ngl 99';
      s.push({ title: 'Serve a downloaded GGUF (OpenAI-compatible API on port 8080)', cmd: `llama-server -m "${gguf}"${ngl} -c 8192 -fa on --port 8080` });
    }

    if (pool && pool.cards > 1) {
      if (pool.link === 'network') {
        s.push({ title: 'Networked cluster: start an RPC worker on each other PC', cmd: 'rpc-server -H 0.0.0.0 -p 50052', text: 'Needs llama.cpp built with -DGGML_RPC=ON. Only use this on a trusted network.' });
        s.push({ title: 'On the main PC, spread the model over the workers', cmd: `llama-server -m "${gguf}" -ngl 99 --rpc 192.168.1.11:50052,192.168.1.12:50052` });
      } else {
        s.push({ title: 'Multi-GPU in one PC', text: 'Ollama splits large models across all GPUs automatically (set OLLAMA_SCHED_SPREAD=1 to always spread them). In llama.cpp, control the split yourself:', cmd: `llama-server -m "${gguf}" -ngl 99 --split-mode layer --tensor-split ${pool.split}` });
        if (pool.identical && engines.some(e => e.name === 'vLLM' && e.level !== 'no')) s.push({ title: 'Identical GPUs: tensor parallel with vLLM (Linux)', cmd: `vllm serve Qwen/Qwen3-32B-AWQ --tensor-parallel-size ${pool.tp}` });
      }
    }
    return s;
  }

  // ------------------------------------------------------------------ main entry

  // ctx: { hw, system, ramGB, poolLink }
  function advise(ctx) {
    const sys = ctx.system || {};
    const hw = ctx.hw;
    let os = sys.platform || (navigator.platform.startsWith('Win') ? 'win32' : navigator.platform.startsWith('Mac') ? 'darwin' : 'linux');
    // Hardware that only exists on one OS overrides the OS of the PC running this app.
    if (/^M\d/.test(hw.name || '') && hw.kind === 'unified') os = 'darwin';
    if (/DGX Spark/i.test(hw.name || '')) os = 'linux';
    const cards = hw.kind === 'cpu' ? [] : hw.cards || [hw];
    const detGpus = sys.gpus || [];
    // Link each card to a detected GPU of the same model, if this PC has one.
    const findDet = name => detGpus.find(g => (g.name || '').toLowerCase().includes(String(name).toLowerCase().replace(/\s*·.*$|\s*\d+gb$/i, '').replace(' laptop', '')));
    const uniq = [...new Map(cards.map(c => [c.name, c])).values()];
    const gpus = uniq.map(c => {
      const det = c.custom ? detGpus[0] : findDet(c.name);
      return { name: c.custom ? (det?.name || 'Custom GPU') : c.name, det, ...archOf(c.custom ? det?.name || '' : c.name, det) };
    });

    // Installed tools and paths only apply when the advice is for this PC's own hardware.
    const thisPc = gpus.length ? gpus.some(g => g.det) : !detGpus.length;
    const base = { os, cpu: thisPc ? sys.cpuInfo : null, tools: thisPc ? sys.tools : null, llmsDir: thisPc ? sys.llmsDir : null, ramGB: hw.kind === 'unified' ? hw.vram : ctx.ramGB };
    let engines, primary;
    if (!gpus.length) {
      primary = { vendor: 'cpu', arch: 'CPU only', name: sys.cpu || 'CPU' };
      engines = cpuEngines(base);
    } else {
      // A pool is only as capable as its oldest card.
      primary = [...gpus].sort((x, y) => (x.cc ?? 99) - (y.cc ?? 99))[0];
      base.det = primary.det;
      engines = primary.vendor === 'nvidia' ? nvidiaEngines(primary, base)
        : primary.vendor === 'amd' ? amdEngines(primary, base)
          : primary.vendor === 'intel' ? intelEngines(primary, base)
            : primary.vendor === 'apple' ? appleEngines(primary)
              : cpuEngines(base);
    }

    const checks = [];
    const vendors = new Set(gpus.map(g => g.vendor));
    if (vendors.size > 1) checks.push(['bad', 'Mixed GPU vendors: Ollama and CUDA/ROCm builds can only use one vendor at a time. llama.cpp’s Vulkan build can use them all together.']);
    for (const g of gpus) checks.push(...legacyChecks(g), ...driverChecks(g, g.det, os));
    if (gpus.length && !gpus.some(g => g.det) && sys.gpus) checks.push(['info', `Showing advice for the selected hardware — this PC has ${detGpus.length ? detGpus.map(g => g.name).join(', ') : 'no detected GPU'}.`]);
    if (os === 'win32' && engines.some(e => e.name === 'vLLM' && e.level !== 'no')) checks.push(['info', 'vLLM, SGLang and most Python serving stacks are Linux-first; on Windows run them in WSL2 or Docker.']);
    if (primary.vendor === 'intel' && !/integrated/.test(primary.arch)) checks.push(['info', 'Arc cards need Resizable BAR enabled in the BIOS for good performance.']);
    if (primary.vendor === 'amd' && /Strix Halo/.test(primary.arch)) checks.push(['info', 'Give the iGPU more memory: “Variable Graphics Memory” in AMD Software on Windows, or the BIOS UMA size / amdgpu.gttsize on Linux.']);
    if (base.cpu?.flags && base.cpu.arch === 'x64' && !base.cpu.flags.includes('avx2')) checks.push(['warn', 'CPU has no AVX2 — CPU offload will be slow and LM Studio will not start.']);
    if (sys.node && parseInt(sys.node, 10) < 20) checks.push(['warn', `Node ${sys.node} is old; this app expects Node 20+.`]);

    const old = primary.vendor === 'cpu' || (primary.vendor === 'nvidia' && (primary.cc ?? 0) < 7) || primary.vendor === 'intel' || /RDNA [12]|GCN|Polaris|Vega/.test(primary.arch || '');
    const usable = engines.filter(e => e.level !== 'no');
    const legacyNv = primary.vendor === 'nvidia' && (primary.cc ?? 0) >= 5 && primary.cc < 7.5;
    const ollamaBest = engines.find(e => e.name === 'Ollama')?.level === 'best';
    const verdict = !gpus.length ? ['warn', 'No GPU: models run on the CPU. Stick to small or MoE models (gpt-oss:20b, qwen3:30b-a3b) and K-quants.']
      : checks.some(c => c[0] === 'bad') ? ['bad', 'Action needed — see the checks below.']
        : ollamaBest && legacyNv ? ['warn', `Works with Ollama, but ${primary.arch} is a legacy GPU: use CUDA 12.x builds and GGUF K-quants; vLLM and ExLlama are out.`]
          : ollamaBest ? ['ok', 'Fully supported. Ollama will use this hardware directly.']
            : ['warn', `Usable, but pick the right engine: ${usable.filter(e => e.level === 'best').map(e => e.name).join(' or ') || usable[0]?.name}.`];

    const poolInfo = hw.cards && hw.cards.length > 1 ? {
      cards: hw.cards.length, link: ctx.poolLink,
      split: hw.cards.map(c => c.vram).join(','),
      identical: new Set(hw.cards.map(c => c.name)).size === 1,
      tp: 2 ** Math.floor(Math.log2(hw.cards.length)),
    } : null;

    return {
      gpus, primary, engines, checks, verdict, os,
      features: gpus.length ? features(primary) : [],
      steps: steps(primary, { ...base, pool: poolInfo }, engines),
      quantPref: old ? 'k' : 'any',
      eff: gpus.length ? efficiency(primary) : 0.65,
      ollamaLevel: engines.find(e => e.name === 'Ollama')?.level,
    };
  }

  // ------------------------------------------------------------------ rendering

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ICON = { ok: '✓', warn: '!', bad: '✕', info: 'i' };
  const linkify = t => esc(t).replace(/https?:\/\/[^\s)]+/g, u => `<a href="${u}" target="_blank" rel="noopener">${u.replace(/^https?:\/\//, '')}</a>`);

  function render(adv, ctx) {
    const sys = ctx.system || {};
    const t = sys.tools || {};
    const gpuLine = g => `<div class="g-gpu"><b>${esc(g.name)}</b><span>${esc(g.arch)}${g.cc ? ` · compute ${g.cc.toFixed(1)}` : ''}${g.gfx ? ` · ${esc(g.gfx)}` : ''}</span>${g.det ? '<em>detected on this PC</em>' : ''}</div>`;
    const machine = sys.os ? `
      <section class="g-card">
        <h3>This machine</h3>
        <dl class="g-dl">
          <dt>OS</dt><dd>${esc(sys.os.name || sys.platform)}${sys.os.wsl ? ' (WSL)' : ''} · ${esc(sys.os.arch)}</dd>
          <dt>CPU</dt><dd>${esc(sys.cpu || '—')}${sys.cpuInfo?.cores ? ` · ${sys.cpuInfo.cores} threads` : ''}${sys.cpuInfo?.flags?.length ? ` · ${esc(sys.cpuInfo.flags.join(', '))}` : ''}</dd>
          <dt>RAM</dt><dd>${sys.ramGB} GB</dd>
          ${(sys.gpus || []).map((g, i) => `<dt>GPU ${sys.gpus.length > 1 ? i + 1 : ''}</dt><dd>${esc(g.name)}${g.vramMiB ? ` · ${Math.round(g.vramMiB / 1024)} GB` : ''}${g.driver ? ` · driver ${esc(g.driver)}` : ''}${g.cudaMax ? ` · CUDA ${esc(g.cudaMax)}` : ''}${g.cc ? ` · cc ${esc(g.cc)}` : ''}</dd>`).join('') || '<dt>GPU</dt><dd>None detected</dd>'}
          <dt>Installed</dt><dd class="g-tools">
            ${[['Ollama', t.ollama], ['llama.cpp', t.llamacpp], ['LM Studio', t.lmstudio], ['Python', t.python], ['Docker', t.docker]]
              .map(([n, v]) => `<span class="${v ? 'on' : ''}">${v ? '✓' : '–'} ${n}${typeof v === 'string' && v !== 'installed' ? ' ' + esc(v) : ''}</span>`).join('')}
          </dd>
        </dl>
      </section>` : '';

    return `
      <section class="g-hero ${adv.verdict[0]}">
        <div class="g-icon">${ICON[adv.verdict[0]]}</div>
        <div>
          <h2>${adv.gpus.length ? adv.gpus.map(g => esc(g.name)).join(' + ') : 'CPU only'}</h2>
          <p>${esc(adv.verdict[1])}</p>
        </div>
      </section>

      ${adv.gpus.length ? `<section class="g-card"><h3>Architecture</h3>${adv.gpus.map(gpuLine).join('')}
        <div class="g-feats">${adv.features.map(([n, ok]) => `<span class="${ok ? 'on' : ''}">${ok ? '✓' : '✕'} ${esc(n)}</span>`).join('')}</div>
        ${adv.quantPref === 'k' ? '<p class="g-tip">Tip: on this hardware prefer K-quants (Q4_K_M, Q5_K_M, Q6_K). I-quants (IQ3/IQ4) need more compute and run slower here — the Hugging Face tab already favours K-quants.</p>' : ''}
      </section>` : ''}

      ${adv.checks.length ? `<section class="g-card"><h3>Checks</h3><ul class="g-checks">${adv.checks.map(([l, txt]) => `<li class="${l}"><i>${ICON[l]}</i><span>${linkify(txt)}</span></li>`).join('')}</ul></section>` : ''}

      <section class="g-card">
        <h3>Which engine to use</h3>
        <div class="g-engines">
          ${adv.engines.map(e => `<div class="g-engine ${e.level}">
            <div class="g-eng-head"><b>${esc(e.name)}</b><span class="g-level">${LEVEL[e.level]}</span></div>
            ${e.build ? `<div class="g-build">${esc(e.build)}</div>` : ''}
            <p>${linkify(e.note)}</p>
          </div>`).join('')}
        </div>
      </section>

      <section class="g-card">
        <h3>Set it up</h3>
        <ol class="g-steps">
          ${adv.steps.map(s => `<li class="${s.done ? 'done' : ''}">
            <b>${esc(s.title)}</b>
            ${s.text ? `<p>${linkify(s.text)}</p>` : ''}
            ${s.cmd ? `<div class="g-cmd"><pre>${esc(s.cmd)}</pre><button class="btn sm ghost" data-copy="${esc(s.cmd)}">Copy</button></div>` : ''}
          </li>`).join('')}
        </ol>
      </section>

      ${machine}`;
  }

  return { advise, render, archOf, efficiency };
})();
