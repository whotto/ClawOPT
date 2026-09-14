/**
 * 生成 backend/openapi.json。
 *
 *   npm run openapi:generate          写文件
 *   npm run openapi:generate -- --check   只比对，过期则退出码 1
 *
 * 不启动服务、不碰数据库与 ~/.openclaw：只把应用组装一遍，读路由登记表。
 */
import fs from 'fs';
import path from 'path';
import { renderOpenApiJson } from '../src/bootstrap/openapi';

const target = path.resolve(__dirname, '..', 'openapi.json');
const rendered = renderOpenApiJson();

if (process.argv.includes('--check')) {
  const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf-8') : '';
  if (current !== rendered) {
    console.error('backend/openapi.json is out of date. Run: cd backend && npm run openapi:generate');
    process.exit(1);
  }
  console.log('backend/openapi.json is up to date.');
} else {
  fs.writeFileSync(target, rendered);
  console.log(`Wrote ${path.relative(process.cwd(), target)}`);
}
