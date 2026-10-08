// Builds Can I Run It? as a single-file executable using Node's Single Executable Applications
// (SEA). The UI (public/) and hardware/catalog data (data/*.json) are embedded as assets, so the
// result runs on a machine with no Node.js installed.
//
//   node scripts/build.js                         build for this OS / CPU
//   node scripts/build.js --target macos-x64 --node path/to/x64/node
//                                                 cross-inject into another Node binary of the
//                                                 SAME version (the blob has no code cache, so it
//                                                 is portable between platforms)
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const args = process.argv.slice(2);
const arg = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };

const osName = { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform] || process.platform;
const target = arg('--target') || `${osName}-${process.arch}`;
const nodeBin = path.resolve(arg('--node') || process.execPath);
const isWin = target.startsWith('windows');
const isMac = target.startsWith('macos');
const out = path.join(DIST, `can-i-run-it-${target}${isWin ? '.exe' : ''}`);

const run = (cmd, argv) => execFileSync(cmd, argv, { stdio: 'inherit' });

// npx without a shell: call npm's own npx-cli.js with this Node (avoids .cmd quoting issues on Windows).
function npx(argv) {
  const prefix = path.dirname(process.execPath);
  const candidates = [
    path.join(prefix, 'node_modules', 'npm', 'bin', 'npx-cli.js'),             // Windows
    path.join(prefix, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'), // Linux / macOS
  ];
  const cli = candidates.find(p => fs.existsSync(p));
  if (!cli) throw new Error('Could not find npm’s npx-cli.js next to ' + process.execPath);
  run(process.execPath, [cli, '--yes', ...argv]);
}

fs.mkdirSync(DIST, { recursive: true });

// 1. Embed the UI and data files. Keys match what server.js asks sea.getAsset() for.
const assets = {};
const add = rel => { assets[rel.split(path.sep).join('/')] = path.join(ROOT, rel); };
for (const f of fs.readdirSync(path.join(ROOT, 'public'))) add(path.join('public', f));
for (const f of ['hardware.json', 'ollama-catalog.json']) add(path.join('data', f));

const blob = path.join(DIST, 'sea-prep.blob');
const configPath = path.join(DIST, 'sea-config.json');
fs.writeFileSync(configPath, JSON.stringify({
  main: path.join(ROOT, 'server.js'),
  output: blob,
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  assets,
}, null, 2));

// 2. Generate the blob with this Node (must be the same version as the target binary).
const targetVersion = execFileSync(nodeBin, ['--version']).toString().trim();
if (targetVersion !== process.version) throw new Error(`Target Node is ${targetVersion} but this Node is ${process.version}; they must match.`);
run(process.execPath, ['--experimental-sea-config', configPath]);

// 3. Copy the Node binary and inject the blob.
fs.copyFileSync(nodeBin, out);
fs.chmodSync(out, 0o755);
if (isMac) run('codesign', ['--remove-signature', out]);
npx(['postject@1.0.0-alpha.6', out, 'NODE_SEA_BLOB', blob,
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(isMac ? ['--macho-segment-name', 'NODE_SEA'] : [])]);
if (isMac) run('codesign', ['--sign', '-', out]); // ad-hoc signature so Apple Silicon will run it

fs.rmSync(blob, { force: true });
console.log(`\nBuilt ${path.relative(ROOT, out)} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB) for ${target} with Node ${process.version}`);
