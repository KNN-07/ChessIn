import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { prepareSources } from './prepare-sources.mjs';

const root = fileURLToPath(new URL('../apps/web/public/engines/19.0.0/', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
const baseUrl = `https://github.com/nmrugg/stockfish.js/releases/download/v${manifest.version}/`;
const expectedFiles = new Set(Object.values(manifest.profiles).flat());
if (expectedFiles.size !== 8 || Object.keys(manifest.files).length !== expectedFiles.size ||
    [...expectedFiles].some(name => !Object.hasOwn(manifest.files, name) || !/^stockfish-19(?:-lite-single|-lite|-single)?\.(?:js|wasm)$/.test(name))) {
  throw new Error('Pinned Stockfish manifest is incomplete or contains unexpected files');
}

async function valid(path, metadata) {
  try {
    if ((await stat(path)).size !== metadata.bytes) return false;
    const hash = createHash('sha256');
    await pipeline(createReadStream(path), new Writable({ write(chunk, _encoding, callback) { hash.update(chunk); callback(); } }));
    return hash.digest('hex') === metadata.sha256;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

await mkdir(root, { recursive: true });
for (const [name, metadata] of Object.entries(manifest.files)) {
  const destination = join(root, name);
  if (await valid(destination, metadata)) { console.log(`Verified ${name}`); continue; }
  const temp = `${destination}.${process.pid}.tmp`;
  try {
    const response = await fetch(`${baseUrl}${name}`, { redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error(`Download failed for ${name}: HTTP ${response.status}`);
    const hash = createHash('sha256');
    let bytes = 0;
    await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    } }), createWriteStream(temp, { flags: 'wx' }));
    if (bytes !== metadata.bytes || hash.digest('hex') !== metadata.sha256) throw new Error(`Pinned size or SHA-256 mismatch for ${name}`);
    await rename(temp, destination);
    console.log(`Downloaded and verified ${name}`);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
await prepareSources();
