import { AwardService, LiveRankingService } from '@openreel/core';
import { getProvider } from '../useAppStore';

let service: AwardService | null = null;

/** TV 端榜单服务单例。 */
export function getAwardService(): AwardService {
  if (!service) service = new AwardService(getProvider());
  return service;
}

export const AWARD_STATUS_LABEL: Record<string, string> = {
  PLAYABLE: '可播放',
  LIBRARY_ONLY: '已入库',
  PENDING: '待确认',
  MISSING: '未收录',
};

export const TYPE_LABEL: Record<string, string> = {
  MOVIE: '电影',
  TV: '电视剧',
  VARIETY: '综艺',
  ANIME: '动漫',
  DOCUMENTARY: '纪录片',
};

const DOUBAN_IMAGE_HEADERS = {
  Referer: 'https://movie.douban.com/',
  'User-Agent':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
};

/** 豆瓣图床要求 Referer；其他图床返回 undefined。 */
export function awardPosterHeaders(uri?: string | null): Record<string, string> | undefined {
  return uri && /doubanio\.com|douban\.com/.test(uri) ? DOUBAN_IMAGE_HEADERS : undefined;
}

let liveService: LiveRankingService | null = null;

/** 红果实时榜服务单例：每次进页都重新读取，缓存只做兜底。 */
export function getLiveRankingService(): LiveRankingService {
  if (!liveService) liveService = new LiveRankingService(getProvider());
  return liveService;
}
