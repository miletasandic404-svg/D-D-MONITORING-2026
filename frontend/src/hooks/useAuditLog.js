import { useState } from 'react';

export function useAuditLog() {
  const currentUser = JSON.parse(localStorage.getItem('currentUser') || 'null');
  const [auditLog, setAuditLog] = useState([]);

  const addAuditEntry = (action) => setAuditLog((prev) => [
    { id: Date.now(), ts: new Date().toLocaleTimeString(), user: currentUser?.email || 'operator', action },
    ...prev
  ].slice(0, 50));

  return { auditLog, addAuditEntry };
}
