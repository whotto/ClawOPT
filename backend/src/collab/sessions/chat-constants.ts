import { OPENCLAW_CHAT_HISTORY_PROBE_LIMIT } from '../../openclaw';

export const CHAT_RUN_ERROR_CODE = 'chat.runError';
export const CHAT_GATEWAY_DISCONNECTED_CODE = 'chat.gatewayDisconnected';
export const CHAT_GATEWAY_DISCONNECTED_DETAIL = 'Connection to gateway lost. The process might have restarted.';
export const CHAT_LATEST_ROUND_ONLY_CODE = 'chat.latestRoundOnly';
export const CHAT_LATEST_ROUND_ONLY_DETAIL = 'Only the latest round can be edited or regenerated.';
export const CHAT_RUN_ERROR_PREFIX = '❌ Error: ';
export const DEFAULT_HISTORY_PAGE_LIMIT = 200;
export const MAX_HISTORY_PAGE_LIMIT = 200;
/** 与网关运行适配器用同一个值（定义在 openclaw 模块），对账读的历史条数不许两处分家。 */
export const CHAT_HISTORY_COMPLETION_PROBE_LIMIT = OPENCLAW_CHAT_HISTORY_PROBE_LIMIT;
export const CHAT_REGENERATE_LOOKBACK_LIMIT = 60;
