/**
 * 年度榜单 / 颁奖礼数据模型。
 *
 * 设计原则：
 * - 榜单包是**只读参考数据**，随 App 发布（也可远程热更新），不进 media 主库、不新增表。
 * - 一个「奖项」下挂多个「榜单」（如奥斯卡 → 历届最佳影片 / 第 98 届获奖名单），
 *   因为豆瓣可稳定获得的数据形态是「获奖名单 / 历届片单」，强行拆分类会引入猜测。
 * - 条目只存事实字段（片名、年份、获奖/提名、豆瓣 subject id、封面外链），
 *   不存豆瓣简介/影评长文。
 */

import type { CollectPreviewItem, MediaType } from '../types';

/** 奖项分组：决定榜单首页的分区顺序与文案。 */
export type AwardGroup = 'AWARDS' | 'CHINESE' | 'TV' | 'DOUBAN';

/** 奖项类型：电影奖 / 电视奖 / 电影节 / 豆瓣年度榜单。 */
export type AwardKind = 'MOVIE' | 'TV' | 'FESTIVAL' | 'ANNUAL';

/** 榜单类型：获奖名单 / 提名名单 / 历届片单 / 年度榜单。 */
export type AwardListKind = 'WINNERS' | 'NOMINEES' | 'ALL_TIME' | 'ANNUAL';

export interface AwardDef {
  id: string;
  name: string;
  shortName: string;
  group: AwardGroup;
  kind: AwardKind;
  region?: string;
  description?: string;
  sourceUrl?: string;
}

export interface AwardItem {
  /** 榜单内名次（从 1 开始）；历届片单按年份倒序。 */
  rank?: number;
  title: string;
  originalTitle?: string | null;
  /** 影片年份（不是颁奖年）。 */
  year: number;
  type: MediaType;
  /** true=获奖；false/缺省=提名或榜单入选。 */
  winner?: boolean;
  /** 豆瓣 subject id，用于补封面/评分/详情链接。 */
  doubanId?: string;
  /** 豆瓣海报外链（离线时不请求，失败由 UI 占位）。 */
  posterUrl?: string | null;
  /** 豆瓣评分（快照值，仅展示）。 */
  rating?: number | null;
  /** 备注，如「最佳影片」「评审团大奖」。 */
  note?: string;
}

export interface AwardList {
  id: string;
  awardId: string;
  title: string;
  /** 榜单年份（颁奖年/年度榜单年份），用于分组与排序；历届片单可缺省。 */
  year?: number;
  /** 届次文案，如「第 98 届」。 */
  edition?: string;
  kind: AwardListKind;
  sourceUrl?: string;
  items: AwardItem[];
}

export interface AwardCatalog {
  /** 数据版本，如 '2026.11.20'；远程热更新据此判断是否覆盖。 */
  version: string;
  updatedAt: string;
  awards: AwardDef[];
  lists: AwardList[];
}

/** 本地库中的候选影片（只取匹配需要的轻量字段）。 */
export interface AwardMediaCandidate {
  id: number;
  title: string;
  originalTitle: string | null;
  alias: string | null;
  year: number;
  type: MediaType;
  posterUrl: string | null;
  rating: number | null;
  ratingCount: number | null;
  area: string | null;
  /** 是否已在 media_source 登记（有源 → 可按需拉取播放地址）。 */
  hasSource: boolean;
}

export type AwardMatchStatus = 'PLAYABLE' | 'LIBRARY_ONLY' | 'PENDING' | 'MISSING';
export type AwardMatchConfidence = 'HIGH' | 'LOW' | 'NONE';

export interface AwardItemMatch {
  /** `${listId}:${itemIndex}`，UI 用它做 key，避免同名条目互相覆盖。 */
  itemKey: string;
  itemIndex: number;
  status: AwardMatchStatus;
  confidence: AwardMatchConfidence;
  media?: AwardMediaCandidate;
}

export interface AwardCollectPending {
  item: AwardItem;
  itemIndex: number;
  /** 低置信预览项，需要用户勾选后入库。 */
  previews: CollectPreviewItem[];
}

export interface AwardCollectProgress {
  /** searching=正在搜源；saving=正在入库；done=成功；skipped=已存在；failed=失败 */
  phase: 'searching' | 'saving' | 'done' | 'skipped' | 'failed';
  current: number;
  total: number;
  title: string;
  saved: number;
  pending: number;
  failed: number;
}

export interface AwardCollectResult {
  saved: number;
  pending: AwardCollectPending[];
  failed: Array<{ item: AwardItem; itemIndex: number; message: string }>;
  cancelled: boolean;
  /** 连续失败过多时提前停止的原因（UI 展示用）。 */
  stoppedReason?: string;
}
