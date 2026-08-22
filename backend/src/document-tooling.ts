import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import type { WorkspaceUploadLink } from './message-upload-rewrite';

const OPENCLAW_HOME = path.join(os.homedir(), '.openclaw');
const MANAGED_DOCUMENT_RUNTIME_DIR = path.join(OPENCLAW_HOME, 'host-tools', 'document-tooling');
const MANAGED_DOCUMENT_RUNTIME_VENV_DIR = path.join(MANAGED_DOCUMENT_RUNTIME_DIR, 'venv');
export const MANAGED_DOCUMENT_RUNTIME_PYTHON_PATH = path.join(MANAGED_DOCUMENT_RUNTIME_VENV_DIR, 'bin', 'python');
const MANAGED_DOCUMENT_RUNTIME_BOOTSTRAP_TIMEOUT_MS = 20 * 60 * 1000;
const MANAGED_DOCUMENT_RUNTIME_PACKAGES = [
  'python-pptx',
  'reportlab',
  'pypdf',
  'pdfplumber',
  'openpyxl',
] as const;
const MANAGED_DOCUMENT_RUNTIME_IMPORTS = [
  'pptx',
  'reportlab',
  'pypdf',
  'pdfplumber',
  'openpyxl',
] as const;

export const MANAGED_DOCUMENT_RUNTIME_PACKAGE_SUMMARY = MANAGED_DOCUMENT_RUNTIME_PACKAGES.join(', ');

export type ManagedDocumentToolingStatus = {
  pythonPath: string;
  ready: boolean;
  packages: readonly string[];
};

let managedDocumentRuntimeBootstrapPromise: Promise<ManagedDocumentToolingStatus> | null = null;

function execFileText(
  file: string,
  args: string[],
  timeoutMs: number,
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      cwd: options.cwd,
      env: options.env,
    }, (error, stdout, stderr) => {
      if (error) {
        const enrichedError = error as Error & { stdout?: string; stderr?: string };
        enrichedError.stdout = stdout;
        enrichedError.stderr = stderr;
        reject(enrichedError);
        return;
      }

      resolve({
        stdout: typeof stdout === 'string' ? stdout : String(stdout || ''),
        stderr: typeof stderr === 'string' ? stderr : String(stderr || ''),
      });
    });
  });
}

async function isManagedDocumentRuntimeReady() {
  if (!fs.existsSync(MANAGED_DOCUMENT_RUNTIME_PYTHON_PATH)) {
    return false;
  }

  try {
    await execFileText(
      MANAGED_DOCUMENT_RUNTIME_PYTHON_PATH,
      [
        '-c',
        `import ${MANAGED_DOCUMENT_RUNTIME_IMPORTS.join(', ')}`
      ],
      20_000,
      {
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1',
        },
      }
    );
    return true;
  } catch {
    return false;
  }
}

export function buildManagedDocumentToolingInstruction() {
  return `Managed document tooling Python: ${MANAGED_DOCUMENT_RUNTIME_PYTHON_PATH} (includes ${MANAGED_DOCUMENT_RUNTIME_PACKAGE_SUMMARY} for PDF/Office extraction and PPTX generation when the system Python lacks these modules).`;
}

export function hasDocumentUploads(linkedUploads: WorkspaceUploadLink[]) {
  return linkedUploads.some((upload) => upload.kind === 'document' && upload.absolutePath);
}

export function buildDocumentToolingContext(linkedUploads: WorkspaceUploadLink[]) {
  const documentUploads = linkedUploads.filter((upload) => upload.kind === 'document' && upload.absolutePath);
  if (documentUploads.length === 0) {
    return '';
  }

  return [
    '[System note: uploaded document files for this turn are also available at the absolute paths below. If the model cannot natively inspect them, it must read or convert them locally before answering.]',
    ...documentUploads.map((upload, index) => `${index + 1}. ${upload.absolutePath} (${upload.filename})`),
    `[System note: ${buildManagedDocumentToolingInstruction()}]`,
  ].join('\n');
}

export async function ensureManagedDocumentToolingReady(): Promise<ManagedDocumentToolingStatus> {
  if (await isManagedDocumentRuntimeReady()) {
    return {
      pythonPath: MANAGED_DOCUMENT_RUNTIME_PYTHON_PATH,
      ready: true,
      packages: MANAGED_DOCUMENT_RUNTIME_PACKAGES,
    };
  }

  if (managedDocumentRuntimeBootstrapPromise) {
    return managedDocumentRuntimeBootstrapPromise;
  }

  managedDocumentRuntimeBootstrapPromise = (async () => {
    fs.mkdirSync(MANAGED_DOCUMENT_RUNTIME_DIR, { recursive: true });

    if (!fs.existsSync(MANAGED_DOCUMENT_RUNTIME_PYTHON_PATH)) {
      await execFileText(
        'python3',
        ['-m', 'venv', MANAGED_DOCUMENT_RUNTIME_VENV_DIR],
        MANAGED_DOCUMENT_RUNTIME_BOOTSTRAP_TIMEOUT_MS
      );
    }

    const managedEnv = {
      ...process.env,
      PIP_DISABLE_PIP_VERSION_CHECK: '1',
      PYTHONUNBUFFERED: '1',
    };

    await execFileText(
      MANAGED_DOCUMENT_RUNTIME_PYTHON_PATH,
      ['-m', 'pip', 'install', '--upgrade', 'pip', 'setuptools', 'wheel'],
      MANAGED_DOCUMENT_RUNTIME_BOOTSTRAP_TIMEOUT_MS,
      { env: managedEnv }
    );
    await execFileText(
      MANAGED_DOCUMENT_RUNTIME_PYTHON_PATH,
      ['-m', 'pip', 'install', '--upgrade', '--prefer-binary', ...MANAGED_DOCUMENT_RUNTIME_PACKAGES],
      MANAGED_DOCUMENT_RUNTIME_BOOTSTRAP_TIMEOUT_MS,
      { env: managedEnv }
    );

    if (!await isManagedDocumentRuntimeReady()) {
      throw new Error(`Managed document runtime was installed at ${MANAGED_DOCUMENT_RUNTIME_VENV_DIR}, but required packages are still unavailable.`);
    }

    return {
      pythonPath: MANAGED_DOCUMENT_RUNTIME_PYTHON_PATH,
      ready: true,
      packages: MANAGED_DOCUMENT_RUNTIME_PACKAGES,
    };
  })()
    .finally(() => {
      managedDocumentRuntimeBootstrapPromise = null;
    });

  return managedDocumentRuntimeBootstrapPromise;
}
