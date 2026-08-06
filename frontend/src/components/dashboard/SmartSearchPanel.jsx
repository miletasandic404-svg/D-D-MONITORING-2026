export function SmartSearchPanel({
  filterCamera,
  setFilterCamera,
  filterZone,
  setFilterZone,
  filterDirection,
  setFilterDirection,
  filterDwellMin,
  setFilterDwellMin,
  filterObjectType,
  setFilterObjectType,
  filterColor,
  setFilterColor,
  suppressEnabled,
  setSuppressEnabled,
  suppressThreshold,
  setSuppressThreshold,
  cameras,
  clearFilters,
  hasActiveFilters,
}) {
  return (
    <section className="search-panel dashboard-panel" id="search" aria-label="Smart search filters">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Smart Search v2</p>
          <h3>Filter Incidents</h3>
        </div>
        <label className="suppress-toggle">
          <input
            type="checkbox"
            checked={suppressEnabled}
            onChange={(e) => setSuppressEnabled(e.target.checked)}
          />
          <span>Suppress below {suppressThreshold}% confidence</span>
        </label>
      </div>

      {suppressEnabled && (
        <div className="suppress-slider-row">
          <span>50%</span>
          <input
            type="range" min="50" max="99" step="1"
            value={suppressThreshold}
            onChange={(e) => setSuppressThreshold(Number(e.target.value))}
            className="suppress-slider"
          />
          <span>{suppressThreshold}%</span>
        </div>
      )}

      <div className="search-grid">
        <label className="search-field">
          <span>Object Type</span>
          <input type="text" placeholder="Person, Vehicle..." value={filterObjectType} onChange={(e) => setFilterObjectType(e.target.value)} />
        </label>
        <label className="search-field">
          <span>Camera</span>
          <select value={filterCamera} onChange={(e) => setFilterCamera(e.target.value)}>
            <option value="">All cameras</option>
            {cameras && cameras.map((cam) => (
              <option key={cam.id} value={cam.id}>{cam.name}</option>
            ))}
          </select>
        </label>
        <label className="search-field">
          <span>Zone / Location</span>
          <input type="text" placeholder="entrance, parking..." value={filterZone} onChange={(e) => setFilterZone(e.target.value)} />
        </label>
        <label className="search-field">
          <span>Direction</span>
          <select value={filterDirection} onChange={(e) => setFilterDirection(e.target.value)}>
            <option value="">Any direction</option>
            <option value="entering">Entering</option>
            <option value="exiting">Exiting</option>
            <option value="left">Left</option>
            <option value="right">Right</option>
          </select>
        </label>
        <label className="search-field">
          <span>Min. Dwell (seconds)</span>
          <input type="number" min="0" placeholder="0" value={filterDwellMin} onChange={(e) => setFilterDwellMin(e.target.value)} />
        </label>
        <label className="search-field">
          <span>Color Attribute</span>
          <input type="text" placeholder="Red, Black..." value={filterColor} onChange={(e) => setFilterColor(e.target.value)} />
        </label>
      </div>

      {hasActiveFilters && (
        <button
          type="button"
          className="ghost-button"
          style={{ marginTop: '0.75rem', fontSize: '0.8rem' }}
          onClick={clearFilters}
        >
          Clear all filters
        </button>
      )}
    </section>
  );
}
