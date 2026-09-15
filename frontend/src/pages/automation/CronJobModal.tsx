// 新建 / 编辑定时任务。调度构造器：六种预设 + 固定间隔 + 单次；预设换算在后端。
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cronApi } from '../../api/control';
import { Button, ErrorBanner, inputClass, labelClass, Modal, Notice, textareaClass, type ErrorDisplay } from '../../components/control/ControlUi';
import { readApi, useErrorDisplay } from '../control/useControlApi';
import { type CronJob, DEFAULT_SCHEDULE_FORM, scheduleFormFromJob, scheduleInputFromForm, type ScheduleForm, type ScheduleMode } from './cronTypes';

const MODES: ScheduleMode[] = ['everyMinutes', 'hourly', 'daily', 'weekly', 'monthly', 'custom', 'every', 'at'];

function NumberField({ value, min, max, onChange, label }: { value: number; min: number; max: number; onChange: (value: number) => void; label: string }) {
  return (
    <label className="block">
      <span className={labelClass}>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Math.min(max, Math.max(min, Number(event.target.value) || min)))}
        className={inputClass}
      />
    </label>
  );
}

export default function CronJobModal({ job, agents, channels, onClose, onSaved }: {
  job: CronJob | null;
  agents: string[];
  channels: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const errors = useErrorDisplay();
  const [name, setName] = useState(job?.name ?? '');
  const [description, setDescription] = useState(job?.description ?? '');
  const [agentId, setAgentId] = useState(job?.agentId ?? '');
  const [message, setMessage] = useState(job?.message ?? '');
  const [sessionTarget, setSessionTarget] = useState(job?.sessionTarget === 'main' ? 'main' : 'isolated');
  const [deliveryMode, setDeliveryMode] = useState(job?.delivery.mode === 'announce' ? 'announce' : 'none');
  const [deliveryChannel, setDeliveryChannel] = useState(job?.delivery.channel ?? 'last');
  const [deliveryTo, setDeliveryTo] = useState(job?.delivery.to ?? '');
  const [model, setModel] = useState(job?.model ?? '');
  const [enabled, setEnabled] = useState(job?.enabled ?? true);
  const [schedule, setSchedule] = useState<ScheduleForm>(job ? scheduleFormFromJob(job) : DEFAULT_SCHEDULE_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ErrorDisplay | null>(null);
  const [conflict, setConflict] = useState(false);

  const patchSchedule = (patch: Partial<ScheduleForm>) => setSchedule((current) => ({ ...current, ...patch }));
  const needsTime = ['daily', 'weekly', 'monthly'].includes(schedule.mode);
  const nonPayloadJob = job && job.payloadKind && job.payloadKind !== 'agentTurn';

  const save = async () => {
    setSaving(true);
    setError(null);
    const body = {
      name,
      description,
      agentId,
      message,
      schedule: scheduleInputFromForm(schedule),
      sessionTarget,
      delivery: deliveryMode === 'announce' ? { mode: 'announce', channel: deliveryChannel, to: deliveryTo } : { mode: 'none' },
      model,
      enabled,
    };
    try {
      const result = await readApi(job ? cronApi.update(job.id, body, job.revision) : cronApi.create(body));
      if (result.ok) {
        onSaved();
        return;
      }
      if (result.status === 412) {
        setConflict(true);
        return;
      }
      setError(errors.fromResult(result, 'control.cron.saveFailed'));
    } catch (exception) {
      setError(errors.fromException(exception));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={job ? t('control.cron.editTitle') : t('control.cron.createTitle')}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" busy={saving} disabled={!name.trim() || !message.trim() || conflict} onClick={save}>{t('common.save')}</Button>
        </>
      )}
    >
      {conflict && <Notice>{t('control.common.changedElsewhere')}</Notice>}
      {nonPayloadJob && <Notice tone="blue">{t('control.cron.nonAgentJobHint')}</Notice>}
      <ErrorBanner error={error} onClose={() => setError(null)} />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <label className="block">
          <span className={labelClass}>{t('control.cron.name')} <span className="text-red-500">*</span></span>
          <input value={name} onChange={(event) => setName(event.target.value)} className={inputClass} maxLength={200} />
        </label>
        <label className="block">
          <span className={labelClass}>{t('control.cron.agent')}</span>
          <select value={agentId} onChange={(event) => setAgentId(event.target.value)} className={inputClass}>
            <option value="">{t('control.cron.defaultAgent')}</option>
            {agents.map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
        </label>
      </div>

      <label className="block">
        <span className={labelClass}>{t('control.cron.message')} <span className="text-red-500">*</span></span>
        <textarea value={message} onChange={(event) => setMessage(event.target.value)} rows={4} className={textareaClass} />
      </label>

      <label className="block">
        <span className={labelClass}>{t('control.cron.descriptionLabel')}</span>
        <input value={description} onChange={(event) => setDescription(event.target.value)} className={inputClass} maxLength={1000} />
      </label>

      <div className="rounded-2xl border border-gray-200 p-4 space-y-4">
        <div className="text-sm font-semibold text-gray-900">{t('control.cron.schedule')}</div>
        <div className="flex flex-wrap gap-2">
          {MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => patchSchedule({ mode })}
              className={`px-3 h-8 rounded-lg text-xs font-medium border transition-all ${schedule.mode === mode ? 'bg-amber-50 border-orange-300 text-gray-700' : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'}`}
            >
              {t(`control.cron.mode.${mode}`)}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {schedule.mode === 'everyMinutes' && <NumberField label={t('control.cron.minutesInterval')} value={schedule.minutes} min={1} max={59} onChange={(minutes) => patchSchedule({ minutes })} />}
          {schedule.mode === 'hourly' && <NumberField label={t('control.cron.minuteOfHour')} value={schedule.minute} min={0} max={59} onChange={(minute) => patchSchedule({ minute })} />}
          {schedule.mode === 'monthly' && <NumberField label={t('control.cron.dayOfMonth')} value={schedule.day} min={1} max={31} onChange={(day) => patchSchedule({ day })} />}
          {needsTime && (
            <>
              <NumberField label={t('control.cron.hour')} value={schedule.hour} min={0} max={23} onChange={(hour) => patchSchedule({ hour })} />
              <NumberField label={t('control.cron.minute')} value={schedule.minute} min={0} max={59} onChange={(minute) => patchSchedule({ minute })} />
            </>
          )}
        </div>
        {schedule.mode === 'weekly' && (
          <div className="flex flex-wrap gap-2">
            {[1, 2, 3, 4, 5, 6, 0].map((day) => {
              const active = schedule.weekdays.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  onClick={() => patchSchedule({ weekdays: active ? schedule.weekdays.filter((value) => value !== day) : [...schedule.weekdays, day] })}
                  className={`w-10 h-8 rounded-lg text-xs font-medium border ${active ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white border-gray-200 text-gray-600'}`}
                >
                  {t(`control.cron.weekday.${day}`)}
                </button>
              );
            })}
          </div>
        )}
        {schedule.mode === 'custom' && (
          <label className="block">
            <span className={labelClass}>{t('control.cron.cronExpression')}</span>
            <input value={schedule.expr} onChange={(event) => patchSchedule({ expr: event.target.value })} className={`${inputClass} font-mono`} placeholder="0 9 * * 1-5" />
          </label>
        )}
        {schedule.mode === 'every' && (
          <label className="block">
            <span className={labelClass}>{t('control.cron.everyDuration')}</span>
            <input value={schedule.every} onChange={(event) => patchSchedule({ every: event.target.value })} className={`${inputClass} font-mono`} placeholder="30m" />
          </label>
        )}
        {schedule.mode === 'at' && (
          <label className="block">
            <span className={labelClass}>{t('control.cron.runAt')}</span>
            <input type="datetime-local" value={schedule.at} onChange={(event) => patchSchedule({ at: event.target.value })} className={inputClass} />
          </label>
        )}
        {schedule.mode !== 'every' && schedule.mode !== 'at' && (
          <label className="block">
            <span className={labelClass}>{t('control.cron.timezone')}</span>
            <input value={schedule.tz} onChange={(event) => patchSchedule({ tz: event.target.value })} className={inputClass} placeholder={t('control.cron.timezonePlaceholder')} />
          </label>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <label className="block">
          <span className={labelClass}>{t('control.cron.sessionTarget')}</span>
          <select value={sessionTarget} onChange={(event) => setSessionTarget(event.target.value)} className={inputClass}>
            <option value="isolated">{t('control.cron.sessionIsolated')}</option>
            <option value="main">{t('control.cron.sessionMain')}</option>
          </select>
        </label>
        <label className="block">
          <span className={labelClass}>{t('control.cron.model')}</span>
          <input value={model} onChange={(event) => setModel(event.target.value)} className={inputClass} placeholder={t('control.cron.modelPlaceholder')} />
        </label>
        <label className="block">
          <span className={labelClass}>{t('control.cron.delivery')}</span>
          <select value={deliveryMode} onChange={(event) => setDeliveryMode(event.target.value)} className={inputClass}>
            <option value="none">{t('control.cron.deliveryNone')}</option>
            <option value="announce">{t('control.cron.deliveryAnnounce')}</option>
          </select>
        </label>
        {deliveryMode === 'announce' && (
          <label className="block">
            <span className={labelClass}>{t('control.cron.deliveryChannel')}</span>
            <select value={deliveryChannel} onChange={(event) => setDeliveryChannel(event.target.value)} className={inputClass}>
              <option value="last">{t('control.cron.deliveryLast')}</option>
              {channels.map((channel) => <option key={channel} value={channel}>{channel}</option>)}
            </select>
          </label>
        )}
        {deliveryMode === 'announce' && (
          <label className="block sm:col-span-2">
            <span className={labelClass}>{t('control.cron.deliveryTo')}</span>
            <input value={deliveryTo} onChange={(event) => setDeliveryTo(event.target.value)} className={inputClass} placeholder={t('control.cron.deliveryToPlaceholder')} />
          </label>
        )}
      </div>

      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
        {t('control.cron.enabled')}
      </label>
    </Modal>
  );
}
