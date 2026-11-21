import { AwardService, LiveRankingService } from '@openreel/core';
import { getProvider } from '../../init';

let service: AwardService | null = null;

/** 榜单服务单例：复用 CollectorService 与匹配缓存，避免每个页面各建一套。 */
export function getAwardService(): AwardService {
  if (!service) service = new AwardService(getProvider());
  return service;
}

export interface AwardStatusMeta {
  label: string;
  className: string;
}

export const AWARD_STATUS_META: Record<string, AwardStatusMeta> = {
  PLAYABLE: { label: '可播放', className: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/20' },
  LIBRARY_ONLY: { label: '已入库·暂无源', className: 'bg-sky-500/15 text-sky-400 border-sky-500/20' },
  PENDING: { label: '待确认', className: 'bg-amber-500/15 text-amber-400 border-amber-500/20' },
  MISSING: { label: '未收录', className: 'bg-white/5 text-muted-foreground border-white/10' },
};

let liveService: LiveRankingService | null = null;

/** 红果实时榜服务单例：每次进页都重新读取，缓存只做兜底。 */
export function getLiveRankingService(): LiveRankingService {
  if (!liveService) liveService = new LiveRankingService(getProvider());
  return liveService;
}
