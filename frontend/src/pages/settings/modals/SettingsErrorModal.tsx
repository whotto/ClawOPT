// 设置页通用错误详情弹窗。
import { X } from 'lucide-react';
import type { SettingsController } from '../useSettingsController';

export default function SettingsErrorModal({ ctx }: { ctx: SettingsController }) {
  const { gatewayErrorDetail, gatewayErrorMessage, gatewayErrorModalOpen, setGatewayErrorModalOpen, t } = ctx;

  return (
    <>
            {/* Gateway Error Modal */}
            {gatewayErrorModalOpen && (
              <div className="fixed inset-0 z-[300] flex items-center justify-center p-4">
                <div className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity animate-in fade-in duration-200" onClick={() => setGatewayErrorModalOpen(false)}></div>
                <div className="bg-white rounded-[32px] border border-gray-200 w-full max-w-[420px] max-h-[calc(100vh-2rem)] overflow-y-auto relative z-10 animate-in fade-in zoom-in-95 duration-200">
                  <div className="p-8 text-center">
      	              <div className="mx-auto flex items-center justify-center h-16 w-16 rounded-3xl bg-red-50 mb-6 border border-red-100"><X className="h-8 w-8 text-red-500" /></div>
      	              <h3 className="text-xl font-black text-gray-900 mb-2 tracking-tight">{t('settings.gateway.configErrorTitle')}</h3>
      	              <p className="text-sm text-gray-500 leading-relaxed px-2">{gatewayErrorMessage}</p>
                      {gatewayErrorDetail && (
                        <div className="mt-4 text-left bg-gray-50 border border-gray-200 rounded-2xl px-4 py-3">
                          <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 mb-1.5">{t('settings.gateway.errorDetailLabel')}</p>
                          <p className="text-xs text-gray-500 whitespace-pre-wrap break-all font-mono">{gatewayErrorDetail}</p>
                        </div>
                      )}
      	            </div>
                  <div className="p-5 bg-gray-50/80 border-t border-gray-100">
                    <button type="button" onClick={() => setGatewayErrorModalOpen(false)} className="w-full px-4 py-3 text-white bg-blue-600 hover:bg-blue-700 active:scale-95 rounded-2xl font-bold text-sm transition-all">{t('common.gotIt')}</button>
                  </div>
                </div>
              </div>
            )}
    </>
  );
}
