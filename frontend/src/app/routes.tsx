import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

const GuestRoomPage = lazy(() => import('../features/rooms/guest/GuestRoomPage'));
import ChatPage from '../pages/chat/ChatPage';
import LoginPage from '../pages/login/LoginPage';
import AutomationPage from '../pages/automation/AutomationPage';
import SettingsPage from '../pages/settings/SettingsPage';
import AppShell from './AppShell';
import { RequireAuth } from './auth';
import { LOGIN_PATH } from './routeState';

/**
 * 路由表。路径形状与 routeState.ts 的 parseAppPath / formatAppPath 一一对应，改一处必须改另一处
 * （routeState.test.ts 覆盖往返）。
 *
 * `/` 与缺段路径（`/chat`、`/groups`、`/settings`、`/settings/<未知页签>`）不在这里重定向：
 * 壳层按「地址栏优先、缺的段用上次记忆补」折算出完整状态，再用 replace 改写地址栏，
 * 补出来的会话 / 群 / 页签才与 localStorage 记忆一致。`/` 在改写前空一帧，不挂页面，
 * 免得先挂一个页面、改写地址后又换成另一条路由的实例重挂一次。
 */
export default function AppRoutes() {
  return (
    <Routes>
      <Route path={LOGIN_PATH} element={<LoginPage />} />
      {/* P3 访客页：邀请码 + 访客令牌，不经登录壳层。 */}
      <Route path="share/rooms/:code" element={<Suspense fallback={null}><GuestRoomPage /></Suspense>} />
      <Route element={<RequireAuth><AppShell /></RequireAuth>}>
        <Route index element={null} />
        <Route path="chat/:sessionId?" element={<ChatPage mode="chat" />} />
        <Route path="groups/:groupId?" element={<ChatPage mode="group" />} />
        <Route path="settings/:tab?" element={<SettingsPage />} />
        <Route path="automation/:section?/:workflowId?" element={<AutomationPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
