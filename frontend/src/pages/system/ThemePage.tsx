// 主题（系统区，每个登录用户改自己的）：明暗 × 强调色 × 文字色 × 字号 × 背景图。
// 编辑时整个界面实时预览；保存后写服务端并更新本机缓存（下一次首帧就是这套）；离开页面没保存就恢复已保存的主题。
import { Check, ImageUp, Monitor, Moon, RotateCcw, Sun, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { themeApi } from '../../api/theme';
import { useAccess } from '../../app/access';
import { Badge, Button, Card, ConfirmDialog, ErrorBanner, inputClass, LoadingRow, Notice, PageIntro, type ErrorDisplay } from '../../components/control/ControlUi';
import {
  DEFAULT_USER_THEME,
  THEME_BACKGROUND_MAX_BYTES,
  THEME_FONT_SIZE_MAX,
  THEME_FONT_SIZE_MIN,
  applyTheme,
  cacheTheme,
  themeBackgroundUrl,
  themeUserKey,
  type ThemeMode,
  type UserTheme,
} from '../../theme/themeRuntime';
import { readApi, useErrorDisplay } from '../control/useControlApi';

type Draft = Pick<UserTheme, 'mode' | 'accentColor' | 'textColor' | 'fontSize'>;

const ACCENT_PRESETS = ['#3a6bd4', '#2f8578', '#7c5cc4', '#c2553a', '#b7791f', '#2f7d4f'];
const TEXT_PRESETS = ['#171c24', '#2b2f36', '#3b3024', '#1f2d3a'];
const HEX = /^#[0-9a-f]{6}$/;

const MODE_OPTIONS: { mode: ThemeMode; icon: typeof Sun }[] = [
  { mode: 'light', icon: Sun },
  { mode: 'dark', icon: Moon },
  { mode: 'system', icon: Monitor },
];

function sameDraft(a: Draft, b: Draft): boolean {
  return a.mode === b.mode && a.accentColor === b.accentColor && a.textColor === b.textColor && a.fontSize === b.fontSize;
}

function ColorField({ label, hint, value, presets, fallback, onChange }: {
  label: string;
  hint: string;
  value: string | null;
  presets: string[];
  fallback: string;
  onChange: (next: string | null) => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(value ?? '');
  useEffect(() => setText(value ?? ''), [value]);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium text-gray-900">{label}</div>
          <div className="text-xs text-gray-500">{hint}</div>
        </div>
        {value ? <Button size="sm" variant="ghost" onClick={() => onChange(null)}>{t('theme.useDefault')}</Button> : <Badge>{t('theme.default')}</Badge>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="color"
          aria-label={label}
          value={value ?? fallback}
          onChange={(event) => onChange(event.target.value.toLowerCase())}
          className="h-10 w-12 rounded-xl border border-gray-200 bg-white p-1 cursor-pointer"
        />
        <input
          value={text}
          onChange={(event) => {
            const next = event.target.value.trim().toLowerCase();
            setText(next);
            if (HEX.test(next)) onChange(next);
          }}
          placeholder={fallback}
          className={`${inputClass} w-32 font-mono`}
          aria-label={`${label} hex`}
        />
        <div className="flex flex-wrap gap-1.5">
          {presets.map((preset) => (
            <button
              key={preset}
              type="button"
              title={preset}
              aria-label={preset}
              onClick={() => onChange(preset)}
              className={`h-7 w-7 rounded-full border ${value === preset ? 'border-gray-900 ring-2 ring-gray-300' : 'border-gray-200'}`}
              style={{ backgroundColor: preset }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export default function ThemePage() {
  const { t } = useTranslation();
  const errors = useErrorDisplay();
  const { user } = useAccess();
  const [saved, setSaved] = useState<UserTheme | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<ErrorDisplay | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const savedRef = useRef<UserTheme | null>(null);
  const userKey = themeUserKey(user);

  const adopt = useCallback((theme: UserTheme) => {
    savedRef.current = theme;
    setSaved(theme);
    setDraft({ mode: theme.mode, accentColor: theme.accentColor, textColor: theme.textColor, fontSize: theme.fontSize });
    cacheTheme(userKey, theme);
    applyTheme(theme);
  }, [userKey]);

  useEffect(() => {
    let cancelled = false;
    readApi<{ theme: UserTheme }>(themeApi.get())
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          // 只读：载入不写服务端（「加载不许写」），缓存与应用交给 adopt。
          savedRef.current = result.data.theme;
          setSaved(result.data.theme);
          setDraft({ mode: result.data.theme.mode, accentColor: result.data.theme.accentColor, textColor: result.data.theme.textColor, fontSize: result.data.theme.fontSize });
        } else {
          setError(errors.fromResult(result, 'theme.loadFailed'));
          setSaved(DEFAULT_USER_THEME);
          setDraft({ mode: 'light', accentColor: null, textColor: null, fontSize: null });
        }
      })
      .catch((exception) => {
        if (!cancelled) setError(errors.fromException(exception));
      });
    return () => {
      cancelled = true;
      // 离开页面：没保存的预览不留在界面上。
      if (savedRef.current) applyTheme(savedRef.current);
    };
  }, [errors]);

  const updateDraft = (patch: Partial<Draft>) => {
    setNotice(null);
    setDraft((current) => {
      if (!current) return current;
      const next = { ...current, ...patch };
      applyTheme({ ...next, background: savedRef.current?.background ?? null });
      return next;
    });
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const result = await readApi<{ theme: UserTheme }>(themeApi.save(draft));
      if (result.ok) {
        adopt(result.data.theme);
        setNotice(t('theme.saved'));
      } else setError(errors.fromResult(result, 'theme.saveFailed'));
    } catch (exception) {
      setError(errors.fromException(exception));
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    if (!saved) return;
    setNotice(null);
    setDraft({ mode: saved.mode, accentColor: saved.accentColor, textColor: saved.textColor, fontSize: saved.fontSize });
    applyTheme(saved);
  };

  const resetAll = async () => {
    setConfirmReset(false);
    setSaving(true);
    try {
      const result = await readApi<{ theme: UserTheme }>(themeApi.reset());
      if (result.ok) {
        adopt(result.data.theme);
        setNotice(t('theme.resetDone'));
      } else setError(errors.fromResult(result, 'theme.saveFailed'));
    } catch (exception) {
      setError(errors.fromException(exception));
    } finally {
      setSaving(false);
    }
  };

  const upload = async (file: File | undefined) => {
    if (!file) return;
    if (fileRef.current) fileRef.current.value = '';
    if (file.size > THEME_BACKGROUND_MAX_BYTES) {
      setError({ message: t('theme.backgroundTooLarge', { maxMb: THEME_BACKGROUND_MAX_BYTES / 1024 / 1024 }), detail: '' });
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const result = await readApi<{ theme: UserTheme }>(themeApi.uploadBackground(file));
      if (result.ok) {
        // 背景立即生效；没保存的颜色草稿继续保留在预览里。
        savedRef.current = result.data.theme;
        setSaved(result.data.theme);
        cacheTheme(userKey, result.data.theme);
        if (draft) applyTheme({ ...draft, background: result.data.theme.background });
        setNotice(t('theme.backgroundSaved'));
      } else setError(errors.fromResult(result, 'theme.backgroundUploadFailed'));
    } catch (exception) {
      setError(errors.fromException(exception));
    } finally {
      setUploading(false);
    }
  };

  const removeBackground = async () => {
    setUploading(true);
    try {
      const result = await readApi<{ theme: UserTheme }>(themeApi.removeBackground());
      if (result.ok) {
        savedRef.current = result.data.theme;
        setSaved(result.data.theme);
        cacheTheme(userKey, result.data.theme);
        if (draft) applyTheme({ ...draft, background: null });
      } else setError(errors.fromResult(result, 'theme.backgroundUploadFailed'));
    } catch (exception) {
      setError(errors.fromException(exception));
    } finally {
      setUploading(false);
    }
  };

  if (!saved || !draft) return <LoadingRow />;
  const dirty = !sameDraft(draft, saved);

  return (
    <div className="space-y-6">
      <PageIntro
        title={t('theme.title')}
        description={t('theme.description')}
        actions={(
          <>
            <Button onClick={() => setConfirmReset(true)} disabled={saving}><RotateCcw className="w-4 h-4" />{t('theme.resetAll')}</Button>
            <Button onClick={discard} disabled={!dirty || saving}>{t('theme.discard')}</Button>
            <Button variant="primary" onClick={() => void save()} busy={saving} disabled={!dirty}><Check className="w-4 h-4" />{t('theme.save')}</Button>
          </>
        )}
      />
      <ErrorBanner error={error} onClose={() => setError(null)} />
      {notice && <Notice tone="green">{notice}</Notice>}
      {dirty && <Notice tone="blue">{t('theme.previewing')}</Notice>}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-6 min-w-0">
          <Card className="p-5 space-y-3">
            <div>
              <div className="text-sm font-semibold text-gray-900">{t('theme.modeTitle')}</div>
              <div className="text-xs text-gray-500">{t('theme.modeHint')}</div>
            </div>
            <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label={t('theme.modeTitle')}>
              {MODE_OPTIONS.map(({ mode, icon: Icon }) => (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={draft.mode === mode}
                  onClick={() => updateDraft({ mode })}
                  className={`h-11 rounded-xl border text-sm font-medium inline-flex items-center justify-center gap-2 transition-colors ${draft.mode === mode ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50'}`}
                >
                  <Icon className="w-4 h-4" />
                  {t(`theme.mode.${mode}`)}
                </button>
              ))}
            </div>
          </Card>

          <Card className="p-5 space-y-5">
            <ColorField label={t('theme.accentTitle')} hint={t('theme.accentHint')} value={draft.accentColor} presets={ACCENT_PRESETS} fallback="#3a6bd4" onChange={(accentColor) => updateDraft({ accentColor })} />
            <div className="border-t border-gray-100" />
            <ColorField label={t('theme.textTitle')} hint={t('theme.textHint')} value={draft.textColor} presets={TEXT_PRESETS} fallback="#171c24" onChange={(textColor) => updateDraft({ textColor })} />
          </Card>

          <Card className="p-5 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-gray-900">{t('theme.fontTitle')}</div>
                <div className="text-xs text-gray-500">{t('theme.fontHint', { min: THEME_FONT_SIZE_MIN, max: THEME_FONT_SIZE_MAX })}</div>
              </div>
              {draft.fontSize ? <Button size="sm" variant="ghost" onClick={() => updateDraft({ fontSize: null })}>{t('theme.useDefault')}</Button> : <Badge>{t('theme.default')}</Badge>}
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-gray-400">{THEME_FONT_SIZE_MIN}</span>
              <input
                type="range"
                min={THEME_FONT_SIZE_MIN}
                max={THEME_FONT_SIZE_MAX}
                step={1}
                value={draft.fontSize ?? 16}
                onChange={(event) => updateDraft({ fontSize: Number(event.target.value) })}
                className="flex-1 accent-blue-600"
                aria-label={t('theme.fontTitle')}
              />
              <span className="text-xs text-gray-400">{THEME_FONT_SIZE_MAX}</span>
              <span className="w-14 text-right text-sm font-mono text-gray-700">{draft.fontSize ?? 16}px</span>
            </div>
          </Card>

          <Card className="p-5 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-gray-900">{t('theme.backgroundTitle')}</div>
                <div className="text-xs text-gray-500">{t('theme.backgroundHint', { maxMb: THEME_BACKGROUND_MAX_BYTES / 1024 / 1024 })}</div>
              </div>
              <div className="flex gap-2">
                {saved.background && <Button size="sm" variant="danger" onClick={() => void removeBackground()} busy={uploading}><Trash2 className="w-3.5 h-3.5" />{t('theme.backgroundRemove')}</Button>}
                <Button size="sm" onClick={() => fileRef.current?.click()} busy={uploading}><ImageUp className="w-3.5 h-3.5" />{t('theme.backgroundUpload')}</Button>
              </div>
            </div>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" onChange={(event) => void upload(event.target.files?.[0])} />
            {saved.background ? (
              <div className="rounded-xl border border-gray-200 overflow-hidden">
                <img src={themeBackgroundUrl(saved.background.revision)} alt={t('theme.backgroundTitle')} className="block w-full h-40 object-cover" />
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-gray-200 px-4 py-8 text-center text-sm text-gray-400">{t('theme.backgroundEmpty')}</div>
            )}
          </Card>
        </div>

        <Card className="p-5 space-y-4 h-fit lg:sticky lg:top-4">
          <div className="text-sm font-semibold text-gray-900">{t('theme.previewTitle')}</div>
          <div className="rounded-xl border border-gray-200 bg-gray-50 p-3 space-y-3">
            <div className="rounded-xl border border-gray-200 bg-white p-3">
              <div className="text-xs font-semibold text-gray-500">{t('theme.previewAgent')}</div>
              <div className="mt-1 text-sm text-gray-700">{t('theme.previewReply')}</div>
            </div>
            <div className="ml-auto max-w-[85%] rounded-xl bg-blue-600 px-3 py-2 text-sm text-white">{t('theme.previewUser')}</div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="primary">{t('theme.previewPrimary')}</Button>
              <Button size="sm">{t('theme.previewSecondary')}</Button>
              <Badge tone="blue">{t('theme.previewBadge')}</Badge>
            </div>
            <input className={inputClass} readOnly value={t('theme.previewInput')} aria-label={t('theme.previewInput')} />
          </div>
          <p className="text-xs text-gray-500">{t('theme.previewNote')}</p>
        </Card>
      </div>

      {confirmReset && (
        <ConfirmDialog
          title={t('theme.resetAll')}
          message={t('theme.resetConfirm')}
          confirmLabel={t('theme.resetAll')}
          busy={saving}
          onConfirm={() => void resetAll()}
          onCancel={() => setConfirmReset(false)}
        />
      )}
    </div>
  );
}
