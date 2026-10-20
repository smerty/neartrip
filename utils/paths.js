const path = require('path');

// Resolve against the Node launch directory before the core changes cwd.
// Both the launcher and snapshot reader use this exact absolute filename.
const OPERATIONS_PATH = path.resolve(process.env.NEARTRIP_OPERATIONS || path.join(__dirname, '..', 'logs', 'operations.json'));
module.exports = { OPERATIONS_PATH };
