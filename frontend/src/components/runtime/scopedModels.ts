// scoped 模式的模型下拉用的 ClawOPT 模型配置（GET /api/models），同一页面里只取一次。
// 群成员运行时、外部运行时单聊、工作流外部运行时节点共用。
import { listModels } from '../../api/models';

let modelsCache: Promise<Array<{ id: string; alias?: string }>> | null = null;

export function loadScopedModels(): Promise<Array<{ id: string; alias?: string }>> {
  if (!modelsCache) {
    modelsCache = listModels()
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        return Array.isArray(data.models) ? data.models : [];
      })
      .catch(() => {
        modelsCache = null;
        return [];
      });
  }
  return modelsCache;
}
