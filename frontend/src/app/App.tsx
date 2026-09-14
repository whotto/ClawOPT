import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from './auth';
import { legacyHashToPath } from './routeState';
import AppRoutes from './routes';

// 改路由前的书签是 `/#settings/models` 这种形状；挂载路由前原地换成新路径，不留历史记录。
function upgradeLegacyHashUrl() {
  const legacyPath = legacyHashToPath(window.location.hash);
  if (legacyPath) {
    window.history.replaceState(window.history.state, '', `${legacyPath}${window.location.search}`);
  }
}

upgradeLegacyHashUrl();

export default function App() {
  return (
    // 显式声明 v7 行为开关：导航不包进 startTransition（状态同步依赖同步提交），相对路径按 v7 解析（本应用不用 splat 相对链接）。
    <BrowserRouter future={{ v7_startTransition: false, v7_relativeSplatPath: true }}>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}
