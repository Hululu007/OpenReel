import { getHttpClient } from '../utils/httpClient';
import { normalizer } from '../utils/normalizer';
import type { DatabaseProvider } from '../db/provider';
import type { CollectPreviewItem, MediaType } from '../types';
import { CollectorService } from './collectorService';
import { AWARD_CATALOG } from '../awards/catalog';
import type {
  AwardCatalog,
  AwardListMatchOptions,
  AwardCollectPending,
  AwardCollectProgress,
  AwardCollectResult,
  AwardEdition,
  AwardGroup,
  AwardItem,
  AwardItemMatch,
  AwardList,
  AwardMatchConfidence,
  AwardMediaCandidate,
  AwardOverview,
} from '../awards/types';

const CACHE_KEY = 'awards.catalog.v1';
const REMOTE_URLS = [
  'https://cdn.jsdelivr.net/gh/roma007/openreel@master/packages/core/src/awards/award-catalog.json',
  'https://raw.githubusercontent.com/roma007/openreel/master/packages/core/src/awards/award-catalog.json',
];
/** 远程榜单包最短检查间隔：24h（避免每次进榜单页都打网络）。 */
const REMOTE_CHECK_INTERVAL_MS = 24 * 3600 * 1000;
/** 单条找片最多自动入库的预览项数量，防止一个片名把多个错误版本一起收进来。 */
const MAX_AUTO_SAVE_PER_ITEM = 4;

interface CachedCatalog {
  catalog: AwardCatalog;
  fetchedAt: number;
}

function isCatalog(value: unknown): value is AwardCatalog {
  if (!value || typeof value !== 'object') return false;
  const c = value as AwardCatalog;
  return typeof c.version === 'string' && Array.isArray(c.awards) && Array.isArray(c.lists);
}

/** 版本号比较：'2026.11.20' > '2026.10.01'。非数字段按字符串比较。 */
function compareVersion(a: string, b: string): number {
  const pa = a.split(/[.\-+]/);
  const pb = b.split(/[.\-+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '0';
    const y = pb[i] ?? '0';
    const nx = Number(x);
    const ny = Number(y);
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (nx !== ny) return nx > ny ? 1 : -1;
    } else if (x !== y) {
      return x > y ? 1 : -1;
    }
  }
  return 0;
}

/** 标题归一化：简繁、大小写、标点、空格、季号/版本后缀，用于「同名判定」。 */
async function normalizeAwardTitle(title: string): Promise<string> {
  if (!title) return '';
  const simplified = await normalizer.toSimplified(title);
  return simplified
    .toLowerCase()
    .replace(/《|》|〈|〉|【|】|\[|\]|（|）|\(|\)/g, '')
    .replace(/[：:·,，。.!！?？'"“”‘’、\-—_\s]/g, '')
    .replace(/(第[一二三四五六七八九十百千\d]+季|season\s*\d+|s\d+)$/g, '')
    .replace(/(剧场版|电影版|电视剧版|导演剪辑版|加长版)$/g, '')
    .trim();
}

function splitAliases(alias: string | null): string[] {
  if (!alias) return [];
  return alias
    .split(/[,，/|、;；]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

interface ScoredCandidate {
  candidate: AwardMediaCandidate;
  score: number;
  confidence: AwardMatchConfidence;
}

/**
 * 年度榜单 / 颁奖礼服务。
 *
 * 职责：
 * 1. 提供榜单包（内置 + 远程热更新缓存）；
 * 2. 把榜单条目匹配到本地库（类型 + 年份区间 + 标题归一化，低置信不自动命中）；
 * 3. 复用现有 CollectorService 做单条找片 / 整榜补齐（必须 unlimitedYear，避免老片被采集配置过滤）。
 */
export class AwardService {
  private catalog: AwardCatalog | null = null;
  private matchCache = new Map<string, { at: number; matches: AwardItemMatch[] }>();
  private readonly collector: CollectorService;

  constructor(private db: DatabaseProvider, collector?: CollectorService) {
    this.collector = collector ?? new CollectorService(db);
  }

  getBundledCatalog(): AwardCatalog {
    return AWARD_CATALOG;
  }

  /** 读取可用榜单包：优先使用远程缓存（版本更高时），否则内置。 */
  async loadCatalog(): Promise<AwardCatalog> {
    if (this.catalog) return this.catalog;
    try {
      const row = await this.db.selectOne<{ value: string }>(
        'SELECT value FROM system_config WHERE key = ?',
        [CACHE_KEY]
      );
      if (row?.value) {
        const cached = JSON.parse(row.value) as CachedCatalog;
        if (isCatalog(cached?.catalog) && compareVersion(cached.catalog.version, AWARD_CATALOG.version) > 0) {
          this.catalog = cached.catalog;
          return this.catalog;
        }
      }
    } catch {
      // 缓存损坏不影响内置数据
    }
    this.catalog = AWARD_CATALOG;
    return this.catalog;
  }

  /**
   * 后台检查远程榜单包。失败静默；24h 内不重复请求（force=true 可跳过节流）。
   * 返回是否更新了本地榜单包。
   */
  async refreshRemoteCatalog(force = false): Promise<boolean> {
    const bundled = AWARD_CATALOG;
    try {
      const row = await this.db.selectOne<{ value: string }>(
        'SELECT value FROM system_config WHERE key = ?',
        [CACHE_KEY]
      );
      let cached: CachedCatalog | null = null;
      if (row?.value) {
        try {
          cached = JSON.parse(row.value) as CachedCatalog;
        } catch {
          cached = null;
        }
      }
      if (!force && cached && Date.now() - cached.fetchedAt < REMOTE_CHECK_INTERVAL_MS) {
        return false;
      }

      for (const url of REMOTE_URLS) {
        try {
          const res = await getHttpClient().get(url, { timeout: 8000, mode: 'cors' });
          const data = res.data;
          if (!isCatalog(data)) continue;
          const base = cached?.catalog?.version && compareVersion(cached.catalog.version, bundled.version) > 0
            ? cached.catalog
            : bundled;
          if (compareVersion(data.version, base.version) <= 0) {
            // 版本没变也要落一次 fetchedAt，避免每次进榜单页都重复请求
            await this.writeCache({
              catalog: cached && compareVersion(cached.catalog.version, bundled.version) > 0 ? cached.catalog : bundled,
              fetchedAt: Date.now(),
            });
            return false;
          }
          await this.writeCache({ catalog: data, fetchedAt: Date.now() });
          this.catalog = data;
          this.matchCache.clear();
          return true;
        } catch {
          // 换下一个镜像
        }
      }
    } catch {
      // 静默
    }
    return false;
  }

  private async writeCache(value: CachedCatalog): Promise<void> {
    const now = new Date().toISOString();
    await this.db.execute(
      `INSERT INTO system_config (key, value, value_type, created_at, updated_at)
       VALUES (?, ?, 'json', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [CACHE_KEY, JSON.stringify(value), now, now]
    );
  }

  getAward(awardId: string): AwardCatalog['awards'][number] | undefined {
    return (this.catalog ?? AWARD_CATALOG).awards.find((a) => a.id === awardId);
  }

  getList(listId: string): AwardList | undefined {
    return (this.catalog ?? AWARD_CATALOG).lists.find((l) => l.id === listId);
  }

  /** 一届的唯一键：awardId + 年份；历届合集用 all。 */
  getEditionKey(awardId: string, year?: number): string {
    return `${awardId}:${year ?? 'all'}`;
  }

  /**
   * 把一个奖项的榜单聚合成「届」。
   *
   * 用户心智只有「奖项 → 哪一年 → 名单」；豆瓣一年给 6 份片单（华语电影/外语电影/…），
   * 它们属于同一届，作为同一页的 section，不再并列成 6 个年份入口。
   * 历届合集没有年份，单独成一个 edition（year 缺省），不参与年份排序。
   */
  getAwardEditions(awardId: string): AwardEdition[] {
    const catalog = this.catalog ?? AWARD_CATALOG;
    const award = catalog.awards.find((a) => a.id === awardId);
    if (!award) return [];
    const byKey = new Map<string, AwardList[]>();
    for (const list of catalog.lists) {
      if (list.awardId !== awardId) continue;
      const key = this.getEditionKey(awardId, list.year);
      const bucket = byKey.get(key);
      if (bucket) bucket.push(list);
      else byKey.set(key, [list]);
    }
    const editions: AwardEdition[] = [...byKey.values()].map((lists) => ({
      id: this.getEditionKey(awardId, lists[0]?.year),
      award,
      year: lists[0]?.year,
      lists,
      primary: lists[0],
      totalItems: lists.reduce((n, l) => n + l.items.length, 0),
    }));
    return editions.sort((a, b) => (b.year ?? -1) - (a.year ?? -1));
  }

  /** 某条榜单所属的「届」（详情页据此拿 section 与年份切换）。 */
  getEditionOfList(listId: string): AwardEdition | undefined {
    const list = this.getList(listId);
    if (!list) return undefined;
    return this.getAwardEditions(list.awardId).find(
      (e) => this.getEditionKey(e.award.id, e.year) === this.getEditionKey(list.awardId, list.year)
    );
  }

  /**
   * 榜单首页数据：按分区 → 奖项 → 届 组织。
   * 每个奖项只返回一次，最新一届作为主入口，其余年份与历届合集作为次级入口。
   */
  getAwardOverviews(): Array<{
    group: string;
    groupKey: AwardGroup;
    awards: AwardOverview[];
  }> {
    const catalog = this.catalog ?? AWARD_CATALOG;
    const groupOrder: AwardGroup[] = ['AWARDS', 'CHINESE', 'TV', 'DOUBAN'];
    const groupLabel: Record<AwardGroup, string> = {
      AWARDS: '国际颁奖季',
      CHINESE: '华语奖项',
      TV: '剧集与电视',
      DOUBAN: '豆瓣年度榜单',
    };
    return groupOrder
      .map((groupKey) => {
        const awards = catalog.awards
          .filter((a) => a.group === groupKey)
          .map((award): AwardOverview => {
            const editions = this.getAwardEditions(award.id);
            const yearEditions = editions.filter((e) => e.year != null);
            const allTime = editions.filter((e) => e.year == null);
            // 没有年度名单的奖项（如只有「历届最佳影片」），把合集当作主入口，不再重复出现在次级入口。
            const allTimeIsPrimary = yearEditions.length === 0 && allTime.length > 0;
            return {
              award,
              latest: yearEditions[0] ?? allTime[0],
              otherEditions: yearEditions.slice(1),
              allTime: allTimeIsPrimary ? allTime.slice(1) : allTime,
            };
          })
          .filter((x) => x.latest);
        return { group: groupLabel[groupKey], groupKey, awards };
      })
      .filter((g) => g.awards.length > 0);
  }

  /** 首页/搜索联动：按奖项名或榜单名找相关榜单。 */
  findListsByKeyword(keyword: string, limit = 6): AwardList[] {
    const raw = keyword.trim().toLowerCase();
    if (!raw) return [];
    const catalog = this.catalog ?? AWARD_CATALOG;
    const hitAwards = new Set(
      catalog.awards
        .filter((a) => a.name.toLowerCase().includes(raw) || a.shortName.toLowerCase().includes(raw))
        .map((a) => a.id)
    );
    return catalog.lists
      .filter((l) => hitAwards.has(l.awardId) || l.title.toLowerCase().includes(raw))
      .sort((a, b) => (b.year ?? 0) - (a.year ?? 0))
      .slice(0, limit);
  }

  /** 清空匹配缓存（找片入库后调用）。 */
  invalidateMatches(): void {
    this.matchCache.clear();
  }

  /**
   * 匹配整个榜单。先渲染条目，再回填状态；结果按列表缓存 60s。
   *
   * 性能策略：
   * 1. 先用「类型 + 年份区间 + 标题 IN」一次性批量取精确匹配（年度榜单通常 0.05~0.6s）；
   * 2. 未命中的条目再做 LIKE 兜底（覆盖「繁花 沪语版」这类带后缀的源站标题）；
   * 3. 首页进度条只做第 1 步（refineMissing=false），详情页做全量。
   */
  async matchList(list: AwardList, opts?: { refineMissing?: boolean }): Promise<AwardItemMatch[]> {
    const refineMissing = opts?.refineMissing !== false;
    const cacheKey = `${list.id}:${(this.catalog ?? AWARD_CATALOG).version}:${refineMissing ? 'full' : 'fast'}`;
    const cached = this.matchCache.get(cacheKey);
    if (cached && Date.now() - cached.at < 60_000) return cached.matches;

    const matchOptions = list.matchOptions;
    const batch = await this.queryCandidatesBatch(list.items, matchOptions);
    const matches: AwardItemMatch[] = [];
    for (let i = 0; i < list.items.length; i++) {
      const item = list.items[i];
      const itemKey = `${list.id}:${i}`;
      try {
        let scored = await this.findBestCandidateFrom(batch, item, matchOptions);
        if (!scored && refineMissing) {
          const rows = await this.queryCandidates(item, matchOptions);
          scored = await this.findBestCandidateFrom(rows, item, matchOptions);
        }
        if (!scored) {
          matches.push({ itemKey, itemIndex: i, status: 'MISSING', confidence: 'NONE' });
        } else if (scored.confidence === 'HIGH') {
          matches.push({
            itemKey,
            itemIndex: i,
            status: scored.candidate.hasSource ? 'PLAYABLE' : 'LIBRARY_ONLY',
            confidence: 'HIGH',
            media: scored.candidate,
          });
        } else {
          matches.push({
            itemKey,
            itemIndex: i,
            status: 'PENDING',
            confidence: 'LOW',
            media: scored.candidate,
          });
        }
      } catch {
        matches.push({ itemKey, itemIndex: i, status: 'MISSING', confidence: 'NONE' });
      }
    }
    this.matchCache.set(cacheKey, { at: Date.now(), matches });
    return matches;
  }

  /** 标题/年份打分（批量候选与单条候选共用）。 */
  private async findBestCandidateFrom(
    rows: AwardMediaCandidate[],
    item: AwardItem,
    options?: AwardListMatchOptions
  ): Promise<ScoredCandidate | null> {
    if (rows.length === 0) return null;

    const itemNorms = new Set<string>();
    for (const t of [item.title, item.originalTitle]) {
      if (t) itemNorms.add(await normalizeAwardTitle(t));
    }
    itemNorms.delete('');

    const scored: ScoredCandidate[] = [];
    for (const row of rows) {
      const candNorms = new Set<string>();
      for (const t of [row.title, row.originalTitle, ...splitAliases(row.alias)]) {
        if (t) candNorms.add(await normalizeAwardTitle(t));
      }
      candNorms.delete('');
      if (candNorms.size === 0) continue;

      let titleScore = 0;
      for (const a of itemNorms) {
        for (const b of candNorms) {
          if (a === b) titleScore = Math.max(titleScore, 100);
          else {
            const longer = a.length >= b.length ? a : b;
            const shorter = a.length >= b.length ? b : a;
            if (shorter.length >= 2 && longer.includes(shorter)) {
              titleScore = Math.max(titleScore, 70);
            }
          }
        }
      }
      if (titleScore === 0) continue;

      // 实时榜（短剧）没有上映年：不按年份排除，只靠标题精确度判置信度。
      const yearDiff = options?.ignoreYear ? 0 : Math.abs(row.year - item.year);
      if (yearDiff >= 2) continue;
      const confidence: AwardMatchConfidence = titleScore >= 100 && yearDiff === 0 ? 'HIGH' : 'LOW';
      const score = titleScore + (yearDiff === 0 ? 20 : 8) + (row.hasSource ? 2 : 0);
      scored.push({ candidate: row, score, confidence });
    }

    if (scored.length === 0) return null;
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.candidate.hasSource !== b.candidate.hasSource) return a.candidate.hasSource ? -1 : 1;
      return 0;
    });
    return scored[0];
  }

  /**
   * 批量精确匹配：一次查询取回整页榜单里「标题/原名/别名完全相等」的本地候选。
   * 只用等值比较（不用 LIKE），避免 30 条标题 × 大年份跨度把大表扫穿。
   */
  private async queryCandidatesBatch(
    items: AwardItem[],
    options?: AwardListMatchOptions
  ): Promise<AwardMediaCandidate[]> {
    if (items.length === 0) return [];
    const types = options?.types ?? [...new Set(items.map((i) => i.type))];
    const years = items.map((i) => i.year);
    // 短剧没有上映年，用固定窗口限制扫描范围，避免全表扫（实测跨全表 15s，2024-2026 窗口 155ms）。
    const [minYear, maxYear] = options?.ignoreYear
      ? options.yearWindow ?? [new Date().getFullYear() - 3, new Date().getFullYear() + 1]
      : [Math.max(0, Math.min(...years) - 1), Math.max(...years) + 1];
    const titles = [
      ...new Set(
        items
          .flatMap((i) => [i.title, i.originalTitle])
          .filter((t): t is string => !!t && t.trim().length > 0)
          .map((t) => t.trim())
      ),
    ];
    if (titles.length === 0) return [];

    const values = titles.map(() => '(?)').join(', ');
    const typePlaceholders = types.map(() => '?').join(', ');
    const rows = await this.db.select<any>(
      `WITH wanted(title) AS (VALUES ${values})
       SELECT m.id, m.title, m.original_title, m.alias, m.year, m.type, m.poster_url,
              m.rating, m.rating_count, m.area,
              EXISTS(SELECT 1 FROM media_source ms WHERE ms.media_id = m.id) AS has_source
       FROM media m
       JOIN wanted w ON (m.title = w.title OR m.original_title = w.title OR m.alias = w.title)
       WHERE (m.hidden IS NULL OR m.hidden = 0)
         AND m.type IN (${typePlaceholders})
         AND m.year BETWEEN ? AND ?
       LIMIT 600`,
      [...titles, ...types, minYear, maxYear]
    );
    return this.mapCandidates(rows);
  }

  private mapCandidates(rows: any[]): AwardMediaCandidate[] {
    const seen = new Set<number>();
    const out: AwardMediaCandidate[] = [];
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push({
        id: r.id,
        title: r.title,
        originalTitle: r.original_title ?? null,
        alias: r.alias ?? null,
        year: r.year,
        type: r.type as MediaType,
        posterUrl: r.poster_url ?? null,
        rating: r.rating ?? null,
        ratingCount: r.rating_count ?? null,
        area: r.area ?? null,
        hasSource: !!r.has_source,
      });
    }
    return out;
  }

  private async queryCandidates(
    item: AwardItem,
    options?: AwardListMatchOptions
  ): Promise<AwardMediaCandidate[]> {
    const [yearFrom, yearTo] = options?.ignoreYear
      ? options.yearWindow ?? [new Date().getFullYear() - 3, new Date().getFullYear() + 1]
      : [Math.max(0, item.year - 1), item.year + 1];
    const types = options?.types ?? [item.type];
    const typePlaceholders = types.map(() => '?').join(', ');
    const titles = [item.title, item.originalTitle].filter((t): t is string => !!t && t.trim().length > 0);
    if (titles.length === 0) return [];

    // 源站标题常带「第二季 / Season 2」等后缀，或反过来榜单带、源站不带。
    // 精确/整串 LIKE 都命中不了时，用去掉季号的基名再兜一次，交给打分逻辑判 LOW/HIGH。
    const variants = new Set<string>();
    for (const t of titles) {
      const trimmed = t.trim();
      variants.add(trimmed);
      const base = trimmed
        .replace(/\s*(第[一二三四五六七八九十百千\d]+季|season\s*\d+|s\d+)\s*$/i, '')
        .trim();
      if (base && base !== trimmed) variants.add(base);
    }

    const rows: any[] = [];
    for (const title of [...variants].slice(0, 3)) {
      const like = `%${title}%`;
      const part = await this.db.select<any>(
        `SELECT m.id, m.title, m.original_title, m.alias, m.year, m.type, m.poster_url,
                m.rating, m.rating_count, m.area,
                EXISTS(SELECT 1 FROM media_source ms WHERE ms.media_id = m.id) AS has_source
         FROM media m
         WHERE (m.hidden IS NULL OR m.hidden = 0)
           AND m.type IN (${typePlaceholders})
           AND m.year BETWEEN ? AND ?
           AND (m.title LIKE ? OR m.alias LIKE ? OR m.original_title LIKE ?)
         ORDER BY CASE WHEN m.year = ? THEN 0 ELSE 1 END, m.view_count DESC
         LIMIT 40`,
        [...types, yearFrom, yearTo, like, like, like, item.year]
      );
      rows.push(...part);
      if (rows.length >= 40) break;
    }

    return this.mapCandidates(rows);
  }

  /**
   * 单条找片：调现有采集预览链路，高置信自动入库，低置信返回给用户确认。
   *
   * 源站慢/不可达时 searchKeywordPreview 可能拖到几分钟，故这里加整体超时（60s），
   * 超时后返回已拿到的部分结果，避免「点了没反应」。
   */
  async collectItem(
    item: AwardItem,
    itemIndex = 0,
    signal?: AbortSignal
  ): Promise<{ saved: number; pending: AwardCollectPending[] }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    const itemNorms = new Set<string>();
    for (const t of [item.title, item.originalTitle]) {
      if (t) itemNorms.add(await normalizeAwardTitle(t));
    }
    itemNorms.delete('');

    const searchOptions = {
      unlimitedYear: true,
      searchTimeoutMs: 8000,
      searchMaxRetries: 1,
      maxItemsPerSource: 8,
    };

    // 找到高置信结果就提前停止搜索后面的源：点一次找片不必等全部 6 个源跑完。
    const onBatch = (batch: CollectPreviewItem[]) => {
      if (batch.length === 0 || controller.signal.aborted) return;
      void this.batchHasHighConfidence(batch, itemNorms, item).then((has) => {
        if (has && !controller.signal.aborted) controller.abort();
      });
    };

    let previews: CollectPreviewItem[] = [];
    try {
      previews = await this.collector.searchKeywordPreview(
        item.title,
        searchOptions,
        onBatch,
        controller.signal
      );
      if (previews.length === 0 && item.originalTitle && !controller.signal.aborted) {
        previews = await this.collector.searchKeywordPreview(
          item.originalTitle,
          searchOptions,
          onBatch,
          controller.signal
        );
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    if (previews.length === 0) return { saved: 0, pending: [] };

    const high: CollectPreviewItem[] = [];
    const low: CollectPreviewItem[] = [];
    for (const p of previews) {
      const confidence = await this.previewConfidence(p, itemNorms, item);
      if (confidence === 'HIGH') high.push(p);
      else if (confidence === 'LOW') low.push(p);
    }

    if (high.length > 0) {
      const picked = high.slice(0, MAX_AUTO_SAVE_PER_ITEM);
      const result = await this.collector.savePreviewItems(picked, { unlimitedYear: true });
      this.matchCache.clear();
      return { saved: result.saved, pending: [] };
    }

    if (low.length > 0) {
      return {
        saved: 0,
        pending: [{ item, itemIndex, previews: low.slice(0, 20) }],
      };
    }
    return { saved: 0, pending: [] };
  }

  /** 预览项与榜单条目的置信度（与本地匹配同一套标题/年份规则）。 */
  private async previewConfidence(
    p: CollectPreviewItem,
    itemNorms: Set<string>,
    item: AwardItem
  ): Promise<AwardMatchConfidence> {
    const pNorms = new Set<string>();
    pNorms.add(await normalizeAwardTitle(p.title));
    pNorms.delete('');
    if (pNorms.size === 0) return 'NONE';

    let titleScore = 0;
    for (const a of itemNorms) {
      for (const b of pNorms) {
        if (a === b) titleScore = Math.max(titleScore, 100);
        else {
          const longer = a.length >= b.length ? a : b;
          const shorter = a.length >= b.length ? b : a;
          if (shorter.length >= 2 && longer.includes(shorter)) {
            titleScore = Math.max(titleScore, 70);
          }
        }
      }
    }
    if (titleScore === 0) return 'NONE';
    const yearDiff = Math.abs(p.year - item.year);
    if (yearDiff >= 2) return 'NONE';
    return titleScore >= 100 && yearDiff === 0 ? 'HIGH' : 'LOW';
  }

  private async batchHasHighConfidence(
    batch: CollectPreviewItem[],
    itemNorms: Set<string>,
    item: AwardItem
  ): Promise<boolean> {
    for (const p of batch) {
      if ((await this.previewConfidence(p, itemNorms, item)) === 'HIGH') return true;
    }
    return false;
  }

  /**
   * 整榜补齐：逐条找片，支持进度回调与取消。
   * 注意：searchKeywordPreview 内部无 AbortSignal，取消会在当前条完成后生效。
   */
  async collectItems(
    entries: Array<{ item: AwardItem; itemIndex: number }>,
    onProgress?: (p: AwardCollectProgress) => void,
    signal?: AbortSignal
  ): Promise<AwardCollectResult> {
    const result: AwardCollectResult = { saved: 0, pending: [], failed: [], cancelled: false };
    let current = 0;
    let consecutiveFailed = 0;
    for (const { item, itemIndex } of entries) {
      if (signal?.aborted) {
        result.cancelled = true;
        break;
      }
      current += 1;
      onProgress?.({
        phase: 'searching',
        current,
        total: entries.length,
        title: item.title,
        saved: result.saved,
        pending: result.pending.length,
        failed: result.failed.length,
      });

      try {
        const outcome = await this.collectItem(item, itemIndex, signal);
        result.saved += outcome.saved;
        result.pending.push(...outcome.pending);
        if (outcome.saved > 0 || outcome.pending.length > 0) consecutiveFailed = 0;
        if (outcome.saved > 0) {
          onProgress?.({
            phase: 'done',
            current,
            total: entries.length,
            title: item.title,
            saved: result.saved,
            pending: result.pending.length,
            failed: result.failed.length,
          });
        } else if (outcome.pending.length > 0) {
          onProgress?.({
            phase: 'saving',
            current,
            total: entries.length,
            title: item.title,
            saved: result.saved,
            pending: result.pending.length,
            failed: result.failed.length,
          });
        } else {
          result.failed.push({ item, itemIndex, message: '未在已启用视频源中找到匹配' });
          consecutiveFailed += 1;
          onProgress?.({
            phase: 'failed',
            current,
            total: entries.length,
            title: item.title,
            saved: result.saved,
            pending: result.pending.length,
            failed: result.failed.length,
          });
          if (consecutiveFailed >= 5) {
            result.stoppedReason = '连续 5 部未找到匹配，已提前停止，避免长时间空跑';
            break;
          }
        }
      } catch (err: any) {
        result.failed.push({ item, itemIndex, message: err?.message ?? '搜索失败' });
        onProgress?.({
          phase: 'failed',
          current,
          total: entries.length,
          title: item.title,
          saved: result.saved,
          pending: result.pending.length,
          failed: result.failed.length,
        });
      }

      // 源站限流保护：每条之间留抖动，避免连续请求触发 429/403
      await abortableDelay(350 + Math.floor(Math.random() * 300), signal);
    }
    if (signal?.aborted) result.cancelled = true;
    this.matchCache.clear();
    return result;
  }

  /** 低置信预览项保存（用户在待确认列表勾选后调用）。 */
  async savePendingPreviews(previews: CollectPreviewItem[]): Promise<number> {
    if (previews.length === 0) return 0;
    const result = await this.collector.savePreviewItems(previews, { unlimitedYear: true });
    this.matchCache.clear();
    return result.saved;
  }
}
