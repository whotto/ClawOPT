import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { pathToFileURL } from 'url';
import type { WorkspaceUploadLink } from './message-upload-rewrite';

export const CHAT_AUDIO_TRANSCRIPTION_UNAVAILABLE_ERROR_CODE = 'chat.audioTranscriptionUnavailable';
export const CHAT_AUDIO_TRANSCRIPTION_FAILED_ERROR_CODE = 'chat.audioTranscriptionFailed';

const OPENCLAW_HOME = path.join(os.homedir(), '.openclaw');
const OPENCLAW_CONFIG_PATH = path.join(OPENCLAW_HOME, 'openclaw.json');
const OPENCLAW_DIST_DIR = path.join(os.homedir(), '.npm-global', 'lib', 'node_modules', 'openclaw', 'dist');
const MANAGED_AUDIO_RUNTIME_DIR = path.join(OPENCLAW_HOME, 'host-tools', 'audio-transcription');
const MANAGED_AUDIO_RUNTIME_VENV_DIR = path.join(MANAGED_AUDIO_RUNTIME_DIR, 'venv');
const MANAGED_AUDIO_RUNTIME_PYTHON_PATH = path.join(MANAGED_AUDIO_RUNTIME_VENV_DIR, 'bin', 'python');
const AUDIO_PROVIDER_CACHE_TTL_MS = 30_000;
const AUDIO_TRANSCRIPTION_TIMEOUT_MS = 90_000;
const LOCAL_AUDIO_DISCOVERY_TIMEOUT_MS = 15_000;
const LOCAL_AUDIO_TRANSCRIPTION_MIN_TIMEOUT_MS = 10 * 60 * 1000;
const LOCAL_AUDIO_TRANSCRIPTION_MAX_TIMEOUT_MS = 90 * 60 * 1000;
const LOCAL_AUDIO_TRANSCRIPTION_TIMEOUT_MULTIPLIER = 1.5;
const LOCAL_AUDIO_TRANSCRIPTION_TIMEOUT_BUFFER_MS = 5 * 60 * 1000;
const LOCAL_AUDIO_DURATION_PROBE_TIMEOUT_MS = 15_000;
const LOCAL_AUDIO_RUNTIME_BOOTSTRAP_TIMEOUT_MS = 20 * 60 * 1000;
const LOCAL_AUDIO_FALLBACK_MODEL = 'base';
const LOCAL_AUDIO_RUNTIME_PACKAGE = 'faster-whisper';
const LOCAL_AUDIO_BACKEND_DISCOVERY_SCRIPT = [
  'import importlib.util',
  'backend = ""',
  'if importlib.util.find_spec("faster_whisper") is not None:',
  '    backend = "faster_whisper"',
  'elif importlib.util.find_spec("whisper") is not None:',
  '    backend = "whisper"',
  'print(backend)',
].join('\n');
const LOCAL_AUDIO_TRANSCRIPTION_SCRIPT = [
  'import json',
  'import os',
  'import sys',
  'backend = None',
  'text = ""',
  'errors = []',
  'file_path = sys.argv[1]',
  'model_name = sys.argv[2]',
  'device = "cpu"',
  'compute_type = "int8"',
  'cpu_threads = max(1, (os.cpu_count() or 4) - 1)',
  'try:',
  '    import ctranslate2',
  '    if getattr(ctranslate2, "get_cuda_device_count", lambda: 0)() > 0:',
  '        device = "cuda"',
  '        compute_type = "float16"',
  'except Exception:',
  '    pass',
  'try:',
  '    from faster_whisper import WhisperModel',
  '    model_kwargs = {"device": device, "compute_type": compute_type}',
  '    if device == "cpu":',
  '        model_kwargs["cpu_threads"] = cpu_threads',
  '    model = WhisperModel(model_name, **model_kwargs)',
  '    segments, _ = model.transcribe(file_path, vad_filter=True)',
  '    text = " ".join((segment.text or "").strip() for segment in segments if (segment.text or "").strip()).strip()',
  '    backend = "faster_whisper"',
  'except Exception as exc:',
  '    errors.append(f"faster_whisper: {exc}")',
  'if backend is None:',
  '    try:',
  '        import whisper',
  '        model = whisper.load_model(model_name)',
  '        result = model.transcribe(file_path, fp16=False)',
  '        text = (result.get("text") or "").strip()',
  '        backend = "whisper"',
  '    except Exception as exc:',
  '        errors.append(f"whisper: {exc}")',
  'print(json.dumps({"backend": backend, "text": text, "error": "; ".join(errors)}, ensure_ascii=False))',
  'sys.exit(0 if backend else 3)',
].join('\n');

type OpenClawRuntimeConfig = Record<string, any>;

type OpenClawRuntimeModule = {
  transcribeAudioFile: (params: {
    filePath: string;
    cfg: OpenClawRuntimeConfig;
    agentDir: string;
  }) => Promise<{ text?: string }>;
};

type OpenClawEntryCapabilitiesModule = {
  r: (
    overrides: undefined,
    cfg: OpenClawRuntimeConfig
  ) => Map<string, { transcribeAudio?: unknown; defaultModels?: Record<string, string> }>;
};

type OpenClawModelAuthModule = {
  a: (params: {
    provider: string;
    cfg: OpenClawRuntimeConfig;
    agentDir: string;
  }) => Promise<boolean>;
};

type LoadedAudioModules = {
  runtime: OpenClawRuntimeModule;
  entryCapabilities: OpenClawEntryCapabilitiesModule;
  modelAuth: OpenClawModelAuthModule;
};

type CachedAudioProviderAvailability = {
  checkedAt: number;
  configMtimeMs: number;
  availableProviders: string[];
  checkedProviders: string[];
};

type LocalAudioBackend = 'faster_whisper' | 'whisper';

type CachedLocalAudioBackendAvailability = {
  checkedAt: number;
  pythonCommand: string | null;
  backend: LocalAudioBackend | null;
  detail: string;
};

export type PreparedAudioTranscript = {
  displayName: string;
  absolutePath: string;
  mimeType: string | null;
  text: string;
};

export class AudioPreparationError extends Error {
  readonly messageCode: string;
  readonly rawDetail: string;

  constructor(messageCode: string, rawDetail: string) {
    super(rawDetail);
    this.name = 'AudioPreparationError';
    this.messageCode = messageCode;
    this.rawDetail = rawDetail;
  }
}

let loadedAudioModulesPromise: Promise<LoadedAudioModules> | null = null;
const audioProviderAvailabilityCache = new Map<string, CachedAudioProviderAvailability>();
let localAudioBackendCache: CachedLocalAudioBackendAvailability | null = null;
let managedLocalAudioRuntimeBootstrapPromise: Promise<CachedLocalAudioBackendAvailability> | null = null;
const nativeDynamicImport = new Function(
  'specifier',
  'return import(specifier);'
) as (specifier: string) => Promise<unknown>;

function importOpenClawModule<T>(filePath: string): Promise<T> {
  return nativeDynamicImport(pathToFileURL(filePath).href) as Promise<T>;
}

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

function extractLastNonEmptyLine(value: string): string {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1] : '';
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function normalizeDetailLines(value: string): string[] {
  return stripAnsi(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function dedupeDetailLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const line of lines) {
    if (seen.has(line)) continue;
    seen.add(line);
    deduped.push(line);
  }

  return deduped;
}

function filterBenignLocalAudioStderr(stderr: string): string {
  const benignPatterns = [
    /The compute type inferred from the saved model is float16/i,
    /Skipping pci_bus_id/i,
    /did? not match expected pattern/i,
  ];

  return dedupeDetailLines(normalizeDetailLines(stderr))
    .filter((line) => !benignPatterns.some((pattern) => pattern.test(line)))
    .join('\n');
}

function parseLocalAudioTranscriptionPayload(value: string): {
  backend?: string | null;
  text?: string | null;
  error?: string | null;
} | null {
  const lines = normalizeDetailLines(value);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    try {
      return JSON.parse(line) as {
        backend?: string | null;
        text?: string | null;
        error?: string | null;
      };
    } catch {}
  }

  return null;
}

async function probeAudioDurationMs(filePath: string): Promise<number | null> {
  try {
    const result = await execFileText(
      'ffprobe',
      [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'json',
        filePath,
      ],
      LOCAL_AUDIO_DURATION_PROBE_TIMEOUT_MS
    );
    const payload = JSON.parse(result.stdout) as { format?: { duration?: string | number } };
    const durationSeconds = Number(payload?.format?.duration);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      return null;
    }
    return Math.ceil(durationSeconds * 1000);
  } catch {
    return null;
  }
}

function computeLocalAudioTranscriptionTimeoutMs(durationMs: number | null): number {
  if (!durationMs || durationMs <= 0) {
    return LOCAL_AUDIO_TRANSCRIPTION_MIN_TIMEOUT_MS;
  }

  const scaledTimeout = Math.ceil((durationMs * LOCAL_AUDIO_TRANSCRIPTION_TIMEOUT_MULTIPLIER) + LOCAL_AUDIO_TRANSCRIPTION_TIMEOUT_BUFFER_MS);
  return Math.max(
    LOCAL_AUDIO_TRANSCRIPTION_MIN_TIMEOUT_MS,
    Math.min(LOCAL_AUDIO_TRANSCRIPTION_MAX_TIMEOUT_MS, scaledTimeout)
  );
}

function formatTimeoutMinutes(timeoutMs: number): number {
  return Math.max(1, Math.round(timeoutMs / 60_000));
}

async function inspectLocalAudioBackendWithPython(pythonCommand: string): Promise<CachedLocalAudioBackendAvailability | null> {
  try {
    const result = await execFileText(
      pythonCommand,
      ['-c', LOCAL_AUDIO_BACKEND_DISCOVERY_SCRIPT],
      LOCAL_AUDIO_DISCOVERY_TIMEOUT_MS
    );
    const backend = extractLastNonEmptyLine(result.stdout);

    if (backend === 'faster_whisper' || backend === 'whisper') {
      return {
        checkedAt: Date.now(),
        pythonCommand,
        backend,
        detail: `${backend} via ${pythonCommand}`,
      };
    }
  } catch {}

  return null;
}

async function loadAudioModules(): Promise<LoadedAudioModules> {
  if (!loadedAudioModulesPromise) {
    loadedAudioModulesPromise = Promise.all([
      importOpenClawModule<OpenClawRuntimeModule>(path.join(OPENCLAW_DIST_DIR, 'runtime-BAhPozfv.js')),
      importOpenClawModule<OpenClawEntryCapabilitiesModule>(path.join(OPENCLAW_DIST_DIR, 'entry-capabilities-BkYBkUwC.js')),
      importOpenClawModule<OpenClawModelAuthModule>(path.join(OPENCLAW_DIST_DIR, 'model-auth-RU1Lwgn8.js')),
    ]).then(([runtime, entryCapabilities, modelAuth]) => ({
      runtime,
      entryCapabilities,
      modelAuth,
    }));
  }

  return loadedAudioModulesPromise;
}

async function bootstrapManagedLocalAudioRuntime(): Promise<CachedLocalAudioBackendAvailability> {
  if (managedLocalAudioRuntimeBootstrapPromise) {
    return managedLocalAudioRuntimeBootstrapPromise;
  }

  managedLocalAudioRuntimeBootstrapPromise = (async () => {
    fs.mkdirSync(MANAGED_AUDIO_RUNTIME_DIR, { recursive: true });

    if (!fs.existsSync(MANAGED_AUDIO_RUNTIME_PYTHON_PATH)) {
      await execFileText(
        'python3',
        ['-m', 'venv', MANAGED_AUDIO_RUNTIME_VENV_DIR],
        LOCAL_AUDIO_RUNTIME_BOOTSTRAP_TIMEOUT_MS
      );
    }

    const managedEnv = {
      ...process.env,
      PIP_DISABLE_PIP_VERSION_CHECK: '1',
      PYTHONUNBUFFERED: '1',
    };

    await execFileText(
      MANAGED_AUDIO_RUNTIME_PYTHON_PATH,
      ['-m', 'pip', 'install', '--upgrade', 'pip', 'setuptools', 'wheel'],
      LOCAL_AUDIO_RUNTIME_BOOTSTRAP_TIMEOUT_MS,
      { env: managedEnv }
    );
    await execFileText(
      MANAGED_AUDIO_RUNTIME_PYTHON_PATH,
      ['-m', 'pip', 'install', '--upgrade', '--prefer-binary', LOCAL_AUDIO_RUNTIME_PACKAGE],
      LOCAL_AUDIO_RUNTIME_BOOTSTRAP_TIMEOUT_MS,
      { env: managedEnv }
    );

    const detected = await inspectLocalAudioBackendWithPython(MANAGED_AUDIO_RUNTIME_PYTHON_PATH);
    if (!detected?.backend) {
      throw new Error(`Managed audio transcription runtime was installed at ${MANAGED_AUDIO_RUNTIME_VENV_DIR}, but no usable backend was detected afterwards.`);
    }

    localAudioBackendCache = detected;
    return detected;
  })()
    .finally(() => {
      managedLocalAudioRuntimeBootstrapPromise = null;
    });

  return managedLocalAudioRuntimeBootstrapPromise;
}

async function detectLocalAudioBackend(
  options: { allowAutoBootstrap?: boolean } = {}
): Promise<CachedLocalAudioBackendAvailability> {
  if (
    localAudioBackendCache
    && (Date.now() - localAudioBackendCache.checkedAt) < AUDIO_PROVIDER_CACHE_TTL_MS
  ) {
    return localAudioBackendCache;
  }

  const pythonCommands = [
    MANAGED_AUDIO_RUNTIME_PYTHON_PATH,
    'python3',
    'python',
  ];

  for (const pythonCommand of pythonCommands) {
    const detected = await inspectLocalAudioBackendWithPython(pythonCommand);
    if (detected) {
      localAudioBackendCache = detected;
      return localAudioBackendCache;
    }
  }

  if (options.allowAutoBootstrap) {
    try {
      return await bootstrapManagedLocalAudioRuntime();
    } catch (error: any) {
      localAudioBackendCache = {
        checkedAt: Date.now(),
        pythonCommand: MANAGED_AUDIO_RUNTIME_PYTHON_PATH,
        backend: null,
        detail: typeof error?.message === 'string' && error.message.trim()
          ? error.message.trim()
          : 'Managed audio transcription runtime bootstrap failed.',
      };
      return localAudioBackendCache;
    }
  }

  localAudioBackendCache = {
    checkedAt: Date.now(),
    pythonCommand: null,
    backend: null,
    detail: 'No local whisper or faster-whisper runtime detected.',
  };
  return localAudioBackendCache;
}

function readOpenClawRuntimeConfig(): OpenClawRuntimeConfig {
  return JSON.parse(fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf8')) as OpenClawRuntimeConfig;
}

function getOpenClawAgentDir(agentId: string): string {
  return path.join(OPENCLAW_HOME, 'agents', agentId || 'main', 'agent');
}

async function getAvailableAudioProviders(agentId: string): Promise<CachedAudioProviderAvailability> {
  const resolvedAgentId = agentId || 'main';
  const configStat = fs.statSync(OPENCLAW_CONFIG_PATH);
  const cached = audioProviderAvailabilityCache.get(resolvedAgentId);

  if (
    cached
    && cached.configMtimeMs === configStat.mtimeMs
    && (Date.now() - cached.checkedAt) < AUDIO_PROVIDER_CACHE_TTL_MS
  ) {
    return cached;
  }

  const cfg = readOpenClawRuntimeConfig();
  const agentDir = getOpenClawAgentDir(resolvedAgentId);
  const { entryCapabilities, modelAuth } = await loadAudioModules();
  const registry = entryCapabilities.r(undefined, cfg);
  const checkedProviders = [...registry.entries()]
    .filter(([, provider]) => typeof provider?.transcribeAudio === 'function')
    .map(([providerId]) => providerId);

  const providerAvailability = await Promise.all(
    checkedProviders.map(async (providerId) => {
      try {
        const available = await modelAuth.a({
          provider: providerId,
          cfg,
          agentDir,
        });

        return { providerId, available };
      } catch {
        return { providerId, available: false };
      }
    })
  );

  const nextValue: CachedAudioProviderAvailability = {
    checkedAt: Date.now(),
    configMtimeMs: configStat.mtimeMs,
    checkedProviders,
    availableProviders: providerAvailability
      .filter((entry) => entry.available)
      .map((entry) => entry.providerId),
  };

  audioProviderAvailabilityCache.set(resolvedAgentId, nextValue);
  return nextValue;
}

function dedupeAudioUploads(uploads: WorkspaceUploadLink[]): WorkspaceUploadLink[] {
  const seen = new Set<string>();
  const deduped: WorkspaceUploadLink[] = [];

  for (const upload of uploads) {
    if (upload.kind !== 'audio') continue;
    if (seen.has(upload.absolutePath)) continue;
    seen.add(upload.absolutePath);
    deduped.push(upload);
  }

  return deduped;
}

async function transcribeAudioWithLocalBackend(
  upload: WorkspaceUploadLink,
  options: { allowAutoBootstrap?: boolean } = {}
): Promise<PreparedAudioTranscript | null> {
  const localBackend = await detectLocalAudioBackend(options);

  if (!localBackend.backend || !localBackend.pythonCommand) {
    return null;
  }

  const displayName = upload.altText || upload.filename;
  const durationMs = await probeAudioDurationMs(upload.absolutePath);
  const timeoutMs = computeLocalAudioTranscriptionTimeoutMs(durationMs);

  try {
    const result = await execFileText(
      localBackend.pythonCommand,
      ['-c', LOCAL_AUDIO_TRANSCRIPTION_SCRIPT, upload.absolutePath, LOCAL_AUDIO_FALLBACK_MODEL],
      timeoutMs
    );
    const payload = parseLocalAudioTranscriptionPayload(result.stdout);
    if (!payload) {
      throw new Error(`Local audio transcription returned no output for "${displayName}".`);
    }
    const transcriptText = typeof payload.text === 'string' ? payload.text.trim() : '';

    if (!transcriptText) {
      const detail = typeof payload.error === 'string' && payload.error.trim()
        ? payload.error.trim()
        : `Local audio transcription returned no text for "${displayName}".`;
      throw new Error(detail);
    }

    return {
      displayName,
      absolutePath: upload.absolutePath,
      mimeType: upload.mimeType,
      text: transcriptText,
    };
  } catch (error: any) {
    const stdout = typeof error?.stdout === 'string' && error.stdout.trim()
      ? error.stdout.trim()
      : '';
    const payload = parseLocalAudioTranscriptionPayload(stdout);
    const transcriptText = typeof payload?.text === 'string' ? payload.text.trim() : '';
    if (payload?.backend && transcriptText) {
      return {
        displayName,
        absolutePath: upload.absolutePath,
        mimeType: upload.mimeType,
        text: transcriptText,
      };
    }

    const stderr = typeof error?.stderr === 'string' && error.stderr.trim()
      ? filterBenignLocalAudioStderr(error.stderr)
      : '';
    const payloadError = typeof payload?.error === 'string' && payload.error.trim()
      ? payload.error.trim()
      : '';
    const normalizedMessage = typeof error?.message === 'string' && error.message.trim()
      ? error.message.trim()
      : '';
    const likelyTimeout = error?.killed === true || error?.signal === 'SIGTERM' || /timed? out/i.test(normalizedMessage);
    const detail = payloadError
      || (likelyTimeout
        ? `Local audio transcription timed out after ${formatTimeoutMinutes(timeoutMs)} minutes for "${displayName}".`
        : `Local audio transcription failed for "${displayName}".`);

    throw new Error(
      [detail, stderr]
        .filter(Boolean)
        .join(' | ')
    );
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(timeoutMessage));
    }, timeoutMs);

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export async function prepareAudioTranscriptsFromUploads(
  uploads: WorkspaceUploadLink[],
  agentId: string
): Promise<PreparedAudioTranscript[]> {
  const audioUploads = dedupeAudioUploads(uploads);
  if (audioUploads.length === 0) {
    return [];
  }

  try {
    const resolvedAgentId = agentId || 'main';
    const providerAvailability = await getAvailableAudioProviders(resolvedAgentId)
      .catch(() => ({
        checkedAt: Date.now(),
        configMtimeMs: 0,
        availableProviders: [],
        checkedProviders: [] as string[],
      }));
    const localBackend = await detectLocalAudioBackend({
      allowAutoBootstrap: providerAvailability.availableProviders.length === 0,
    });

    const cfg = readOpenClawRuntimeConfig();
    const { runtime } = await loadAudioModules();
    const agentDir = getOpenClawAgentDir(resolvedAgentId);
    const transcripts: PreparedAudioTranscript[] = [];

    for (const upload of audioUploads) {
      const displayName = upload.altText || upload.filename;
      try {
        if (providerAvailability.availableProviders.length > 0) {
          const result = await withTimeout(
            runtime.transcribeAudioFile({
              filePath: upload.absolutePath,
              cfg,
              agentDir,
            }),
            AUDIO_TRANSCRIPTION_TIMEOUT_MS,
            `Audio transcription timed out for "${displayName}".`
          );

          const transcriptText = typeof result?.text === 'string' ? result.text.trim() : '';
          if (!transcriptText) {
            throw new Error(
              `Audio transcription returned no text for "${displayName}".`
            );
          }

          transcripts.push({
            displayName,
            absolutePath: upload.absolutePath,
            mimeType: upload.mimeType,
            text: transcriptText,
          });
          continue;
        }

        const localTranscript = await transcribeAudioWithLocalBackend(upload, { allowAutoBootstrap: true });
        if (localTranscript) {
          transcripts.push(localTranscript);
          continue;
        }

        const checkedProviders = providerAvailability.checkedProviders.length > 0
          ? providerAvailability.checkedProviders.join(', ')
          : 'none';

        throw new AudioPreparationError(
          CHAT_AUDIO_TRANSCRIPTION_UNAVAILABLE_ERROR_CODE,
          `No usable audio transcription path is configured for agent "${resolvedAgentId}". OpenClaw providers: ${checkedProviders}. Local fallback: ${localBackend.detail}`
        );
      } catch (error: any) {
        if (
          providerAvailability.availableProviders.length > 0
          && !(error instanceof AudioPreparationError)
        ) {
          const localTranscript = await transcribeAudioWithLocalBackend(upload, { allowAutoBootstrap: true }).catch(() => null);
          if (localTranscript) {
            transcripts.push(localTranscript);
            continue;
          }
        }

        const detail = typeof error?.message === 'string' && error.message.trim()
          ? error.message.trim()
          : `Audio transcription failed for "${displayName}".`;

        throw new AudioPreparationError(CHAT_AUDIO_TRANSCRIPTION_FAILED_ERROR_CODE, detail);
      }
    }

    return transcripts;
  } catch (error) {
    if (error instanceof AudioPreparationError) {
      throw error;
    }

    const detail = error instanceof Error && error.message.trim()
      ? error.message.trim()
      : 'Audio transcription failed before the model request started.';

    throw new AudioPreparationError(CHAT_AUDIO_TRANSCRIPTION_FAILED_ERROR_CODE, detail);
  }
}

export async function ensureManagedLocalAudioRuntimeReady(): Promise<CachedLocalAudioBackendAvailability> {
  return detectLocalAudioBackend({ allowAutoBootstrap: true });
}

export function buildAudioTranscriptContext(transcripts: PreparedAudioTranscript[]): string {
  if (transcripts.length === 0) {
    return '';
  }

  const sections = transcripts.map((transcript, index) => [
    `[System audio transcript ${index + 1}: ${transcript.displayName}]`,
    'The following text was automatically transcribed from an uploaded audio file. It may contain recognition mistakes, so use it together with the original file path when analyzing the audio.',
    transcript.text,
  ].join('\n\n'));

  return [
    '[System note: audio attachments were automatically transcribed before this turn was sent to the model.]',
    ...sections,
  ].join('\n\n');
}
