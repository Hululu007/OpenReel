/**
 * 红果短剧「实时榜」抓取服务。
 *
 * 数据来源：https://hongguoduanju.com/rank/{board}
 * - 官方站是 Next.js 服务端渲染，HTML 里内嵌 `"rankList":[...]` 完整榜单 JSON；
 * - 每页 20 条，TOP100（page 1..5，page 6 返回 404）；
 * - 官方日更（页面自带 `updatedText`，如「11月21日已更新·…」）；
 * - 无需登录/cookie/签名，封面不带 Referer 也能取（2026-11-21 实测）。
 *
 * 设计原则：
 * - **每次进入页面都重新读取**（用户要求），缓存只作为「读失败时的兜底」与首屏占位；
 * - 只取公开排名与元数据，不抓播放地址；
 * - 结果转成现有 `AwardList`，直接复用 AwardService 的匹配 / 单条找源 / 一键补齐。
 */
import { getHttpClient } from '../utils/httpClient';
import type { DatabaseProvider } from '../db/provider';
import type { AwardItem, AwardList } from '../awards/types';

export type LiveRankingBoardKey =
  | 'hot'
  | 'new'
  | 'hot-search'
  | 'prestige'
  | 'must-watch'
  | 'followed'
  | 'subscribe';

export type LiveRankingTypeKey = 'all' | 'real' | 'comic' | 'ai';

export interface LiveRankingBoardDef {
  key: LiveRankingBoardKey;
  label: string;
  /** 榜单页路径（hot 的类型筛选会在此基础上改写）。 */
  path: string;
  /** 只有「热播榜」支持 真人剧/漫剧/AI剧 类型筛选（官网类型 tab 只链到 hot-* 页面）。 */
  supportsType: boolean;
}

export const LIVE_RANKING_BOARDS: LiveRankingBoardDef[] = [
  { key: 'hot', label: '热播榜', path: 'hot-drama', supportsType: true },
  { key: 'new', label: '新剧榜', path: 'new-drama', supportsType: false },
  { key: 'hot-search', label: '热搜榜', path: 'hot-search-drama', supportsType: false },
  { key: 'prestige', label: '臻果榜', path: 'prestige-drama', supportsType: false },
  { key: 'must-watch', label: '必看榜', path: 'must-watch-drama', supportsType: false },
  { key: 'followed', label: '收藏榜', path: 'followed-drama', supportsType: false },
  { key: 'subscribe', label: '预约榜', path: 'subscribe-drama', supportsType: false },
];

export const LIVE_RANKING_TYPES: Array<{ key: LiveRankingTypeKey; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'real', label: '真人剧' },
  { key: 'comic', label: '漫剧' },
  { key: 'ai', label: 'AI剧' },
];

const BASE_URL = 'https://hongguoduanju.com';
const MAX_PAGES = 5;
const PAGE_SIZE = 20;
const REQUEST_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml',
};
/** 兜底缓存的 system_config key 前缀（只用于读失败时展示上次数据）。 */
const CACHE_KEY_PREFIX = 'liveRanking.hongguo.v1';

export interface LiveRankingItem {
  rank: number;
  seriesId: string;
  title: string;
  cover?: string | null;
  /** 如「8751万热度」。 */
  heatText?: string;
  /** 如「8分」。 */
  scoreText?: string;
  favoriteText?: string;
  likeText?: string;
  tags: string[];
  episodeCount?: number;
  description?: string;
  sourceUrl?: string;
}

export interface LiveRankingSnapshot {
  board: LiveRankingBoardKey;
  type: LiveRankingTypeKey;
  items: LiveRankingItem[];
  updatedText: string;
  fetchedAt: number;
  /** true = 本次读取失败，返回的是上次缓存。 */
  fromCache: boolean;
}

export interface LiveRankingLoadOptions {
  signal?: AbortSignal;
  /** 读完一页回调（用于进度提示）。 */
  onProgress?: (info: { page: number; loaded: number }) => void;
}

/**
 * 从 HTML 里按 key 提取一个 JSON 数组。
 *
 * 不能用正则：数组内部存在 `"statusTags":[]`，非贪婪 `\[.*?\]` 会在第一个空数组处截断，
 * 只会解析出 1 条（实测踩过）。这里做括号配对，并跳过字符串内的括号与转义。
 */
export function extractJsonArrayAfterKey(source: string, key: string): string | null {
  const keyIndex = source.indexOf(`"${key}":`);
  if (keyIndex < 0) return null;
  const start = source.indexOf('[', keyIndex);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

/** 解析一页榜单 HTML。 */
export function parseLiveRankingPage(html: string): {
  items: LiveRankingItem[];
  updatedText: string;
} {
  const arrayText = extractJsonArrayAfterKey(html, 'rankList');
  if (!arrayText) return { items: [], updatedText: '' };
  let raw: any[] = [];
  try {
    raw = JSON.parse(arrayText);
  } catch {
    return { items: [], updatedText: '' };
  }
  const updatedMatch = html.match(/"updatedText":"([^"]*)"/);
  const updatedText = updatedMatch ? JSON.parse(`"${updatedMatch[1]}"`) : '';
  const items: LiveRankingItem[] = [];
  for (const r of raw) {
    const title = String(r?.title ?? '').trim();
    if (!title) continue;
    const tags: string[] = Array.isArray(r?.tags) ? r.tags.filter((t: unknown) => typeof t === 'string') : [];
    items.push({
      rank: Number(r?.rank) || items.length + 1,
      seriesId: String(r?.seriesId ?? r?.id ?? ''),
      title,
      cover: r?.cover ?? null,
      heatText: r?.heatText ?? r?.primaryMetricText ?? '',
      scoreText: r?.scoreText ?? '',
      favoriteText: r?.favoriteText ?? '',
      likeText: r?.likeText ?? '',
      tags,
      episodeCount: typeof r?.episodeCount === 'number' ? r.episodeCount : undefined,
      description: typeof r?.description === 'string' ? r.description : undefined,
      sourceUrl: r?.href ? `${BASE_URL}${r.href}` : undefined,
    });
  }
  return { items, updatedText };
}

/** 榜单 + 类型 → 官网路径。 */
export function resolveLiveRankingPath(
  board: LiveRankingBoardKey,
  type: LiveRankingTypeKey
): { path: string; type: LiveRankingTypeKey } {
  const def = LIVE_RANKING_BOARDS.find((b) => b.key === board) ?? LIVE_RANKING_BOARDS[0];
  if (!def.supportsType || type === 'all') return { path: def.path, type: 'all' };
  return { path: `hot-${type}-drama`, type };
}

/** 榜单列表项 → 稳定 list id（路由用）。 */
export function liveRankingListId(board: LiveRankingBoardKey, type: LiveRankingTypeKey): string {
  return `hongguo:${board}:${type}`;
}

export function parseLiveRankingListId(
  listId: string
): { board: LiveRankingBoardKey; type: LiveRankingTypeKey } | null {
  if (!listId.startsWith('hongguo:')) return null;
  const [, board, type] = listId.split(':');
  if (!LIVE_RANKING_BOARDS.some((b) => b.key === board)) return null;
  if (!LIVE_RANKING_TYPES.some((t) => t.key === type)) return null;
  return { board: board as LiveRankingBoardKey, type: type as LiveRankingTypeKey };
}

async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  const client = getHttpClient();
  if (typeof client.getText === 'function') {
    const res = await client.getText(url, { timeout: 20000, signal, headers: REQUEST_HEADERS });
    return res.data;
  }
  const res = await fetch(url, { headers: REQUEST_HEADERS, signal, mode: 'cors' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/**
 * 红果实时榜服务。
 *
 * 与 AwardService 的分工：
 * - 这里只负责「取数 + 转成 AwardList」；
 * - 匹配/找源/补齐仍由 AwardService 承担，接口保持一致。
 */
export class LiveRankingService {
  private lists = new Map<string, AwardList>();
  /** 本次会话的榜单快照（同一榜单在页面间切换时避免重复拉 5 页）。 */
  private snapshots = new Map<string, LiveRankingSnapshot>();

  constructor(private db: DatabaseProvider) {}

  getBoards(): LiveRankingBoardDef[] {
    return LIVE_RANKING_BOARDS;
  }

  /** 已加载的榜单（详情页首帧用）。 */
  peekList(listId: string): AwardList | undefined {
    return this.lists.get(listId);
  }

  /**
   * 读取榜单首页预览（1 页 20 条）。榜单页每次打开都调用。
   * 网络失败时回退到上次缓存，`fromCache=true`。
   */
  async loadPreview(
    board: LiveRankingBoardKey,
    type: LiveRankingTypeKey = 'all',
    opts?: LiveRankingLoadOptions
  ): Promise<LiveRankingSnapshot> {
    return this.load(board, type, 1, opts);
  }

  /**
   * 读取完整榜单（最多 5 页 / TOP100），并转成 AwardList 供匹配与找片。
   * 每次进入详情页都调用（用户要求「每次打开时去读取」）。
   */
  async loadList(
    listId: string,
    opts?: LiveRankingLoadOptions
  ): Promise<AwardList | null> {
    const parsed = parseLiveRankingListId(listId);
    if (!parsed) return null;
    const snapshot = await this.load(parsed.board, parsed.type, MAX_PAGES, opts);
    const list = this.toAwardList(snapshot);
    this.lists.set(list.id, list);
    return list;
  }

  private async load(
    board: LiveRankingBoardKey,
    type: LiveRankingTypeKey,
    maxPages: number,
    opts?: LiveRankingLoadOptions
  ): Promise<LiveRankingSnapshot> {
    const resolved = resolveLiveRankingPath(board, type);
    const items: LiveRankingItem[] = [];
    let updatedText = '';
    let failed = false;

    for (let page = 1; page <= maxPages; page++) {
      if (opts?.signal?.aborted) break;
      const url = `${BASE_URL}/rank/${resolved.path}${page > 1 ? `?page=${page}` : ''}`;
      try {
        const html = await fetchText(url, opts?.signal);
        const parsed = parseLiveRankingPage(html);
        if (!parsed.items.length) break;
        if (!updatedText) updatedText = parsed.updatedText;
        for (const item of parsed.items) {
          // 跨页去重（排名偶发挪动时同一部剧可能重复出现）
          if (items.some((x) => x.seriesId && x.seriesId === item.seriesId)) continue;
          items.push(item);
        }
        opts?.onProgress?.({ page, loaded: items.length });
        if (parsed.items.length < PAGE_SIZE) break;
      } catch {
        failed = true;
        break;
      }
    }

    if (items.length === 0) {
      const cached = await this.readCache(resolved.path);
      if (cached) return { ...cached, board, type: resolved.type, fromCache: true };
      throw new Error('红果实时榜读取失败，请稍后重试');
    }

    const snapshot: LiveRankingSnapshot = {
      board,
      type: resolved.type,
      items,
      updatedText,
      fetchedAt: Date.now(),
      fromCache: failed && items.length === 0,
    };
    this.snapshots.set(liveRankingListId(board, resolved.type), snapshot);
    void this.writeCache(resolved.path, snapshot);
    return snapshot;
  }

  /** 快照 → AwardList（复用现有匹配/找源链路）。 */
  toAwardList(snapshot: LiveRankingSnapshot): AwardList {
    const boardDef = LIVE_RANKING_BOARDS.find((b) => b.key === snapshot.board) ?? LIVE_RANKING_BOARDS[0];
    const typeLabel = LIVE_RANKING_TYPES.find((t) => t.key === snapshot.type)?.label;
    const title =
      snapshot.type !== 'all' && typeLabel ? `红果${boardDef.label} · ${typeLabel}` : `红果${boardDef.label}`;
    const currentYear = new Date().getFullYear();
    const items: AwardItem[] = snapshot.items.map((item) => ({
      rank: item.rank,
      title: item.title,
      // 短剧榜单不提供上映年；匹配时按 ignoreYear 处理，这里只填当前年占位（UI 不展示年份）。
      year: currentYear,
      type: 'TV',
      winner: undefined,
      posterUrl: item.cover ?? null,
      rating: item.scoreText ? Number.parseFloat(item.scoreText) || null : null,
      note: [item.heatText, item.episodeCount ? `${item.episodeCount}集` : ''].filter(Boolean).join(' · '),
    }));
    return {
      id: liveRankingListId(snapshot.board, snapshot.type),
      awardId: `hongguo-${snapshot.board}`,
      title,
      kind: 'LIVE',
      updatedText: snapshot.updatedText,
      matchOptions: { ignoreYear: true, types: ['MOVIE', 'TV'], yearWindow: [currentYear - 3, currentYear + 1] },
      sourceUrl: `${BASE_URL}/rank/${resolveLiveRankingPath(snapshot.board, snapshot.type).path}`,
      items,
    };
  }

  private cacheKey(path: string): string {
    return `${CACHE_KEY_PREFIX}.${path}`;
  }

  private async readCache(path: string): Promise<LiveRankingSnapshot | null> {
    try {
      const row = await this.db.selectOne<{ value: string }>(
        'SELECT value FROM system_config WHERE key = ?',
        [this.cacheKey(path)]
      );
      if (!row?.value) return null;
      const parsed = JSON.parse(row.value) as LiveRankingSnapshot;
      return Array.isArray(parsed?.items) && parsed.items.length > 0 ? parsed : null;
    } catch {
      return null;
    }
  }

  private async writeCache(path: string, snapshot: LiveRankingSnapshot): Promise<void> {
    try {
      const now = new Date().toISOString();
      await this.db.execute(
        `INSERT INTO system_config (key, value, value_type, created_at, updated_at)
         VALUES (?, ?, 'json', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [this.cacheKey(path), JSON.stringify(snapshot), now, now]
      );
    } catch {
      // 缓存失败不影响主流程
    }
  }
}
