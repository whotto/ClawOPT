import os from 'os';
import path from 'path';
import fs from 'fs';
import axios from 'axios';

import { readCliErrorDetail } from '../core/process';
import { normalizeCliText, sleep } from '../core/util';
import {
  OPENCLAW_GATEWAY_HEALTH_PROBE_TIMEOUTS_MS,
  OPENCLAW_GATEWAY_READY_PROBE_STEP_TIMEOUT_MS,
  OPENCLAW_GATEWAY_READY_PROBE_TIMEOUT_MS,
  OPENCLAW_GATEWAY_READY_RESULT_CACHE_TTL_MS,
} from './gateway-service';
import { OpenClawClient } from './openclaw-client';
import { readOpenClawConfigSafe } from './openclaw-config';

let cachedGatewayProbeKey: string | null = null;
let cachedGatewayProbeResult:
  | { checkedAt: number; result: GatewayConnectionProbeResult }
  | null = null;
const gatewayProbeInflight = new Map<string, Promise<GatewayConnectionProbeResult>>();

function normalizeGatewayHostname(hostname: string): string {
  const normalized = normalizeCliText(hostname).toLowerCase();
  return normalized.startsWith('[') && normalized.endsWith(']')
    ? normalized.slice(1, -1)
    : normalized;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeGatewayHostname(hostname);
  return normalized === '127.0.0.1'
    || normalized === 'localhost'
    || normalized === '::1';
}

export function isLocalGatewayHostname(hostname: string): boolean {
  const normalized = normalizeGatewayHostname(hostname);
  if (!normalized) return false;
  if (isLoopbackHostname(normalized)) return true;

  const localNames = new Set<string>([
    normalizeGatewayHostname(os.hostname()),
    '0.0.0.0',
    '::',
  ]);

  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      localNames.add(normalizeGatewayHostname(entry.address));
    }
  }

  return localNames.has(normalized);
}

export function parseGatewayUrlForStatusProbe(gatewayUrl: string): { hostname: string; port: number | null } | null {
  const normalized = normalizeCliText(gatewayUrl);
  if (!normalized) return null;

  try {
    const parsed = new URL(normalized.replace(/^ws/i, 'http'));
    const port = parsed.port
      ? Number(parsed.port)
      : (parsed.protocol === 'https:' ? 443 : 80);

    return {
      hostname: parsed.hostname,
      port: Number.isFinite(port) ? port : null,
    };
  } catch {
    return null;
  }
}

function buildGatewayHttpBaseUrl(gatewayUrl: string): string | null {
  const normalized = normalizeCliText(gatewayUrl);
  if (!normalized) return null;

  try {
    const parsed = new URL(normalized.replace(/^ws/i, 'http'));
    parsed.pathname = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

export function readLocalGatewayRuntimeConfig(): {
  port: number | null;
  token: string;
  password: string;
} | null {
  const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
  if (!fs.existsSync(configPath)) return null;

  try {
    const raw = readOpenClawConfigSafe();
    const gateway = raw?.gateway;
    if (!gateway || typeof gateway !== 'object') return null;

    const parsedPort = Number(gateway.port);
    return {
      port: Number.isFinite(parsedPort) ? parsedPort : null,
      token: normalizeCliText(gateway.auth?.token),
      password: normalizeCliText(gateway.auth?.password),
    };
  } catch {
    return null;
  }
}

export async function probeGatewayHealth(gatewayUrl: string): Promise<{ ok: boolean; message?: string }> {
  const baseUrl = buildGatewayHttpBaseUrl(gatewayUrl);
  if (!baseUrl) {
    return { ok: false, message: 'Invalid gateway URL' };
  }

  let lastFailure = 'Gateway health probe failed';
  for (let index = 0; index < OPENCLAW_GATEWAY_HEALTH_PROBE_TIMEOUTS_MS.length; index += 1) {
    try {
      const response = await axios.get(`${baseUrl}/health`, {
        timeout: OPENCLAW_GATEWAY_HEALTH_PROBE_TIMEOUTS_MS[index],
        validateStatus: () => true,
      });
      const statusText = normalizeCliText((response.data as any)?.status).toLowerCase();
      const ok = response.status >= 200
        && response.status < 300
        && (((response.data as any)?.ok === true) || statusText === 'live' || statusText === 'ok');

      if (ok) {
        return { ok: true };
      }

      lastFailure = `Gateway health probe returned HTTP ${response.status}`;
    } catch (error: any) {
      lastFailure = readCliErrorDetail(error) || 'Gateway health probe failed';
    }

    if (index < OPENCLAW_GATEWAY_HEALTH_PROBE_TIMEOUTS_MS.length - 1) {
      await sleep(250);
    }
  }

  return {
    ok: false,
    message: lastFailure,
  };
}

function evaluateLocalGatewayCredentialMatch(
  params: { gatewayUrl: string; token?: string; password?: string },
  gatewayTarget: { hostname: string; port: number | null } | null,
): boolean | null {
  const localConfig = readLocalGatewayRuntimeConfig();
  if (!localConfig) return null;

  if (
    gatewayTarget?.port != null
    && localConfig.port != null
    && gatewayTarget.port !== localConfig.port
  ) {
    return null;
  }

  if (!localConfig.token && !localConfig.password) {
    return true;
  }

  const tokenMatches = !localConfig.token || normalizeCliText(params.token) === localConfig.token;
  const passwordMatches = !localConfig.password || normalizeCliText(params.password) === localConfig.password;
  return tokenMatches && passwordMatches;
}

function buildGatewayProbeCacheKey(params: {
  gatewayUrl: string;
  token?: string;
  password?: string;
}) {
  return JSON.stringify({
    gatewayUrl: normalizeCliText(params.gatewayUrl),
    token: normalizeCliText(params.token) || '',
    password: normalizeCliText(params.password) || '',
  });
}

export type GatewayConnectionProbeResult = {
  connected: boolean;
  message?: string;
  source: 'local-runtime' | 'auth-probe' | 'active-session';
};

export async function probeGatewayConnectionStatus(params: {
  gatewayUrl: string;
  token?: string;
  password?: string;
}, options: {
  preferLocalHealth?: boolean;
  allowRpcProbe?: boolean;
} = {}): Promise<GatewayConnectionProbeResult> {
  const allowRpcProbe = options.allowRpcProbe !== false;
  const probeKey = [
    buildGatewayProbeCacheKey(params),
    `preferLocalHealth=${options.preferLocalHealth ? '1' : '0'}`,
    `allowRpcProbe=${allowRpcProbe ? '1' : '0'}`,
  ].join('|');
  const now = Date.now();
  if (
    cachedGatewayProbeKey === probeKey
    && cachedGatewayProbeResult
    && (now - cachedGatewayProbeResult.checkedAt) <= OPENCLAW_GATEWAY_READY_RESULT_CACHE_TTL_MS
  ) {
    return cachedGatewayProbeResult.result;
  }

  const inflightProbe = gatewayProbeInflight.get(probeKey);
  if (inflightProbe) {
    return inflightProbe;
  }

  const probePromise: Promise<GatewayConnectionProbeResult> = (async () => {
    const gatewayTarget = parseGatewayUrlForStatusProbe(params.gatewayUrl);
    const isLocalGatewayTarget = gatewayTarget ? isLocalGatewayHostname(gatewayTarget.hostname) : false;
    let localHealthFailureMessage: string | null = null;
    let localHealthOk = false;

    if (isLocalGatewayTarget) {
      const health = await probeGatewayHealth(params.gatewayUrl);
      if (!health.ok) {
        // Older OpenClaw builds may not respond to /health reliably.
        // Fall back to a real gateway RPC probe before declaring disconnected.
        localHealthFailureMessage = health.message || 'Local OpenClaw gateway is not responding';
      } else {
        localHealthOk = true;
      }

      const credentialMatches = evaluateLocalGatewayCredentialMatch(params, gatewayTarget);
      if (credentialMatches === false) {
        return {
          connected: false,
          message: 'Gateway credentials do not match local OpenClaw config',
          source: 'local-runtime',
        };
      }

      if (options?.preferLocalHealth && localHealthOk) {
        return {
          connected: true,
          message: 'Local OpenClaw gateway ready',
          source: 'local-runtime',
        };
      }

      if (!allowRpcProbe) {
        return {
          connected: localHealthOk,
          message: localHealthOk
            ? 'Local OpenClaw gateway ready'
            : (localHealthFailureMessage || 'Local OpenClaw gateway is not responding'),
          source: 'local-runtime',
        };
      }
    } else if (!allowRpcProbe) {
      return {
        connected: false,
        message: 'Gateway HTTP health probe is only available for a local OpenClaw gateway.',
        source: 'auth-probe',
      };
    }

    const attemptGatewayReadyProbe = async (options?: {
      totalTimeoutMs?: number;
      stepTimeoutMs?: number;
    }): Promise<GatewayConnectionProbeResult> => {
      const client = new OpenClawClient({
        gatewayUrl: params.gatewayUrl,
        token: params.token,
        password: params.password,
      });
      client.on('error', () => {});
      let timeoutId: NodeJS.Timeout | null = null;

      try {
        await Promise.race([
          client.getGatewayStatus(options?.stepTimeoutMs ?? OPENCLAW_GATEWAY_READY_PROBE_STEP_TIMEOUT_MS),
          new Promise<never>((_, reject) => {
            timeoutId = setTimeout(
              () => reject(new Error('Gateway readiness probe timeout')),
              options?.totalTimeoutMs ?? OPENCLAW_GATEWAY_READY_PROBE_TIMEOUT_MS
            );
          }),
        ]);
        return {
          connected: true,
          message: isLocalGatewayTarget
            ? (localHealthFailureMessage
              ? 'Local OpenClaw gateway ready after HTTP health probe failed'
              : 'Local OpenClaw gateway ready')
            : undefined,
          source: isLocalGatewayTarget ? 'local-runtime' : 'auth-probe',
        };
      } catch (error: any) {
        return {
          connected: false,
          message: readCliErrorDetail(error) || error?.message || localHealthFailureMessage || 'Connection failed',
          source: isLocalGatewayTarget ? 'local-runtime' : 'auth-probe',
        };
      } finally {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        client.disconnect();
      }
    };

    return attemptGatewayReadyProbe();
  })();

  gatewayProbeInflight.set(probeKey, probePromise);
  try {
    const result = await probePromise;
    cachedGatewayProbeKey = probeKey;
    cachedGatewayProbeResult = {
      checkedAt: Date.now(),
      result,
    };
    return result;
  } finally {
    gatewayProbeInflight.delete(probeKey);
  }
}
