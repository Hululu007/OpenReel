/**
 * 「届」的展示文案规则。
 *
 * 用户心智是「奖项 → 哪一年 → 名单」，所以：
 * - 有年份的届，标题只写「奖项 + 年份」，**不出现「第X届」**（届次数字门槛太高）；
 * - 历届合集没有年份，直接用它自己的标题，且不参与年份轴。
 */
import type { AwardEdition } from './types';

/** 一届的标题，如「豆瓣 2025 年度榜单」「金球奖 2025 获奖名单」「奥斯卡历届最佳影片」。 */
export function getEditionTitle(edition: AwardEdition): string {
  if (edition.year == null) return edition.primary.title;
  if (edition.award.kind === 'ANNUAL') return `豆瓣 ${edition.year} 年度榜单`;
  return `${edition.award.name} ${edition.year} 获奖名单`;
}

/**
 * 卡片里的短标题：卡片抬头已经写了奖项名，这里不再重复。
 * 如「2025 获奖名单」「2025 年度榜单」。
 */
export function getEditionShortTitle(edition: AwardEdition): string {
  if (edition.year == null) return edition.primary.title;
  if (edition.award.kind === 'ANNUAL') return `${edition.year} 年度榜单`;
  return `${edition.year} 获奖名单`;
}

/** 卡片主按钮文案。 */
export function getEditionActionLabel(edition: AwardEdition): string {
  if (edition.year == null) return '查看历届合集';
  if (edition.award.kind === 'ANNUAL') return `查看 ${edition.year} 年度榜单`;
  return `查看 ${edition.year} 名单`;
}

/** 主标题旁的年份文案；历届合集返回「历届」。 */
export function getEditionYearLabel(edition: AwardEdition): string {
  return edition.year == null ? '历届' : String(edition.year);
}
