const healthHandler = require('../lib/handlers/health');
const verifyStreamTokenHandler = require('../lib/handlers/verify-stream-token');
const cronPendingActivationsHandler = require('../lib/handlers/cron-pending-activations');

module.exports = async (req, res) => {
  const path = req.url || '';
  if (path.startsWith('/api/verify-stream-token')) {
    return verifyStreamTokenHandler(req, res);
  }
  if (path.startsWith('/api/cron-pending-activations')) {
    return cronPendingActivationsHandler(req, res);
  }
  // Default to health
  return healthHandler(req, res);
};
