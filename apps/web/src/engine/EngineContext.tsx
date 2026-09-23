import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { EngineDescriptor, EngineSettings, ResourceCaps, SearchLimit } from '@chessin/core/engine';
import { getSetting, putSetting, flushSaves, hasUnsavedGames } from '../storage/db';
import { EngineController } from './engine-controller';
import { LocalEngine } from './local-engine';
import { RemoteEngine } from './remote-engine';
import { canThread, hardwareThreads, profileSize, type EngineProfile } from './engine-assets';

type Installed = Record<EngineProfile, boolean>;
type DownloadProgress = { profile: EngineProfile; loaded: number; total: number; file?: string } | null;
type EngineContextValue = {
  controller: EngineController;
  descriptor: EngineDescriptor | null;
  settings: EngineSettings;
  setSettings(settings: EngineSettings): void;
  limit: SearchLimit;
  setLimit(limit: SearchLimit): void;
  provider: 'local' | 'remote';
  status: string;
  ensureReady(): Promise<EngineDescriptor>;
  profile: EngineProfile;
  setProfile(profile: EngineProfile): Promise<void>;
  installed: Installed;
  offlineReady: boolean;
  storageAvailable: boolean;
  progress: DownloadProgress;
  download(profile: EngineProfile): Promise<void>;
  cancelDownload(profile: EngineProfile): Promise<void>;
  remove(profile: EngineProfile): Promise<void>;
  runOnline(): void;
  onlineConsent: boolean;
  refreshInstallations(): Promise<void>;
  clearHash(): Promise<void>;
  testRemote(endpoint: string, token: string): Promise<EngineDescriptor[]>;
  connectRemote(endpoint: string, token: string, engineId?: string, consent?: boolean): Promise<EngineDescriptor>;
  disconnectRemote(): Promise<void>;
  remoteEndpoint: string;
  remoteEngineId: string;
  remoteLimits: ResourceCaps | null;
  remoteEngines: EngineDescriptor[];
  updateAvailable: boolean;
  applyUpdate(): Promise<void>;
  install(): Promise<boolean>;
  installAvailable: boolean;
};
const Context = createContext<EngineContextValue | null>(null);
export function useEngine(): EngineContextValue {
  const value = useContext(Context);
  if (!value) throw new Error('EngineProvider is missing');
  return value;
}

function initialSettings(): EngineSettings {
  const touch = matchMedia('(pointer: coarse)').matches;
  return { threads: 1, hashMb: touch ? 32 : 64, multiPv: 3, strength: { kind: 'full' } };
}
function constrain(settings: EngineSettings, descriptor: EngineDescriptor | null, profile: EngineProfile, provider: 'local' | 'remote', caps?: ResourceCaps): EngineSettings {
  const option = (name: string) => descriptor?.options.find(item => item.name.toLowerCase() === name.toLowerCase());
  const control = (name: string, value: number | undefined, min: number, max: number): number | undefined => {
    const advertised = option(name);
    if (descriptor && advertised?.type !== 'spin') return undefined;
    if (value === undefined) return undefined;
    const lower = Math.max(min, advertised?.min ?? min), upper = Math.min(max, advertised?.max ?? max);
    return upper >= lower ? Math.max(lower, Math.min(upper, value)) : undefined;
  };
  return {
    threads: control('Threads', settings.threads, 1, provider === 'local' ? hardwareThreads(profile) : Math.min(8, caps?.maxThreads ?? 8)),
    hashMb: control('Hash', settings.hashMb, 16, Math.min(256, caps?.maxHashMb ?? 256)),
    multiPv: control('MultiPV', settings.multiPv, 1, Math.min(5, caps?.maxMultiPv ?? 5)),
    strength: settings.strength,
  };
}

type WorkerReply = { type: 'status'; installed: Installed } | { type: 'complete' | 'cancelled' | 'removed' };
async function workerMessage(message: object, progress?: (data: { type: string; loaded?: number; total?: number; file?: string }) => void): Promise<WorkerReply> {
  const registration = await navigator.serviceWorker.getRegistration();
  const worker = registration?.active;
  if (!worker) throw new Error('Offline storage unavailable. You can run online with explicit consent.');
  // Promise.withResolvers is unavailable on the supported Safari 16 baseline.
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    let timer: number;
    const deadline = () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => { channel.port1.close(); reject(new Error('Offline engine service stopped responding. Retry or run online.')); }, progress ? 45000 : 15000);
    };
    deadline();
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      const data = event.data;
      if (!data || typeof data !== 'object' || !('type' in data)) return;
      if (data.type === 'progress') {
        if ('loaded' in data && typeof data.loaded === 'number' && 'total' in data && typeof data.total === 'number') {
          deadline(); progress?.({ type: 'progress', loaded: data.loaded, total: data.total, file: 'file' in data && typeof data.file === 'string' ? data.file : undefined });
        }
        return;
      }
      clearTimeout(timer);
      channel.port1.close();
      if (data.type === 'status' && 'installed' in data && data.installed && typeof data.installed === 'object') {
        const installed = data.installed;
        if (['stockfish-lite-single', 'stockfish-lite-threaded', 'stockfish-full-single', 'stockfish-full-threaded'].every(key => key in installed && typeof Reflect.get(installed, key) === 'boolean')) {
          resolve({ type: 'status', installed: installed as Installed }); return;
        }
      } else if (data.type === 'complete' || data.type === 'cancelled' || data.type === 'removed') {
        resolve({ type: data.type }); return;
      }
      reject(new Error('message' in data && typeof data.message === 'string' ? data.message : 'Invalid offline engine service response.'));
    };
    worker.postMessage(message, [channel.port2]);
  });
}

export function EngineProvider({ children }: { children: ReactNode }) {
  const controller = useMemo(() => new EngineController(), []);
  const [descriptor, setDescriptor] = useState<EngineDescriptor | null>(null);
  const [settings, updateSettings] = useState<EngineSettings>(initialSettings);
  const [limit, updateLimit] = useState<SearchLimit>({ kind: 'bounded', depth: 18, moveTimeMs: 5000 });
  const [hydrated, setHydrated] = useState(false);
  const [provider, setProvider] = useState<'local' | 'remote'>('local');
  const [profile, updateProfile] = useState<EngineProfile>('stockfish-lite-single');
  const [status, setStatus] = useState('Download local engine to analyze.');
  const [installed, setInstalled] = useState<Installed>({ 'stockfish-lite-single': false, 'stockfish-lite-threaded': false, 'stockfish-full-single': false, 'stockfish-full-threaded': false });
  const [storageAvailable, setStorageAvailable] = useState(false);
  const [controlled, setControlled] = useState(false);
  const [onlineConsent, setOnlineConsent] = useState(false);
  const [progress, setProgress] = useState<DownloadProgress>(null);
  const [remoteAdapter, setRemoteAdapter] = useState<RemoteEngine | null>(null);
  const [remoteEndpoint, setRemoteEndpoint] = useState('');
  const [remoteEngineId, setRemoteEngineId] = useState('');
  const [remoteEngines, setRemoteEngines] = useState<EngineDescriptor[]>([]);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const offlineReady = controlled && installed[profile];

  const refreshInstallations = useCallback(async () => {
    if (!('serviceWorker' in navigator)) { setStorageAvailable(false); return; }
    try {
      const message = await workerMessage({ type: 'STATUS' });
      if (message.type !== 'status') throw new Error('Invalid engine installation status');
      setInstalled(message.installed);
      setStorageAvailable(true);
      setControlled(!!navigator.serviceWorker.controller);
    } catch { setStorageAvailable(false); setControlled(false); }
  }, []);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const saved = await getSetting<{ profile?: EngineProfile; settings?: EngineSettings; limit?: SearchLimit; endpoint?: string; engineId?: string }>('engine-preferences');
        if (alive && saved) {
          if (saved.profile && ['stockfish-lite-single', 'stockfish-lite-threaded', 'stockfish-full-single', 'stockfish-full-threaded'].includes(saved.profile)) updateProfile(saved.profile);
          if (saved.settings) updateSettings(saved.settings);
          if (saved.limit) updateLimit(saved.limit);
          if (saved.endpoint) setRemoteEndpoint(saved.endpoint); // Tokens are never saved.
          if (typeof saved.engineId === 'string') setRemoteEngineId(saved.engineId);
        }
      } catch { /* Library storage warning handles blocked IndexedDB. */ }
      finally { if (alive) setHydrated(true); }
    })();
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (hydrated) void putSetting('engine-preferences', { profile, settings, limit, endpoint: remoteEndpoint, engineId: remoteEngineId }).catch(() => {});
  }, [hydrated, profile, settings, limit, remoteEndpoint, remoteEngineId]);
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    let cancelled = false;
    const check = () => { if (!cancelled) void refreshInstallations(); };
    navigator.serviceWorker.addEventListener('controllerchange', check);
    if (import.meta.env.PROD) {
      void navigator.serviceWorker.register('/sw.js').then(registration => {
        check();
        if (registration.waiting) setUpdateAvailable(true);
        registration.addEventListener('updatefound', () => registration.installing?.addEventListener('statechange', () => {
          if (registration.waiting && navigator.serviceWorker.controller) setUpdateAvailable(true);
        }));
      }).catch(() => { setStorageAvailable(false); });
    } else check();
    return () => { cancelled = true; navigator.serviceWorker.removeEventListener('controllerchange', check); };
  }, [refreshInstallations]);
  useEffect(() => {
    const onPrompt = (event: Event) => { event.preventDefault(); setInstallPrompt(event as BeforeInstallPromptEvent); };
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);
  useEffect(() => () => { void controller.dispose(); }, [controller]);
  useEffect(() => {
    controller.onFailure = message => { setStatus(message); setDescriptor(null); };
    return () => { controller.onFailure = undefined; };
  }, [controller]);
  useEffect(() => {
    const network = () => {
      if (provider === 'remote' && !navigator.onLine) setStatus('Remote unavailable while offline. Reconnect or switch to local.');
      else if (provider === 'remote' && remoteAdapter && navigator.onLine && controller.hasAdapter()) setStatus(`Remote · ${remoteAdapter.descriptor.name} connected.`);
    };
    window.addEventListener('online', network);
    window.addEventListener('offline', network);
    network();
    return () => { window.removeEventListener('online', network); window.removeEventListener('offline', network); };
  }, [provider, remoteAdapter, controller]);

  const setSettings = (value: EngineSettings) => {
    if (controller.isPlayActive()) return;
    controller.cancel();
    updateSettings(constrain(value, descriptor, profile, provider, remoteAdapter?.caps));
  };
  const setLimit = (value: SearchLimit) => { if (controller.isPlayActive()) return; controller.cancel(); updateLimit(value); };
  const setProfile = async (value: EngineProfile) => {
    if (controller.isPlayActive()) throw new Error('Suspend the current game before changing engines.');
    if (value.includes('threaded') && !canThread()) throw new Error('Threaded engines need a cross-origin isolated HTTPS host and SharedArrayBuffer.');
    controller.cancel();
    await controller.use(null);
    setProvider('local');
    setRemoteAdapter(null);
    setDescriptor(null);
    updateProfile(value);
    updateSettings(previous => constrain({
      ...previous,
      threads: value.endsWith('threaded') && !profile.endsWith('threaded') ? Math.min(2, hardwareThreads(value)) : previous.threads,
    }, null, value, 'local'));
    setOnlineConsent(false);
    setStatus(`Selected ${value}. Download or choose Run online.`);
  };
  const download = async (value: EngineProfile) => {
    if (value.includes('threaded') && !canThread()) throw new Error('This host does not support threaded WASM; choose a single-thread profile.');
    try {
      if (navigator.storage?.estimate) {
        const estimate = await navigator.storage.estimate();
        if (estimate.quota !== undefined && estimate.usage !== undefined && estimate.quota - estimate.usage < profileSize(value))
          throw new Error('Not enough available space for this engine. Free device storage or use Run online.');
      }
      if (navigator.storage?.persist) await navigator.storage.persist().catch(() => false);
      setProgress({ profile: value, loaded: 0, total: profileSize(value) });
      await workerMessage({ type: 'DOWNLOAD', profile: value }, message => setProgress({ profile: value, loaded: message.loaded ?? 0, total: message.total ?? profileSize(value), file: message.file }));
      await refreshInstallations();
      setStatus(navigator.serviceWorker.controller ? 'Complete engine pair installed. Ready offline.' : 'Engine installed. Reload to control the app shell for offline use.');
    } catch (error) { setStatus(error instanceof Error ? error.message : 'Engine download failed.'); throw error; }
    finally { setProgress(null); }
  };
  const cancelDownload = async (value: EngineProfile) => { await workerMessage({ type: 'CANCEL_DOWNLOAD', profile: value }); };
  const remove = async (value: EngineProfile) => {
    if (controller.isPlayActive()) throw new Error('Suspend the game before removing its engine.');
    controller.cancel();
    await controller.use(null);
    setDescriptor(null);
    await workerMessage({ type: 'REMOVE', profile: value });
    await refreshInstallations();
    setStatus('Engine removed from offline storage.');
  };
  const runOnline = () => { setOnlineConsent(true); setStatus('Online execution allowed for this session; no offline storage is claimed.'); };
  const ensureReady = async (): Promise<EngineDescriptor> => {
    if (provider === 'remote') {
      if (!navigator.onLine) throw new Error('Remote engine unavailable offline. Switch to a downloaded local engine.');
      if (!remoteAdapter || !controller.hasAdapter()) throw new Error('Remote engine disconnected. Reconnect or switch to local.');
      return remoteAdapter.initialize();
    }
    if (profile.includes('threaded') && !canThread()) throw new Error('This host cannot run threaded WASM. Switch to lite-single.');
    if (descriptor?.id === profile && controller.hasAdapter()) return descriptor;
    let present = false;
    try {
      const result = await workerMessage({ type: 'STATUS' });
      if (result.type !== 'status') throw new Error('Invalid engine installation status');
      setInstalled(result.installed);
      present = result.installed[profile] === true;
    } catch { setStorageAvailable(false); }
    const usableOffline = !!navigator.serviceWorker?.controller && present;
    if (!usableOffline && !(onlineConsent && navigator.onLine)) throw new Error(present && !navigator.serviceWorker.controller
      ? 'Reload once to enable the installed offline engine, or explicitly choose Run online.'
      : `Download local engine · ${(profileSize(profile) / 1e6).toFixed(1)} MB, or explicitly choose Run online.`);
    try {
      const local = new LocalEngine(profile);
      await controller.use(local);
      const initialized = await local.initialize();
      updateSettings(previous => constrain(previous, initialized, profile, 'local'));
      setDescriptor(initialized);
      setStatus(`${initialized.name} · ${usableOffline ? 'Ready offline' : 'Online only; offline storage unavailable'}`);
      return initialized;
    } catch (error) {
      setDescriptor(null);
      await controller.use(null);
      await refreshInstallations();
      setStatus(error instanceof Error ? error.message : 'Local engine failed to start.');
      throw error;
    }
  };
  const testRemote = async (endpoint: string, token: string): Promise<EngineDescriptor[]> => {
    const catalog = await RemoteEngine.discover(endpoint, token);
    setRemoteEngines(catalog.engines);
    setRemoteEndpoint(catalog.endpoint);
    setStatus(`${catalog.engines.length} remote engine${catalog.engines.length === 1 ? '' : 's'} available. Select one and connect to analyze.`);
    return catalog.engines;
  };
  const connectRemote = async (endpoint: string, token: string, engineId?: string, consent = false): Promise<EngineDescriptor> => {
    if (!consent) throw new Error('Confirm that the requested position and move history will be sent to this server.');
    if (!engineId) throw new Error('Test the connection and select an engine first.');
    if (controller.isPlayActive()) throw new Error('Suspend the game before changing providers.');
    const { adapter, engines } = await RemoteEngine.connect(endpoint, token, engineId);
    await controller.use(adapter);
    setRemoteAdapter(adapter);
    setRemoteEngines(engines);
    setRemoteEndpoint(adapter.endpoint);
    setRemoteEngineId(adapter.descriptor.id);
    setDescriptor(adapter.descriptor);
    updateSettings(previous => constrain(previous, adapter.descriptor, profile, 'remote', adapter.caps));
    setProvider('remote');
    setStatus(`Remote · ${adapter.descriptor.name} connected. Positions are shared only when you request analysis.`);
    return adapter.descriptor;
  };
  const disconnectRemote = async () => {
    if (controller.isPlayActive()) throw new Error('Suspend the game before switching providers.');
    await controller.use(null);
    setRemoteAdapter(null);
    setDescriptor(null);
    setProvider('local');
    setOnlineConsent(false);
    setStatus('Local selected. Download or explicitly allow online engine execution.');
  };
  const clearHash = async () => {
    if (provider !== 'local') throw new Error('Remote jobs always use a fresh hash.');
    if (controller.isPlayActive()) throw new Error('Suspend the active game before clearing hash.');
    await controller.use(null);
    setDescriptor(null);
    await ensureReady();
  };
  const applyUpdate = async () => {
    if (controller.isBusy()) throw new Error('Pause analysis/review or suspend the game before applying an update.');
    controller.cancel();
    await flushSaves();
    if (controller.isBusy() || hasUnsavedGames()) throw new Error('Save or export unsaved work and stop engine activity before updating.');
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration?.waiting) return;
    const activated = new Promise<void>((resolve, reject) => {
      const onControl = () => { clearTimeout(timeout); resolve(); };
      const timeout = setTimeout(() => { navigator.serviceWorker.removeEventListener('controllerchange', onControl); reject(new Error('Update did not activate. Please retry later.')); }, 15000);
      navigator.serviceWorker.addEventListener('controllerchange', onControl, { once: true });
      registration.waiting!.postMessage({ type: 'SKIP_WAITING' });
    });
    await activated;
    setUpdateAvailable(false);
    window.location.reload();
  };
  const install = async () => {
    if (!installPrompt) return false;
    await installPrompt.prompt();
    const result = await installPrompt.userChoice;
    setInstallPrompt(null);
    return result.outcome === 'accepted';
  };
  const value: EngineContextValue = { controller, descriptor, settings, setSettings, limit, setLimit, provider, status, ensureReady,
    profile, setProfile, installed, offlineReady, storageAvailable, progress, download, cancelDownload, remove, runOnline, onlineConsent,
    refreshInstallations, clearHash, testRemote, connectRemote, disconnectRemote, remoteEndpoint, remoteEngineId, remoteEngines, remoteLimits: remoteAdapter?.caps ?? null, updateAvailable, applyUpdate, install, installAvailable: !!installPrompt };
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}
