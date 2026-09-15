// 设置 → 通用 → 提醒：完成 / 审批的提示音与系统通知开关，各带「试一下」。按浏览器记，切换即生效，不经「保存」按钮。
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Toggle } from '../../components/control/ControlUi';
import { persistNotificationPrefs, readNotificationPrefs, type NotificationPrefs } from './notificationPrefs';
import { osNotificationPermission, playNotificationTone, requestOsNotificationPermission, showOsNotification, type OsPermission } from './signals';

type PrefKey = keyof NotificationPrefs;

const ROWS: Array<{ key: PrefKey; kind: 'completion' | 'approval'; channel: 'sound' | 'os' }> = [
  { key: 'completionSound', kind: 'completion', channel: 'sound' },
  { key: 'completionOs', kind: 'completion', channel: 'os' },
  { key: 'approvalSound', kind: 'approval', channel: 'sound' },
  { key: 'approvalOs', kind: 'approval', channel: 'os' },
];

export default function NotificationSettingsSection() {
  const { t } = useTranslation();
  // 只读：挂载时读 localStorage，不写回（加载不许写）。
  const [prefs, setPrefs] = useState<NotificationPrefs>(() => readNotificationPrefs());
  const [permission, setPermission] = useState<OsPermission>(() => osNotificationPermission());

  const update = (key: PrefKey, value: boolean) => {
    setPrefs(persistNotificationPrefs({ ...prefs, [key]: value }));
  };

  const test = (row: typeof ROWS[number]) => {
    if (row.channel === 'sound') {
      playNotificationTone(row.kind);
      return;
    }
    showOsNotification({
      title: t(row.kind === 'completion' ? 'notifications.os.runCompletedTitle' : 'notifications.os.approvalTitle', { name: t('notifications.settings.testName') }),
      body: t(row.kind === 'completion' ? 'notifications.os.runCompletedBody' : 'notifications.os.approvalBody'),
      tag: `clawopt-test:${row.key}`,
    });
  };

  const requestPermission = async () => {
    setPermission(await requestOsNotificationPermission());
  };

  return (
    <div className="border-t border-gray-100 pt-6" data-testid="notification-settings">
      <label className="block text-sm font-semibold text-gray-900 mb-1">{t('notifications.settings.title')}</label>
      <p className="text-xs text-gray-400 mb-4">{t('notifications.settings.hint')}</p>
      <div className="space-y-3">
        {ROWS.map((row) => {
          const osBlocked = row.channel === 'os' && permission !== 'granted';
          return (
            <div key={row.key} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm text-gray-800">{t(`notifications.settings.${row.key}`)}</div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => test(row)}
                  disabled={osBlocked}
                  className="h-8 px-3 rounded-lg border border-gray-200 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                >
                  {t('notifications.settings.test')}
                </button>
                <Toggle checked={prefs[row.key]} onChange={(next) => update(row.key, next)} label={t(`notifications.settings.${row.key}`)} />
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-gray-500">
        <span>{t('notifications.settings.permissionLabel')}: {t(`notifications.settings.permission.${permission}`)}</span>
        {permission === 'default' && (
          <button
            type="button"
            onClick={() => { void requestPermission(); }}
            className="h-8 px-3 rounded-lg border border-gray-200 text-xs font-medium text-blue-600 hover:bg-blue-50 transition-all"
          >
            {t('notifications.settings.requestPermission')}
          </button>
        )}
        {permission === 'denied' && <span className="text-amber-600">{t('notifications.settings.permissionDeniedHint')}</span>}
      </div>
    </div>
  );
}
