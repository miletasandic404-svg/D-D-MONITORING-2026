export function EventsTable({
  recentEvents,
  currentUser,
  updatingIncidentId,
  updateIncidentStatus,
  statusClassName,
  nextActionsForStatus,
  exportEvidence,
  openAlarmMap,
  addAuditEntry,
  incidentsLoaded,
  setSelectedAlarmId,
}) {
  return (
    <section className="dashboard-panel table-panel" id="events">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Activity feed</p>
          <h3>Recent Events</h3>
        </div>
        <span className="subtle-chip">Last 24h</span>
      </div>

      <div className="table-wrap">
        <table className="events-table">
          <thead>
            <tr>
              <th>Event</th>
              <th>Source</th>
              <th>Time</th>
              <th>Status</th>
              <th>Actions</th>
              <th>Evidence</th>
            </tr>
          </thead>
          <tbody>
            {recentEvents.length ? (
              recentEvents.map((event) => (
                <tr key={event.id}>
                  <td>
                    <div className="table-title">{event.title}</div>
                    <div className="table-subtitle">{event.subtitle}</div>
                  </td>
                  <td>{event.source || event.subtitle}</td>
                  <td>{event.time}</td>
                  <td>
                    <span className={`status-pill ${statusClassName(event.status)}`}>
                      {event.status}
                    </span>
                  </td>
                  <td>
                    <div className="incident-actions">
                      {currentUser ? (
                        nextActionsForStatus(event.status).map((nextStatus) => (
                          <button
                            key={`${event.id}-${nextStatus}`}
                            type="button"
                            className="ghost-button incident-action-button"
                            onClick={() => updateIncidentStatus(event.eventId, nextStatus)}
                            disabled={updatingIncidentId === event.eventId}
                          >
                            {updatingIncidentId === event.eventId ? 'Updating...' : nextStatus}
                          </button>
                        ))
                      ) : (
                        <span className="table-subtitle">Login required</span>
                      )}
                    </div>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="ghost-button incident-action-button export-btn"
                      onClick={() => { exportEvidence(event); setSelectedAlarmId(event.eventId); addAuditEntry(`Exported evidence package for Event #${event.eventId}`); }}
                      title="Download evidence package (JSON + video metadata)"
                    >
                      Export
                    </button>
                    <button
                      type="button"
                      className="ghost-button incident-action-button"
                      onClick={() => openAlarmMap(event)}
                    >
                      Show map
                    </button>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={6} className="empty-state">
                  {incidentsLoaded ? 'No incidents match the current filters.' : 'Loading incident queue...'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
