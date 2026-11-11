/**
 * F17 sample: executable TS config. If loaded without trust it must never run.
 * Running it writes a marker outside the project; tests assert the marker is
 * absent after an unauthorized load.
 */
import { writeFileSync } from 'node:fs';

writeFileSync(process.env.NEXUS_MARKER_PATH ?? 'unauthorized-marker.txt', 'executed');

export default { configVersion: 1 };
