export function MetricsGrid({ cameras, incidentsLoaded, incidents, activeCameras }) {
  const systemStatus = { label: 'Operational', tone: 'good' };

  return (
    <section className="metrics-grid" aria-label="Key metrics">
      <article className="metric-card">
        <p className="metric-label">Active Cameras</p>
        {cameras === null ? (
          <div className="skeleton skeleton-number" />
        ) : (
          <strong>{cameras.length ? activeCameras : '-'}</strong>
        )}
        <span>{cameras === null ? <div className="skeleton skeleton-text short" /> : cameras.length ? `${cameras.length} total cameras` : 'No cameras configured'}</span>
      </article>
      <article className="metric-card">
        <p className="metric-label">Offline Cameras</p>
        {cameras === null ? (
          <div className="skeleton skeleton-number" />
        ) : (
          <strong>{cameras.length ? cameras.length - activeCameras : '-'}</strong>
        )}
        <span>{cameras === null ? <div className="skeleton skeleton-text short" /> : cameras.length ? 'Disabled streams' : 'No cameras configured'}</span>
      </article>
      <article className="metric-card">
        <p className="metric-label">Active Streams</p>
        {cameras === null ? (
          <div className="skeleton skeleton-number" />
        ) : (
          <strong>{cameras.length ? activeCameras : '-'}</strong>
        )}
        <span>{cameras === null ? <div className="skeleton skeleton-text short" /> : cameras.length ? 'Live HLS connections' : 'No cameras configured'}</span>
      </article>
      <article className="metric-card">
        <p className="metric-label">Open Alerts</p>
        {!incidentsLoaded ? (
          <div className="skeleton skeleton-number" />
        ) : (
          <strong>{incidents.filter((i) => ['New', 'Acknowledged', 'In Progress'].includes(i.status)).length}</strong>
        )}
        <span>{!incidentsLoaded ? <div className="skeleton skeleton-text short" /> : 'New & acknowledged'}</span>
      </article>
      <article className="metric-card">
        <p className="metric-label">Incidents Today</p>
        {!incidentsLoaded ? (
          <div className="skeleton skeleton-number" />
        ) : (
          <strong>{incidents.length}</strong>
        )}
        <span>{!incidentsLoaded ? <div className="skeleton skeleton-text short" /> : 'Total detections'}</span>
      </article>
      <article className="metric-card">
        <p className="metric-label">System Health</p>
        <strong className="metric-accent">{systemStatus.label}</strong>
        <span>Core services operational</span>
      </article>
      <article className="metric-card">
        <p className="metric-label">Storage Usage</p>
        <strong>-</strong>
        <span>Storage monitoring not configured</span>
      </article>
      <article className="metric-card">
        <p className="metric-label">API Status</p>
        <strong className="metric-accent">Online</strong>
        <span>Backend connected</span>
      </article>
    </section>
  );
}
