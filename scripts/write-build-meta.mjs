import { getGitCommit, readRootPackageJson, writeBuildMeta } from './versioning-utils.mjs';

const packageJson = readRootPackageJson();
const buildTime = new Date().toISOString();
const commit = getGitCommit({ short: true });

writeBuildMeta({
  appName: typeof packageJson.appName === 'string' && packageJson.appName.trim()
    ? packageJson.appName.trim()
    : packageJson.name,
  buildTime,
  commit,
});

console.log(`Wrote build metadata for ${packageJson.name} at ${buildTime}${commit ? ` (${commit})` : ''}`);
