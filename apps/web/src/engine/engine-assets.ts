// Keep this browser-side table identical to public/engines/19.0.0/manifest.json.
// The service worker needs the pins before it can cache or serve a worker pair.
export type EngineProfile = 'stockfish-lite-single' | 'stockfish-lite-threaded' | 'stockfish-full-single' | 'stockfish-full-threaded';
export const engineVersion = '19.0.0';
export const engineCacheName = `chessin-engines-${engineVersion}`;
export const assetBase = `/engines/${engineVersion}/`;
export const assetMetadata: Record<string, { bytes: number; sha256: string }> = {
  'stockfish-19-lite-single.js': { bytes: 21415, sha256: 'd3344124ab067fb0b90ee77873bb8e9fbf5fc01bc525fe714b0f942581e889e6' },
  'stockfish-19-lite-single.wasm': { bytes: 1787571, sha256: '57ac2d72312aba346760e3f173f687a8c211208e97a87268436f7f0e10bb5387' },
  'stockfish-19-lite.js': { bytes: 32817, sha256: '2f98d35d20bf435c16925f8955fe4b0c2062e66962799a407667218ff9ea709d' },
  'stockfish-19-lite.wasm': { bytes: 1636291, sha256: '18727c9ade11a8ca04391ab5a298232bc6fffebe2002e7cfffac82e7ad453447' },
  'stockfish-19-single.js': { bytes: 21315, sha256: '72772f8bdd7353e4e24245d946bb831f56bcccf02fa16a779c1b92a6c00e5cc2' },
  'stockfish-19-single.wasm': { bytes: 99102793, sha256: '8725c26572762617fd96b2ea83ff130e6640b85815890d682bf8c49db0820721' },
  'stockfish-19.js': { bytes: 32718, sha256: '227b9317cb8fc347da722b3f6694c5f57eafe17842a8a1afbfe08c3aeeae5671' },
  'stockfish-19.wasm': { bytes: 99065439, sha256: 'e0ef90031a310479e5b0c3692a9839118ed785535c306252e68ed3300a45b02d' },
};
export const profiles: Record<EngineProfile, [string, string]> = {
  'stockfish-lite-single': ['stockfish-19-lite-single.js', 'stockfish-19-lite-single.wasm'],
  'stockfish-lite-threaded': ['stockfish-19-lite.js', 'stockfish-19-lite.wasm'],
  'stockfish-full-single': ['stockfish-19-single.js', 'stockfish-19-single.wasm'],
  'stockfish-full-threaded': ['stockfish-19.js', 'stockfish-19.wasm'],
};
export const profileNames: Record<EngineProfile, string> = {
  'stockfish-lite-single': 'Lite · single thread',
  'stockfish-lite-threaded': 'Lite · threaded',
  'stockfish-full-single': 'Full · single thread',
  'stockfish-full-threaded': 'Full · threaded',
};
export function isThreaded(profile: EngineProfile): boolean { return profile.endsWith('threaded'); }
export function profileSize(profile: EngineProfile): number { return profiles[profile].reduce((sum, name) => sum + assetMetadata[name].bytes, 0); }
export function canThread(): boolean { return crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined'; }
export function hardwareThreads(profile: EngineProfile): number { return isThreaded(profile) ? Math.min(8, Math.max(1, navigator.hardwareConcurrency ?? 1)) : 1; }
export function cacheMarker(profile: EngineProfile): string { return `${assetBase}${profile}.complete`; }
