import type { DB } from '../core/db';

export function helper(db?: DB): string {
  return String(db);
}
