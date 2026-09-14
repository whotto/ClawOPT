import type { ConfigManager } from '../core/config';
import type { GatewayConnectionProbeResult } from './gateway-probe';
import { OpenClawClient } from './openclaw-client';

export type GatewayConnectionsDeps = {
  configManager: ConfigManager;
  connections: Map<string, OpenClawClient>;
};

export function createGatewayConnections(ctx: GatewayConnectionsDeps) {
  const { configManager, connections } = ctx;

  function getActiveGatewayConnectionStatus(): GatewayConnectionProbeResult | null {
    const activeConnectionCount = Array.from(connections.values())
      .filter((client) => client.isConnected())
      .length;

    if (activeConnectionCount === 0) {
      return null;
    }

    return {
      connected: true,
      message: `OpenClaw gateway has ${activeConnectionCount} active session connection${activeConnectionCount === 1 ? '' : 's'}`,
      source: 'active-session',
    };
  }

  function disconnectConnection(sessionId: string): void {
    const client = connections.get(sessionId);
    if (!client) return;
    connections.delete(sessionId);
    client.disconnect();
  }

  /**
   * 等网关真的看见这个 Agent。
   *
   * `provision()` 返回的只是「配置写完了」。网关是靠**监听文件变化**热重载的，
   * 那之间有一个窗口——在窗口里派活，网关会回
   * `Agent "<id>" no longer exists in configuration`。
   *
   * 生产实测：一个刚加进团队的成员，第一次 @ 它必失败一次，第二次才好。
   * 用户看到的是「这个 Agent 坏了」，重试一下又好了，最难查的那类。
   *
   * 在这里等，而不是在某一个调用点加重试：新建运行时 Agent 的路径只有这一条，
   * 堵在源头，后面所有调用方都不必各自记得重试。
   */
  async function waitForGatewayToSeeAgent(agentId: string, timeoutMs = 8000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown = null;
    while (Date.now() < deadline) {
      try {
        const client = await getConnection(agentId);
        // 拿一次该 Agent 的会话历史：这是最便宜的「网关认不认这个 id」探针，
        // 认不出来会抛，认得出来即使是空历史也会正常返回。
        await client.getChatHistory(`agent:${agentId}:chat:probe`, 1);
        return true;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    // 超时不抛。等不到不等于一定失败——可能只是探针这条路不通，
    // 而真正的派活是另一条。出声，然后照常往下走，让真实失败自己说话。
    console.warn(
      `[GroupRuntime] 等了 ${timeoutMs}ms 网关仍未确认 Agent ${agentId}，继续派活：`,
      (lastError as Error)?.message ?? lastError,
    );
    return false;
  }

  // Helper to get or create connection
  async function getConnection(sessionId: string): Promise<OpenClawClient> {
    const cachedClient = connections.get(sessionId);
    if (cachedClient) {
      if (cachedClient.isConnected()) {
        return cachedClient;
      }
      connections.delete(sessionId);
      cachedClient.disconnect();
    }

    const config = configManager.getConfig();
    const client = new OpenClawClient({
      gatewayUrl: config.gatewayUrl,
      token: config.token,
      password: config.password,
    });
    client.on('error', (err) => {
      console.error(`[OpenClawClient Error for session ${sessionId}]`, err.message);
    });

    try {
      await client.connect();
    } catch (error) {
      connections.delete(sessionId);
      client.disconnect();
      throw error;
    }
    connections.set(sessionId, client);

    client.on('disconnected', () => {
      connections.delete(sessionId);
    });

    return client;
  }

  return {
    getActiveGatewayConnectionStatus,
    disconnectConnection,
    waitForGatewayToSeeAgent,
    getConnection,
  };
}
export type GatewayConnections = ReturnType<typeof createGatewayConnections>;
