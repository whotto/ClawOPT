// Web 终端（系统区，super_admin）：先问服务端本机能不能开伪终端，不能就说明原因与怎么开；能开再懒加载 xterm 工作台。
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { terminalApi } from '../../api/terminal';
import { ErrorBanner, LoadingRow, NoPermissionState, PageIntro, type ErrorDisplay } from '../../components/control/ControlUi';
import { HostFeatureNotice } from '../../components/control/HostFeatureNotice';
import { readApi, useErrorDisplay } from '../control/useControlApi';

const TerminalWorkbench = lazy(() => import('../../features/terminal/TerminalWorkbench'));

type Availability = { available: boolean; reasonCode: string | null; detail?: string | null };

export default function TerminalPage() {
  const { t } = useTranslation();
  const errors = useErrorDisplay();
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<ErrorDisplay | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (refresh: boolean) => {
    setRefreshing(refresh);
    try {
      const result = await readApi<Availability>(terminalApi.status(refresh));
      if (result.status === 403) setForbidden(true);
      else if (result.ok) setAvailability(result.data);
      else setError(errors.fromResult(result, 'terminal.internalError'));
    } catch (exception) {
      setError(errors.fromException(exception));
    } finally {
      setRefreshing(false);
    }
  }, [errors]);

  useEffect(() => {
    void load(false);
  }, [load]);

  if (forbidden) return <NoPermissionState />;

  return (
    <div className="space-y-6">
      <PageIntro title={t('terminal.ui.title')} description={t('terminal.ui.description')} />
      <ErrorBanner error={error} onClose={() => setError(null)} />
      {availability === null ? (
        error ? null : <LoadingRow />
      ) : !availability.available ? (
        <HostFeatureNotice reasonCode={availability.reasonCode} detail={availability.detail} onRefresh={() => void load(true)} refreshing={refreshing} />
      ) : (
        <Suspense fallback={<LoadingRow />}>
          <TerminalWorkbench />
        </Suspense>
      )}
    </div>
  );
}
