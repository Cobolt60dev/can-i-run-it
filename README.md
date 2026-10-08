# Can I Run It?

**Load it on any machine and it tells you which local AI models will run there. It also tells you which engine and build to use, then downloads the models for you.**

Windows, Linux and macOS. NVIDIA, AMD, Intel Arc, Apple Silicon (M1–M6), CPU-only, and multi-GPU rigs and clusters.

- **Detects your hardware**: GPU, VRAM, compute capability, driver, highest CUDA version, CPU, RAM, OS, and which tools are installed (Ollama, llama.cpp, LM Studio, Python, Docker).
- **Rates every model** as *Full GPU*, *GPU + CPU*, *CPU* or *Too large* for your chosen context length, with an estimated speed in tokens/sec.
- **Setup guide**: which engine fits your GPU and which build to download, driver checks, and copy-paste setup commands:
  - Engines: Ollama, llama.cpp (CUDA 13 / CUDA 12.4 / ROCm / Vulkan / SYCL / Metal / CPU), LM Studio, vLLM, ExLlama, MLX, OpenVINO.
  - Older hardware is handled too: Kepler, Maxwell/Pascal/Volta after CUDA 13, ROCm-dropped AMD cards, and more.
- **Downloads**:
  - The live Ollama library (top 80 families with real sizes).
  - Hugging Face GGUF search, with the best quantization picked for your card.
  - One-click **Auto-pull best models**.
  - Pause and resume. The queue survives restarts.
- **Multi-GPU pool**: combine any cards (e.g. 2× RTX 4090 + RTX 3090), in one PC or across networked PCs.
- **Uncensored scan**: finds uncensored / abliterated / heretic / Dolphin builds that fit. They're kept in their own `uncensored/` folder and never auto-pulled.

## Download

Get the latest standalone build from **[Releases](../../releases/latest)**. Nothing else needs installing: Node.js is built in.

| System | File |
|---|---|
| Windows 10/11 (x64) | `can-i-run-it-windows-x64.zip` |
| Linux x64 | `can-i-run-it-linux-x64.tar.gz` |
| Linux ARM64 (DGX Spark, Jetson, Pi 5…) | `can-i-run-it-linux-arm64.tar.gz` |
| macOS Apple Silicon (M1–M6) | `can-i-run-it-macos-arm64.tar.gz` |
| macOS Intel | `can-i-run-it-macos-x64.tar.gz` |

Unpack it and run it. Your browser opens at http://localhost:5180. Keep the window open while you use the app.

**First run:** the builds aren't code-signed yet, so your OS may warn you.

- **Windows**: SmartScreen → *More info* → *Run anyway*.
- **macOS**: right-click the file → *Open*. Or run `xattr -d com.apple.quarantine can-i-run-it-macos-*`.
- **Linux**: `chmod +x can-i-run-it-linux-*` and then `./can-i-run-it-linux-x64`.

Models download into a `llms/` folder next to the program. Set `LLMS_DIR` to put them on another drive.

## Run from source

Needs Node.js 20+. There are no npm dependencies.

| OS | |
|---|---|
| Windows | double-click `start.bat` |
| macOS | double-click `start.command` |
| Linux / macOS terminal | `sh start.sh` |
| Anywhere | `npm start` or `node server.js --open` |

## Where models go

| What | Folder |
|---|---|
| Hugging Face GGUF | `llms/huggingface/<user>__<repo>/` |
| Uncensored GGUF | `llms/uncensored/<user>__<repo>/` |
| Ollama | `OLLAMA_MODELS`. If Ollama isn't running, the app starts it with `llms/ollama`. |

GGUF files work with llama.cpp, LM Studio, KoboldCpp and Jan.

## Settings (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `5180` | Web UI port |
| `LLMS_DIR` | `./llms` | Where models are downloaded |
| `OLLAMA_MODELS` | Ollama default | Ollama's model store |
| `HF_TOKEN` | — | Needed for gated Hugging Face repos |
| `MAX_PARALLEL` | `2` | Concurrent downloads |
| `OLLAMA_HOST` | `127.0.0.1:11434` | Ollama API address |
| `AUTO_START_OLLAMA` | `1` | `0` = never start Ollama automatically |
| `OLLAMA_LIBRARY_SIZE` | `80` | How many ollama.com families to sync |

Flags: `--open` opens the browser (packaged builds do this by default), and `--no-open` stops it.

## Build the standalone executables

```
npm run build                      # single-file executable for this OS → dist/
```

Pushing a `v*` tag runs `.github/workflows/release.yml`. It builds Windows x64, Linux x64/ARM64 and macOS ARM64/x64 on GitHub's runners, smoke-tests each one, and publishes them to a Release. The builds use [Node.js Single Executable Applications](https://nodejs.org/api/single-executable-applications.html), with the UI embedded.

## Project layout

```
server.js                 Node server: detection, ollama.com sync, HF search/scan, download queue
public/advisor.js         GPU architecture rules → engines, builds, drivers, setup steps
public/app.js             UI: fit/speed model, multi-GPU pool, model picks
data/hardware.json        ~140 GPUs / Macs with VRAM + bandwidth (PRs welcome)
data/ollama-catalog.json  curated Ollama notes
scripts/build.js          single-file executable builder
```

## How the estimates work

- **Fit** = weights + KV cache for the chosen context (about √size × 0.35 GB per 8K tokens) + 0.4 GB. That's compared with VRAM minus 0.8 GB for the display card (0.5 GB for each other card).
- **Speed** = memory bandwidth × an efficiency factor for the GPU generation, plus a small per-token cost for each extra GPU.
- **Multi-GPU**: a model stays on one card if it fits. Otherwise it's split by layers, and the cards' speeds combine.

These are estimates: real numbers depend on the engine, the drivers and the workload. Engine support changes over time, and the rules are kept in `public/advisor.js` so they're easy to update.

## Credits

Made by **Paul Bardell - Cobolt60 Studios**, 2026. Licensed under the [Apache License 2.0](LICENSE).
