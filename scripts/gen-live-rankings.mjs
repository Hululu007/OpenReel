#!/usr/bin/env node
/**
 * 生成「红果短剧实时榜」镜像数据。
 *
 * 为什么需要镜像：
 * 官网（https://hongguoduanju.com/rank/{board}）是 Next.js SSR，Mac/服务器侧能拿到完整页面，
 * 但安卓端（RN/OkHttp）实测只收到被截断的 HTML（94,257 字符，结尾停在半个 <li>），
 * 拿不到数据。因此由 GitHub Actions 定时在服务端抓取，写成小 JSON 文件，
 * 客户端每次打开页面直接读取镜像（每榜约 12KB），官方口径本来就是日更。
 *
 * 用法：node scripts/gen-live-rankings.mjs
 * 输出：packages/core/src/awards/live/hongguo/{board}-{type}.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'packages/core/src/awards/live/hongguo');

const BASE_URL = 'https://hongguoduanju.com';
const MAX_PAGES = 5;
const PAGE_SIZE = 20;
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 与 packages/core/src/services/liveRankingService.ts 保持一致的榜单定义。 */
const BOARDS = [
  { key: 'hot', label: '热播榜', path: 'hot-drama', types: ['all', 'real', 'comic', 'ai'] },
  { key: 'new', label: '新剧榜', path: 'new-drama', types: ['all'] },
  { key: 'hot-search', label: '热搜榜', path: 'hot-search-drama', types: ['all'] },
  { key: 'prestige', label: '臻果榜', path: 'prestige-drama', types: ['all'] },
  { key: 'must-watch', label: '必看榜', path: 'must-watch-drama', types: ['all'] },
  { key: 'followed', label: '收藏榜', path: 'followed-drama', types: ['all'] },
  { key: 'subscribe', label: '预约榜', path: 'subscribe-drama', types: ['all'] },
];

const TYPE_LABEL = { all: '全部', real: '真人剧', comic: '漫剧', ai: 'AI剧' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resolvePath(board, type) {
  if (type === 'all') return board.path;
  return `hot-${type}-drama`;
}

/**
 * 括号配对提取 JSON 数组（不能正则：数组里有 `"statusTags":[]`，非贪婪会截断）。
 */
function extractJsonArrayAfterKey(source, key) {
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

function parsePage(html) {
  const arrayText = extractJsonArrayAfterKey(html, 'rankList');
  if (!arrayText) return { items: [], updatedText: '' };
  let raw = [];
  try {
    raw = JSON.parse(arrayText);
  } catch {
    return { items: [], updatedText: '' };
  }
  const updatedMatch = html.match(/"updatedText":"([^"]*)"/);
  const updatedText = updatedMatch ? JSON.parse(`"${updatedMatch[1]}"`) : '';
  const items = [];
  for (const r of raw) {
    const title = String(r?.title ?? '').trim();
    if (!title) continue;
    items.push({
      rank: Number(r?.rank) || items.length + 1,
      seriesId: String(r?.seriesId ?? r?.id ?? ''),
      title,
      cover: r?.cover ?? null,
      heatText: r?.heatText ?? r?.primaryMetricText ?? '',
      scoreText: r?.scoreText ?? '',
      favoriteText: r?.favoriteText ?? '',
      likeText: r?.likeText ?? '',
      tags: Array.isArray(r?.tags) ? r.tags.filter((t) => typeof t === 'string') : [],
      episodeCount: typeof r?.episodeCount === 'number' ? r.episodeCount : undefined,
    });
  }
  return { items, updatedText };
}

async function fetchHtml(url, attempt = 0) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Accept-Encoding': 'identity',
    },
  });
  if (!res.ok) {
    if (attempt < 2) {
      await sleep(3000);
      return fetchHtml(url, attempt + 1);
    }
    throw new Error(`HTTP ${res.status} ${url}`);
  }
  return res.text();
}

async function buildSnapshot(board, type) {
  const urlPath = resolvePath(board, type);
  const items = [];
  let updatedText = '';
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${BASE_URL}/rank/${urlPath}${page > 1 ? `?page=${page}` : ''}`;
    const html = await fetchHtml(url);
    const parsed = parsePage(html);
    if (!parsed.items.length) break;
    if (!updatedText) updatedText = parsed.updatedText;
    for (const item of parsed.items) {
      if (items.some((x) => x.seriesId && x.seriesId === item.seriesId)) continue;
      items.push(item);
    }
    if (parsed.items.length < PAGE_SIZE) break;
    await sleep(400);
  }
  return {
    board: board.key,
    type,
    label: type === 'all' ? `红果${board.label}` : `红果${board.label} · ${TYPE_LABEL[type]}`,
    updatedText,
    fetchedAt: new Date().toISOString(),
    source: `${BASE_URL}/rank/${urlPath}`,
    items,
  };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const index = [];
  let failed = 0;

  for (const board of BOARDS) {
    for (const type of board.types) {
      const file = `${board.key}-${type}.json`;
      try {
        const snapshot = await buildSnapshot(board, type);
        if (snapshot.items.length === 0) {
          console.log(`[live] ${file} 空数据，跳过写入`);
          failed += 1;
          continue;
        }
        fs.writeFileSync(path.join(OUT_DIR, file), JSON.stringify(snapshot));
        console.log(
          `[live] ${file}: ${snapshot.items.length} 条 · ${snapshot.updatedText || '无更新文案'}`
        );
        index.push({
          board: board.key,
          type,
          file,
          label: snapshot.label,
          updatedText: snapshot.updatedText,
          count: snapshot.items.length,
        });
      } catch (err) {
        failed += 1;
        console.log(`[live] ${file} 失败：${err.message}`);
      }
      await sleep(600);
    }
  }

  if (index.length === 0) {
    console.error('[live] 全部榜单抓取失败，保留原数据');
    process.exit(1);
  }

  fs.writeFileSync(
    path.join(OUT_DIR, 'index.json'),
    JSON.stringify(
      { version: new Date().toISOString().slice(0, 10), updatedAt: new Date().toISOString(), boards: index },
      null,
      2
    )
  );
  console.log(`[live] 完成：${index.length} 个榜单文件，失败 ${failed} 个`);
  console.log(`[live] 输出目录：${path.relative(ROOT, OUT_DIR)}`);
}

main().catch((err) => {
  console.error('[live] 生成失败：', err);
  process.exit(1);
});
