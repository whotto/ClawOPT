// 违规 2：跨模块绕过 barrel
import type { DB } from '../core/db/db';

export function helper(db?: DB): string {
  return String(db);
}
