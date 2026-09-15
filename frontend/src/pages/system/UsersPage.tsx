// 用户与权限（系统区，super_admin）：用户列表、角色 / 状态、Agent 授权、重置口令、删除；登录 IP 锁解锁（admin）。
import { Lock, Pencil, Plus, RefreshCw, Trash2, Unlock } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usersApi } from '../../api/control';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorBanner, formatTime, inputClass, labelClass, LoadingRow, Modal, NoPermissionState, Notice, PageIntro, type ErrorDisplay } from '../../components/control/ControlUi';
import { useAccess } from '../../app/access';
import { useShellContext } from '../../app/shellContext';
import { readApi, useCurrentUser, useErrorDisplay } from '../control/useControlApi';
import { listMemberRuntimes } from '../../api/runtime';
import type { RuntimeOption } from '../../components/runtime/runtimeSelection';
import { assignableAgents, assignmentLabel, type AssignableAgent } from './userAssignments';

type Role = 'super_admin' | 'admin' | 'member';
type User = { id: number; username: string; role: Role; status: 'active' | 'disabled'; mustChangePassword: boolean; lastLoginAt: number | null; agentIds: string[] };
type IpLock = { ip: string; failures: number; lockedUntil: number | null };

function AssignmentChips({ options, assigned, onToggle }: { options: AssignableAgent[]; assigned: string[]; onToggle: (id: string) => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((option) => {
        const active = assigned.includes(option.id);
        return (
          <button
            key={option.id}
            type="button"
            title={option.id}
            onClick={() => onToggle(option.id)}
            className={`px-3 h-8 rounded-lg text-xs font-medium border inline-flex items-center gap-1.5 ${active ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white border-gray-200 text-gray-600'}`}
          >
            {option.label}
            {!option.available && <span className={active ? 'text-blue-100' : 'text-gray-400'}>· {t('control.users.notInstalled')}</span>}
          </button>
        );
      })}
    </div>
  );
}

function UserModal({ user, sessions, runtimes, onClose, onSaved }: { user: User | null; sessions: Array<{ id: string; agentId?: string; externalRuntime?: string | null }>; runtimes: RuntimeOption[]; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const errors = useErrorDisplay();
  const [username, setUsername] = useState(user?.username ?? '');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>(user?.role ?? 'member');
  const [status, setStatus] = useState(user?.status ?? 'active');
  const [assigned, setAssigned] = useState<string[]>(user?.agentIds ?? []);
  const [error, setError] = useState<ErrorDisplay | null>(null);
  const [saving, setSaving] = useState(false);
  const options = assignableAgents(sessions, runtimes, user?.agentIds ?? []);
  const openclawOptions = options.filter((option) => option.kind === 'openclaw');
  const externalOptions = options.filter((option) => option.kind === 'external');
  const toggle = (id: string) => setAssigned(assigned.includes(id) ? assigned.filter((item) => item !== id) : [...assigned, id]);

  const save = async () => {
    setSaving(true);
    setError(null);
    const body = { username, password: password || undefined, role, status, agentIds: assigned };
    try {
      const result = await readApi(user ? usersApi.update(user.id, body) : usersApi.create(body));
      if (result.ok) onSaved();
      else setError(errors.fromResult(result, 'control.users.saveFailed'));
    } catch (exception) {
      setError(errors.fromException(exception));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={user ? t('control.users.editTitle', { name: user.username }) : t('control.users.createTitle')}
      onClose={onClose}
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" busy={saving} disabled={!username.trim() || (!user && password.length < 8)} onClick={save}>{t('common.save')}</Button></>}
    >
      <ErrorBanner error={error} onClose={() => setError(null)} />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <label className="block">
          <span className={labelClass}>{t('control.users.username')}</span>
          <input value={username} disabled={!!user} onChange={(event) => setUsername(event.target.value)} className={inputClass} autoComplete="off" />
        </label>
        <label className="block">
          <span className={labelClass}>{user ? t('control.users.resetPassword') : t('control.users.password')}</span>
          <input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} className={inputClass} placeholder={user ? t('control.users.leaveBlankKeep') : t('control.users.passwordHint')} />
        </label>
        <label className="block">
          <span className={labelClass}>{t('control.users.role')}</span>
          <select value={role} onChange={(event) => setRole(event.target.value as Role)} className={inputClass}>
            {(['member', 'admin', 'super_admin'] as const).map((value) => <option key={value} value={value}>{t(`control.users.roles.${value}`)}</option>)}
          </select>
        </label>
        <label className="block">
          <span className={labelClass}>{t('control.users.status')}</span>
          <select value={status} onChange={(event) => setStatus(event.target.value as 'active' | 'disabled')} className={inputClass}>
            <option value="active">{t('control.users.statusActive')}</option>
            <option value="disabled">{t('control.users.statusDisabled')}</option>
          </select>
        </label>
      </div>
      <div>
        <div className={labelClass}>{t('control.users.agents')}</div>
        {role !== 'member' ? <p className="text-xs text-gray-400">{t('control.users.agentsAllForAdmins')}</p> : options.length === 0 ? <p className="text-xs text-gray-400">{t('control.users.noAgents')}</p> : (
          <div className="space-y-3">
            {openclawOptions.length > 0 && <AssignmentChips options={openclawOptions} assigned={assigned} onToggle={toggle} />}
            {externalOptions.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-xs font-medium text-gray-500">{t('control.users.externalRuntimes')}</div>
                <AssignmentChips options={externalOptions} assigned={assigned} onToggle={toggle} />
                <p className="text-xs text-gray-400">{t('control.users.externalRuntimesHint')}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

export default function UsersPage() {
  const { t, i18n } = useTranslation();
  const errors = useErrorDisplay();
  const shell = useShellContext();
  const { user: me } = useCurrentUser();
  // 用户列表与增删改只给 super_admin（users.manage）；admin 进这一页只管登录 IP 锁。
  const { can, capabilities } = useAccess();
  const canManageUsers = can('users.manage');
  const [users, setUsers] = useState<User[] | null>(null);
  const [usersForbidden, setUsersForbidden] = useState(false);
  const [locks, setLocks] = useState<IpLock[]>([]);
  const [error, setError] = useState<ErrorDisplay | null>(null);
  const [editing, setEditing] = useState<User | 'new' | null>(null);
  const [deleting, setDeleting] = useState<User | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [runtimes, setRuntimes] = useState<RuntimeOption[]>([]);

  const load = useCallback(async () => {
    if (!capabilities) return;
    setError(null);
    try {
      const [list, locked, runtimeList] = await Promise.all([
        canManageUsers ? readApi<{ users: User[] }>(usersApi.list()) : Promise.resolve(null),
        readApi<{ locks: IpLock[] }>(usersApi.lockedIps()),
        // 可授权的外部运行时（`ext:<运行时>`）：只有管理用户的人要选。
        canManageUsers ? readApi<{ runtimes: RuntimeOption[] }>(listMemberRuntimes()) : Promise.resolve(null),
      ]);
      if (runtimeList?.ok) setRuntimes(runtimeList.data.runtimes ?? []);
      // 403 是「没有权限」，不是「还没有用户」：两种空态不能混。
      setUsersForbidden(!list || list.status === 403);
      if (list?.ok) setUsers(list.data.users);
      else if (list && list.status !== 403) {
        setUsers([]);
        setError(errors.fromResult(list, 'control.users.loadFailed'));
      }
      if (locked.ok) setLocks(locked.data.locks);
    } catch (exception) {
      setUsers([]);
      setError(errors.fromException(exception));
    }
  }, [errors, capabilities, canManageUsers]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (key: string, request: () => Promise<Response>) => {
    setBusy(key);
    setError(null);
    try {
      const result = await readApi(request());
      if (!result.ok) setError(errors.fromResult(result));
      await load();
    } catch (exception) {
      setError(errors.fromException(exception));
    } finally {
      setBusy(null);
      setDeleting(null);
    }
  };

  return (
    <div className="space-y-6">
      <PageIntro
        title={t('control.users.title')}
        description={t('control.users.description')}
        actions={(
          <>
            <Button onClick={() => void load()}><RefreshCw className="w-4 h-4" />{t('control.common.refresh')}</Button>
            {canManageUsers && !usersForbidden && <Button variant="primary" onClick={() => setEditing('new')}><Plus className="w-4 h-4" />{t('control.users.create')}</Button>}
          </>
        )}
      />
      <ErrorBanner error={error} onClose={() => setError(null)} />
      {me?.implicit && <Notice tone="blue">{t('control.users.loginDisabledHint')}</Notice>}

      {usersForbidden ? <NoPermissionState /> : users === null ? <LoadingRow /> : users.length === 0 ? <EmptyState>{t('control.users.empty')}</EmptyState> : (
        <Card className="divide-y divide-gray-100">
          {users.map((user) => (
            <div key={user.id} className="p-4 flex flex-col md:flex-row md:items-center gap-3">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-gray-900">{user.username}</span>
                  <Badge tone={user.role === 'super_admin' ? 'amber' : user.role === 'admin' ? 'blue' : 'gray'}>{t(`control.users.roles.${user.role}`)}</Badge>
                  {user.status === 'disabled' && <Badge tone="red">{t('control.users.statusDisabled')}</Badge>}
                  {user.mustChangePassword && <Badge tone="amber">{t('control.users.mustChangePassword')}</Badge>}
                  {me?.id === user.id && <Badge tone="green">{t('control.users.you')}</Badge>}
                </div>
                <div className="text-xs text-gray-400 flex flex-wrap gap-x-4">
                  <span>{t('control.users.lastLogin')}: {formatTime(user.lastLoginAt, i18n.language)}</span>
                  {user.role === 'member' && <span>{t('control.users.agents')}: {user.agentIds.map((id) => assignmentLabel(id, runtimes)).join(', ') || '—'}</span>}
                </div>
              </div>
              {canManageUsers && (
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => setEditing(user)}><Pencil className="w-3.5 h-3.5" />{t('common.edit')}</Button>
                  {me?.id !== user.id && <Button size="sm" variant="danger" onClick={() => setDeleting(user)}><Trash2 className="w-3.5 h-3.5" />{t('common.delete')}</Button>}
                </div>
              )}
            </div>
          ))}
        </Card>
      )}

      <Card className="p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-sm font-semibold text-gray-900 flex items-center gap-2"><Lock className="w-4 h-4" />{t('control.users.lockedIps')}</div>
          {locks.length > 0 && <Button size="sm" busy={busy === 'unlock-all'} onClick={() => void run('unlock-all', () => usersApi.unlockIp(null))}><Unlock className="w-3.5 h-3.5" />{t('control.users.unlockAll')}</Button>}
        </div>
        {locks.length === 0 ? <div className="text-sm text-gray-400">{t('control.users.noLockedIps')}</div> : locks.map((lock) => (
          <div key={lock.ip} className="flex items-center justify-between gap-2 text-sm">
            <span className="font-mono text-gray-700">{lock.ip}</span>
            <span className="text-xs text-gray-400">{t('control.users.lockedUntil', { time: formatTime(lock.lockedUntil, i18n.language), count: lock.failures })}</span>
            <Button size="sm" busy={busy === `unlock:${lock.ip}`} onClick={() => void run(`unlock:${lock.ip}`, () => usersApi.unlockIp(lock.ip))}><Unlock className="w-3.5 h-3.5" />{t('control.users.unlock')}</Button>
          </div>
        ))}
      </Card>

      {editing && <UserModal user={editing === 'new' ? null : editing} sessions={shell.sessions} runtimes={runtimes} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
      {deleting && (
        <ConfirmDialog
          title={t('common.confirmDelete')}
          message={t('control.users.confirmDelete', { name: deleting.username })}
          confirmLabel={t('common.delete')}
          busy={busy === `delete:${deleting.id}`}
          onConfirm={() => void run(`delete:${deleting.id}`, () => usersApi.remove(deleting.id))}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
