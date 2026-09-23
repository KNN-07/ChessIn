/// <reference lib="webworker" />
import { precacheAndRoute, createHandlerBoundToURL } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { assetBase, assetMetadata, cacheMarker, engineCacheName, profiles, type EngineProfile } from './engine/engine-assets';

const sw = self as unknown as ServiceWorkerGlobalScope;
// @ts-ignore Workbox replaces this exact global expression at build time.
precacheAndRoute(self.__WB_MANIFEST);
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html'), { denylist: [/^\/engines\//, /^\/v1\//, /^\/healthz$/] }));

const pending = new Map<EngineProfile, AbortController>();
const validProfile = (name: unknown): name is EngineProfile => typeof name === 'string' && Object.hasOwn(profiles, name);

async function installed(profile: EngineProfile, cache: Cache): Promise<boolean> {
  if (!await cache.match(cacheMarker(profile))) return false;
  for (const file of profiles[profile]) {
    const response = await cache.match(assetBase + file);
    if (!response || response.headers.get('X-ChessIn-Verified-SHA256') !== assetMetadata[file].sha256 ||
      response.headers.get('X-ChessIn-Verified-Bytes') !== String(assetMetadata[file].bytes)) return false;
  }
  return true;
}

registerRoute(({ url }) => url.origin === sw.location.origin && url.pathname.startsWith(assetBase) &&
  Object.hasOwn(assetMetadata, url.pathname.slice(assetBase.length)), async ({ request }) => {
  const name = new URL(request.url).pathname.slice(assetBase.length);
  const profile = (Object.keys(profiles) as EngineProfile[]).find(value => profiles[value].includes(name));
  const cache = await caches.open(engineCacheName);
  if (profile && await installed(profile, cache)) {
    const response = await cache.match(request);
    if (response) return response;
  }
  return fetch(request); // Explicit online execution only; caller checks consent first.
});

sw.addEventListener('message', event => {
  const message = event.data as { type?: string; profile?: unknown };
  const port = event.ports[0];
  if (message?.type === 'SKIP_WAITING') { void sw.skipWaiting(); return; }
  if (!port) return;
  if (message?.type === 'CANCEL_DOWNLOAD' && validProfile(message.profile)) {
    pending.get(message.profile)?.abort();
    port.postMessage({ type: 'cancelled' });
    return;
  }
  event.waitUntil((async () => {
    if (message?.type === 'STATUS') {
      const cache = await caches.open(engineCacheName);
      const result: Record<string, boolean> = {};
      for (const profile of Object.keys(profiles) as EngineProfile[]) result[profile] = await installed(profile, cache);
      port.postMessage({ type: 'status', installed: result });
      return;
    }
    if (!validProfile(message?.profile)) throw new Error('Unknown engine profile');
    const profile = message.profile;
    const cache = await caches.open(engineCacheName);
    if (message.type === 'REMOVE') {
      pending.get(profile)?.abort();
      await cache.delete(cacheMarker(profile));
      for (const file of profiles[profile]) await cache.delete(assetBase + file);
      port.postMessage({ type: 'removed' });
      return;
    }
    if (message.type !== 'DOWNLOAD') throw new Error('Unknown engine operation');
    if (pending.has(profile)) throw new Error('Download already running');
    const controller = new AbortController();
    pending.set(profile, controller);
    const total = profiles[profile].reduce((sum, file) => sum + assetMetadata[file].bytes, 0);
    let completed = 0;
    try {
      await cache.delete(cacheMarker(profile));
      for (const file of profiles[profile]) {
        const metadata = assetMetadata[file];
        const digest = Uint8Array.from(metadata.sha256.match(/../g)!, byte => parseInt(byte, 16));
        const integrity = `sha256-${btoa(String.fromCharCode(...digest))}`;
        const response = await fetch(assetBase + file, { integrity, signal: controller.signal, cache: 'no-store' });
        if (!response.ok || !response.body) throw new Error(`Engine download failed: HTTP ${response.status}`);
        let bytes = 0;
        const progress = new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, stream) {
            bytes += chunk.byteLength;
            if (bytes > metadata.bytes) throw new Error('Engine asset is larger than its pinned release size');
            port.postMessage({ type: 'progress', loaded: completed + bytes, total, file });
            stream.enqueue(chunk);
          },
        });
        const headers = new Headers(response.headers);
        headers.delete('Content-Encoding');
        headers.delete('Content-Length');
        headers.set('X-ChessIn-Verified-SHA256', metadata.sha256);
        headers.set('X-ChessIn-Verified-Bytes', String(metadata.bytes));
        headers.set('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
        await cache.put(assetBase + file, new Response(response.body.pipeThrough(progress), { headers }));
        if (bytes !== metadata.bytes) throw new Error('Engine asset size differs from its pinned release');
        completed += bytes;
      }
      await cache.put(cacheMarker(profile), new Response('complete'));
      port.postMessage({ type: 'complete' });
    } catch (error) {
      await cache.delete(cacheMarker(profile));
      for (const file of profiles[profile]) await cache.delete(assetBase + file);
      port.postMessage({ type: 'error', message: controller.signal.aborted ? 'Download cancelled.' :
        error instanceof Error ? `Could not store engine: ${error.message}` : 'Could not store the engine.' });
    } finally { pending.delete(profile); }
  })().catch(error => port.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Engine operation failed.' })));
});
