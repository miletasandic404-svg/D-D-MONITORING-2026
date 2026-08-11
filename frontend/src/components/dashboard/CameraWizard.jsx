export function CameraWizard({
  wizardOpen,
  setWizardOpen,
  wizardStep,
  setWizardStep,
  wizardScanning,
  wizardSaving,
  wizardScanResults,
  wizardNode,
  wizardNodeError,
  wizardSelectedCam,
  setWizardSelectedCam,
  wizardManualIp,
  setWizardManualIp,
  wizardStreams,
  wizardSelectedStream,
  setWizardSelectedStream,
  wizardProbing,
  wizardPreviewReady,
  setWizardPreviewReady,
  wizardTokenOk,
  wizardTunnelBusy,
  newCamera,
  setNewCamera,
  wizardUsername,
  setWizardUsername,
  wizardPassword,
  setWizardPassword,
  wizardError,
  setWizardError,
  wizardPreview,
  wizardPreviewRef,
  closeWizard,
  startWizardScan,
  testWizardConnection,
  connectWizardPreview,
  saveWizardCamera,
  startWizardTunnel,
}) {
  if (!wizardOpen) return null;

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Add new camera">
      <section className="modal-card">
        <div className="modal-header">
          <h2 className="modal-title">
            {wizardStep === 3 ? 'Live Preview' : wizardStep === 2 ? 'Connect Camera' : 'Add New Camera'}
          </h2>
          <button className="notif-dismiss" onClick={closeWizard} aria-label="Close">&#x2715;</button>
        </div>

        {/* Health panel — always visible */}
        <div className="wizard-fields" style={{ background: 'rgba(0,0,0,0.35)', borderRadius: 8, padding: '8px 12px', marginBottom: 10 }}>
          {[
            { key: 'node', label: 'Media Node online', ok: !!wizardNode, hint: 'Desktop media app nije online — pokreni start-laptop.bat na računaru pored kamera.' },
            { key: 'mtx', label: 'MediaMTX online', ok: !!wizardNode?.mediamtx_online, hint: 'MediaMTX ne odgovara na nodu — proveri da je pokrenut (start-laptop.bat).' },
            { key: 'tunnel', label: 'Tunnel online', ok: !!wizardNode?.tunnel_online, hint: 'Cloudflare Tunnel nije aktivan.' },
            { key: 'rtsp', label: 'RTSP connected', ok: wizardStreams?.find((s) => s.url === wizardSelectedStream)?.reachable ?? (wizardSelectedStream ? undefined : null), hint: 'Izaberi stream sa kamere.' },
            { key: 'hls', label: 'HLS active', ok: wizardPreviewReady, hint: 'HLS radi kada video počne da se reprodukuje.' },
            { key: 'token', label: 'Token auth OK', ok: wizardTokenOk, hint: '' },
          ].map((it) => (
            <div key={it.key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, padding: '2px 0' }}>
              <span>{it.ok === true ? '🟢' : it.ok === false ? '🔴' : '⚪'}</span>
              <span style={{ minWidth: 130 }}>{it.label}</span>
              {it.ok === false && it.hint && <span style={{ color: 'var(--color-warn, #f59e0b)' }}>{it.hint}</span>}
            </div>
          ))}
          {wizardNode?.health?.system && (
            <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid rgba(255,255,255,0.08)', fontSize: 12 }}>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', opacity: 0.95 }}>
                <span>🖥️ CPU {wizardNode.health.system.cpu_usage_percent != null ? `${wizardNode.health.system.cpu_usage_percent}%` : '—'}</span>
                <span>🧠 RAM {wizardNode.health.system.memory ? `${wizardNode.health.system.memory.used_mb} MB / ${wizardNode.health.system.memory.total_mb} MB` : '—'}</span>
                <span>💾 Disk {wizardNode.health.system.disk ? `${wizardNode.health.system.disk.free_mb} MB free` : '—'}</span>
              </div>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', opacity: 0.95, marginTop: 2 }}>
                <span>📷 Cameras {wizardNode.health.cameras ? `${wizardNode.health.cameras.active}/${wizardNode.health.cameras.total} active` : `${wizardNode.current_cameras || 0}`}</span>
                <span>⏱️ Uptime {wizardNode.health.system.uptime_seconds ? `${Math.floor(wizardNode.health.system.uptime_seconds / 60)} min` : '—'}</span>
                <span>💓 Last heartbeat {wizardNode.health_checked_at ? new Date(wizardNode.health_checked_at).toLocaleTimeString() : '—'}</span>
              </div>
            </div>
          )}
          {wizardNodeError && <p style={{ color: 'var(--color-danger, #ef4444)', fontSize: 12, margin: '4px 0' }}>⚠️ {wizardNodeError}</p>}
          {wizardNode && !wizardNode.tunnel_online && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
              <button className="ghost-button" type="button" onClick={startWizardTunnel} disabled={wizardTunnelBusy} style={{ padding: '3px 10px', fontSize: 12 }}>
                {wizardTunnelBusy ? 'Starting…' : '🚀 Start Tunnel'}
              </button>
              <span style={{ fontSize: 11, opacity: 0.8 }}>HLS neće biti javno dostupan dok tunnel ne radi.</span>
            </div>
          )}
        </div>

        {wizardStep === 1 && (
          <>
            <p className="ls-desc">Skeniranje lokalne mreže se pokreće automatski. Izaberi pronađenu kameru ili unesi IP adresu ručno — bez RTSP putanja i bez konfiguracije.</p>
            {wizardScanning ? (
              <p className="ls-desc" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>⏳ Scanning the local network for ONVIF cameras…</p>
            ) : (
              <div className="wizard-fields">
                {wizardScanResults?.cameras?.length > 0 ? (
                  <>
                    <span style={{ fontSize: 13 }}>Found {wizardScanResults.cameras.length} camera(s) on {wizardScanResults.subnet || 'LAN'}:</span>
                    <div className="wizard-found">
                      {wizardScanResults.cameras.map((cam, i) => (
                        <button key={i} type="button" className="wizard-found-item"
                          onClick={() => { setWizardSelectedCam(cam); setWizardManualIp(cam.ip); }}
                          style={{ textAlign: 'left', padding: 10, marginBottom: 6, borderRadius: 6, cursor: 'pointer', width: '100%' }}>
                          <div>📷 <strong>{cam.manufacturer || 'Unknown'} {cam.model || ''}</strong></div>
                          <div style={{ fontSize: 12, opacity: 0.8 }}>
                            {cam.ip}{cam.onvif_port ? ` :${cam.onvif_port}` : ''} · FW {cam.firmware_version || 'n/a'} · ONVIF ✓
                          </div>
                        </button>
                      ))}
                    </div>
                  </>
                ) : (
                  <p className="ls-desc" style={{ color: 'var(--color-warn, #f59e0b)' }}>No cameras found automatically. Enter the camera IP manually below (e.g. 192.168.1.17).</p>
                )}
                <label className="search-field">
                  <span>Camera IP</span>
                  <input value={wizardManualIp} onChange={(e) => { setWizardManualIp(e.target.value); setWizardSelectedCam(null); }} placeholder="192.168.1.17" />
                </label>
                <label className="search-field"><span>Username (ONVIF)</span><input value={wizardUsername} onChange={(e) => setWizardUsername(e.target.value)} placeholder="admin" autoComplete="off" /></label>
                <label className="search-field"><span>Password</span><input type="password" value={wizardPassword} onChange={(e) => setWizardPassword(e.target.value)} placeholder="••••••••" /></label>
                <label className="search-field"><span>Camera name</span><input value={newCamera.name} onChange={(e) => setNewCamera((p) => ({ ...p, name: e.target.value }))} placeholder="South Entrance" /></label>
              </div>
            )}
            {wizardError && <p className="ls-desc" style={{ color: 'var(--color-danger, #ef4444)' }}>⚠️ {wizardError}</p>}
            <div className="wizard-actions">
              <button className="primary-button" type="button" onClick={testWizardConnection} disabled={wizardScanning || wizardProbing || !wizardNode}>
                {wizardProbing ? 'Finding streams…' : 'Test Connection & Find Streams'}
              </button>
              <button className="ghost-button" type="button" onClick={startWizardScan} disabled={wizardScanning}>Rescan network</button>
            </div>
          </>
        )}

        {wizardStep === 2 && (
          <>
            <p className="ls-desc">Izaberi stream koji želiš da povežeš (Main je obično visoka rezolucija, Sub niža). Ako nema pronađenih streamova, unesi RTSP URL ručno.</p>
            {wizardStreams?.length > 0 ? (
              <div className="wizard-found">
                {wizardStreams.map((s, i) => (
                  <button key={i} type="button"
                    onClick={() => setWizardSelectedStream(s.url)}
                    style={{ textAlign: 'left', padding: 10, marginBottom: 6, borderRadius: 6, cursor: 'pointer', width: '100%',
                             outline: wizardSelectedStream === s.url ? '2px solid var(--color-primary, #3b82f6)' : 'none' }}>
                    <div>🎥 <strong>{s.label}</strong> {s.reachable ? '🟢' : '🔴'}</div>
                    <div style={{ fontSize: 11, opacity: 0.75, wordBreak: 'break-all' }}>{s.url}</div>
                  </button>
                ))}
              </div>
            ) : (
              <label className="search-field">
                <span>RTSP URL (manual)</span>
                <input value={newCamera.rtsp_url} onChange={(e) => setNewCamera((p) => ({ ...p, rtsp_url: e.target.value }))} placeholder="rtsp://user:pass@192.168.1.17:554/Streaming/Channels/101" />
              </label>
            )}
            {wizardError && <p className="ls-desc" style={{ color: 'var(--color-danger, #ef4444)' }}>⚠️ {wizardError}</p>}
            <div className="wizard-actions">
              <button className="primary-button" type="button" onClick={connectWizardPreview} disabled={wizardSaving}>
                {wizardSaving ? 'Connecting…' : 'Connect & Preview'}
              </button>
              <button className="ghost-button" type="button" onClick={() => setWizardStep(1)}>Back</button>
            </div>
          </>
        )}

        {wizardStep === 3 && (
          <>
            <p className="wizard-success">Camera <strong>{wizardPreview?.name || newCamera.name}</strong> is live. Klikni Save da je trajno dodaš.</p>
            {wizardPreview?.hlsUrl && (
              <video
                ref={wizardPreviewRef}
                controls
                autoPlay
                muted
                playsInline
                onPlaying={() => setWizardPreviewReady(true)}
                onError={() => setWizardError('Preview failed to play. Proveri health panel i probaj ponovo.')}
                style={{ width: '100%', borderRadius: 8, background: '#000', aspectRatio: '16 / 9', marginBottom: 12 }}
              />
            )}
            {wizardError && <p className="ls-desc" style={{ color: 'var(--color-danger, #ef4444)' }}>⚠️ {wizardError}</p>}
            <div className="wizard-actions">
              <button className="primary-button" type="button" onClick={saveWizardCamera} disabled={!wizardPreviewReady}>
                {wizardPreviewReady ? '💾 Save Camera' : 'Waiting for live preview…'}
              </button>
              <button className="ghost-button" type="button" onClick={closeWizard}>Cancel</button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
