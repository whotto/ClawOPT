import { useEffect, useRef, useState } from 'react';
import { getGatewayStatus } from '../api/gateway';
import { BOOTSTRAP_REQUEST_TIMEOUT_MS, isPageVisible } from './bootstrap';

const CONNECTION_STATUS_STORAGE_KEY = 'clawopt_connection_status';
const CONNECTION_STATUS_STORAGE_TTL_MS = 30 * 1000;
const CONNECTION_STATUS_POLL_CONNECTED_MS = 10000;
const CONNECTION_STATUS_POLL_DISCONNECTED_MS = 2000;
const CONNECTION_STATUS_REFRESH_EVENT = 'clawopt:refresh-connection-status';

function readInitialConnectionState(): boolean {
  try {
    const raw = window.sessionStorage.getItem(CONNECTION_STATUS_STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { connected?: unknown; checkedAt?: unknown };
    const connected = parsed?.connected === true;
    const checkedAt = typeof parsed?.checkedAt === 'number' ? parsed.checkedAt : 0;
    if ((Date.now() - checkedAt) > CONNECTION_STATUS_STORAGE_TTL_MS) {
      return false;
    }
    return connected;
  } catch {
    return false;
  }
}

/**
 * 网关连接状态轮询。连着时 10 秒一次、断开时 2 秒一次；
 * 已连接状态下单次失败不立刻判断开，1.5 秒后复查，连续两次失败才翻成断开。
 */
export function useConnectionStatus(): boolean {
  const connectionFailureCountRef = useRef(0);
  const connectionRetryTimerRef = useRef<number | null>(null);
  const latestIsConnectedRef = useRef(false);
  const [isConnected, setIsConnected] = useState<boolean>(() => readInitialConnectionState());

  useEffect(() => {
    latestIsConnectedRef.current = isConnected;
    try {
      window.sessionStorage.setItem(CONNECTION_STATUS_STORAGE_KEY, JSON.stringify({
        connected: isConnected,
        checkedAt: Date.now(),
      }));
    } catch {}
  }, [isConnected]);

  useEffect(() => {
    const checkStatus = async () => {
      try {
        const data = await getGatewayStatus(BOOTSTRAP_REQUEST_TIMEOUT_MS);
        if (data.connected) {
          connectionFailureCountRef.current = 0;
          if (connectionRetryTimerRef.current !== null) {
            window.clearTimeout(connectionRetryTimerRef.current);
            connectionRetryTimerRef.current = null;
          }
          setIsConnected(true);
          return;
        }
      } catch (e) {}

      if (!latestIsConnectedRef.current) {
        connectionFailureCountRef.current = 0;
        setIsConnected(false);
        return;
      }

      connectionFailureCountRef.current += 1;
      if (connectionFailureCountRef.current >= 2) {
        connectionFailureCountRef.current = 0;
        if (connectionRetryTimerRef.current !== null) {
          window.clearTimeout(connectionRetryTimerRef.current);
          connectionRetryTimerRef.current = null;
        }
        setIsConnected(false);
        return;
      }

      if (connectionRetryTimerRef.current === null) {
        connectionRetryTimerRef.current = window.setTimeout(() => {
          connectionRetryTimerRef.current = null;
          void checkStatus();
        }, 1500);
      }
    };

    const handleImmediateCheck = () => {
      void checkStatus();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void checkStatus();
      }
    };

    void checkStatus();
    const timer = window.setInterval(() => {
      if (isPageVisible()) void checkStatus();
    }, isConnected ? CONNECTION_STATUS_POLL_CONNECTED_MS : CONNECTION_STATUS_POLL_DISCONNECTED_MS);
    window.addEventListener('focus', handleImmediateCheck);
    window.addEventListener('online', handleImmediateCheck);
    window.addEventListener(CONNECTION_STATUS_REFRESH_EVENT, handleImmediateCheck as EventListener);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.clearInterval(timer);
      if (connectionRetryTimerRef.current !== null) {
        window.clearTimeout(connectionRetryTimerRef.current);
        connectionRetryTimerRef.current = null;
      }
      window.removeEventListener('focus', handleImmediateCheck);
      window.removeEventListener('online', handleImmediateCheck);
      window.removeEventListener(CONNECTION_STATUS_REFRESH_EVENT, handleImmediateCheck as EventListener);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isConnected]);

  return isConnected;
}
