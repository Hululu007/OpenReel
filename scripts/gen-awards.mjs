#!/usr/bin/env node
/**
 * 生成年度榜单 / 颁奖礼数据包。
 *
 * 数据来源（只读、公开页面/接口）：
 * 1. 豆瓣年度榜单（2023 起新版）：https://movie.douban.com/j/neu/page/{pageId}/
 *    - 2023 = 22，2024 = 27，2025 = 33（每年新增一年时，在 ANNUAL_PAGES 里加一行）
 *    - 页面 JSON 的 widgets[].payload.source 指向当年各榜单的 subject_collection
 * 2. 豆瓣年度榜单（2017–2022 旧版）：
 *    - https://movie.douban.com/ithil_j/activity/movie_annual{year}?with_widgets=1
 *    - 2018 的 with_widgets 接口返回 500，改逐 widget 抓：
 *      /ithil_j/activity/movie_annual2018/widget/{idx}
 *    - 旧版 top10 widget 的 payload.subject_ids 是影片豆瓣 id，逐条补详情
 * 3. 豆瓣获奖名单片单：https://m.douban.com/rexxar/api/v2/subject_collection/{id}/items
 * 4. 豆瓣奖项页（颁奖礼逐届名单）：
 *    https://movie.douban.com/awards/{slug}/{edition}/nominees
 *    - 解析 .levl3 分组里带 .won 的条目；影片可能是 r_main 或 r_sub
 *
 * 用法：
 *   node scripts/gen-awards.mjs
 *   AWARDS_CACHE=/tmp/openreel-awards-cache node scripts/gen-awards.mjs
 *
 * 说明：
 * - 脚本带缓存 + 限速 + 403 退避；重复执行不会重复请求（缓存命中直接读本地）。
 * - 输出 packages/core/src/awards/awardCatalog.generated.ts（随包内置）
 *   与 packages/core/src/awards/award-catalog.json（远程热更新镜像）。
 * - 新增奖项：在 AWARD_COLLECTIONS / AWARD_EDITIONS 里加一条，重新执行即可，不改 App 代码。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = process.env.AWARDS_CACHE || path.join(os.tmpdir(), 'openreel-awards-cache');
const OUT_TS = path.join(ROOT, 'packages/core/src/awards/awardCatalog.generated.ts');
const OUT_JSON = path.join(ROOT, 'packages/core/src/awards/award-catalog.json');

const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';
const HEADERS = {
  'User-Agent': UA,
  Referer: 'https://m.douban.com/',
  Accept: 'application/json, text/plain, */*',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJSON(url, file, { tries = 5, delayMs = 4000 } = {}) {
  if (fs.existsSync(file) && fs.statSync(file).size > 200) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (res.status === 403 || res.status === 429) {
        const wait = 30000 * (attempt + 1);
        console.log(`[awards] ${res.status} 触发限流，等待 ${wait / 1000}s 后重试…`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) {
        const error = new Error(`HTTP ${res.status}`);
        // 4xx（除限流）多为条目不存在/已删除，重试没有意义。
        if (res.status >= 400 && res.status < 500) error.noRetry = true;
        throw error;
      }
      const data = await res.json();
      fs.writeFileSync(file, JSON.stringify(data));
      console.log(`[awards] 已抓取 ${path.basename(file)}`);
      await sleep(delayMs);
      return data;
    } catch (err) {
      if (err.noRetry) throw err;
      console.log(`[awards] 请求失败 ${url}：${err.message}`);
      await sleep(10000 * (attempt + 1));
    }
  }
  throw new Error(`抓取失败：${url}`);
}

/** 抓 HTML（带缓存 + 同样的 403/429 退避）。 */
async function fetchText(url, file, { tries = 5, delayMs = 1500 } = {}) {
  if (fs.existsSync(file) && fs.statSync(file).size > 200) {
    return fs.readFileSync(file, 'utf8');
  }
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { ...HEADERS, Accept: 'text/html,application/xhtml+xml' },
      });
      if (res.status === 403 || res.status === 429) {
        const wait = 30000 * (attempt + 1);
        console.log(`[awards] ${res.status} 触发限流，等待 ${wait / 1000}s 后重试…`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) {
        const error = new Error(`HTTP ${res.status}`);
        if (res.status >= 400 && res.status < 500) error.noRetry = true;
        throw error;
      }
      const text = await res.text();
      fs.writeFileSync(file, text);
      console.log(`[awards] 已抓取 ${path.basename(file)}`);
      await sleep(delayMs);
      return text;
    } catch (err) {
      if (err.noRetry) throw err;
      console.log(`[awards] 请求失败 ${url}：${err.message}`);
      await sleep(10000 * (attempt + 1));
    }
  }
  throw new Error(`抓取失败：${url}`);
}

function decodeHtml(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 补全一条豆瓣影视条目（年份/类型/评分）。
 * 旧版年度榜单与奖项页只给 subject id，没有这些字段。
 *
 * 用 movie.douban.com/j/subject_abstract 而不是 m.douban.com/rexxar/api/v2/movie：
 * 后者连续请求几十次就触发 IP 级限流（code 1309），前者限制宽松得多。
 * 该接口不返回封面，posterUrl 置空由 UI 占位。
 */
async function fetchSubjectItem(id, { delayMs = 400 } = {}) {
  if (!id) return null;
  const file = path.join(CACHE_DIR, `subject_abstract_${id}.json`);
  try {
    const data = await fetchJSON(
      `https://movie.douban.com/j/subject_abstract?subject_id=${id}`,
      file,
      { delayMs }
    );
    const subject = data?.subject;
    if (!subject?.title) return null;
    // 标题形如「一战再战 One Battle After Another‎ (2025)」。
    const rawTitle = String(subject.title)
      .replace(/[\u200e\u200f]/g, '')
      .replace(/\s*\(\d{4}\)\s*$/, '')
      .trim();
    const hasCJK = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(rawTitle);
    // 有中文时取第一段（中文名），否则保留完整外文名。
    const title = (hasCJK ? rawTitle.split(/\s+/)[0] : rawTitle).trim();
    const year =
      Number(subject.release_year) ||
      Number((String(subject.title).match(/\((\d{4})\)/) || [])[1]) ||
      0;
    return {
      title: title || rawTitle,
      originalTitle: null,
      year,
      type: subject.is_tv ? 'TV' : 'MOVIE',
      doubanId: String(id),
      posterUrl: null,
      rating: Number(subject.rate) || null,
    };
  } catch {
    return null;
  }
}

/** 豆瓣年度榜单页 id（新增年份时在此追加）。 */
const ANNUAL_PAGES = [
  { year: 2023, pageId: 22 },
  { year: 2024, pageId: 27 },
  { year: 2025, pageId: 33 },
];

/** 年度榜单页里需要收录的榜单标题关键词（排除「最值得期待」「热搜」等非看片榜单）。 */
const ANNUAL_KEEP = /评分最高|冷门佳片/;

/** 2017–2022 旧版年度榜单（新版 /j/neu/page/ 接口不覆盖这些年份）。 */
const OLD_ANNUAL_YEARS = [2017, 2018, 2019, 2020, 2021, 2022];

/**
 * 年度榜单统一收录的 6 个 section。
 * 旧版各年标题不一致（如「大陆电视剧集」「英美剧（非新剧）」），这里归一。
 */
const ANNUAL_SECTIONS = [
  { slug: 'chinese-movies', label: '华语电影', match: (t) => /华语电影/.test(t) },
  { slug: 'foreign-movies', label: '外语电影', match: (t) => /外语电影/.test(t) },
  { slug: 'hidden-gems', label: '冷门佳片', match: (t) => /冷门佳片/.test(t) },
  { slug: 'chinese-series', label: '华语剧集', match: (t) => /(华语剧集|大陆剧集|大陆电视剧集)/.test(t) },
  {
    slug: 'returning-english-series',
    label: '英美续订剧',
    match: (t) => /英美.*(非新剧|续订剧)/.test(t),
  },
  {
    slug: 'new-english-series',
    label: '英美新剧',
    match: (t) => /英美.*新剧/.test(t),
  },
];

const AWARDS = [
  {
    id: 'oscar',
    name: '奥斯卡金像奖',
    shortName: '奥斯卡',
    group: 'AWARDS',
    kind: 'MOVIE',
    region: '美国',
    sourceUrl: 'https://movie.douban.com/annual/2025/',
  },
  {
    id: 'golden-globe',
    name: '金球奖',
    shortName: '金球奖',
    group: 'AWARDS',
    kind: 'MOVIE',
    region: '美国',
    sourceUrl: 'https://m.douban.com/subject_collection/ECNA7QSZI',
  },
  {
    id: 'cannes',
    name: '戛纳电影节',
    shortName: '戛纳',
    group: 'AWARDS',
    kind: 'FESTIVAL',
    region: '法国',
    sourceUrl: 'https://m.douban.com/subject_collection/ECCU6GZUA',
  },
  {
    id: 'berlinale',
    name: '柏林电影节',
    shortName: '柏林',
    group: 'AWARDS',
    kind: 'FESTIVAL',
    region: '德国',
    sourceUrl: 'https://m.douban.com/subject_collection/ECZAHZJTI',
  },
  {
    id: 'venice',
    name: '威尼斯电影节',
    shortName: '威尼斯',
    group: 'AWARDS',
    kind: 'FESTIVAL',
    region: '意大利',
    sourceUrl: 'https://m.douban.com/subject_collection/ECQU75JDA',
  },
  {
    id: 'golden-horse',
    name: '金马奖',
    shortName: '金马',
    group: 'CHINESE',
    kind: 'MOVIE',
    region: '中国台湾',
    sourceUrl: 'https://m.douban.com/subject_collection/ECBQ6CECI',
  },
  {
    id: 'magnolia',
    name: '上海电视节白玉兰奖',
    shortName: '白玉兰',
    group: 'TV',
    kind: 'TV',
    region: '中国大陆',
    sourceUrl: 'https://m.douban.com/subject_collection/ECXI7Y6IQ',
  },
  {
    id: 'emmy',
    name: '黄金时段艾美奖',
    shortName: '艾美奖',
    group: 'TV',
    kind: 'TV',
    region: '美国',
    sourceUrl: 'https://m.douban.com/subject_collection/ECSA77HQY',
  },
  {
    id: 'douban-annual',
    name: '豆瓣年度榜单',
    shortName: '豆瓣年度',
    group: 'DOUBAN',
    kind: 'ANNUAL',
    region: '中国大陆',
    description: '豆瓣电影每年年底基于用户评分与标记数据发布的年度榜单。',
    sourceUrl: 'https://movie.douban.com/annual/2025/',
  },
];

/**
 * 历届合集片单（豆瓣 subject_collection）。
 * 单届获奖名单已改由 AWARD_EDITIONS 从豆瓣奖项页抓取，这里只保留跨年份的合集。
 */
const AWARD_COLLECTIONS = [
  {
    awardId: 'oscar',
    collectionId: 'ECMQHVGWI',
    slug: 'oscar-best-picture-alltime',
    title: '奥斯卡历届最佳影片',
    kind: 'ALL_TIME',
  },
  {
    awardId: 'cannes',
    collectionId: 'ECCU6GZUA',
    slug: 'cannes-palme-alltime',
    title: '戛纳历届金棕榈奖',
    kind: 'ALL_TIME',
  },
  {
    awardId: 'berlinale',
    collectionId: 'ECZAHZJTI',
    slug: 'berlinale-bear-alltime',
    title: '柏林历届金熊奖',
    kind: 'ALL_TIME',
  },
];

/**
 * 颁奖礼逐届获奖名单（豆瓣奖项页）。
 * slug 为 movie.douban.com/awards/{slug}/{edition}/nominees 的路径。
 * 只覆盖近 10 年（2016–2026），避免数据包无限膨胀。
 */
const AWARD_EDITIONS = [
  { awardId: 'oscar', slug: 'oscar', latestEdition: 98, earliestEdition: 88 },
  { awardId: 'golden-globe', slug: 'golden-globes', latestEdition: 83, earliestEdition: 73 },
  { awardId: 'cannes', slug: 'cannes', latestEdition: 79, earliestEdition: 69 },
  { awardId: 'berlinale', slug: 'berlinale', latestEdition: 76, earliestEdition: 66 },
  { awardId: 'venice', slug: 'venice', latestEdition: 83, earliestEdition: 73 },
  { awardId: 'golden-horse', slug: 'goldenhorse', latestEdition: 63, earliestEdition: 53 },
  { awardId: 'magnolia', slug: 'stvf', latestEdition: 31, earliestEdition: 22 },
  { awardId: 'emmy', slug: 'emmys', latestEdition: 78, earliestEdition: 68 },
];

const ANNUAL_SLUGS = {
  '评分最高华语电影': 'chinese-movies',
  '评分最高外语电影': 'foreign-movies',
  '冷门佳片': 'hidden-gems',
  '评分最高华语剧集': 'chinese-series',
  '评分最高英美新剧': 'new-english-series',
  '评分最高英美续订剧': 'returning-english-series',
};

/**
 * 豆瓣一年有 6 份片单，它们属于同一「届」，UI 里作为同一页的 section 展示，
 * 而不是 6 个并列年份入口。这里给每份片单一个人话名称。
 */
const ANNUAL_SECTION_LABELS = {
  '评分最高华语电影': '华语电影',
  '评分最高外语电影': '外语电影',
  '冷门佳片': '冷门佳片',
  '评分最高华语剧集': '华语剧集',
  '评分最高英美新剧': '英美新剧',
  '评分最高英美续订剧': '英美续订剧',
};

function parseYearFromCard(cardSubtitle) {
  const m = String(cardSubtitle || '').match(/^(\d{4})/);
  return m ? Number(m[1]) : null;
}

function extractItems(payload) {
  const items = payload?.subject_collection_items || [];
  const out = [];
  for (const raw of items) {
    const year = parseYearFromCard(raw.card_subtitle);
    if (!raw.title || !year) continue;
    const type = raw.type === 'tv' || raw.subtype === 'tv' ? 'TV' : 'MOVIE';
    out.push({
      rank: raw.rank ?? raw.rank_value ?? undefined,
      title: raw.title,
      originalTitle: null,
      year,
      type,
      winner: undefined,
      doubanId: raw.id ? String(raw.id) : undefined,
      posterUrl: raw.cover_url || raw.pic?.large || raw.pic?.normal || null,
      rating: raw.rating?.value ?? null,
      note: undefined,
    });
  }
  return out;
}

/** 去掉年份前缀/「年度」/括号差异，便于归类。 */
function normalizeOldAnnualTitle(rawTitle) {
  return String(rawTitle || '')
    .replace(/^\s*豆瓣\s*\d{4}\s*/, '')
    .replace(/^\s*\d{4}\s*/, '')
    .replace(/^年度/, '')
    .replace(/[（(]\s*新剧\s*[)）]/, '新剧')
    .replace(/[（(]\s*非新剧\s*[)）]/, '非新剧')
    .replace(/\s+/g, '');
}

function classifyAnnualSection(rawTitle) {
  const title = normalizeOldAnnualTitle(rawTitle);
  return ANNUAL_SECTIONS.find((s) => s.match(title)) || null;
}

/** 旧版年度榜单：2018 的 with_widgets 接口 500，改为逐 widget 抓。 */
async function loadOldAnnualWidgets(year) {
  if (year === 2018) {
    const act = await fetchJSON(
      'https://movie.douban.com/ithil_j/activity/movie_annual2018',
      path.join(CACHE_DIR, 'old_annual_2018_activity.json')
    );
    const infos = act?.res?.widget_infos || [];
    const widgets = [];
    for (let idx = 0; idx < infos.length; idx++) {
      try {
        const w = await fetchJSON(
          `https://movie.douban.com/ithil_j/activity/movie_annual2018/widget/${idx}`,
          path.join(CACHE_DIR, `old_annual_2018_widget_${idx}.json`),
          { delayMs: 1200, tries: 2 }
        );
        if (w?.res) widgets.push(w.res);
      } catch {
        // 个别 widget（如台词/图片组件）接口 500，跳过即可，不影响其它榜单。
        console.log(`[awards] 跳过 2018 widget ${idx}（接口不可用）`);
      }
    }
    return widgets;
  }
  const act = await fetchJSON(
    `https://movie.douban.com/ithil_j/activity/movie_annual${year}?with_widgets=1`,
    path.join(CACHE_DIR, `old_annual_${year}.json`)
  );
  return act?.res?.widgets || [];
}

/** 递归收集旧版年度榜单里的 top10（union_top 会嵌套子榜单）。 */
function collectOldAnnualTop10(widgets) {
  const out = [];
  const walk = (list) => {
    for (const widget of list || []) {
      const payload = widget.payload || {};
      if (
        widget.kind_str === 'top10' &&
        payload.title &&
        payload.subject_ids
      ) {
        const subjectIds = String(payload.subject_ids)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (subjectIds.length > 0) {
          out.push({ title: payload.title.trim(), subjectIds });
        }
      }
      if (Array.isArray(payload.widgets)) walk(payload.widgets);
    }
  };
  walk(widgets);
  return out;
}

/**
 * 旧版年度榜单（2017–2022）：每类榜单只有 subject_ids，逐条补详情。
 * 与 2023+ 一致，每年只收 6 个 section。
 */
async function buildOldAnnualLists() {
  const lists = [];
  for (const year of OLD_ANNUAL_YEARS) {
    const widgets = await loadOldAnnualWidgets(year);
    const top10s = collectOldAnnualTop10(widgets);
    const picked = new Map();
    for (const item of top10s) {
      const section = classifyAnnualSection(item.title);
      if (!section) continue;
      // 同一年同一 section 可能有重复 widget（旧版偶尔重复挂），保留第一个。
      if (!picked.has(section.slug)) picked.set(section.slug, { section, item });
    }
    for (const { section, item } of picked.values()) {
      const items = [];
      for (let i = 0; i < item.subjectIds.length; i++) {
        const subject = await fetchSubjectItem(item.subjectIds[i]);
        if (!subject || subject.year <= 0) continue;
        items.push({
          rank: i + 1,
          ...subject,
          winner: undefined,
          note: undefined,
        });
      }
      if (items.length === 0) continue;
      lists.push({
        id: `douban-annual-${year}-${section.slug}`,
        awardId: 'douban-annual',
        title: `豆瓣${year}${normalizeOldAnnualTitle(item.title)}`,
        year,
        kind: 'ANNUAL',
        sectionLabel: section.label,
        sourceUrl: `https://movie.douban.com/annual/${year}/`,
        items,
      });
    }
    console.log(`[awards] 旧版年度榜单 ${year}：${picked.size} 个 section`);
  }
  return lists;
}

async function buildAnnualLists() {
  const lists = [];
  for (const { year, pageId } of ANNUAL_PAGES) {
    const pageFile = path.join(CACHE_DIR, `page_${year}.json`);
    const page = await fetchJSON(
      `https://movie.douban.com/j/neu/page/${pageId}/`,
      pageFile
    );
    const widgets = Array.isArray(page.widgets) ? page.widgets : [];
    for (const widget of widgets) {
      const title = widget.title || '';
      const source = widget.payload?.source || '';
      if (!ANNUAL_KEEP.test(title) || !source) continue;
      const m = String(source).match(/subject_collection\/(\d+)/);
      if (!m) continue;
      const collectionId = m[1];
      const collFile = path.join(CACHE_DIR, `coll_${collectionId}.json`);
      const coll = await fetchJSON(
        `https://m.douban.com/rexxar/api/v2/subject_collection/${collectionId}/items?start=0&count=50`,
        collFile
      );
      const items = extractItems(coll).map((it) => ({ ...it, winner: undefined }));
      if (items.length === 0) continue;
      // 「评分最高华语电影」→ chinese-movies；「年度冷门佳片」→ hidden-gems
      const normalizedTitle = title.replace(/^年度/, '').replace(/^豆瓣\d{4}/, '');
      const slug =
        ANNUAL_SLUGS[title] ||
        ANNUAL_SLUGS[normalizedTitle] ||
        normalizedTitle.replace(/[^\u4e00-\u9fa5a-z0-9]+/gi, '-').toLowerCase();
      lists.push({
        id: `douban-annual-${year}-${slug}`,
        awardId: 'douban-annual',
        title: `豆瓣${year}${normalizedTitle}`,
        year,
        kind: 'ANNUAL',
        sectionLabel: ANNUAL_SECTION_LABELS[title] || ANNUAL_SECTION_LABELS[normalizedTitle] || undefined,
        sourceUrl: `https://movie.douban.com/annual/${year}/`,
        items,
      });
    }
  }
  return lists;
}

async function buildAwardLists() {
  const lists = [];
  for (const def of AWARD_COLLECTIONS) {
    const collFile = path.join(CACHE_DIR, `coll_${def.collectionId}.json`);
    const coll = await fetchJSON(
      `https://m.douban.com/rexxar/api/v2/subject_collection/${def.collectionId}/items?start=0&count=100`,
      collFile
    );
    const items = extractItems(coll).map((it) => ({
      ...it,
      winner: def.kind === 'WINNERS' || def.kind === 'ALL_TIME' ? true : undefined,
    }));
    if (items.length === 0) continue;
    // 历届合集不属于任何「一届」，不要再伪造一个抓取年（旧版曾因此让戛纳/柏林凭空多出年份）。
    const year =
      def.kind === 'ALL_TIME' ? undefined : def.year ?? items.reduce((max, it) => Math.max(max, it.year), 0) + 1;
    lists.push({
      id: def.slug,
      awardId: def.awardId,
      title: def.title,
      year: Number.isFinite(year) && year > 0 ? year : undefined,
      edition: def.edition,
      kind: def.kind,
      sourceUrl: `https://m.douban.com/subject_collection/${def.collectionId}`,
      items,
    });
  }
  return lists;
}

/** 颁奖礼逐届名单的年份窗口（与需求确认的「近 10 年」一致）。 */
const AWARD_YEAR_FROM = 2016;
const AWARD_YEAR_TO = 2026;

/**
 * 解析豆瓣奖项页 /awards/{slug}/{edition}/nominees。
 *
 * 页面结构：
 *   div.levl2.channels > h3            单元（如「主竞赛单元」）
 *     div.levl3 > h4                   奖项（如「金熊奖」）
 *       ul > li
 *         div.r_main > a               影片或影人
 *         div.r_sub  > a               另一半（影人 / 影片）
 *         div.won                      存在即获奖
 *
 * 返回该届所有获奖影片（按 subject id 去重，note 汇总获奖类别）。
 */
function parseAwardEdition(html) {
  const heading = decodeHtml((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || '');
  const year = Number((heading.match(/\((\d{4})\)/) || [])[1]) || null;
  const seen = new Map();

  // 每个单元一块，逐块解析，避免 levl3 串到别的单元。
  const chunks = html.split(/<div class="levl2 channels">/).slice(1);
  for (const chunk of chunks) {
    const awardBlocks = chunk.split(/<div class="levl3">/).slice(1);
    for (const block of awardBlocks) {
      const awardName = decodeHtml((block.match(/<h4[^>]*>([\s\S]*?)<\/h4>/) || [])[1] || '');
      if (!awardName) continue;
      // 「金熊奖 / Golden Berlin Bear」「最佳影片 Best Motion Picture」只留中文短名。
      const baseName = awardName.split('/')[0].trim() || awardName;
      const shortName = /[\u4e00-\u9fff]/.test(baseName)
        ? baseName.replace(/[A-Za-z][\s\S]*$/, '').trim() || baseName
        : baseName;
      const lis = block.split(/<li[^>]*>/).slice(1);
      for (const li of lis) {
        if (!/class="won"/.test(li)) continue;
        const main = li.match(/<div class="r_main">[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
        const sub = li.match(/<div class="r_sub">[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
        let subject = null;
        if (main && /\/subject\//.test(main[1])) {
          subject = { id: (main[1].match(/subject\/(\d+)/) || [])[1], title: decodeHtml(main[2]) };
        } else if (sub && /\/subject\//.test(sub[1])) {
          subject = { id: (sub[1].match(/subject\/(\d+)/) || [])[1], title: decodeHtml(sub[2]) };
        }
        if (!subject?.id || !subject.title) continue;
        const prev = seen.get(subject.id);
        if (prev) {
          if (!prev.notes.includes(shortName)) prev.notes.push(shortName);
        } else {
          seen.set(subject.id, { title: subject.title, notes: [shortName] });
        }
      }
    }
  }

  return {
    heading,
    year,
    entries: [...seen.entries()].map(([id, value], index) => ({
      id,
      rank: index + 1,
      note: value.notes.join(' / '),
    })),
  };
}

/** 从豆瓣奖项页抓 2016–2026 各届获奖名单（影片年份由 subject 详情补全）。 */
async function buildAwardEditionLists() {
  const lists = [];
  for (const def of AWARD_EDITIONS) {
    const award = AWARDS.find((a) => a.id === def.awardId);
    if (!award) continue;
    for (let edition = def.latestEdition; edition >= def.earliestEdition; edition--) {
      const file = path.join(CACHE_DIR, `award_${def.slug}_${edition}.html`);
      let html;
      try {
        html = await fetchText(
          `https://movie.douban.com/awards/${def.slug}/${edition}/nominees`,
          file
        );
      } catch {
        console.log(`[awards] 跳过 ${award.name} 第${edition}届（页面不可用）`);
        continue;
      }
      const parsed = parseAwardEdition(html);
      if (!parsed.year || parsed.year < AWARD_YEAR_FROM || parsed.year > AWARD_YEAR_TO) {
        continue;
      }
      if (parsed.entries.length === 0) continue;

      const items = [];
      for (const entry of parsed.entries) {
        const subject = await fetchSubjectItem(entry.id);
        // 年份缺失的条目无法与本地影片匹配（year=0 会被年份区间直接排除），不入包。
        if (!subject || subject.year <= 0) continue;
        items.push({
          rank: entry.rank,
          ...subject,
          winner: true,
          note: entry.note,
        });
      }
      if (items.length === 0) continue;

      lists.push({
        id: `${def.awardId}-${parsed.year}-winners`,
        awardId: def.awardId,
        title: `${award.name} ${parsed.year} 获奖名单`,
        year: parsed.year,
        edition: `第${edition}届`,
        kind: 'WINNERS',
        sourceUrl: `https://movie.douban.com/awards/${def.slug}/${edition}/nominees`,
        items,
      });
      console.log(`[awards] ${award.name} ${parsed.year}：${items.length} 条`);
    }
  }
  return lists;
}

function toTs(catalog) {
  return `/**
 * 本文件由 scripts/gen-awards.mjs 生成，请勿手改。
 * 数据来源：豆瓣年度榜单页 + 豆瓣获奖名单片单（详见脚本头注释）。
 */
import type { AwardCatalog } from './types';

export const AWARD_CATALOG: AwardCatalog = ${JSON.stringify(catalog, null, 2)};
`;
}

async function main() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  console.log(`[awards] 缓存目录：${CACHE_DIR}`);
  const annualLists = await buildAnnualLists();
  const oldAnnualLists = await buildOldAnnualLists();
  const awardLists = await buildAwardLists();
  const awardEditionLists = await buildAwardEditionLists();
  const catalog = {
    version: new Date().toISOString().slice(0, 10),
    updatedAt: new Date().toISOString(),
    awards: AWARDS,
    lists: [...awardLists, ...awardEditionLists, ...annualLists, ...oldAnnualLists],
  };
  fs.mkdirSync(path.dirname(OUT_TS), { recursive: true });
  fs.writeFileSync(OUT_TS, toTs(catalog));
  fs.writeFileSync(OUT_JSON, JSON.stringify(catalog, null, 2));
  const items = catalog.lists.reduce((n, l) => n + l.items.length, 0);
  console.log(
    `[awards] 生成完成：${catalog.awards.length} 个奖项、${catalog.lists.length} 个榜单、${items} 条条目`
  );
  console.log(`[awards] ${path.relative(ROOT, OUT_TS)}`);
  console.log(`[awards] ${path.relative(ROOT, OUT_JSON)}`);
}

export {
  parseAwardEdition,
  classifyAnnualSection,
  collectOldAnnualTop10,
  buildAwardEditionLists,
  buildOldAnnualLists,
};

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error('[awards] 生成失败：', err);
    process.exit(1);
  });
}
