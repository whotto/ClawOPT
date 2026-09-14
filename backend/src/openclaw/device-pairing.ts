import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

import {
  GATEWAY_DEVICE_PAIRING_APPROVE_FAILED_ERROR_CODE,
  GATEWAY_DEVICE_PAIRING_NO_PENDING_ERROR_CODE,
  StructuredRequestError,
} from '../core/http';
import { readCliErrorDetail } from '../core/process';
import { normalizeCliText } from '../core/util';
import { collectOpenClawPackageRoots, ensureResolvedOpenClawExecutablePath } from './cli';

type DevicePairingPendingRequestSummary = {
  requestId: string;
  deviceId: string | null;
  displayName: string | null;
  clientId: string | null;
  clientMode: string | null;
  role: string | null;
  roles: string[];
  scopes: string[];
  remoteIp: string | null;
  isRepair: boolean;
  ts: number | null;
};

type DevicePairingStatusSnapshot = {
  pending: DevicePairingPendingRequestSummary[];
  latestPending: DevicePairingPendingRequestSummary | null;
  pairedCount: number | null;
  rawDetail: string | null;
};

type OpenClawLocalDevicePairingList = {
  pending?: unknown[];
  paired?: unknown[];
};

type OpenClawLocalDevicePairingApproveResult =
  | {
      status: 'approved';
      device?: {
        deviceId?: string;
        displayName?: string;
      } | null;
    }
  | {
      status: 'forbidden';
      missingScope?: string;
    }
  | null;

type OpenClawLocalDevicePairingApi = {
  listDevicePairing: () => Promise<OpenClawLocalDevicePairingList>;
  approveDevicePairing: (
    requestId: string,
    options?: { callerScopes?: readonly string[] },
  ) => Promise<OpenClawLocalDevicePairingApproveResult>;
};

function normalizeCliStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => normalizeCliText(entry))
    .filter(Boolean);
}

function normalizeDevicePairingPendingRequest(value: any): DevicePairingPendingRequestSummary | null {
  const requestId = normalizeCliText(value?.requestId);
  if (!requestId) {
    return null;
  }

  const roles = normalizeCliStringArray(value?.roles);
  const scopes = normalizeCliStringArray(value?.scopes);
  const ts = Number.isFinite(value?.ts) ? Number(value.ts) : null;

  return {
    requestId,
    deviceId: normalizeCliText(value?.deviceId) || null,
    displayName: normalizeCliText(value?.displayName) || null,
    clientId: normalizeCliText(value?.clientId) || null,
    clientMode: normalizeCliText(value?.clientMode) || null,
    role: normalizeCliText(value?.role) || (roles[0] || null),
    roles,
    scopes,
    remoteIp: normalizeCliText(value?.remoteIp) || null,
    isRepair: value?.isRepair === true,
    ts,
  };
}

function selectLatestPendingDevicePairingRequest(pending: DevicePairingPendingRequestSummary[]) {
  if (pending.length === 0) {
    return null;
  }

  return pending.reduce((latest, current) => {
    const latestTs = latest.ts ?? 0;
    const currentTs = current.ts ?? 0;
    return currentTs > latestTs ? current : latest;
  });
}

function normalizeDevicePairingStatusSnapshot(raw: any, rawDetail?: string | null): DevicePairingStatusSnapshot {
  const pending = Array.isArray(raw?.pending)
    ? raw.pending
        .map((entry: any) => normalizeDevicePairingPendingRequest(entry))
        .filter((entry: DevicePairingPendingRequestSummary | null): entry is DevicePairingPendingRequestSummary => !!entry)
    : [];

  return {
    pending,
    latestPending: selectLatestPendingDevicePairingRequest(pending),
    pairedCount: Array.isArray(raw?.paired) ? raw.paired.length : 0,
    rawDetail: normalizeCliText(rawDetail) || null,
  };
}

let cachedOpenClawLocalDevicePairingApiPromise: Promise<OpenClawLocalDevicePairingApi> | null = null;

const importOpenClawEsmModule = new Function(
  'specifier',
  'return import(specifier)'
) as (specifier: string) => Promise<unknown>;

async function loadOpenClawLocalDevicePairingApi(): Promise<OpenClawLocalDevicePairingApi> {
  if (!cachedOpenClawLocalDevicePairingApiPromise) {
    cachedOpenClawLocalDevicePairingApiPromise = (async () => {
      const packageRoots = new Set<string>(collectOpenClawPackageRoots());

      try {
        const executablePath = await ensureResolvedOpenClawExecutablePath();
        const resolvedExecutablePath = fs.realpathSync(executablePath);
        if (path.basename(resolvedExecutablePath) === 'openclaw.mjs') {
          packageRoots.add(path.dirname(resolvedExecutablePath));
        }
      } catch {}

      for (const packageRoot of packageRoots) {
        const apiPath = path.join(packageRoot, 'dist', 'extensions', 'device-pair', 'api.js');
        if (!fs.existsSync(apiPath)) {
          continue;
        }

        const imported = await importOpenClawEsmModule(pathToFileURL(apiPath).href) as Partial<OpenClawLocalDevicePairingApi>;
        if (
          typeof imported.listDevicePairing === 'function'
          && typeof imported.approveDevicePairing === 'function'
        ) {
          return imported as OpenClawLocalDevicePairingApi;
        }
      }

      throw new Error('OpenClaw official device-pair API is not available in the local install.');
    })();
  }

  try {
    return await cachedOpenClawLocalDevicePairingApiPromise;
  } catch (error) {
    cachedOpenClawLocalDevicePairingApiPromise = null;
    throw error;
  }
}

async function listLocalDevicePairingStatus() {
  const localApi = await loadOpenClawLocalDevicePairingApi();
  const localList = await localApi.listDevicePairing();
  return normalizeDevicePairingStatusSnapshot(localList);
}

async function approveLocalDevicePairingRequest(requestId: string) {
  const localApi = await loadOpenClawLocalDevicePairingApi();
  return await localApi.approveDevicePairing(requestId, { callerScopes: ['operator.admin'] });
}

async function readDevicePairingStatus(): Promise<DevicePairingStatusSnapshot> {
  return listLocalDevicePairingStatus();
}

export async function safeReadDevicePairingStatus(): Promise<DevicePairingStatusSnapshot> {
  try {
    return await readDevicePairingStatus();
  } catch (error: any) {
    return {
      pending: [],
      latestPending: null,
      pairedCount: null,
      rawDetail: readCliErrorDetail(error) || 'Failed to inspect device pairing status.',
    };
  }
}

export async function approveLatestDevicePairingRequest() {
  const currentStatus = await readDevicePairingStatus();
  const latestPending = currentStatus.latestPending;
  if (!latestPending) {
    throw new StructuredRequestError(
      409,
      GATEWAY_DEVICE_PAIRING_NO_PENDING_ERROR_CODE,
      'No pending device pairing requests to approve.',
    );
  }

  const approved = await approveLocalDevicePairingRequest(latestPending.requestId);
  if (approved?.status === 'forbidden') {
    throw new StructuredRequestError(
      403,
      GATEWAY_DEVICE_PAIRING_APPROVE_FAILED_ERROR_CODE,
      normalizeCliText(approved.missingScope)
        ? `Missing scope: ${approved.missingScope}`
        : 'Failed to approve the latest device pairing request.',
    );
  }

  if (approved == null) {
    throw new StructuredRequestError(
      409,
      GATEWAY_DEVICE_PAIRING_NO_PENDING_ERROR_CODE,
      'No pending device pairing requests to approve.',
    );
  }

  return {
    approvedRequestId: latestPending.requestId,
    approvedDeviceId: normalizeCliText(approved?.device?.deviceId) || latestPending.deviceId,
    approvedDeviceName: normalizeCliText(approved?.device?.displayName) || latestPending.displayName,
    devicePairing: await safeReadDevicePairingStatus(),
  };
}
