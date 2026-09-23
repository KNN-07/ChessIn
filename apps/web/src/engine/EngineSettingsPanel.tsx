import { useState } from 'react';
import type { EngineSettings } from '@chessin/core/engine';
import { useEngine } from './EngineContext';
import { hasUnsavedGames } from '../storage/db';
import { canThread, profileNames, profileSize, profiles, type EngineProfile } from './engine-assets';
import './engine.css';

export function EngineSettingsPanel() {
  const engine = useEngine();
  const [endpoint, setEndpoint] = useState(engine.remoteEndpoint || 'http://127.0.0.1:8787');
  const [token, setToken] = useState('');
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [selectedRemote, setSelectedRemote] = useState('');
  const [tested, setTested] = useState('');
  const [size, setSize] = useState<{ usage?: number; quota?: number }>({});
  const option = (name: string) => engine.descriptor?.options.find(value => value.name.toLowerCase() === name.toLowerCase());
  const range = (name: string, min: number, max: number) => {
    const advertised = option(name);
    return advertised?.type === 'spin' ? { min: Math.max(min, advertised.min ?? min), max: Math.min(max, advertised.max ?? max) } : null;
  };
  const field = (name: string, key: 'threads' | 'hashMb' | 'multiPv', min: number, max: number) => {
    const bounds = range(name, min, max);
    if (!bounds || bounds.max < bounds.min) return null;
    return <label className="engine-field" key={key}>{name}
      <input type="number" min={bounds.min} max={bounds.max} value={engine.settings[key] ?? bounds.min}
        onChange={event => { const value = Number(event.target.value); if (Number.isInteger(value) && value >= bounds.min && value <= bounds.max) engine.setSettings({ ...engine.settings, [key]: value }); }} />
      <small>{bounds.min}–{bounds.max}</small>
    </label>;
  };
  const action = async (run: () => Promise<unknown>) => {
    setError(''); setBusy(true);
    try { await run(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'The engine action failed.'); }
    finally { setBusy(false); }
  };
  const setBound = (key: 'depth' | 'moveTimeMs' | 'nodes', raw: string, min: number, max: number) => {
    if (engine.limit.kind !== 'bounded') return;
    const value = raw === '' ? undefined : Number(raw);
    if (value !== undefined && (!Number.isInteger(value) || value < min || value > max)) return;
    const updated = { ...engine.limit, [key]: value };
    if (updated.depth === undefined && updated.moveTimeMs === undefined && updated.nodes === undefined) return;
    engine.setLimit(updated);
  };
  const setStrength = (strength: EngineSettings['strength']) => engine.setSettings({ ...engine.settings, strength });
  const selectedProfile = engine.profile;

  return <section className="engine-settings" aria-label="Engine settings">
    <h2>Engine settings</h2>
    <p className="engine-badge">{engine.provider === 'local' ? 'Local' : 'Remote'} · {engine.descriptor?.name ?? (engine.provider === 'remote' ? 'Disconnected' : profileNames[selectedProfile])}</p>
    <p role="status">{engine.status}</p>
    {error && <p className="engine-error" role="alert">{error}</p>}
    <fieldset><legend>Local engine profiles</legend>
      <label className="engine-field">Profile
        <select value={selectedProfile} onChange={event => void action(() => engine.setProfile(event.target.value as EngineProfile))}>
          {(Object.keys(profiles) as EngineProfile[]).map(profile => <option key={profile} value={profile} disabled={profile.endsWith('threaded') && !canThread()}>
            {profileNames[profile]} · {(profileSize(profile) / 1e6).toFixed(1)} MB
          </option>)}
        </select>
      </label>
      {!canThread() && <p>Threaded builds require a cross-origin isolated HTTPS host with SharedArrayBuffer. Lite-single remains available.</p>}
      {selectedProfile.endsWith('threaded') && <p>Multiple threads use more CPU and battery power.</p>}
      <p>{engine.installed[selectedProfile] ? engine.offlineReady ? 'Ready offline: controlled app shell and engine pair verified.' : 'Engine stored; reload to control the app shell for offline use.' : 'Engine not stored offline.'}</p>
      <p>Installed engine data: {((Object.keys(profiles) as EngineProfile[]).filter(value => engine.installed[value]).reduce((bytes, value) => bytes + profileSize(value), 0) / 1e6).toFixed(1)} MB across all profiles.</p>
      <div className="engine-actions">
        <button disabled={busy || !!engine.progress} onClick={() => void action(() => engine.download(selectedProfile))}>Download local engine · {(profileSize(selectedProfile) / 1e6).toFixed(1)} MB</button>
        {engine.progress?.profile === selectedProfile && <button onClick={() => void action(() => engine.cancelDownload(selectedProfile))}>Cancel download</button>}
        {engine.installed[selectedProfile] && <button disabled={busy} onClick={() => void action(() => engine.remove(selectedProfile))}>Remove downloaded engine</button>}
        {!engine.onlineConsent && <button onClick={engine.runOnline}>Run online without offline storage</button>}
      </div>
      {engine.progress && <label>Downloading {engine.progress.file ?? 'engine'} · {Math.round(engine.progress.loaded / engine.progress.total * 100)}%
        <progress max={engine.progress.total} value={engine.progress.loaded} />
      </label>}
      {!engine.storageAvailable && <p>Offline engine storage unavailable. Run online only with explicit consent; the board and library still work.</p>}
      <button disabled={busy} onClick={() => void action(() => engine.ensureReady())}>Initialize selected engine</button>
      <button onClick={() => void action(async () => { await engine.refreshInstallations(); const estimate = await navigator.storage?.estimate?.(); setSize({ usage: estimate?.usage, quota: estimate?.quota }); })}>Check storage</button>
      {size.quota !== undefined && <p>Storage used: {((size.usage ?? 0) / 1e6).toFixed(1)} MB of {(size.quota / 1e6).toFixed(1)} MB estimated quota. Browser eviction remains possible.</p>}
    </fieldset>
    <fieldset><legend>Search controls</legend>
      {!engine.descriptor && <p>Initialize or connect an engine to see its actual supported options.</p>}
      {field('Threads', 'threads', 1, engine.provider === 'local' ? selectedProfile.endsWith('threaded') ? Math.min(8, navigator.hardwareConcurrency ?? 1) : 1 : Math.min(8, engine.remoteLimits?.maxThreads ?? 8))}
      {field('Hash', 'hashMb', 16, Math.min(256, engine.remoteLimits?.maxHashMb ?? 256))}
      {field('MultiPV', 'multiPv', 1, Math.min(5, engine.remoteLimits?.maxMultiPv ?? 5))}
      <label className="engine-field">Search mode
        <select value={engine.limit.kind} onChange={event => engine.setLimit(event.target.value === 'infinite' ? { kind: 'infinite' } : { kind: 'bounded', depth: 18, moveTimeMs: 5000 })}>
          <option value="bounded">Bounded</option><option value="infinite">Infinite until stopped</option>
          {engine.limit.kind === 'clock' && <option value="clock">Game clock (managed by Play)</option>}
        </select>
      </label>
      {engine.limit.kind === 'bounded' && <div className="engine-fields">
        <label className="engine-field">Depth (1–60)<input type="number" min="1" max="60" value={engine.limit.depth ?? ''} onChange={event => setBound('depth', event.target.value, 1, 60)} /></label>
        <label className="engine-field">Time ms (100–300000)<input type="number" min="100" max="300000" value={engine.limit.moveTimeMs ?? ''} onChange={event => setBound('moveTimeMs', event.target.value, 100, 300000)} /></label>
        <label className="engine-field">Nodes (1000–1 billion)<input type="number" min="1000" max="1000000000" value={engine.limit.nodes ?? ''} onChange={event => setBound('nodes', event.target.value, 1000, 1000000000)} /></label>
      </div>}
      {engine.provider === 'local' && engine.descriptor && <button onClick={() => void action(() => engine.clearHash())}>Clear Hash (restart local engine)</button>}
      {engine.provider === 'remote' && <p>Remote jobs start in fresh processes with a fresh hash; there is no remote Clear Hash action.</p>}
      <p>Analysis and review use full strength. Weakened strength is for engine play only.</p>
      {option('Skill Level')?.type === 'spin' && <label className="engine-field">Play skill level
        <input type="number" min={Math.max(0, option('Skill Level')?.min ?? 0)} max={Math.min(20, option('Skill Level')?.max ?? 20)}
          value={engine.settings.strength.kind === 'skill' ? engine.settings.strength.value : 10}
          onChange={event => setStrength({ kind: 'skill', value: Number(event.target.value) })} /></label>}
      {option('UCI_LimitStrength')?.type === 'check' && option('UCI_Elo')?.type === 'spin' && <label className="engine-field">Play Elo (engine-advertised range)
        <input type="number" min={option('UCI_Elo')?.min ?? 1} max={option('UCI_Elo')?.max ?? 4000}
          value={engine.settings.strength.kind === 'elo' ? engine.settings.strength.value : option('UCI_Elo')?.min ?? 1000}
          onChange={event => setStrength({ kind: 'elo', value: Number(event.target.value) })} /></label>}
      {engine.settings.strength.kind !== 'full' && <button onClick={() => setStrength({ kind: 'full' })}>Full strength</button>}
    </fieldset>
    <fieldset><legend>Remote connection · optional</legend>
      <p>Connecting shares only each requested FEN and move history with this trusted server. Your game library is never uploaded. The bearer token stays in memory and must be re-entered after reload.</p>
      <label className="engine-field">HTTPS server origin (localhost HTTP allowed)
        <input type="url" value={endpoint} onChange={event => setEndpoint(event.target.value)} placeholder="https://chess.example.org" /></label>
      <label className="engine-field">Bearer token <input type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} /></label>
      <label className="engine-consent"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} /> I trust this server with positions I explicitly analyze or play.</label>
      {engine.remoteEngineId && <p>Previously selected engine: {engine.remoteEngineId}. Test the connection and select it again to reconnect.</p>}
      {engine.remoteEngines.length > 0 && tested === `${endpoint}\\0${token}` && <label className="engine-field">Choose remote engine
        <select value={selectedRemote} onChange={event => setSelectedRemote(event.target.value)}>
          <option value="">Select an engine</option>
          {engine.remoteEngines.map(value => <option key={value.id} value={value.id}>{value.name} · {value.buildVersion}</option>)}
        </select></label>}
      <div className="engine-actions">
        <button disabled={busy || !consent} onClick={() => void action(async () => { await engine.testRemote(endpoint, token); setSelectedRemote(''); setTested(`${endpoint}\\0${token}`); })}>Test connection &amp; list engines</button>
        <button disabled={busy || !consent || !selectedRemote || tested !== `${endpoint}\\0${token}`} onClick={() => void action(() => engine.connectRemote(endpoint, token, selectedRemote, consent))}>Connect selected engine</button>
        {engine.provider === 'remote' && <button onClick={() => void action(() => engine.disconnectRemote())}>Switch to local</button>}
      </div>
    </fieldset>
    <fieldset><legend>Install ChessIn</legend>
      {engine.installAvailable ? <button onClick={() => void action(() => engine.install())}>Install app</button> :
        <p>Use your browser menu: on Chrome/Edge choose Install app; on iPhone/iPad Safari choose Share → Add to Home Screen. Installation may not be offered in private browsing or over plain HTTP outside localhost.</p>}
      {engine.updateAvailable && !engine.controller.isBusy() && !hasUnsavedGames() && <button disabled={busy} onClick={() => void action(() => engine.applyUpdate())}>Apply app update when idle</button>}
      <p>Installing the app does not download an engine. “Ready offline” requires both a controlled app shell and a complete installed engine pair.</p>
    </fieldset>
  </section>;
}
