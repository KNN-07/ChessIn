import largeAssets from '../../.cloudflare/asset-manifest.mjs';

const internal = '/__chessin_parts';
const navigationPaths = new Set(['/analysis', '/library', '/play', '/settings', '/licenses']);

function secure(response, cacheControl) {
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('X-Content-Type-Options', 'nosniff');
  if (cacheControl) headers.set('Cache-Control', cacheControl);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function text(status, message, extra = {}, head = false) {
  return secure(new Response(head ? null : message, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  }));
}
async function partBody(env, url, part) {
  const response = await env.ASSETS.fetch(new Request(new URL(part.path, url), {
    headers: { 'Accept-Encoding': 'identity' },
  }));
  if (response.status !== 200 || !response.body ||
    (response.headers.has('Content-Encoding') && response.headers.get('Content-Encoding') !== 'identity') ||
    (response.headers.has('Content-Length') && Number(response.headers.get('Content-Length')) !== part.size)) {
    await response.body?.cancel();
    throw new Error('Staged asset part is unavailable or changed');
  }
  return response.body;
}

async function largeResponse(request, env, entry, ctx) {
  const etag = `"${entry.sha256}"`;
  const headers = {
    'Content-Type': entry.mime,
    'Content-Length': String(entry.size),
    'Cache-Control': 'public, max-age=0, must-revalidate',
    ETag: etag,
    'Accept-Ranges': 'none',
  };
  if (request.headers.get('If-None-Match')?.split(',').some(tag => tag.trim() === etag)) {
    const { 'Content-Length': ignored, ...conditionalHeaders } = headers;
    return secure(new Response(null, { status: 304, headers: conditionalHeaders }));
  }
  if (request.method === 'HEAD') return secure(new Response(null, { headers }));

  let first;
  try { first = await partBody(env, request.url, entry.parts[0]); }
  catch { return text(502, 'Staged asset is temporarily unavailable'); }
  // Native piping avoids spending the free Worker CPU allowance on every binary chunk.
  // FixedLengthStream also makes truncated responses fail rather than silently end early.
  const { readable, writable } = new FixedLengthStream(entry.size);
  const transfer = async () => {
    try {
      await first.pipeTo(writable, { preventClose: true });
      for (let index = 1; index < entry.parts.length; index++) {
        const body = await partBody(env, request.url, entry.parts[index]);
        await body.pipeTo(writable, { preventClose: true });
      }
      await writable.close();
    } catch (error) {
      await writable.abort(error).catch(() => {});
      throw error;
    }
  };
  ctx.waitUntil(transfer());
  return secure(new Response(readable, { headers }));
}

function navigation(pathname, request) {
  return navigationPaths.has(pathname) && request.headers.get('Accept')?.includes('text/html');
}

export default {
  async fetch(request, env, ctx) {
    const pathname = new URL(request.url).pathname;
    // Percent-encoded, backslash or repeated-separator aliases cannot bypass internal-path filtering.
    if (pathname.includes('%') || pathname.includes('\\') || pathname.includes('//')) return text(400, 'Invalid asset path', {}, request.method === 'HEAD');
    if (pathname === internal || pathname.startsWith(`${internal}/`)) return text(404, 'Not found', {}, request.method === 'HEAD');
    if (request.method !== 'GET' && request.method !== 'HEAD') return text(405, 'Method not allowed', { Allow: 'GET, HEAD' });
    if (pathname === '/v1' || pathname.startsWith('/v1/') || pathname === '/healthz') return text(404, 'API not hosted here', {}, request.method === 'HEAD');
    const entry = Object.hasOwn(largeAssets, pathname) ? largeAssets[pathname] : null;
    if (entry) return largeResponse(request, env, entry, ctx);

    const target = pathname === '/' || navigation(pathname, request) ? '/index.html' : pathname;
    const url = new URL(request.url);
    url.pathname = target;
    url.search = '';
    // Do not forward Range/conditional headers to index.html when falling back from a route.
    const assetRequest = target === pathname ? request : new Request(url, { method: request.method });
    const asset = await env.ASSETS.fetch(assetRequest);
    if (asset.status === 404) {
      await asset.body?.cancel();
      return text(404, 'Not found', {}, request.method === 'HEAD');
    }
    const shell = target === '/index.html' || pathname === '/sw.js';
    if (request.method === 'HEAD') {
      await asset.body?.cancel();
      return secure(new Response(null, { status: asset.status, headers: asset.headers }), shell ? 'no-cache, must-revalidate' : undefined);
    }
    return secure(asset, shell ? 'no-cache, must-revalidate' : undefined);
  },
};
