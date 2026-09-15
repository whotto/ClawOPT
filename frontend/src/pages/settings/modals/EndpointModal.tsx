// 新增 / 编辑端点弹窗。
import { Activity, Check, ChevronDown, Eye, EyeOff, Loader2, X } from 'lucide-react';
import type { SettingsController } from '../useSettingsController';

export default function EndpointModal({ ctx }: { ctx: SettingsController }) {
  const {
    editingEndpoint,
    endpointModalError,
    endpointTestMessage,
    endpointTestStatus,
    handleSaveEndpoint,
    handleTestEndpoint,
    isEndpointModalOpen,
    isLoading,
    modelError,
    newEndpointData,
    setIsEndpointModalOpen,
    setNewEndpointData,
    setShowPassword,
    showPassword,
    t,
  } = ctx;

  return (
    <>
            {/* Endpoint Add/Edit Modal */}
            {isEndpointModalOpen && (
              <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
                <div className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity" onClick={() => setIsEndpointModalOpen(false)}></div>
                <div className="bg-white rounded-2xl border border-gray-200 w-full max-w-2xl max-h-[calc(100vh-2rem)] overflow-y-auto relative z-10 animate-in fade-in zoom-in-95 duration-200">
                  <div className="px-6 py-5 border-b border-gray-100 flex justify-between items-center">
                    <h3 className="text-lg font-bold text-gray-900">
                      {editingEndpoint ? t('settings.models.endpointModalEditTitle') : t('settings.models.endpointModalCreateTitle')}
                    </h3>
                    <button
                      onClick={() => setIsEndpointModalOpen(false)}
                      className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                      title={t('common.close')}
                    >
                      <X className="w-5 h-5" />
                    </button>
                  </div>
                  <div className="p-6 space-y-4">
                    {endpointModalError.message && (
                      <div className="p-3 bg-red-50 text-red-600 text-sm rounded-xl border border-red-100 flex items-start gap-2">
                        <X className="w-4 h-4 shrink-0 mt-0.5" />
                        <div className="min-w-0">
                          <div>{endpointModalError.message}</div>
                          {endpointModalError.detail && (
                            <div className="mt-2 rounded-xl border border-red-100 bg-white/70 px-3 py-2 text-xs text-red-500 whitespace-pre-wrap break-all font-mono">
                              {endpointModalError.detail}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                    {modelError && (
                      <div className="p-3 bg-red-50 text-red-600 text-sm rounded-xl border border-red-100 flex items-center gap-2">
                        <X className="w-4 h-4 shrink-0" />
                        {modelError}
                      </div>
                    )}
                    <div>
                      <label className="block text-sm font-medium text-gray-900 mb-1.5">
                        {t('settings.models.endpointNameLabel')} <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="text"
                        value={newEndpointData.id}
                        onChange={(e) => setNewEndpointData({ ...newEndpointData, id: e.target.value })}
                        disabled={!!editingEndpoint}
                        placeholder={t('settings.models.endpointNamePlaceholder')}
                        className="block w-full px-4 py-2.5 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm disabled:opacity-60 disabled:cursor-not-allowed"
                      />
                    </div>

      	              <div>
      	                <label className="block text-sm font-medium text-gray-900 mb-1.5">
      	                  {t('settings.models.apiTypeLabel')} <span className="text-red-500">*</span>
      	                </label>
      	                <div className="relative">
      	                  <select
      	                    value={newEndpointData.api}
      	                    onChange={(e) => setNewEndpointData({ ...newEndpointData, api: e.target.value })}
      	                    className="block w-full appearance-none px-4 pr-14 py-2.5 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm"
      	                  >
      	                    <option value="openai-completions">{t('settings.models.openaiCompatibleLabel')}</option>
      	                    <option value="anthropic-messages">Anthropic (Messages)</option>
      	                    <option value="google-genai">Google Gemini (GenAI)</option>
      	                    <option value="cohere-chat">Cohere Chat</option>
      	                    <option value="mistral-chat">Mistral Chat</option>
      	                    <option value="ollama">Ollama</option>
      	                  </select>
      	                  <span className="pointer-events-none absolute inset-y-0 right-5 flex items-center text-gray-500">
      	                    <ChevronDown className="w-4 h-4" />
      	                  </span>
      	                </div>
      	                <p className="text-xs text-gray-500 mt-1.5 ml-1">{t('settings.models.apiTypeHint')}</p>
      	              </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-900 mb-1.5">
                        {t('settings.models.baseUrlLabel')} <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="text"
                        value={newEndpointData.baseUrl}
                        onChange={(e) => setNewEndpointData({ ...newEndpointData, baseUrl: e.target.value })}
                        placeholder="https://api.openai.com/v1"
                        className="block w-full px-4 py-2.5 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-900 mb-1.5">
                        {t('settings.models.apiKeyLabel')}
                      </label>
                      <div className="relative">
                        <input
                          type={showPassword ? "text" : "password"}
                          value={newEndpointData.apiKey}
                          onChange={(e) => setNewEndpointData({ ...newEndpointData, apiKey: e.target.value })}
                          placeholder={editingEndpoint?.hasApiKey ? t('settings.gateway.secretConfigured') : 'sk-...'}
                          className="block w-full px-4 py-2.5 pr-12 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm"
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword(!showPassword)}
                          className="absolute inset-y-0 right-0 px-4 flex items-center text-gray-400 hover:text-gray-600 transition-colors"
                        >
                          {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                      {editingEndpoint?.hasApiKey && <p className="text-xs text-gray-400 mt-1.5">{t('settings.gateway.secretKeepHint')}</p>}
                    </div>
                  </div>
                  <div className="p-4 bg-gray-50 flex gap-3 border-t border-gray-100">
                    <button
                      type="button"
                      onClick={() => setIsEndpointModalOpen(false)}
                      className="flex-[0.5] px-3 py-2.5 text-gray-700 bg-white border border-gray-200 hover:bg-gray-50 rounded-xl font-semibold transition-all text-sm whitespace-nowrap"
                    >
                      {t('common.cancel')}
                    </button>
                    <button
                      type="button"
                      onClick={handleTestEndpoint}
                      disabled={endpointTestStatus === 'testing' || !newEndpointData.baseUrl || !newEndpointData.api}
                      className={`flex-[1.5] px-3 py-2.5 rounded-xl font-semibold transition-all flex items-center justify-center gap-1.5 disabled:opacity-50 text-sm overflow-hidden ${ endpointTestStatus === 'testing' ? 'bg-blue-50 text-blue-600 border border-blue-200' : endpointTestStatus === 'success' ? 'bg-green-50 text-green-600 border border-green-200' : endpointTestStatus === 'error' ? 'bg-red-50 text-red-600 border border-red-200' : 'bg-white text-gray-700 border border-gray-200 hover:text-purple-700 hover:border-purple-200 hover:bg-purple-50' }`}
                      title={endpointTestStatus !== 'idle' ? endpointTestMessage : t('settings.models.pretestEndpoint')}
                    >
                      {endpointTestStatus === 'testing' ? <Loader2 className="w-4 h-4 animate-spin shrink-0" /> :
                       endpointTestStatus === 'success' ? <Check className="w-4 h-4 shrink-0" /> :
                       endpointTestStatus === 'error' ? <X className="w-4 h-4 shrink-0" /> :
                       <Activity className="w-4 h-4 shrink-0" />}
                      <span className="truncate">
                        {endpointTestStatus === 'idle' ? t('common.test') : endpointTestMessage}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={handleSaveEndpoint}
                      disabled={isLoading}
                      className="flex-[0.8] px-3 py-2.5 text-white bg-blue-600 hover:bg-blue-700 rounded-xl font-semibold transition-all flex items-center justify-center gap-2 disabled:opacity-50 text-sm whitespace-nowrap"
                    >
                      {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                      {t('settings.models.saveEndpoint')}
                    </button>
                  </div>
                </div>
              </div>
            )}
            {/* End of content */}
    </>
  );
}
