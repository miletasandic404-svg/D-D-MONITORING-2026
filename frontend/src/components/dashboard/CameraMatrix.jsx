export function CameraMatrix({
  visibleCameras,
  cameras,
  streamErrors,
  snapshotStatus,
  talkdownActive,
  takeSnapshot,
  triggerTalkdown,
  showAddCam,
  setShowAddCam,
  addCamForm,
  setAddCamForm,
  addCamSaving,
  addCamError,
  setAddCamError,
  submitAddCamera,
  addAuditEntry,
  globalSearchNeedle,
}) {
  return (
    <section className="dashboard-panel cameras-panel" id="cameras">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Camera matrix</p>
          <h3>Streams</h3>
        </div>
        <button
          className="ghost-button"
          type="button"
          onClick={() => { setShowAddCam((v) => !v); setAddCamError(''); }}
        >
          {showAddCam ? 'Cancel' : '+ Add Camera'}
        </button>
      </div>

      {addCamError && (
        <p className="checkout-status checkout-status-error" role="alert">
          Camera list failed to load: {addCamError}
        </p>
      )}

      {showAddCam && (
        <form className="add-cam-form" onSubmit={(e) => { e.preventDefault(); submitAddCamera(addCamForm, setAddCamForm, setShowAddCam, setAddCamError, addAuditEntry); }}>
          <label className="search-field">
            <span>Camera Name</span>
            <input
              value={addCamForm.name}
              onChange={(e) => setAddCamForm((p) => ({ ...p, name: e.target.value }))}
              placeholder="e.g. Back Yard"
              required
              autoFocus
            />
          </label>
          <label className="search-field">
            <span>RTSP Stream URL</span>
            <input
              value={addCamForm.rtsp_url}
              onChange={(e) => setAddCamForm((p) => ({ ...p, rtsp_url: e.target.value }))}
              placeholder="rtsp://your-camera-ip:554/stream"
              required
            />
          </label>
          <label className="search-field">
            <span>Location (optional)</span>
            <input
              value={addCamForm.location}
              onChange={(e) => setAddCamForm((p) => ({ ...p, location: e.target.value }))}
              placeholder="e.g. back_yard"
            />
          </label>
          <label className="search-field">
            <span>Latitude (optional)</span>
            <input
              type="number"
              step="any"
              value={addCamForm.lat}
              onChange={(e) => setAddCamForm((p) => ({ ...p, lat: e.target.value }))}
              placeholder="e.g. 45.8154"
            />
          </label>
          <label className="search-field">
            <span>Longitude (optional)</span>
            <input
              type="number"
              step="any"
              value={addCamForm.lng}
              onChange={(e) => setAddCamForm((p) => ({ ...p, lng: e.target.value }))}
              placeholder="e.g. 15.9819"
            />
          </label>
          <div className="add-cam-actions">
            {addCamError && <p className="checkout-status checkout-status-error">{addCamError}</p>}
            <button
              className="primary-button"
              type="submit"
              disabled={addCamSaving || !addCamForm.name.trim() || !addCamForm.rtsp_url.trim()}
            >
              {addCamSaving ? 'Saving...' : 'Add Camera'}
            </button>
          </div>
        </form>
      )}

      <div className="camera-list">
        {visibleCameras && visibleCameras.length > 0 ? (
          visibleCameras.map((cam) => (
            <article className="camera-card" key={cam.id}>
              <div className="camera-card-header">
                <div>
                  <h4>{cam.name}</h4>
                  <p>{cam.location || cam.rtsp_url}</p>
                </div>
                <span className={`status-pill ${cam.enabled !== false ? 'good' : 'neutral'}`}>
                  {cam.enabled !== false ? 'Live' : 'Disabled'}
                </span>
              </div>
              <div className="camera-video-wrapper">
                {streamErrors[cam.id] && (
                  <p className="checkout-status checkout-status-error" role="alert">
                    {streamErrors[cam.id]}
                  </p>
                )}
                <video id={`video-${cam.id}`} controls muted playsInline className="camera-video" />
              </div>
              {/* Snapshot + talkdown controls */}
              <div className="talkdown-row">
                <button
                  type="button"
                  className="talkdown-btn"
                  onClick={() => takeSnapshot(cam.id)}
                  disabled={snapshotStatus[cam.id] === 'capturing'}
                >
                  {snapshotStatus[cam.id] === 'capturing' ? 'Capturing...' :
                    snapshotStatus[cam.id] === 'success' ? 'Snapshot saved' :
                    snapshotStatus[cam.id] === 'error' ? 'Snapshot failed' : 'Take Snapshot'}
                </button>
                <button
                  type="button"
                  className={`talkdown-btn${talkdownActive === cam.id ? ' talkdown-active' : ''}`}
                  onClick={() => triggerTalkdown(cam.id)}
                  disabled={talkdownActive === cam.id}
                >
                  {talkdownActive === cam.id ? 'Warning Active...' : 'Trigger Talkdown'}
                </button>
                {talkdownActive === cam.id && (
                  <span className="talkdown-indicator" aria-live="polite">
                    <span className="talkdown-pulse" aria-hidden="true" /> Broadcasting warning to {cam.name}
                  </span>
                )}
              </div>
            </article>
          ))
        ) : (
          <div className="empty-state">
            <div className="empty-state-content">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: '#8ea3b8', marginBottom: '1rem' }}>
                <path d="M23 7l-7 5 7 5V7z" />
                <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
              </svg>
              <p style={{ color: '#8ea3b8', fontSize: '0.95rem', margin: 0 }}>
                {globalSearchNeedle ? `No cameras match "${globalSearchNeedle}"` : 'No active streams connected'}
              </p>
              {!globalSearchNeedle && (
                <button 
                  className="ghost-button" 
                  type="button"
                  onClick={() => { setShowAddCam((v) => !v); setAddCamError(''); }}
                  style={{ marginTop: '1rem' }}
                >
                  Add Camera
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
