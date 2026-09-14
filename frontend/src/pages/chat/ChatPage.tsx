import UnifiedChatView from '../../components/UnifiedChatView';
import { useShellContext } from '../../app/shellContext';

/**
 * 单聊（/chat/:sessionId）与群聊（/groups/:groupId）共用一页。
 * 两条路由渲染同一组件类型，切换时聊天视图不重挂载——与改路由前 App 里三元切换的行为一致。
 */
export default function ChatPage({ mode }: { mode: 'chat' | 'group' }) {
  const shell = useShellContext();

  if (mode === 'chat') {
    return (
      <UnifiedChatView
        mode="chat"
        isConnected={shell.isConnected}
        activeSessionId={shell.activeSessionId}
        onMenuClick={shell.openMobileMenu}
        sessions={shell.sessions}
        availableModels={shell.availableModels}
      />
    );
  }

  return (
    <UnifiedChatView
      mode="group"
      isConnected={shell.isConnected}
      onMenuClick={shell.openMobileMenu}
      sessions={shell.sessions}
      availableModels={shell.availableModels}
      activeGroupId={shell.activeGroupId}
      onSelectGroup={shell.selectGroup}
    />
  );
}
