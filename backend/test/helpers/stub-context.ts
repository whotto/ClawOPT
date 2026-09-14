/**
 * 测试用的组装上下文：直接复用 `bootstrap/route-inventory.ts` 的注册期替身，
 * 与 OpenAPI 生成走同一份实现，免得测试替身与生成器替身两边分家。
 */
export { createRegistrationContext as createStubContext } from '../../src/bootstrap/route-inventory';
