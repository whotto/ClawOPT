// 定时计划：列表（启用、上次、下次、最近运行、事件）+ 表单（频率构建器、时区、输入、开始节点、超时）。
import { Pencil, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createSchedule, deleteSchedule, listScheduleEvents, listSchedules, updateSchedule } from '../../../api/automation';
import { describeError, requestJson } from '../lib/request';
import { FREQUENCY_KINDS, cronToFrequency, defaultFrequency, frequencyToCron, type Frequency } from '../lib/schedule-frequency';
import type { ScheduleRecord, WfNode } from '../lib/types';
import { ErrorBanner, Field, InfoBanner, Modal, Toggle, dangerButton, formatTime, iconButton, fieldClass, inputClass, primaryButton, secondaryButton, selectClass } from './ui';

type Draft = { id: string | null; name: string; frequency: Frequency; timezone: string; enabled: boolean; input: string; startNodeIds: string[]; timeoutMinutes: string };
type ScheduleEvent = { id: string; kind: string; reason: string | null; runId: string | null; scheduledAt: number | null; createdAt: number };

const browserTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const emptyDraft = (): Draft => ({ id: null, name: '', frequency: { kind: 'daily', hour: 9, minute: 0 }, timezone: browserTimezone(), enabled: true, input: '', startNodeIds: [], timeoutMinutes: '' });

function NumberInput({ value, min, max, onChange }: { value: number; min: number; max: number; onChange: (value: number) => void }) {
  return <input className={`${fieldClass} w-20`} type="number" min={min} max={max} value={value} onChange={(event) => onChange(Number(event.target.value))} />;
}

export default function SchedulesModal({ workflowId, savedNodes, onClose }: { workflowId: string; savedNodes: WfNode[]; onClose: () => void }) {
  const { t } = useTranslation();
  const [schedules, setSchedules] = useState<ScheduleRecord[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [events, setEvents] = useState<{ scheduleId: string; rows: ScheduleEvent[] } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const generation = useRef(0);

  const reload = useCallback(async () => {
    const token = ++generation.current;
    const result = await requestJson<{ schedules: ScheduleRecord[] }>(listSchedules(workflowId));
    if (token !== generation.current) return;
    if (result.ok) setSchedules(result.data.schedules);
    else setProblem(describeError(t, result.error));
  }, [workflowId, t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const save = async () => {
    if (!draft) return;
    const timeout = draft.timeoutMinutes.trim() ? Math.round(Number(draft.timeoutMinutes) * 60_000) : null;
    const body = { name: draft.name, cron: frequencyToCron(draft.frequency), timezone: draft.timezone, enabled: draft.enabled, input: draft.input, start_node_ids: draft.startNodeIds, timeout_ms: timeout };
    const result = await requestJson(draft.id ? updateSchedule(workflowId, draft.id, body) : createSchedule(workflowId, body));
    if (!result.ok) return setProblem(describeError(t, result.error));
    setDraft(null);
    setProblem(null);
    void reload();
  };

  const toggle = async (schedule: ScheduleRecord) => {
    const result = await requestJson(updateSchedule(workflowId, schedule.id, { enabled: !schedule.enabled }));
    if (!result.ok) setProblem(describeError(t, result.error));
    void reload();
  };

  const remove = async (schedule: ScheduleRecord) => {
    const result = await requestJson(deleteSchedule(workflowId, schedule.id));
    if (!result.ok) setProblem(describeError(t, result.error));
    void reload();
  };

  const showEvents = async (schedule: ScheduleRecord) => {
    const result = await requestJson<{ events: ScheduleEvent[] }>(listScheduleEvents(workflowId, schedule.id));
    if (result.ok) setEvents({ scheduleId: schedule.id, rows: result.data.events });
  };

  const setFrequency = (frequency: Frequency) => setDraft((current) => (current ? { ...current, frequency } : current));
  const frequency = draft?.frequency;

  return (
    <Modal title={t('automation.schedules.title')} onClose={onClose} width="max-w-2xl">
      {problem && <ErrorBanner message={problem} onDismiss={() => setProblem(null)} />}
      <InfoBanner>{t('automation.schedules.policyNote')}</InfoBanner>
      {!draft && (
        <>
          <div className="space-y-2">
            {schedules.length === 0 && <p className="text-sm text-gray-500">{t('automation.schedules.empty')}</p>}
            {schedules.map((schedule) => (
              <div key={schedule.id} className="p-3 rounded-xl border border-gray-200 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-gray-900 truncate">{schedule.name || schedule.cron}</div>
                    <div className="text-xs text-gray-500 font-mono">{schedule.cron} · {schedule.timezone}</div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Toggle checked={schedule.enabled} onChange={() => void toggle(schedule)} label="" />
                    <button className={iconButton} title={t('common.edit')} onClick={() => setDraft({ id: schedule.id, name: schedule.name, frequency: cronToFrequency(schedule.cron), timezone: schedule.timezone, enabled: schedule.enabled, input: schedule.input ?? '', startNodeIds: schedule.startNodeIds, timeoutMinutes: schedule.timeoutMs ? String(schedule.timeoutMs / 60_000) : '' })}>
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button className={iconButton} title={t('common.delete')} onClick={() => void remove(schedule)}><Trash2 className="w-4 h-4" /></button>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-1 text-xs text-gray-500">
                  <span>{t('automation.schedules.next')}: {formatTime(schedule.nextRunAt)}</span>
                  <span>{t('automation.schedules.last')}: {formatTime(schedule.lastScheduledAt)}</span>
                  <button className="text-left text-blue-600 hover:underline" onClick={() => void showEvents(schedule)}>{t('automation.schedules.events')}</button>
                </div>
                {schedule.lastError && <div className="text-xs text-red-600">{describeError(t, { code: schedule.lastError })}</div>}
                {events?.scheduleId === schedule.id && (
                  <ul className="text-xs text-gray-600 space-y-1 border-t border-gray-100 pt-2">
                    {events.rows.length === 0 && <li className="text-gray-400">{t('automation.schedules.noEvents')}</li>}
                    {events.rows.map((row) => (
                      <li key={row.id} className="flex flex-wrap gap-2">
                        <span>{formatTime(row.scheduledAt ?? row.createdAt)}</span>
                        <span className="font-medium">{t(`automation.schedules.eventKinds.${row.kind}`)}</span>
                        {row.reason && <span className="text-gray-400">{row.reason === 'misfire' || row.reason === 'overlap' ? t(`automation.schedules.reasons.${row.reason}`) : describeError(t, { code: row.reason })}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
          <button className={primaryButton} onClick={() => setDraft(emptyDraft())}>{t('automation.schedules.add')}</button>
        </>
      )}
      {draft && frequency && (
        <div className="space-y-3">
          <Field label={t('automation.schedules.name')}>
            <input className={inputClass} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          </Field>
          <Field label={t('automation.schedules.frequency')}>
            <select className={selectClass} value={frequency.kind} onChange={(event) => setFrequency(defaultFrequency(event.target.value as Frequency['kind'], frequencyToCron(frequency)))}>
              {FREQUENCY_KINDS.map((kind) => <option key={kind} value={kind}>{t(`automation.schedules.kinds.${kind}`)}</option>)}
            </select>
          </Field>
          <div className="flex flex-wrap items-end gap-2 text-sm text-gray-600">
            {frequency.kind === 'weekly' && (
              <select className={`${fieldClass} w-auto`} value={frequency.weekday} onChange={(event) => setFrequency({ ...frequency, weekday: Number(event.target.value) })}>
                {[0, 1, 2, 3, 4, 5, 6].map((day) => <option key={day} value={day}>{t(`automation.schedules.weekdays.${day}`)}</option>)}
              </select>
            )}
            {frequency.kind === 'monthly' && <><span>{t('automation.schedules.day')}</span><NumberInput value={frequency.day} min={1} max={31} onChange={(day) => setFrequency({ ...frequency, day })} /></>}
            {(frequency.kind === 'daily' || frequency.kind === 'weekly' || frequency.kind === 'monthly') && <><span>{t('automation.schedules.hour')}</span><NumberInput value={frequency.hour} min={0} max={23} onChange={(hour) => setFrequency({ ...frequency, hour })} /></>}
            {(frequency.kind === 'hourly' || frequency.kind === 'daily' || frequency.kind === 'weekly' || frequency.kind === 'monthly') && <><span>{t('automation.schedules.minute')}</span><NumberInput value={frequency.minute} min={0} max={59} onChange={(minute) => setFrequency({ ...frequency, minute })} /></>}
            {frequency.kind === 'custom' && <input className={`${inputClass} font-mono`} value={frequency.cron} onChange={(event) => setFrequency({ kind: 'custom', cron: event.target.value })} placeholder="0 9 * * MON-FRI" />}
          </div>
          <p className="text-xs text-gray-500 font-mono">{frequencyToCron(frequency)}</p>
          <Field label={t('automation.schedules.timezone')}>
            <input className={inputClass} value={draft.timezone} onChange={(event) => setDraft({ ...draft, timezone: event.target.value })} />
          </Field>
          <Toggle checked={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} label={t('automation.schedules.enabled')} />
          <Field label={t('automation.schedules.input')}>
            <textarea className={`${inputClass} min-h-[64px]`} value={draft.input} onChange={(event) => setDraft({ ...draft, input: event.target.value })} />
          </Field>
          <Field label={t('automation.schedules.startNodes')} hint={t('automation.schedules.startNodesHint')}>
            <div className="flex flex-wrap gap-2">
              {savedNodes.map((node) => (
                <label key={node.id} className="inline-flex items-center gap-1 text-sm text-gray-700">
                  <input type="checkbox" checked={draft.startNodeIds.includes(node.id)} onChange={(event) => setDraft({ ...draft, startNodeIds: event.target.checked ? [...draft.startNodeIds, node.id] : draft.startNodeIds.filter((id) => id !== node.id) })} />
                  {node.data.title}
                </label>
              ))}
            </div>
          </Field>
          <Field label={t('automation.schedules.timeout')} hint={t('automation.schedules.timeoutHint')}>
            <input className={inputClass} type="number" min={0.1} max={1440} value={draft.timeoutMinutes} onChange={(event) => setDraft({ ...draft, timeoutMinutes: event.target.value })} />
          </Field>
          <div className="flex justify-end gap-2">
            <button className={secondaryButton} onClick={() => setDraft(null)}>{t('common.cancel')}</button>
            {draft.id && <button className={dangerButton} onClick={() => { const found = schedules.find((item) => item.id === draft.id); if (found) void remove(found); setDraft(null); }}>{t('common.delete')}</button>}
            <button className={primaryButton} onClick={() => void save()}>{t('common.save')}</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
