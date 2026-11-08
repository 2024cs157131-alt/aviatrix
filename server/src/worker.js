// Dedicated background worker process: round engine (single leader across all instances) plus housekeeping.
import { startBackground } from './background.js';
import { pool } from './db.js';
import { config } from './config.js';

void config.encryptionKey;
const ctrl = new AbortController();
startBackground({ signal: ctrl.signal }).then(() => pool.end());
const stop = () => { ctrl.abort(); setTimeout(() => process.exit(0), 3000); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
