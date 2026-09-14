import path from 'path';

const dataDir = process.env.CLAWOPT_DATA_DIR || '.clawopt';
export const uploadDir = path.join(process.env.HOME || '.', dataDir, 'uploads');
export const browserWarmupMarkerPath = path.join(process.env.HOME || '.', dataDir, 'browser-warmup.pending');
export const updateRestartStatePath = path.join(process.env.HOME || '.', dataDir, 'update-restart-state.json');
export const gatewayRestartStatePath = path.join(process.env.HOME || '.', dataDir, 'gateway-restart-state.json');

export const appRepoRoot = path.resolve(__dirname, '..', '..', '..', '..');
export const previewCacheDir = path.join(process.env.HOME || '.', '.clawopt_preview_cache');
