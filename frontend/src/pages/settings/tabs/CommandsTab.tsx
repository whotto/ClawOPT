// 快捷指令页签。
import { Check, Edit2, Plus, Trash2 } from 'lucide-react';
import type { SettingsController } from '../useSettingsController';

export default function CommandsTab({ ctx }: { ctx: SettingsController }) {
  const {
    commands,
    editingId,
    handleAddCommand,
    handleDeleteCommand,
    handleUpdateCommand,
    isLoading,
    newCommand,
    newDescription,
    setEditingId,
    setNewCommand,
    setNewDescription,
    startEdit,
    t,
  } = ctx;

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-gray-900 mb-1">{t('settings.commands.title')}</h3>
        <p className="text-sm text-gray-500 mb-6">{t('settings.commands.description')}</p>

        {/* Add/Edit Form */}
        <div className="bg-white p-4 sm:p-6 rounded-2xl border border-gray-200 mb-6">
          <div className="flex flex-col sm:flex-row gap-4 items-end">
            <div className="flex-1 w-full">
              <label className="block text-sm font-medium text-gray-900 mb-2">{t('settings.commands.commandLabel')}</label>
              <input
                type="text"
                value={newCommand}
                onChange={(e) => setNewCommand(e.target.value)}
                placeholder="/models"
                className="block w-full px-4 py-2.5 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm font-mono"
              />
            </div>
            <div className="flex-[2] w-full">
              <label className="block text-sm font-medium text-gray-900 mb-2">{t('settings.commands.descriptionLabel')}</label>
              <input
                type="text"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder={t('settings.commands.descriptionPlaceholder')}
                className="block w-full px-4 py-2.5 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm"
              />
            </div>
            <div className="flex w-full sm:w-auto gap-2">
              <button
                onClick={editingId ? handleUpdateCommand : handleAddCommand}
                disabled={isLoading || !newCommand || !newDescription}
                className="h-[42px] px-6 rounded-xl bg-blue-600 text-white font-bold text-sm hover:bg-blue-700 transition-all disabled:opacity-50 flex-1 sm:flex-none flex items-center justify-center gap-2"
              >
                {editingId ? <Check className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
                {editingId ? t('settings.commands.save') : t('settings.commands.addNew')}
              </button>
              {editingId && (
                <button
                  onClick={() => { setEditingId(null); setNewCommand(''); setNewDescription(''); }}
                  className="h-[42px] px-4 rounded-xl border border-gray-200 text-gray-500 hover:bg-gray-50 transition-all font-bold text-sm flex-1 sm:flex-none"
                >
                  {t('common.cancel')}
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Commands List */}
        <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse min-w-[500px]">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="px-6 py-4 text-xs font-bold text-gray-400 uppercase tracking-widest w-1/3">{t('settings.commands.tableCommand')}</th>
                <th className="px-6 py-4 text-xs font-bold text-gray-400 uppercase tracking-widest">{t('settings.commands.tableDescription')}</th>
                <th className="px-6 py-4 text-xs font-bold text-gray-400 uppercase tracking-widest text-right w-24">{t('settings.commands.tableActions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {commands.map((cmd) => (
                <tr key={cmd.id} className="hover:bg-gray-50/50 transition-colors">
                  <td className="px-6 py-4 text-sm font-mono font-bold text-blue-600">{cmd.command}</td>
                  <td className="px-6 py-4 text-sm text-gray-600">{cmd.description}</td>
                  <td className="px-6 py-4 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button 
                        onClick={() => startEdit(cmd)}
                        className="p-2 text-gray-400 hover:text-blue-500 hover:bg-blue-50 rounded-lg transition-all"
                        title={t('common.edit')}
                      >
                        <Edit2 className="w-4 h-4" />
                      </button>
                      <button 
                        onClick={() => handleDeleteCommand(cmd.id)}
                        className="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all"
                        title={t('common.delete')}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {commands.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-6 py-12 text-center text-gray-400 text-sm italic">
                    {t('settings.commands.empty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          </div>
        </div>
      </div>
    </div>
  );
}
