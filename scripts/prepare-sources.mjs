import { mkdir, rename, rm, stat, copyFile, writeFile, readFile, readdir } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const destination = path.join(root, 'apps/web/public/sources');
const sources = [
  ['stockfish-js-v19.0.0.tar.gz', 'https://codeload.github.com/nmrugg/stockfish.js/tar.gz/refs/tags/v19.0.0'],
  ['Stockfish-sf_19.tar.gz', 'https://codeload.github.com/official-stockfish/Stockfish/tar.gz/refs/tags/sf_19'],
  ['nn-1a298aa575a0.nnue', 'https://tests.stockfishchess.org/api/nn/nn-1a298aa575a0.nnue', '1a298aa575a0'],
  ['nn-61e7af4bb97d.nnue', 'https://tests.stockfishchess.org/api/nn/nn-61e7af4bb97d.nnue', '61e7af4bb97d'],
  ['Stockfish-AUTHORS.txt', 'https://raw.githubusercontent.com/nmrugg/stockfish.js/v19.0.0/AUTHORS'],
];
async function hashFile(file) { const hash = createHash('sha256'); for await(const bytes of createReadStream(file)) hash.update(bytes); return hash.digest('hex'); }
export async function prepareSources() {
  await mkdir(destination, { recursive: true });
  for (const [name, url, prefix] of sources) {
    const file = path.join(destination, name);
    if (await stat(file).then(s => s.size > 0).catch(() => false)) {
      if (!prefix || (await hashFile(file)).startsWith(prefix)) { console.log(`Source present: ${name}`); continue; }
    }
    const temp = `${file}.partial`;
    try {
      console.log(`Downloading corresponding source: ${name}`);
      const response = await fetch(url, { signal: AbortSignal.timeout(300000) });
      if (!response.ok || !response.body) throw new Error(`Source download failed: ${response.status} ${name}`);
      const hash = createHash('sha256');
      await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, encoding, callback) { hash.update(chunk); callback(null, chunk); } }), createWriteStream(temp));
      const digest = hash.digest('hex');
      if (prefix && !digest.startsWith(prefix)) throw new Error(`Network SHA-256 does not match upstream content name: ${name}`);
      await rename(temp, file);
    } finally { await rm(temp, { force: true }); }
  }
  await copyFile(path.join(root, 'LICENSE'), path.join(root, 'apps/web/public/LICENSE'));
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  const notices = ['ChessIn third-party dependency license notices\n'];
  for (const [directory, metadata] of Object.entries(lock.packages)) {
    if (!directory.startsWith('node_modules/') || metadata.link) continue;
    const packageRoot = path.join(root, directory);
    const entries = await readdir(packageRoot, { withFileTypes: true }).catch(() => []);
    const licenses = entries.filter(entry => entry.isFile() && /^(license|copying|notice)([.-]|$)/i.test(entry.name));
    if (!licenses.length) continue;
    notices.push(`\n=== ${directory.slice(13)} ${metadata.version} (${metadata.license || 'see below'}) ===\n`);
    for (const entry of licenses) notices.push(await readFile(path.join(packageRoot, entry.name), 'utf8'));
  }
  await writeFile(path.join(root, 'apps/web/public/THIRD-PARTY-NOTICES.txt'), notices.join('\n'));
  await writeFile(path.join(destination, 'README.txt'), `ChessIn corresponding engine source distribution\n\nChessIn is licensed under GNU GPL version 3. See /LICENSE.\nStockfish.js copyright 2026 Chess.com, LLC; WebAssembly port by Nathan Rugg.\nStockfish copyright 2004-2026 the Stockfish developers. Full author list: Stockfish-AUTHORS.txt.\nEngine source archives here are the upstream v19.0.0 and sf_19 tags, unmodified.\n\nBrowser build: extract stockfish-js-v19.0.0.tar.gz, install Emscripten 3.1.7 and Node.js, install the archive's npm dependencies, copy both distributed nn-*.nnue files into src/, then run node build.js --all. See the archive README.md, build.js --help, and src/Makefile for platform/toolchain details. The source archive includes JS bindings, C++ engine, build scripts and patches.\n\nNative build: extract Stockfish-sf_19.tar.gz, copy nn-1a298aa575a0.nnue into src/, then use GNU make and a C++ compiler: make -C src -j2 build ARCH=x86-64 (or ARCH=armv8 on ARM64). See src/Makefile and README.md in the archive. The native container also preserves /opt/stockfish including the release's source and license.\n\nThese network files are the actual build inputs; their SHA-256 prefixes are prescribed by upstream evaluate.h. They are served locally, not fetched by the browser at runtime. Sources are not automatically cached on phones.\n`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepareSources();
