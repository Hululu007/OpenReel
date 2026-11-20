#!/usr/bin/env node
/**
 * 生成年度榜单 / 颁奖礼数据包。
 *
 * 数据来源（只读、公开页面/接口）：
 * 1. 豆瓣年度榜单页：https://movie.douban.com/j/neu/page/{pageId}/
 *    - 2023 = 22，2024 = 27，2025 = 33（每年新增一年时，在 ANNUAL_PAGES 里加一行）
 *    - 页面 JSON 的 widgets[].payload.source 指向当年各榜单的 subject_collection
 * 2. 豆瓣获奖名单片单：https://m.douban.com/rexxar/api/v2/subject_collection/{id}/items
 *
 * 用法：
 *   node scripts/gen-awards.mjs
 *   AWARDS_CACHE=/tmp/openreel-awards-cache node scripts/gen-awards.mjs
 *
 * 说明：
 * - 脚本带缓存 + 限速 + 403 退避；重复执行不会重复请求（缓存命中直接读本地）。
 * - 输出 packages/core/src/awards/awardCatalog.generated.ts（随包内置）
 *   与 packages/core/src/awards/award-catalog.json（远程热更新镜像）。
 * - 新增奖项：在 AWARD_COLLECTIONS 里加一条，重新执行即可，不改 App 代码。
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
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      fs.writeFileSync(file, JSON.stringify(data));
      console.log(`[awards] 已抓取 ${path.basename(file)}`);
      await sleep(delayMs);
      return data;
    } catch (err) {
      console.log(`[awards] 请求失败 ${url}：${err.message}`);
      await sleep(10000 * (attempt + 1));
    }
  }
  throw new Error(`抓取失败：${url}`);
}

/** 豆瓣年度榜单页 id（新增年份时在此追加）。 */
const ANNUAL_PAGES = [
  { year: 2023, pageId: 22 },
  { year: 2024, pageId: 27 },
  { year: 2025, pageId: 33 },
];

/** 年度榜单页里需要收录的榜单标题关键词（排除「最值得期待」「热搜」等非看片榜单）。 */
const ANNUAL_KEEP = /评分最高|冷门佳片/;

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
 * 获奖名单片单（豆瓣 subject_collection）。
 * slug 用于生成稳定 list id；新增奖项/年份时在此追加。
 */
const AWARD_COLLECTIONS = [
  {
    awardId: 'oscar',
    collectionId: 'ECMQHVGWI',
    slug: 'oscar-best-picture-alltime',
    title: '历届奥斯卡金像奖最佳影片',
    kind: 'ALL_TIME',
  },
  {
    awardId: 'golden-globe',
    collectionId: 'ECNA7QSZI',
    slug: 'golden-globe-82-winners',
    title: '第82届金球奖获奖名单',
    year: 2025,
    edition: '第82届',
    kind: 'WINNERS',
  },
  {
    awardId: 'cannes',
    collectionId: 'ECMNABFUI',
    slug: 'cannes-79-winners',
    title: '第79届戛纳电影节获奖名单',
    year: 2026,
    edition: '第79届',
    kind: 'WINNERS',
  },
  {
    awardId: 'cannes',
    collectionId: 'ECCU6GZUA',
    slug: 'cannes-palme-alltime',
    title: '历届戛纳电影节金棕榈奖',
    year: 2023,
    kind: 'ALL_TIME',
  },
  {
    awardId: 'berlinale',
    collectionId: 'ECMU76GZQ',
    slug: 'berlinale-75-winners',
    title: '第75届柏林国际电影节获奖名单',
    year: 2025,
    edition: '第75届',
    kind: 'WINNERS',
  },
  {
    awardId: 'berlinale',
    collectionId: 'ECZAHZJTI',
    slug: 'berlinale-bear-alltime',
    title: '历届柏林电影节金熊奖获奖影片',
    year: 2020,
    kind: 'ALL_TIME',
  },
  {
    awardId: 'venice',
    collectionId: 'ECQU75JDA',
    slug: 'venice-82-winners',
    title: '第82届威尼斯电影节获奖名单',
    year: 2025,
    edition: '第82届',
    kind: 'WINNERS',
  },
  {
    awardId: 'golden-horse',
    collectionId: 'ECBQ6CECI',
    slug: 'golden-horse-60-winners',
    title: '第60届金马奖获奖名单',
    year: 2023,
    edition: '第60届',
    kind: 'WINNERS',
  },
  {
    awardId: 'magnolia',
    collectionId: 'ECXI7Y6IQ',
    slug: 'magnolia-30-winners',
    title: '第30届上海电视节白玉兰奖获奖名单',
    year: 2025,
    edition: '第30届',
    kind: 'WINNERS',
  },
  {
    awardId: 'emmy',
    collectionId: 'ECSA77HQY',
    slug: 'emmy-77-winners',
    title: '第77届黄金时段艾美奖获奖名单',
    year: 2025,
    edition: '第77届',
    kind: 'WINNERS',
  },
  {
    awardId: 'emmy',
    collectionId: 'ECDA7UYMA',
    slug: 'emmy-76-winners',
    title: '第76届黄金时段艾美奖获奖名单',
    year: 2024,
    edition: '第76届',
    kind: 'WINNERS',
  },
];

const ANNUAL_SLUGS = {
  '评分最高华语电影': 'chinese-movies',
  '评分最高外语电影': 'foreign-movies',
  '冷门佳片': 'hidden-gems',
  '评分最高华语剧集': 'chinese-series',
  '评分最高英美新剧': 'new-english-series',
  '评分最高英美续订剧': 'returning-english-series',
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
    const year = def.year ?? items.reduce((max, it) => Math.max(max, it.year), 0) + 1;
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
  const awardLists = await buildAwardLists();
  const catalog = {
    version: new Date().toISOString().slice(0, 10),
    updatedAt: new Date().toISOString(),
    awards: AWARDS,
    lists: [...awardLists, ...annualLists],
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

main().catch((err) => {
  console.error('[awards] 生成失败：', err);
  process.exit(1);
});
