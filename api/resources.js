const aiDetectionsHandler = require('../lib/handlers/ai-detections');
const snapshotsHandler = require('../lib/handlers/snapshots');
const recordingsHandler = require('../lib/handlers/recordings');

module.exports = async (req, res) => {
  const path = req.url || '';
  if (path.startsWith('/api/ai-detections')) {
    return aiDetectionsHandler(req, res);
  } else if (path.startsWith('/api/snapshots')) {
    return snapshotsHandler(req, res);
  } else if (path.startsWith('/api/recordings')) {
    return recordingsHandler(req, res);
  }
  return res.status(404).json({ error: 'Not Found' });
};
