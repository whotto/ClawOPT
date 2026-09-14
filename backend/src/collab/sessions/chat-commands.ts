import type { DB } from '../../core/db';
import { readCliErrorDetail } from '../../core/process';
import { normalizeCliText } from '../../core/util';
import type { GatewayConnections } from '../../openclaw';
import type { SessionManager } from './session-manager';

type ParsedChatCommand = {
  command: string;
  argsText: string;
};

type ResolvedChatCommandResult = {
  content: string;
  clearBeforeSave?: boolean;
};

export function parseChatCommand(rawMessage: unknown): ParsedChatCommand | null {
  const normalized = normalizeCliText(rawMessage);
  if (!normalized.startsWith('/')) return null;
  const [token = ''] = normalized.split(/\s+/, 1);
  const command = token.toLowerCase();
  if (!command.startsWith('/') || command.length < 2) return null;
  return {
    command,
    argsText: normalized.slice(token.length).trim(),
  };
}

const builtinChatCommandOptions: Record<string, { clearBeforeSave?: boolean }> = {
  '/status': {},
  '/help': {},
  '/models': {},
  '/clear': { clearBeforeSave: true },
};

export type ChatCommandsDeps = {
  db: DB;
  sessionManager: SessionManager;
  gatewayConnections: GatewayConnections;
};

export function createChatCommands(ctx: ChatCommandsDeps) {
  const { db, sessionManager } = ctx;
  const { getConnection } = ctx.gatewayConnections;

  function listConfiguredQuickCommands() {
    return (db.getQuickCommands() as Array<{ command?: unknown; description?: unknown }>)
      .map((entry) => ({
        command: normalizeCliText(entry.command).toLowerCase(),
        description: normalizeCliText(entry.description),
      }))
      .filter((entry) => entry.command.startsWith('/'));
  }

  async function resolveChatCommandResult(
    parsed: ParsedChatCommand,
    sessionId: string,
  ): Promise<ResolvedChatCommandResult | null> {
    const configuredCommands = listConfiguredQuickCommands();
    const configuredCommandSet = new Set(configuredCommands.map((entry) => entry.command));
    const builtinOptions = builtinChatCommandOptions[parsed.command];
    const shouldExecuteAsNativeCommand = Boolean(builtinOptions) || configuredCommandSet.has(parsed.command);
    if (!shouldExecuteAsNativeCommand) {
      return null;
    }

    const commandLine = parsed.argsText ? `${parsed.command} ${parsed.argsText}` : parsed.command;

    try {
      const client = await getConnection(sessionId);
      const sessionInfo = sessionManager.getSession(sessionId);
      const nativeText = normalizeCliText(await client.sendChatMessage({
        sessionKey: sessionId,
        agentId: sessionInfo?.agentId || 'main',
        message: commandLine,
      }));
      if (!nativeText || nativeText === 'No assistant text found in response.') {
        throw new Error('No response text from native command runtime.');
      }
      return {
        content: nativeText,
        clearBeforeSave: builtinOptions?.clearBeforeSave,
      };
    } catch (error) {
      const detail = readCliErrorDetail(error) || 'Native command execution failed.';
      return {
        content: `❌ ${detail}`,
        clearBeforeSave: builtinOptions?.clearBeforeSave,
      };
    }
  }

  return {
    resolveChatCommandResult,
  };
}
export type ChatCommands = ReturnType<typeof createChatCommands>;
