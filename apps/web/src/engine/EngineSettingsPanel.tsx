import { useId, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faMicrochip, faSliders, faLink, faMobileScreenButton } from '@fortawesome/free-solid-svg-icons';
import type { EngineSettings } from '@chessin/core/engine';
import { useEngine } from './EngineContext';
import { hasUnsavedGames } from '../storage/db';
import { canThread, profileNames, profileSize, profiles, type EngineProfile } from './engine-assets';
import './engine.css';

const sections = [
  { id: 'engine', label: 'Engine', icon: faMicrochip },
  { id: 'search', label: 'Search', icon: faSliders },
  { id: 'connection', label: 'Connection', icon: faLink },
  { id: 'app', label: 'App', icon: faMobileScreenButton },
] as const;
type SettingsSection = typeof sections[number]['id'];

export function EngineSettingsPanel() {
  const engine = useEngine();
  const id = useId();
  const [section, setSection] = useState<SettingsSection>(engine.provider === 'remote' ? 'connection' : 'engine');
  const [endpoint, setEndpoint] = useState(engine.remoteEndpoint || '');
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
  const field = (name: string, key: 'threads' | 'hashMb' | 'multiPv', min: number, max: number, label: string, description: string) => {
    const bounds = range(name, min, max);
    if (!bounds || bounds.max < bounds.min) return null;
    return <label className="engine-field" key={key}><span>{label}</span>
      <input aria-label={name} type="number" min={bounds.min} max={bounds.max} disabled={bounds.min === bounds.max} value={engine.settings[key] ?? bounds.min}
        onChange={event => { const value = Number(event.target.value); if (Number.isInteger(value) && value >= bounds.min && value <= bounds.max) engine.setSettings({ ...engine.settings, [key]: value }); }} />
      <small>{bounds.min === bounds.max ? 'Fixed for this build' : `${description} · ${bounds.min}–${bounds.max}`}</small>
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
  const installed = engine.installed[selectedProfile];
  const installedMb = (Object.keys(profiles) as EngineProfile[]).reduce((bytes, profile) => bytes + (engine.installed[profile] ? profileSize(profile) : 0), 0) / 1e6;

  return <section className="engine-settings" aria-label="Engine settings">
    <header className="settings-overview">
      <div className="settings-engine-icon" aria-hidden="true"><FontAwesomeIcon icon={faMicrochip} /></div>
      <div className="settings-engine-identity"><span className="settings-kicker">YOUR ENGINE</span><strong>{engine.descriptor?.name ?? (engine.provider === 'remote' ? 'Remote engine' : 'Stockfish 19')}</strong></div>
      <span className="settings-provider"><span />{engine.provider === 'local' ? 'On device' : 'Remote'}</span>
    </header>
    <div className="settings-tabs" role="tablist" aria-label="Engine settings sections">
      {sections.map((item, index) => <button key={item.id} id={`${id}-${item.id}-tab`} type="button" role="tab" aria-selected={section === item.id} aria-controls={`${id}-${item.id}-panel`} tabIndex={section === item.id ? 0 : -1}
        onClick={() => setSection(item.id)} onKeyDown={event => {
          const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? sections.length - 1 : offset ? (index + offset + sections.length) % sections.length : -1;
          if (next < 0) return;
          event.preventDefault(); setSection(sections[next].id);
          document.getElementById(`${id}-${sections[next].id}-tab`)?.focus();
        }}><FontAwesomeIcon icon={item.icon} aria-hidden="true" />{item.label}</button>)}
    </div>
    {error && <p className="engine-error" role="alert">{error}</p>}
    <div className="settings-content" id={`${id}-${section}-panel`} role="tabpanel" aria-labelledby={`${id}-${section}-tab`} tabIndex={0}>
      {section === 'engine' && <>
        <div className="settings-section-heading"><div><h2>Local engine</h2><p>Powerful analysis. Your positions stay on this device.</p></div><span className="settings-tag">PRIVATE BY DEFAULT</span></div>
        {engine.provider === 'remote' && <div className="settings-notice"><p>You’re connected to a remote engine. Switch back to run analysis on this device.</p><button className="engine-button" disabled={busy} onClick={() => void action(() => engine.disconnectRemote())}>Switch to local</button></div>}
        <div className="engine-profile-grid" role="radiogroup" aria-label="Local engine profile">
          {(Object.keys(profiles) as EngineProfile[]).map(profile => {
            const threaded = profile.endsWith('threaded');
            const unavailable = threaded && !canThread();
            return <label key={profile} className={`engine-profile ${selectedProfile === profile ? 'selected' : ''} ${unavailable ? 'unavailable' : ''}`}>
              <input type="radio" name={`${id}-profile`} aria-label={profileNames[profile]} value={profile} checked={selectedProfile === profile} disabled={busy || !!engine.progress || unavailable} onChange={() => void action(() => engine.setProfile(profile))} />
              <span className="profile-copy"><span className="profile-title">{profile.includes('lite') ? 'Stockfish Lite' : 'Stockfish Full'}<span className="profile-size">{(profileSize(profile) / 1e6).toFixed(1)} MB</span></span><span className="profile-description">{threaded ? 'Multiple threads' : 'Single thread'} · {profile.includes('lite') ? 'Lightweight' : 'Larger network'}</span><span className="profile-caption">{unavailable ? 'Requires an isolated host' : profile === 'stockfish-lite-single' ? 'Recommended for most devices' : threaded ? 'More CPU & battery use' : 'More memory, stronger analysis'}</span></span>
            </label>;
          })}
        </div>
        {!canThread() && <p className="settings-help">Threaded engines need cross-origin isolation and SharedArrayBuffer. Single-thread engines remain available.</p>}
        <div className={`engine-storage-state ${engine.offlineReady ? 'ready' : ''}`}><span className="storage-state-dot" /><div><strong>{engine.offlineReady ? 'Ready offline' : installed ? 'Preparing offline access' : 'Download to get started'}</strong><span>{engine.offlineReady ? 'App and engine verified. Initialization is automatic.' : installed ? 'Connecting the installed engine to this app. No reload needed.' : 'A one-time download, then the engine starts automatically.'}</span></div><span className="storage-total">{installedMb.toFixed(1)} MB stored</span></div>
        <div className="engine-actions">
          {!installed && <button className="engine-button primary-button" disabled={busy || !!engine.progress} onClick={() => void action(() => engine.download(selectedProfile))}>{engine.progress ? 'Downloading…' : `Download engine · ${(profileSize(selectedProfile) / 1e6).toFixed(1)} MB`}</button>}
          {!engine.descriptor && (installed || engine.onlineConsent) && <button className="engine-button" disabled={busy || engine.initializing || engine.provider !== 'local'} onClick={() => void action(() => engine.ensureReady())}>{engine.initializing ? 'Starting engine…' : 'Retry initialization'}</button>}
          {engine.progress?.profile === selectedProfile && <button className="engine-button" onClick={() => void action(() => engine.cancelDownload(selectedProfile))}>Cancel download</button>}
        </div>
        {engine.progress && <label className="engine-download-progress">Downloading {engine.progress.file ?? 'engine'} · {Math.round(engine.progress.loaded / engine.progress.total * 100)}%<progress max={engine.progress.total} value={engine.progress.loaded} /></label>}
        {!engine.storageAvailable && <p className="settings-help">Offline storage isn’t available yet. You can still explicitly allow online execution below.</p>}
        <details className="settings-details"><summary>Storage & advanced options</summary><div className="settings-details-body"><p className="settings-help">Browser storage can be evicted. Keep a PGN backup of important games.</p><div className="engine-actions">
          <button className="engine-button" disabled={busy} onClick={() => void action(async () => { await engine.refreshInstallations(); const estimate = await navigator.storage?.estimate?.(); setSize({ usage: estimate?.usage, quota: estimate?.quota }); })}>Check storage</button>
          {installed && <><button className="engine-button" disabled={busy || !!engine.progress} onClick={() => void action(() => engine.download(selectedProfile))}>Re-download engine</button><button className="engine-button engine-danger" disabled={busy} onClick={() => void action(() => engine.remove(selectedProfile))}>Remove downloaded engine</button></>}
          {!engine.onlineConsent && <button className="engine-button" onClick={engine.runOnline}>Run online without offline storage</button>}
        </div>{size.quota !== undefined && <p className="settings-help">{((size.usage ?? 0) / 1e6).toFixed(1)} MB used of {(size.quota / 1e6).toFixed(1)} MB estimated quota.</p>}</div></details>
      </>}
      {section === 'search' && <>
        <div className="settings-section-heading"><div><h2>Search preferences</h2><p>Balance analysis depth with time and device resources.</p></div></div>
        {!engine.descriptor && <div className="settings-notice"><p>Download a local engine or connect a remote engine to reveal its supported memory, thread and line controls. Downloaded local engines start automatically.</p><button className="engine-button" onClick={() => setSection(engine.provider === 'local' ? 'engine' : 'connection')}>Set up engine</button></div>}
        {engine.descriptor && <div className="engine-fields">
          {field('Threads', 'threads', 1, engine.provider === 'local' ? selectedProfile.endsWith('threaded') ? Math.min(8, navigator.hardwareConcurrency ?? 1) : 1 : Math.min(8, engine.remoteLimits?.maxThreads ?? 8), 'Threads', 'CPU threads')}
          {field('Hash', 'hashMb', 16, Math.min(256, engine.remoteLimits?.maxHashMb ?? 256), 'Hash memory', 'MiB')}
          {field('MultiPV', 'multiPv', 1, Math.min(5, engine.remoteLimits?.maxMultiPv ?? 5), 'Engine lines', 'Variations')}
        </div>}
        <label className="engine-field">Search mode<select value={engine.limit.kind} onChange={event => engine.setLimit(event.target.value === 'infinite' ? { kind: 'infinite' } : { kind: 'bounded', depth: 18, moveTimeMs: 5000 })}><option value="bounded">Bounded · stop at a limit</option><option value="infinite">Infinite · stop manually</option>{engine.limit.kind === 'clock' && <option value="clock">Game clock (managed by Play)</option>}</select></label>
        {engine.limit.kind === 'bounded' && <div className="engine-fields">
          <label className="engine-field">Depth<input aria-label="Depth (1–60)" type="number" min="1" max="60" value={engine.limit.depth ?? ''} onChange={event => setBound('depth', event.target.value, 1, 60)} /><small>1–60 plies</small></label>
          <label className="engine-field">Time limit<input aria-label="Time ms (100–300000)" type="number" min="100" max="300000" value={engine.limit.moveTimeMs ?? ''} onChange={event => setBound('moveTimeMs', event.target.value, 100, 300000)} /><small>Milliseconds · up to 300,000</small></label>
          <label className="engine-field">Node limit<input aria-label="Nodes (1000–1 billion)" placeholder="No limit" type="number" min="1000" max="1000000000" value={engine.limit.nodes ?? ''} onChange={event => setBound('nodes', event.target.value, 1000, 1000000000)} /><small>Optional · up to 1 billion</small></label>
        </div>}
        <p className="settings-help">{engine.limit.kind === 'bounded' ? 'The first limit reached ends the search. Keep at least one limit set.' : 'Infinite searches run until stopped and use more CPU and battery.'}</p>
        {engine.provider === 'local' && engine.descriptor && <div className="engine-actions"><button className="engine-button" disabled={busy} onClick={() => void action(() => engine.clearHash())}>Clear Hash (restart local engine)</button></div>}
        {engine.provider === 'remote' && <p className="settings-help">Remote jobs always start in a fresh process with an empty hash.</p>}
        <div className="settings-footnote"><span className="storage-state-dot" />Analysis and review always use full strength.</div>
        {(option('Skill Level')?.type === 'spin' || (option('UCI_LimitStrength')?.type === 'check' && option('UCI_Elo')?.type === 'spin')) && <details className="settings-details"><summary>Engine play strength</summary><div className="settings-details-body"><p className="settings-help">Weakening applies to engine play, never analysis or review.</p><div className="engine-fields">
          {option('Skill Level')?.type === 'spin' && <label className="engine-field">Play skill level<input type="number" min={Math.max(0, option('Skill Level')?.min ?? 0)} max={Math.min(20, option('Skill Level')?.max ?? 20)} value={engine.settings.strength.kind === 'skill' ? engine.settings.strength.value : 10} onChange={event => setStrength({ kind: 'skill', value: Number(event.target.value) })} /></label>}
          {option('UCI_LimitStrength')?.type === 'check' && option('UCI_Elo')?.type === 'spin' && <label className="engine-field">Play Elo (engine-advertised range)<input type="number" min={option('UCI_Elo')?.min ?? 1} max={option('UCI_Elo')?.max ?? 4000} value={engine.settings.strength.kind === 'elo' ? engine.settings.strength.value : option('UCI_Elo')?.min ?? 1000} onChange={event => setStrength({ kind: 'elo', value: Number(event.target.value) })} /></label>}
        </div>{engine.settings.strength.kind !== 'full' && <button className="engine-button" onClick={() => setStrength({ kind: 'full' })}>Full strength</button>}</div></details>}
      </>}
      {section === 'connection' && <>
        <div className="settings-section-heading"><div><h2>Remote connection</h2><p>Use a trusted server for native engine analysis.</p></div><span className="settings-tag neutral">OPTIONAL</span></div>
        <div className="settings-privacy-note"><strong>Your library never leaves this device.</strong><p>Only requested positions and move history go to your server. The token stays in memory and must be re-entered after reload.</p></div>
        <div className="engine-connection-fields"><label className="engine-field">Server address<input aria-label="HTTPS server origin (localhost HTTP allowed)" type="url" autoCapitalize="none" spellCheck={false} value={endpoint} onChange={event => setEndpoint(event.target.value)} placeholder="https://chess.example.org" /><small>HTTPS required, except localhost development.</small></label>
          <label className="engine-field">Bearer token<input type="password" autoComplete="off" placeholder="Enter your server’s access token" value={token} onChange={event => setToken(event.target.value)} /><small>Never saved to browser storage.</small></label></div>
        <label className="engine-consent"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} /><span>I trust this server with positions I explicitly analyze or play.</span></label>
        {engine.remoteEngineId && <p className="settings-help">Previously selected: {engine.remoteEngineId}. Test the connection and select it again to reconnect.</p>}
        {engine.remoteEngines.length > 0 && tested === `${endpoint}\\0${token}` && <label className="engine-field">Choose remote engine<select value={selectedRemote} onChange={event => setSelectedRemote(event.target.value)}><option value="">Select an engine</option>{engine.remoteEngines.map(value => <option key={value.id} value={value.id}>{value.name} · {value.buildVersion}</option>)}</select></label>}
        <div className="engine-actions"><button className="engine-button primary-button" disabled={busy || !consent || !endpoint || !token} onClick={() => void action(async () => { await engine.testRemote(endpoint, token); setSelectedRemote(''); setTested(`${endpoint}\\0${token}`); })}>Test connection &amp; list engines</button>
          {selectedRemote && <button className="engine-button" disabled={busy || !consent || tested !== `${endpoint}\\0${token}`} onClick={() => void action(() => engine.connectRemote(endpoint, token, selectedRemote, consent))}>Connect selected engine</button>}
          {engine.provider === 'remote' && <button className="engine-button" disabled={busy} onClick={() => void action(() => engine.disconnectRemote())}>Switch to local</button>}
        </div>
      </>}
      {section === 'app' && <>
        <div className="settings-section-heading"><div><h2>ChessIn, within reach</h2><p>Your chess workspace, one tap from the home screen.</p></div></div>
        <div className="settings-install-card"><img src="/icons/icon-192.png" width="64" height="64" alt="" /><div><strong>Install ChessIn</strong><p>A dedicated window. The same local-first workspace.</p></div></div>
        {engine.installAvailable ? <div className="engine-actions"><button className="engine-button primary-button" disabled={busy} onClick={() => void action(() => engine.install())}>Install app</button></div> : <div className="settings-manual-install"><strong>Install from your browser</strong><p>Chrome / Edge: browser menu → Install app.<br />iPhone / iPad: Safari → Share → Add to Home Screen.</p><small>Installation may be unavailable in private browsing or over non-localhost HTTP.</small></div>}
        <div className="settings-privacy-note"><strong>Installation and offline engines are separate.</strong><p>Download an engine in the Engine tab. Offline analysis is ready only once the app shell is controlled and a complete engine pair is stored.</p></div>
        {engine.updateAvailable && !engine.controller.isBusy() && !hasUnsavedGames() && <div className="engine-actions"><button className="engine-button primary-button" disabled={busy} onClick={() => void action(() => engine.applyUpdate())}>Apply app update when idle</button></div>}
      </>}
    </div>
    <footer className="settings-status" role="status"><span className="settings-status-mark" aria-hidden="true" />{busy ? 'Applying your change…' : engine.status}</footer>
  </section>;
}
