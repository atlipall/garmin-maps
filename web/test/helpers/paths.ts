import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const REPO = fileURLToPath(new URL('../../../', import.meta.url));
export const DETAILED =
  REPO + 'GPSmap.is 2024.21 Android/MAPS - Add content to MAPFILES folder/Iceland GPSmap.is 2024.21 Detailed.img';
export const PY_OUT = REPO + 'out/iceland-gpsmap-is-2024-21-detailed/';
export const hasRealData = existsSync(DETAILED);
