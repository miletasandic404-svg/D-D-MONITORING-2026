import api from './api';

/**
 * Fetch a page of audit_log entries for the Operator Audit Trail
 * tile on the Dashboard. Source of truth is the audit_logs table on
 * the server; this never reads or merges any client-side state.
 *
 * @param {object} [opts]
 * @param {string} [opts.action]       - exact-match filter, e.g. 'snapshot.create'
 * @param {string} [opts.resourceType] - exact-match filter, e.g. 'snapshot'
 * @param {string} [opts.from]         - ISO timestamp lower bound
 * @param {string} [opts.to]           - ISO timestamp upper bound
 * @param {number} [opts.limit=50]     - 1..200
 * @param {number} [opts.offset=0]     - 0..100000
 * @returns {Promise<{count:number,total:number,limit:number,offset:number,entries:Array}>}
 */
export async function fetchAuditLogs(opts = {}) {
  const params = {};
  if (opts.action) params.action = opts.action;
  if (opts.resourceType) params.resource_type = opts.resourceType;
  if (opts.from) params.from = opts.from;
  if (opts.to) params.to = opts.to;
  if (opts.limit != null) params.limit = opts.limit;
  if (opts.offset != null) params.offset = opts.offset;
  const res = await api.get('/audit-logs', { params });
  return res.data;
}

export default fetchAuditLogs;
