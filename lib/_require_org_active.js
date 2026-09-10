'use strict';

const db = require('../db/index');
const { sendError } = require('../lib/_error');

async function requireOrgActive(auth, res) {
  const orgResult = await db.queryAsOrg(
    auth.organizationId,
    'SELECT status FROM organizations WHERE id = $1',
    [auth.organizationId],
  );
  if (orgResult.rows.length === 0) {
    return sendError(res, 403, 'Organization not found');
  }
  if (orgResult.rows[0].status !== 'active') {
    return sendError(res, 403, 'Organization is not active');
  }
  return null;
}

module.exports = requireOrgActive;
