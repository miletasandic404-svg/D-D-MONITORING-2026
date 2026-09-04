const healthHandler = require('../lib/handlers/health');
const healthStorageHandler = require('../lib/handlers/health-storage');
const verifyStreamTokenHandler = require('../lib/handlers/verify-stream-token');
const cronPendingActivationsHandler = require('../lib/handlers/cron-pending-activations');
const cronRetentionHandler = require('../lib/handlers/cron-retention');

module.exports = async (req, res) => {
const handler = req.query?.handler || '';

if (handler === 'verify-stream-token') {
  return verifyStreamTokenHandler(req, res);
}
if (handler === 'cron-pending-activations') {
  return cronPendingActivationsHandler(req, res);
}
if (handler === 'cron-retention') {
  return cronRetentionHandler(req, res);
}
if (handler === 'health-storage') {
  return healthStorageHandler(req, res);
}
  // Default to health
  return healthHandler(req, res);
};
