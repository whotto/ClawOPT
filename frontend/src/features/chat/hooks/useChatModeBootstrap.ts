// 单聊模式首屏拉取 AI 名称、快捷指令、角色。
import { useEffect } from 'react';
import { getConfig } from '../../../api/config';
import { listCharacters } from '../../../api/characters';
import { listCommands } from '../../../api/commands';
import type { ChatViewState } from './useChatViewState';

/** 本段读取的、由前面各段产出的值。 */
type ChatModeBootstrapContext = Pick<ChatViewState, 'isChat' | 'setAllCommands' | 'setAiName' | 'setCharacters'>;

export function useChatModeBootstrap(c: ChatModeBootstrapContext) {
  const { isChat, setAllCommands, setAiName, setCharacters } = c;
  // =============== CHAT-MODE EFFECTS ===============
  useEffect(() => {
    if (!isChat) return;
    getConfig().then(r => r.json()).then(data => { if (data.aiName) setAiName(data.aiName); }).catch(() => {});
    fetchCommands();
    listCharacters().then(res => res.json()).then(data => { if (data.success) setCharacters(data.characters); }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isChat]);

  const fetchCommands = async () => {
    try { const res = await listCommands(); const data = await res.json(); if (data.success) setAllCommands(data.commands); } catch {}
  };

  return { fetchCommands };
}
