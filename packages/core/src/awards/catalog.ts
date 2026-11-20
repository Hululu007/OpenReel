/**
 * 榜单包入口。
 *
 * 实际数据由 scripts/gen-awards.mjs 生成到 awardCatalog.generated.ts；
 * 这里单独留一层 re-export，方便后续替换数据来源（远程包/多包合并）而不改调用方。
 */
export { AWARD_CATALOG } from './awardCatalog.generated';
export * from './types';
