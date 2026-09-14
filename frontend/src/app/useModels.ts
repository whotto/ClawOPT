import { useCallback, useEffect, useState } from 'react';
import { listModelsWithTimeout } from '../api/models';
import { BOOTSTRAP_REQUEST_TIMEOUT_MS, MODELS_POLL_MS, isPageVisible } from './bootstrap';

export function useModels() {
  const [availableModels, setAvailableModels] = useState<any[]>([]);

  const reloadModels = useCallback(async () => {
    try {
      const data = await listModelsWithTimeout(BOOTSTRAP_REQUEST_TIMEOUT_MS);
      if (data.success && Array.isArray(data.models)) setAvailableModels(data.models);
    } catch (err) {
      console.error('Failed to reload models:', err);
    }
  }, []);

  useEffect(() => {
    reloadModels();
    const modelTimer = setInterval(() => { if (isPageVisible()) void reloadModels(); }, MODELS_POLL_MS);
    return () => clearInterval(modelTimer);
  }, [reloadModels]);

  return { availableModels, reloadModels };
}
