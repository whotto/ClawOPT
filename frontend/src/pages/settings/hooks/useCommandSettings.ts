// 快捷指令的增删改。
import { useState } from 'react';
import { createCommand, listCommands, updateCommand } from '../../../api/commands';
import type { useSettingsShared } from './useSettingsShared';

export function useCommandSettings(deps: Pick<ReturnType<typeof useSettingsShared>, 'setDeleteModalMessage' | 'setDeleteTarget' | 'setIsDeleteModalOpen' | 'setIsLoading' | 't'>) {
  const { setDeleteModalMessage, setDeleteTarget, setIsDeleteModalOpen, setIsLoading, t } = deps;

  // --- Quick Commands state ---
  const [commands, setCommands] = useState<{ id: number; command: string; description: string }[]>([]);
  const [newCommand, setNewCommand] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);

  const fetchCommands = async () => {
    try {
      const res = await listCommands();
      const data = await res.json();
      if (data.success) setCommands(data.commands);
    } catch (err) {
      console.error(err);
    }
  };

  const handleAddCommand = async () => {
    if (!newCommand || !newDescription) return;
    setIsLoading(true);
    try {
      const res = await createCommand({ command: newCommand, description: newDescription });
      if (res.ok) {
        setNewCommand('');
        setNewDescription('');
        fetchCommands();
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleUpdateCommand = async () => {
    if (!editingId || !newCommand || !newDescription) return;
    setIsLoading(true);
    try {
      const res = await updateCommand(editingId, { command: newCommand, description: newDescription });
      if (res.ok) {
        setEditingId(null);
        setNewCommand('');
        setNewDescription('');
        fetchCommands();
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDeleteCommand = (id: number) => {
    setDeleteTarget({ type: 'command', id });
    setDeleteModalMessage(t('settings.commands.deleteConfirm'));
    setIsDeleteModalOpen(true);
  };

  const startEdit = (cmd: { id: number; command: string; description: string }) => {
    setEditingId(cmd.id);
    setNewCommand(cmd.command);
    setNewDescription(cmd.description);
  };

  return {
    commands,
    setCommands,
    newCommand,
    setNewCommand,
    newDescription,
    setNewDescription,
    editingId,
    setEditingId,
    fetchCommands,
    handleAddCommand,
    handleUpdateCommand,
    handleDeleteCommand,
    startEdit,
  };
}
