// 违规 1：core 依赖业务模块
import { helper } from '../../control';

export class DB {
  run() {
    return helper();
  }
}
