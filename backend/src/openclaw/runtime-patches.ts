import fs from 'fs';
import path from 'path';

import { escapeRegExpForPattern } from '../collab/sessions';
import { writeFileAtomicSync } from '../core/files';
import { collectOpenClawPackageRoots } from './cli';
import { readTextFileSafe } from './openclaw-config';

const OPENCLAW_EXEC_PREFLIGHT_BYPASS_MARKER = 'openclaw-chat-gateway:max-permissions-exec-preflight-bypass';
const OPENCLAW_EXEC_PREFLIGHT_VALIDATOR_SIGNATURE = 'async function validateScriptFileForShellBleed(params) {';
const OPENCLAW_EXEC_PREFLIGHT_VALIDATOR_SIGNATURE_PATTERN = /async function validateScriptFileForShellBleed\s*\(\s*[^)]*\)\s*\{/;
const OPENCLAW_EXEC_PREFLIGHT_PATCHED_SIGNATURE = `async function validateScriptFileForShellBleed(params) { return; /* ${OPENCLAW_EXEC_PREFLIGHT_BYPASS_MARKER} */`;
const OPENCLAW_EXEC_PREFLIGHT_PATCH_BACKUP_SUFFIX = '.clawopt-max-permissions.exec-preflight.bak';
const OPENCLAW_BROWSER_FILL_COMPAT_MARKER = 'openclaw-chat-gateway:browser-fill-compat';
const OPENCLAW_BROWSER_FILL_VALUE_ALIAS_MARKER = `${OPENCLAW_BROWSER_FILL_COMPAT_MARKER}:value-alias`;
const OPENCLAW_BROWSER_FILL_FIELDS_ALIAS_MARKER = `${OPENCLAW_BROWSER_FILL_COMPAT_MARKER}:fields-alias`;
const OPENCLAW_BROWSER_FILL_CLI_ALIAS_MARKER = `${OPENCLAW_BROWSER_FILL_COMPAT_MARKER}:cli-text-alias`;
const OPENCLAW_BROWSER_FILL_COMPAT_PATCH_BACKUP_SUFFIX = '.clawopt-browser-fill-compat.bak';
const OPENCLAW_BROWSER_FILL_CANDIDATE_ENTRY_PATTERNS = [
  /^browser-cli-actions-input-.*\.js$/i,
  /^client-fetch-.*\.js$/i,
  /^plugin-service-.*\.js$/i,
  /^pw-role-snapshot-.*\.js$/i,
  /^routes-.*\.js$/i,
  /^snapshot-urls-.*\.js$/i,
] as const;
const OPENCLAW_BROWSER_FILL_CLIENT_FIELD_SIGNATURE = 'const value = normalizeBrowserFormFieldValue(record.value);';
const OPENCLAW_BROWSER_FILL_CLIENT_FIELD_PATCHED_SIGNATURE = `const value = normalizeBrowserFormFieldValue(record.value !== void 0 ? record.value : record.text); /* ${OPENCLAW_BROWSER_FILL_VALUE_ALIAS_MARKER} */`;
const OPENCLAW_BROWSER_FILL_LEGACY_CLIENT_ACTION_SIGNATURE = 'const fields = (Array.isArray(body.fields) ? body.fields : []).map((field) => {';
const OPENCLAW_BROWSER_FILL_LEGACY_CLIENT_ACTION_PATCHED_SIGNATURE = [
  'const fallbackRef = normalizeBrowserFormFieldRef(body.ref);',
  '\t\t\t\t\t\tconst rawFields = Array.isArray(body.fields) ? body.fields : fallbackRef ? [{',
  '\t\t\t\t\t\t\tref: fallbackRef,',
  '\t\t\t\t\t\t\ttype: body.type,',
  '\t\t\t\t\t\t\tvalue: body.value !== void 0 ? body.value : body.text',
  `\t\t\t\t\t\t}] : []; /* ${OPENCLAW_BROWSER_FILL_FIELDS_ALIAS_MARKER} */`,
  '\t\t\t\t\t\tconst fields = rawFields.map((field) => {',
].join('\n');
const OPENCLAW_BROWSER_FILL_ROUTE_ACTION_SIGNATURE = 'const fields = normalizeFields(body.fields);';
const OPENCLAW_BROWSER_FILL_ROUTE_ACTION_PATCHED_SIGNATURE = [
  `const fallbackRef = toStringOrEmpty(body.ref) || void 0; /* ${OPENCLAW_BROWSER_FILL_FIELDS_ALIAS_MARKER} */`,
  '\t\t\tconst rawFields = Array.isArray(body.fields) ? body.fields : fallbackRef ? [{',
  '\t\t\t\tref: fallbackRef,',
  '\t\t\t\ttype: body.type,',
  '\t\t\t\tvalue: body.value !== void 0 ? body.value : body.text',
  '\t\t\t}] : [];',
  '\t\t\tconst fields = normalizeFields(rawFields);',
].join('\n');
const OPENCLAW_BROWSER_FILL_PLUGIN_READ_FIELDS_SIGNATURE = 'if (rec.value === void 0 || rec.value === null || normalizeBrowserFormFieldValue(rec.value) !== void 0) return parsedField;';
const OPENCLAW_BROWSER_FILL_PLUGIN_READ_FIELDS_PATCHED_SIGNATURE = [
  `const rawValue = rec.value !== void 0 ? rec.value : rec.text; /* ${OPENCLAW_BROWSER_FILL_CLI_ALIAS_MARKER} */`,
  '\t\tif (rawValue === void 0 || rawValue === null || normalizeBrowserFormFieldValue(rawValue) !== void 0) return parsedField;',
].join('\n');

type TextFileSnapshot = {
  existed: boolean;
  content: string | null;
};

type FilePathSnapshot = {
  filePath: string;
  snapshot: TextFileSnapshot;
};

type OpenClawExecPreflightPatchTarget = {
  packageRoot: string;
  targetPath: string;
  backupPath: string;
};

export type OpenClawExecPreflightBypassStatus = {
  ready: boolean;
  targetCount: number;
  patchedCount: number;
  rawDetail: string | null;
  targets: OpenClawExecPreflightPatchTarget[];
};

type OpenClawBrowserFillCompatPatchTargetKind = 'browser-fill-source';

type OpenClawBrowserFillCompatPatchTarget = {
  packageRoot: string;
  targetPath: string;
  backupPath: string;
  kind: OpenClawBrowserFillCompatPatchTargetKind;
};

type OpenClawBrowserFillCompatStatus = {
  ready: boolean;
  targetCount: number;
  patchedCount: number;
  rawDetail: string | null;
  targets: OpenClawBrowserFillCompatPatchTarget[];
};

export function snapshotTextFile(filePath: string): TextFileSnapshot {
  if (!fs.existsSync(filePath)) {
    return {
      existed: false,
      content: null,
    };
  }

  // 走网关：这一行上没有 JSON.parse，所以既躲过了网关也躲过了当时那条按行匹配的
  // 守卫。一个命名管道就能让 POST /api/config/max-permissions 永久挂住整个后端。
  const text = readTextFileSafe(filePath);
  return {
    existed: true,
    content: text.exists ? (text.value as string) : '',
  };
}

export function restoreTextFile(filePath: string, snapshot: TextFileSnapshot) {
  if (snapshot.existed) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileAtomicSync(filePath, snapshot.content || '');
    return;
  }

  fs.rmSync(filePath, { force: true });
}

function snapshotFilePaths(filePaths: string[]): FilePathSnapshot[] {
  const uniquePaths = Array.from(new Set(filePaths.map((filePath) => path.resolve(filePath))));
  return uniquePaths.map((filePath) => ({
    filePath,
    snapshot: snapshotTextFile(filePath),
  }));
}

export function restoreFilePathSnapshots(snapshots: FilePathSnapshot[]) {
  for (const entry of snapshots) {
    restoreTextFile(entry.filePath, entry.snapshot);
  }
}

function getOpenClawExecPreflightPatchBackupPath(targetPath: string) {
  return `${targetPath}${OPENCLAW_EXEC_PREFLIGHT_PATCH_BACKUP_SUFFIX}`;
}

function readOpenClawExecPreflightSource(targetPath: string) {
  return fs.readFileSync(targetPath, 'utf-8');
}

function isOpenClawExecPreflightBypassPatched(source: string) {
  return source.includes(OPENCLAW_EXEC_PREFLIGHT_BYPASS_MARKER)
    || source.includes(OPENCLAW_EXEC_PREFLIGHT_PATCHED_SIGNATURE);
}

function detectOpenClawExecPreflightValidatorSignature(source: string): string | null {
  if (source.includes(OPENCLAW_EXEC_PREFLIGHT_VALIDATOR_SIGNATURE)) {
    return OPENCLAW_EXEC_PREFLIGHT_VALIDATOR_SIGNATURE;
  }
  const match = source.match(OPENCLAW_EXEC_PREFLIGHT_VALIDATOR_SIGNATURE_PATTERN);
  return match?.[0] || null;
}

function collectOpenClawExecPreflightPatchTargets(): OpenClawExecPreflightPatchTarget[] {
  const targets: OpenClawExecPreflightPatchTarget[] = [];
  const seen = new Set<string>();

  for (const packageRoot of collectOpenClawPackageRoots()) {
    const distDir = path.join(packageRoot, 'dist');
    if (!fs.existsSync(distDir)) continue;

    let entryNames: string[] = [];
    try {
      entryNames = fs.readdirSync(distDir)
        .filter((entryName) => entryName.endsWith('.js') || entryName.endsWith('.mjs'))
        .sort((left, right) => {
          const leftPriority = /^pi-embedded-.*\.js$/i.test(left) ? 0 : 1;
          const rightPriority = /^pi-embedded-.*\.js$/i.test(right) ? 0 : 1;
          if (leftPriority !== rightPriority) return leftPriority - rightPriority;
          return left.localeCompare(right);
        });
    } catch {
      continue;
    }

    for (const entryName of entryNames) {
      const targetPath = path.join(distDir, entryName);
      if (seen.has(targetPath)) continue;

      const backupPath = getOpenClawExecPreflightPatchBackupPath(targetPath);
      let shouldInclude = fs.existsSync(backupPath);

      if (!shouldInclude) {
        try {
          const source = readOpenClawExecPreflightSource(targetPath);
          shouldInclude = detectOpenClawExecPreflightValidatorSignature(source) !== null
            || isOpenClawExecPreflightBypassPatched(source);
        } catch {
          shouldInclude = false;
        }
      }

      if (!shouldInclude) continue;

      seen.add(targetPath);
      targets.push({
        packageRoot,
        targetPath,
        backupPath,
      });
    }
  }

  return targets;
}

export function snapshotOpenClawExecPreflightPatchFiles(
  targets = collectOpenClawExecPreflightPatchTargets(),
): FilePathSnapshot[] {
  return snapshotFilePaths(targets.flatMap((target) => [target.targetPath, target.backupPath]));
}

function patchOpenClawExecPreflightBypassTarget(target: OpenClawExecPreflightPatchTarget) {
  const source = readOpenClawExecPreflightSource(target.targetPath);
  if (isOpenClawExecPreflightBypassPatched(source)) {
    return;
  }

  const validatorSignature = detectOpenClawExecPreflightValidatorSignature(source);
  if (!validatorSignature) {
    throw new Error(`OpenClaw exec preflight validator signature not found in ${target.targetPath}.`);
  }

  if (!fs.existsSync(target.backupPath)) {
    fs.writeFileSync(target.backupPath, source);
  }

  const patchedSource = source.replace(
    validatorSignature,
    `${validatorSignature} return; /* ${OPENCLAW_EXEC_PREFLIGHT_BYPASS_MARKER} */`,
  );
  if (patchedSource === source) {
    throw new Error(`Failed to patch OpenClaw exec preflight validator in ${target.targetPath}.`);
  }

  fs.writeFileSync(target.targetPath, patchedSource);
}

function restoreOpenClawExecPreflightBypassTarget(target: OpenClawExecPreflightPatchTarget) {
  if (fs.existsSync(target.backupPath)) {
    fs.writeFileSync(target.targetPath, fs.readFileSync(target.backupPath, 'utf-8'));
    fs.rmSync(target.backupPath, { force: true });
    return;
  }

  if (!fs.existsSync(target.targetPath)) {
    return;
  }

  const source = readOpenClawExecPreflightSource(target.targetPath);
  if (!isOpenClawExecPreflightBypassPatched(source)) {
    return;
  }

  const restoredSource = source.replace(
    OPENCLAW_EXEC_PREFLIGHT_PATCHED_SIGNATURE,
    OPENCLAW_EXEC_PREFLIGHT_VALIDATOR_SIGNATURE,
  ).replace(
    new RegExp(`\\s*return; /\\* ${escapeRegExpForPattern(OPENCLAW_EXEC_PREFLIGHT_BYPASS_MARKER)} \\*/`),
    '',
  );
  if (restoredSource !== source && !isOpenClawExecPreflightBypassPatched(restoredSource)) {
    fs.writeFileSync(target.targetPath, restoredSource);
  }
}

export function readOpenClawExecPreflightBypassStatus(): OpenClawExecPreflightBypassStatus {
  const targets = collectOpenClawExecPreflightPatchTargets();
  if (targets.length === 0) {
    return {
      ready: false,
      targetCount: 0,
      patchedCount: 0,
      rawDetail: 'Could not locate the OpenClaw exec preflight bundle to patch.',
      targets,
    };
  }

  let patchedCount = 0;
  const unpatchedTargets: string[] = [];

  for (const target of targets) {
    try {
      const source = readOpenClawExecPreflightSource(target.targetPath);
      if (isOpenClawExecPreflightBypassPatched(source)) {
        patchedCount += 1;
      } else {
        unpatchedTargets.push(path.basename(target.targetPath));
      }
    } catch {
      unpatchedTargets.push(path.basename(target.targetPath));
    }
  }

  if (patchedCount === targets.length) {
    return {
      ready: true,
      targetCount: targets.length,
      patchedCount,
      rawDetail: null,
      targets,
    };
  }

  return {
    ready: false,
    targetCount: targets.length,
    patchedCount,
    rawDetail: `The OpenClaw exec preflight bypass is not active for: ${unpatchedTargets.join(', ')}`,
    targets,
  };
}

export function applyOpenClawExecPreflightBypass(enabled: boolean) {
  const targets = collectOpenClawExecPreflightPatchTargets();

  if (enabled && targets.length === 0) {
    throw new Error('Could not locate the OpenClaw exec preflight bundle for maximum permissions.');
  }

  for (const target of targets) {
    if (enabled) {
      patchOpenClawExecPreflightBypassTarget(target);
    } else {
      restoreOpenClawExecPreflightBypassTarget(target);
    }
  }

  if (enabled) {
    const status = readOpenClawExecPreflightBypassStatus();
    if (!status.ready) {
      throw new Error(status.rawDetail || 'Failed to activate the OpenClaw exec preflight bypass.');
    }
  }
}

export function synchronizeOpenClawExecPreflightBypassBestEffort(enabled: boolean) {
  try {
    applyOpenClawExecPreflightBypass(enabled);
  } catch (error) {
    console.error('Failed to synchronize the OpenClaw exec preflight bypass:', error);
  }
}

function getOpenClawBrowserFillCompatPatchBackupPath(targetPath: string) {
  return `${targetPath}${OPENCLAW_BROWSER_FILL_COMPAT_PATCH_BACKUP_SUFFIX}`;
}

function readOpenClawBrowserFillCompatSource(targetPath: string) {
  return fs.readFileSync(targetPath, 'utf-8');
}

function isOpenClawBrowserFillCompatCandidateEntryName(entryName: string) {
  return OPENCLAW_BROWSER_FILL_CANDIDATE_ENTRY_PATTERNS.some((pattern) => pattern.test(entryName));
}

function sourceHasOpenClawBrowserFillCompatSignatureOrMarker(source: string) {
  return source.includes(OPENCLAW_BROWSER_FILL_CLIENT_FIELD_SIGNATURE)
    || source.includes(OPENCLAW_BROWSER_FILL_LEGACY_CLIENT_ACTION_SIGNATURE)
    || source.includes(OPENCLAW_BROWSER_FILL_ROUTE_ACTION_SIGNATURE)
    || source.includes(OPENCLAW_BROWSER_FILL_PLUGIN_READ_FIELDS_SIGNATURE)
    || source.includes(OPENCLAW_BROWSER_FILL_VALUE_ALIAS_MARKER)
    || source.includes(OPENCLAW_BROWSER_FILL_FIELDS_ALIAS_MARKER)
    || source.includes(OPENCLAW_BROWSER_FILL_CLI_ALIAS_MARKER);
}

function isOpenClawBrowserFillCompatPatched(_target: OpenClawBrowserFillCompatPatchTarget, source: string) {
  const needsValueAlias = source.includes(OPENCLAW_BROWSER_FILL_CLIENT_FIELD_SIGNATURE)
    || source.includes(OPENCLAW_BROWSER_FILL_VALUE_ALIAS_MARKER);
  const needsFieldsAlias = source.includes(OPENCLAW_BROWSER_FILL_LEGACY_CLIENT_ACTION_SIGNATURE)
    || source.includes(OPENCLAW_BROWSER_FILL_ROUTE_ACTION_SIGNATURE)
    || source.includes(OPENCLAW_BROWSER_FILL_FIELDS_ALIAS_MARKER);
  const needsCliAlias = source.includes(OPENCLAW_BROWSER_FILL_PLUGIN_READ_FIELDS_SIGNATURE)
    || source.includes(OPENCLAW_BROWSER_FILL_CLI_ALIAS_MARKER);

  if (!needsValueAlias && !needsFieldsAlias && !needsCliAlias) {
    return false;
  }

  return (!needsValueAlias || source.includes(OPENCLAW_BROWSER_FILL_VALUE_ALIAS_MARKER))
    && (!needsFieldsAlias || source.includes(OPENCLAW_BROWSER_FILL_FIELDS_ALIAS_MARKER))
    && (!needsCliAlias || source.includes(OPENCLAW_BROWSER_FILL_CLI_ALIAS_MARKER));
}

function collectOpenClawBrowserFillCompatPatchTargets(): OpenClawBrowserFillCompatPatchTarget[] {
  const targets: OpenClawBrowserFillCompatPatchTarget[] = [];
  const seen = new Set<string>();

  for (const packageRoot of collectOpenClawPackageRoots()) {
    const distDir = path.join(packageRoot, 'dist');
    if (!fs.existsSync(distDir)) continue;

    let entryNames: string[] = [];
    try {
      entryNames = fs.readdirSync(distDir)
        .filter((entryName) => entryName.endsWith('.js'))
        .sort((left, right) => left.localeCompare(right));
    } catch {
      continue;
    }

    for (const entryName of entryNames) {
      if (!isOpenClawBrowserFillCompatCandidateEntryName(entryName)) continue;

      const targetPath = path.join(distDir, entryName);
      if (seen.has(targetPath)) continue;

      const backupPath = getOpenClawBrowserFillCompatPatchBackupPath(targetPath);
      const target: OpenClawBrowserFillCompatPatchTarget = {
        packageRoot,
        targetPath,
        backupPath,
        kind: 'browser-fill-source',
      };

      let shouldInclude = fs.existsSync(backupPath);
      if (!shouldInclude) {
        try {
          const source = readOpenClawBrowserFillCompatSource(targetPath);
          shouldInclude = sourceHasOpenClawBrowserFillCompatSignatureOrMarker(source);
        } catch {
          shouldInclude = false;
        }
      }

      if (!shouldInclude) continue;

      seen.add(targetPath);
      targets.push(target);
    }
  }

  return targets;
}

function patchOpenClawBrowserFillCompatTarget(target: OpenClawBrowserFillCompatPatchTarget) {
  const source = readOpenClawBrowserFillCompatSource(target.targetPath);
  if (isOpenClawBrowserFillCompatPatched(target, source)) {
    return;
  }

  let patchedSource = source;

  if (!patchedSource.includes(OPENCLAW_BROWSER_FILL_VALUE_ALIAS_MARKER)
    && patchedSource.includes(OPENCLAW_BROWSER_FILL_CLIENT_FIELD_SIGNATURE)) {
    const nextSource = patchedSource.replace(
      OPENCLAW_BROWSER_FILL_CLIENT_FIELD_SIGNATURE,
      OPENCLAW_BROWSER_FILL_CLIENT_FIELD_PATCHED_SIGNATURE,
    );
    if (nextSource === patchedSource) {
      throw new Error(`Failed to patch the OpenClaw browser fill value alias in ${target.targetPath}.`);
    }
    patchedSource = nextSource;
  }

  if (!patchedSource.includes(OPENCLAW_BROWSER_FILL_FIELDS_ALIAS_MARKER)) {
    if (patchedSource.includes(OPENCLAW_BROWSER_FILL_ROUTE_ACTION_SIGNATURE)) {
      const nextSource = patchedSource.replace(
        OPENCLAW_BROWSER_FILL_ROUTE_ACTION_SIGNATURE,
        OPENCLAW_BROWSER_FILL_ROUTE_ACTION_PATCHED_SIGNATURE,
      );
      if (nextSource === patchedSource) {
        throw new Error(`Failed to patch the OpenClaw browser fill fields alias in ${target.targetPath}.`);
      }
      patchedSource = nextSource;
    } else if (patchedSource.includes(OPENCLAW_BROWSER_FILL_LEGACY_CLIENT_ACTION_SIGNATURE)) {
      const nextSource = patchedSource.replace(
        OPENCLAW_BROWSER_FILL_LEGACY_CLIENT_ACTION_SIGNATURE,
        OPENCLAW_BROWSER_FILL_LEGACY_CLIENT_ACTION_PATCHED_SIGNATURE,
      );
      if (nextSource === patchedSource) {
        throw new Error(`Failed to patch the OpenClaw browser fill legacy fields alias in ${target.targetPath}.`);
      }
      patchedSource = nextSource;
    }
  }

  if (!patchedSource.includes(OPENCLAW_BROWSER_FILL_CLI_ALIAS_MARKER)
    && patchedSource.includes(OPENCLAW_BROWSER_FILL_PLUGIN_READ_FIELDS_SIGNATURE)) {
    const nextSource = patchedSource.replace(
      OPENCLAW_BROWSER_FILL_PLUGIN_READ_FIELDS_SIGNATURE,
      OPENCLAW_BROWSER_FILL_PLUGIN_READ_FIELDS_PATCHED_SIGNATURE,
    );
    if (nextSource === patchedSource) {
      throw new Error(`Failed to patch the OpenClaw browser fill CLI alias in ${target.targetPath}.`);
    }
    patchedSource = nextSource;
  }

  if (patchedSource === source) {
    if (!isOpenClawBrowserFillCompatPatched(target, source)) {
      throw new Error(`OpenClaw browser fill compatibility signature not found in ${target.targetPath}.`);
    }
    return;
  }

  if (!fs.existsSync(target.backupPath)) {
    fs.writeFileSync(target.backupPath, source);
  }

  fs.writeFileSync(target.targetPath, patchedSource);
}

function readOpenClawBrowserFillCompatStatus(): OpenClawBrowserFillCompatStatus {
  const targets = collectOpenClawBrowserFillCompatPatchTargets();
  if (targets.length === 0) {
    return {
      ready: false,
      targetCount: 0,
      patchedCount: 0,
      rawDetail: 'Could not locate the OpenClaw browser fill bundle to patch.',
      targets,
    };
  }

  let patchedCount = 0;
  const unpatchedTargets: string[] = [];

  for (const target of targets) {
    try {
      const source = readOpenClawBrowserFillCompatSource(target.targetPath);
      if (isOpenClawBrowserFillCompatPatched(target, source)) {
        patchedCount += 1;
      } else {
        unpatchedTargets.push(path.basename(target.targetPath));
      }
    } catch {
      unpatchedTargets.push(path.basename(target.targetPath));
    }
  }

  if (patchedCount === targets.length) {
    return {
      ready: true,
      targetCount: targets.length,
      patchedCount,
      rawDetail: null,
      targets,
    };
  }

  return {
    ready: false,
    targetCount: targets.length,
    patchedCount,
    rawDetail: `The OpenClaw browser fill compatibility patch is not active for: ${unpatchedTargets.join(', ')}`,
    targets,
  };
}

function applyOpenClawBrowserFillCompatPatch() {
  const targets = collectOpenClawBrowserFillCompatPatchTargets();
  if (targets.length === 0) {
    throw new Error('Could not locate the OpenClaw browser fill bundle to patch.');
  }

  for (const target of targets) {
    patchOpenClawBrowserFillCompatTarget(target);
  }

  const status = readOpenClawBrowserFillCompatStatus();
  if (!status.ready) {
    throw new Error(status.rawDetail || 'Failed to activate the OpenClaw browser fill compatibility patch.');
  }
}

export function synchronizeOpenClawBrowserFillCompatBestEffort() {
  try {
    applyOpenClawBrowserFillCompatPatch();
  } catch (error) {
    console.error('Failed to synchronize the OpenClaw browser fill compatibility patch:', error);
  }
}
