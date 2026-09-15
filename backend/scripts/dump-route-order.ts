/**
 * 重写 `test/fixtures/route-order.txt`：新增或挪动路由后运行，然后**逐行审阅 diff**——
 * 清单的意义在于顺序与公开性的变化被人看见，不是让测试自己变绿。
 *
 * 用法：cd backend && npx ts-node scripts/dump-route-order.ts
 */
import fs from 'fs';
import path from 'path';

import { collectRouteRecords } from '../src/bootstrap/route-inventory';

const target = path.join(__dirname, '..', 'test', 'fixtures', 'route-order.txt');
const lines = collectRouteRecords().map((record) => `${record.method.toUpperCase()} ${record.path}`);
fs.writeFileSync(target, `${lines.join('\n')}\n`);
console.log(`wrote ${lines.length} entries to ${path.relative(process.cwd(), target)}`);
