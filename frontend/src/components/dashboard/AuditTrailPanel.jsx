export function AuditTrailPanel({ auditLog }) {
  return (
    <section className="dashboard-panel audit-panel" id="audit">
      <div className="panel-heading">
        <div><p className="eyebrow">Compliance &amp; traceability</p><h3>Operator Audit Trail</h3></div>
        <span className="subtle-chip">{auditLog.length} entries</span>
      </div>
      <div className="table-wrap">
        <table className="events-table audit-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Operator</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {(auditLog || []).map((entry) => (
              <tr key={entry.id}>
                <td><span className="audit-ts">{entry.ts}</span></td>
                <td><span className="audit-user">{entry.user}</span></td>
                <td>{entry.action}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
