// 定时任务页（自动化区）：`openclaw cron` 的控制面。
import { History, Pause, Pencil, Play, Plus, RefreshCw, Trash2, Zap } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { channelsApi, cronApi, rosterApi } from '../../api/control';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorBanner, formatTime, LoadingRow, Modal, Notice, PageIntro, type ErrorDisplay } from '../../components/control/ControlUi';
import { readApi, useCurrentUser, useErrorDisplay } from '../control/useControlApi';
import CronJobModal from './CronJobModal';
import { type CronJob, type CronRun, describeSchedule } from './cronTypes';

export default function CronPage() {
  const { t, i18n } = useTranslation();
  const errors = useErrorDisplay();
  const { isAdmin } = useCurrentUser();
  const [jobs, setJobs] = useState<CronJob[] | null>(null);
  const [agents, setAgents] = useState<string[]>([]);
  const [channels, setChannels] = useState<string[]>([]);
  const [error, setError] = useState<ErrorDisplay | null>(null);
  const [editing, setEditing] = useState<CronJob | 'new' | null>(null);
  const [deleting, setDeleting] = useState<CronJob | null>(null);
  const [runsFor, setRunsFor] = useState<{ job: CronJob; runs: CronRun[] | null } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await readApi<{ jobs: CronJob[] }>(cronApi.list());
      if (result.ok) setJobs(result.data.jobs);
      else {
        setJobs([]);
        setError(errors.fromResult(result, 'control.cron.loadFailed'));
      }
    } catch (exception) {
      setJobs([]);
      setError(errors.fromException(exception));
    }
  }, [errors]);

  useEffect(() => {
    void load();
    readApi<{ agents: Array<{ id: string }> }>(rosterApi.engineAgents()).then((result) => {
      if (result.ok) setAgents(result.data.agents.map((agent) => agent.id));
    }).catch(() => undefined);
    readApi<{ channels: Array<{ id: string }> }>(channelsApi.list(false)).then((result) => {
      if (result.ok) setChannels(result.data.channels.map((channel) => channel.id));
    }).catch(() => undefined);
  }, [load]);

  const act = async (job: CronJob, action: 'enable' | 'disable' | 'run' | 'remove') => {
    setBusyId(job.id);
    setError(null);
    try {
      const request = action === 'enable' ? cronApi.enable(job.id) : action === 'disable' ? cronApi.disable(job.id) : action === 'run' ? cronApi.run(job.id) : cronApi.remove(job.id);
      const result = await readApi(request);
      if (!result.ok) setError(errors.fromResult(result, 'control.cron.actionFailed'));
      else if (action === 'run') setNotice(t('control.cron.runQueued', { name: job.name }));
      await load();
    } catch (exception) {
      setError(errors.fromException(exception));
    } finally {
      setBusyId(null);
      setDeleting(null);
    }
  };

  const openRuns = async (job: CronJob) => {
    setRunsFor({ job, runs: null });
    const result = await readApi<{ runs: CronRun[] }>(cronApi.runs(job.id)).catch(() => null);
    setRunsFor({ job, runs: result?.ok ? result.data.runs : [] });
  };

  return (
    <div className="space-y-6">
      <PageIntro
        title={t('control.cron.title')}
        description={t('control.cron.description')}
        actions={(
          <>
            <Button onClick={() => void load()}><RefreshCw className="w-4 h-4" />{t('control.common.refresh')}</Button>
            {isAdmin && <Button variant="primary" onClick={() => setEditing('new')}><Plus className="w-4 h-4" />{t('control.cron.create')}</Button>}
          </>
        )}
      />
      <ErrorBanner error={error} onClose={() => setError(null)} />
      {notice && <Notice tone="green">{notice}</Notice>}

      {jobs === null ? <LoadingRow /> : jobs.length === 0 ? <EmptyState>{t('control.cron.empty')}</EmptyState> : (
        <div className="space-y-3">
          {jobs.map((job) => (
            <Card key={job.id} className="p-4">
              <div className="flex flex-col lg:flex-row lg:items-start gap-3">
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-gray-900 break-all">{job.name}</span>
                    <Badge tone={job.enabled ? 'green' : 'gray'}>{job.enabled ? t('control.cron.statusEnabled') : t('control.cron.statusDisabled')}</Badge>
                    {job.lastStatus && <Badge tone={job.lastStatus === 'ok' || job.lastStatus === 'success' ? 'blue' : 'red'}>{job.lastStatus}</Badge>}
                    <Badge>{job.agentId ?? t('control.cron.defaultAgent')}</Badge>
                  </div>
                  <div className="text-sm text-gray-600">{describeSchedule(job, t)}{job.schedule.tz ? ` · ${job.schedule.tz}` : ''}</div>
                  {job.message && <div className="text-sm text-gray-500 line-clamp-2 break-words">{job.message}</div>}
                  <div className="text-xs text-gray-400 flex flex-wrap gap-x-4 gap-y-1">
                    <span>{t('control.cron.nextRun')}: {formatTime(job.nextRunAtMs, i18n.language)}</span>
                    <span>{t('control.cron.lastRun')}: {formatTime(job.lastRunAtMs, i18n.language)}</span>
                    <span>{t('control.cron.delivery')}: {job.delivery.mode === 'announce' ? `${job.delivery.channel ?? 'last'}${job.delivery.to ? ` → ${job.delivery.to}` : ''}` : t('control.cron.deliveryNone')}</span>
                  </div>
                  {job.lastError && <div className="text-xs text-red-500 break-words">{job.lastError}</div>}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => void openRuns(job)}><History className="w-3.5 h-3.5" />{t('control.cron.history')}</Button>
                  {isAdmin && (
                    <>
                      <Button size="sm" busy={busyId === job.id} onClick={() => void act(job, 'run')}><Zap className="w-3.5 h-3.5" />{t('control.cron.runNow')}</Button>
                      <Button size="sm" onClick={() => void act(job, job.enabled ? 'disable' : 'enable')}>
                        {job.enabled ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                        {job.enabled ? t('control.cron.disable') : t('control.cron.enable')}
                      </Button>
                      <Button size="sm" onClick={() => setEditing(job)}><Pencil className="w-3.5 h-3.5" />{t('common.edit')}</Button>
                      <Button size="sm" variant="danger" onClick={() => setDeleting(job)}><Trash2 className="w-3.5 h-3.5" />{t('common.delete')}</Button>
                    </>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {editing && (
        <CronJobModal
          job={editing === 'new' ? null : editing}
          agents={agents}
          channels={channels}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title={t('common.confirmDelete')}
          message={t('control.cron.confirmDelete', { name: deleting.name })}
          confirmLabel={t('common.delete')}
          busy={busyId === deleting.id}
          onConfirm={() => void act(deleting, 'remove')}
          onCancel={() => setDeleting(null)}
        />
      )}

      {runsFor && (
        <Modal title={t('control.cron.historyTitle', { name: runsFor.job.name })} onClose={() => setRunsFor(null)}>
          {runsFor.runs === null ? <LoadingRow /> : runsFor.runs.length === 0 ? (
            <div className="text-sm text-gray-400 text-center py-6">{t('control.cron.historyEmpty')}</div>
          ) : (
            <div className="divide-y divide-gray-100">
              {runsFor.runs.map((run, index) => (
                <div key={run.runId ?? index} className="py-3 space-y-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <Badge tone={run.status === 'ok' || run.status === 'success' ? 'green' : run.status ? 'red' : 'gray'}>{run.status ?? t('common.unknown')}</Badge>
                    <span className="text-gray-600">{formatTime(run.startedAtMs, i18n.language)}</span>
                    {run.durationMs !== null && <span className="text-gray-400">{Math.round(run.durationMs / 100) / 10}s</span>}
                  </div>
                  {run.summary && <div className="text-sm text-gray-600 whitespace-pre-wrap break-words">{run.summary}</div>}
                  {run.error && <div className="text-xs text-red-500 break-words">{run.error}</div>}
                </div>
              ))}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
