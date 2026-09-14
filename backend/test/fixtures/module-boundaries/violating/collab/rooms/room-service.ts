// 违规 3：服务经 barrel 取路由注册函数
import { registerThingRoutes } from '../../control';
// 违规 4：业务模块导入 bootstrap
import { start } from '../../bootstrap';
// 注释里的 import { helper } from '../../control/helper' 不算
/* import { DB } from '../../core/db/db' */
const text = "import { x } from '../../control/helper'";

export function roomService(): void {
  void text;
  registerThingRoutes();
  start();
}
