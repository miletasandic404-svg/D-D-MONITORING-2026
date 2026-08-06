export function Sidebar({ brandInitial, brandName, sidebarSections, setSidebarSections, navigate }) {
  return (
    <aside className="sidebar">
      <div className="sidebar-scroll">
        <div>
          <div className="brand-mark">{brandInitial}</div>
          <h1 className="sidebar-title">{brandName}</h1>
          <p className="sidebar-copy">Security monitoring, detections, and camera intelligence.</p>
        </div>

        <nav className="sidebar-nav" aria-label="Dashboard navigation">
          {/* Monitoring group */}
          <div className="sidebar-group">
            <button className="sidebar-group-header" onClick={() => setSidebarSections(s => ({ ...s, monitoring: !s.monitoring }))}>
              <span className="sidebar-group-arrow" data-open={sidebarSections.monitoring}>▶</span>
              <span>Monitoring</span>
            </button>
            {sidebarSections.monitoring && (
              <div className="sidebar-group-items">
                <button className="sidebar-nav-item" onClick={() => navigate('/dashboard')}>Dashboard</button>
                <button className="sidebar-nav-item" onClick={() => navigate('/cameras')}>Cameras</button>
                <button className="sidebar-nav-item" onClick={() => navigate('/live-streams')}>Live Streams</button>
                <button className="sidebar-nav-item" onClick={() => navigate('/video-playback')}>Video Playback</button>
              </div>
            )}
          </div>
          {/* Intelligence group */}
          <div className="sidebar-group">
            <button className="sidebar-group-header" onClick={() => setSidebarSections(s => ({ ...s, intelligence: !s.intelligence }))}>
              <span className="sidebar-group-arrow" data-open={sidebarSections.intelligence}>▶</span>
              <span>Intelligence</span>
            </button>
            {sidebarSections.intelligence && (
              <div className="sidebar-group-items">
                <button className="sidebar-nav-item" onClick={() => navigate('/ai-detection')}>AI Detection</button>
                <button className="sidebar-nav-item" onClick={() => navigate('/alerts')}>Alerts</button>
                <button className="sidebar-nav-item" onClick={() => navigate('/incidents')}>Incidents</button>
                <button className="sidebar-nav-item" onClick={() => navigate('/map')}>Map</button>
              </div>
            )}
          </div>
          {/* Recognition group */}
          <div className="sidebar-group">
            <button className="sidebar-group-header" onClick={() => setSidebarSections(s => ({ ...s, recognition: !s.recognition }))}>
              <span className="sidebar-group-arrow" data-open={sidebarSections.recognition}>▶</span>
              <span>Recognition</span>
            </button>
            {sidebarSections.recognition && (
              <div className="sidebar-group-items">
                <button className="sidebar-nav-item" onClick={() => navigate('/face-recognition')}>Face Recognition</button>
                <button className="sidebar-nav-item" onClick={() => navigate('/license-plates')}>LPR</button>
              </div>
            )}
          </div>
          {/* Operations group */}
          <div className="sidebar-group">
            <button className="sidebar-group-header" onClick={() => setSidebarSections(s => ({ ...s, operations: !s.operations }))}>
              <span className="sidebar-group-arrow" data-open={sidebarSections.operations}>▶</span>
              <span>Operations</span>
            </button>
            {sidebarSections.operations && (
              <div className="sidebar-group-items">
                <button className="sidebar-nav-item" onClick={() => navigate('/emergency')}>Emergency</button>
                <button className="sidebar-nav-item" onClick={() => navigate('/reports')}>Reports</button>
                <button className="sidebar-nav-item" onClick={() => navigate('/users')}>Users</button>
                <button className="sidebar-nav-item" onClick={() => navigate('/settings')}>Settings</button>
              </div>
            )}
          </div>
        </nav>
      </div>

      <div className="sidebar-footer">
        <span className="status-pill good">Operational</span>
        <p>Live monitoring enabled</p>
      </div>
    </aside>
  );
}
