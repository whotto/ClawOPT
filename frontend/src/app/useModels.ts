import { useCallback, useEffect, useState } from 'react';
import { listModelsWithTimeout } from '../api/models';
import { BOOTSTRAP_REQUEST_TIMEOUT_MS, MODELS_POLL_MS, isPageVisible } from './bootstrap';

export function useModels() {
  const [availableModels, setAvailableModels] = useState<any[]>([]);
  // 引导提示（没有模型服务商）要分清「还没拿到」与「拿到了但是空的」，以及服务端读配置失败时回的空列表。
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [modelsConfigReadFailed, setModelsConfigReadFailed] = useState(false);

  const reloadModels = useCallback(async () => {
    try {
      const data = await listModelsWithTimeout(BOOTSTRAP_REQUEST_TIMEOUT_MS) as { success?: boolean; models?: any[]; configReadFailed?: boolean };
      if (data.success && Array.isArray(data.models)) {
        setAvailableModels(data.models);
        setModelsConfigReadFailed(data.configReadFailed === true);
        setModelsLoaded(true);
      }
    } catch (err) {
      console.error('Failed to reload models:', err);
    }
  }, []);

  useEffect(() => {
    reloadModels();
    const modelTimer = setInterval(() => { if (isPageVisible()) void reloadModels(); }, MODELS_POLL_MS);
    return () => clearInterval(modelTimer);
  }, [reloadModels]);

  return { availableModels, reloadModels, modelsLoaded, modelsConfigReadFailed };
}
