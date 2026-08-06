export function AlarmMapPanel({ selectedAlarmEvent, selectedAlarmCamera, selectedAlarmGeo, reportSummary, setShowBilling }) {
  return (
    <section className="dashboard-panel alarm-panel" id="alarm-map">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Alarm response</p>
          <h3>Map & Location</h3>
        </div>
        <button className="ghost-button" type="button" onClick={() => setShowBilling(true)}>Open Packages</button>
      </div>

      <div className="alarm-grid">
        <div className="alarm-map-card">
          <div className="alarm-map-header">
            <span className="status-pill warning">Active alarm</span>
            <span className="subtle-chip">{selectedAlarmEvent ? `Event #${selectedAlarmEvent.eventId}` : 'No active event'}</span>
          </div>
          {selectedAlarmCamera && (selectedAlarmGeo.lat !== 0 || selectedAlarmGeo.lng !== 0) ? (
            <div className="alarm-map">
              <div className="map-grid-line map-grid-x" />
              <div className="map-grid-line map-grid-y" />
              <div
                className="map-pin"
                style={{ left: `${Math.min(Math.max(((selectedAlarmGeo.lng - 15.94) / 0.06) * 100, 8), 92)}%`, top: `${Math.min(Math.max((1 - ((selectedAlarmGeo.lat - 45.80) / 0.03)) * 100, 10), 90)}%` }}
              />
              <div className="map-callout">
                <strong>{selectedAlarmGeo.label}</strong>
                <p>{selectedAlarmGeo.note}</p>
              </div>
            </div>
          ) : (
            <div className="alarm-map alarm-map-empty">
              <div className="empty-state-content">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: '#8ea3b8', marginBottom: '1rem' }}>
                  <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                  <circle cx="12" cy="10" r="3" />
                </svg>
                <p style={{ color: '#8ea3b8', fontSize: '0.95rem', margin: 0 }}>No camera locations configured</p>
                <p style={{ color: '#6a7a8a', fontSize: '0.85rem', margin: '0.5rem 0 0' }}>Add cameras with latitude/longitude coordinates to enable map view</p>
              </div>
            </div>
          )}
          <div className="alarm-location-list">
            <div>
              <span className="alarm-label">Exact location</span>
              <strong>{selectedAlarmGeo.label}</strong>
            </div>
            <div>
              <span className="alarm-label">Coordinates</span>
              <strong>{selectedAlarmGeo.lat.toFixed(4)}, {selectedAlarmGeo.lng.toFixed(4)}</strong>
            </div>
            <div>
              <span className="alarm-label">Explanation</span>
              <strong>{reportSummary}</strong>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
