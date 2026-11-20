import type { MediaType } from '../types';

const VARIETY_KEYWORDS = [
  '综艺', '脱口秀', '真人秀', '晚会', '访谈', '选秀', '竞技', '益智',
];

const ANIME_KEYWORDS = [
  '动漫', '动画', '番剧', 'anime', 'cartoon',
  '日漫', '国漫', '动画片',
];

const DOCUMENTARY_KEYWORDS = [
  '纪录片', '记录片', '纪录',
  'documentary', 'Documentary', 'DOCUMENTARY',
];

const TV_KEYWORDS = [
  '电视剧', '连续剧', '国产剧', '韩剧', '美剧', '日剧',
  '泰剧', '台剧', '港剧',
];

const MOVIE_KEYWORDS = ['电影', '正片', '蓝光', 'BD', 'HD高清', '超清'];

const AI_DRAMA_KEYWORDS = [
  'AI漫剧', 'ai漫剧', 'AI動漫', 'ai動漫',
  'AI短剧', 'ai短剧',
  '漫剧', '漫畫劇',
];

export function isAiDrama(...texts: string[]): boolean {
  const allText = texts.join(' ');
  return AI_DRAMA_KEYWORDS.some(kw => allText.includes(kw));
}

const VERSION_QUALITY_KEYWORDS = [
  'HD', 'TC', 'BD', '4K', '2K', '1080p', '720p', '2160p',
  '蓝光', '高清', '标清', '超清', 'SD',
  'hd', 'tc', 'bd', '4k', '2k', '1080P', '720P', '2160P',
];

const VERSION_LANGUAGE_KEYWORDS = [
  '中字', '国语', '粤语', '日语', '韩语', '英语', '台配', '双语',
  '繁中', '简中', '中文字幕', '国语配音',
];

const VERSION_TYPE_KEYWORDS = [
  '完整版', '精编版', '加长版', '导演剪辑版', '原版', '重制版',
  '修复版', '未删减版', '特别版', '纪念版', '终极版', '典藏版',
  '剧场版', '电影版',
];

const NON_DRAMA_SUFFIXES = ['剧情片', '剧场面', '剧本', '剧评', '剧照'];

/** 「XX剧」但实为整片/舞台演出的类目（音乐剧、舞台剧…），不是电视剧。 */
const MOVIE_LIKE_DRAMA_WORDS = ['音乐剧', '歌舞剧', '舞台剧', '歌剧', '话剧', '戏曲'];

export function mapType(
  typeName: string,
  remarks: string,
  playFrom?: string,
  genreArray?: string[],
  /** 播放地址里第一组可播放线路的实际集数（已解析）；用于纠正 remarks 写法不规范的 AI 漫剧/短剧 */
  episodeCount?: number
): MediaType {
  const t = (typeName || '').trim();
  const r = (remarks || '').trim();
  const pf = (playFrom || '').trim();

  if (isAiDrama(t, r, ...(genreArray || []))) {
    // AI 漫剧/短剧：多集按剧集处理，单集才是电影。
    // remarks 写法不统一（全80集 / 第46-47集 / 合集2 / 更新全集…），
    // 因此同时参考播放地址里解析出的实际集数，避免实际多集被误判成电影后与同剧其他季合并。
    const multiEpMatch =
      r.match(/全\s*(\d+)\s*集/) ||
      r.match(/共\s*(\d+)\s*集/) ||
      r.match(/更新至\s*(\d+)\s*集/) ||
      r.match(/第\s*(\d+)\s*集/);
    const rangeMatch = r.match(/第\s*\d+\s*[-~至]\s*(\d+)\s*集/);
    const packMatch = r.match(/合集\s*(\d+)/);
    const declared = Math.max(
      multiEpMatch ? parseInt(multiEpMatch[1], 10) : 0,
      rangeMatch ? parseInt(rangeMatch[1], 10) : 0,
      packMatch ? parseInt(packMatch[1], 10) : 0,
      episodeCount && episodeCount > 0 ? episodeCount : 0
    );
    if (declared <= 1) return 'MOVIE';
    return 'TV';
  }

  for (const kw of ANIME_KEYWORDS) {
    if (t.toLowerCase().includes(kw.toLowerCase())) return 'ANIME';
  }

  for (const kw of VARIETY_KEYWORDS) {
    if (t.includes(kw)) return 'VARIETY';
  }

  for (const kw of DOCUMENTARY_KEYWORDS) {
    if (t.toLowerCase().includes(kw.toLowerCase())) return 'DOCUMENTARY';
  }

  for (const kw of TV_KEYWORDS) {
    if (t === '电视剧' || t.includes(kw)) return 'TV';
  }

  const episodeMatch = r.match(/第\s*(\d+)\s*集/);
  const totalEpisodeMatch = r.match(/共\s*(\d+)\s*集/);
  const updatedMatch = r.match(/更新至\s*(\d+)\s*集/);
  const allMatch = r.match(/全\s*(\d+)\s*集/);

  if (episodeMatch || totalEpisodeMatch || updatedMatch || allMatch) {
    const epNum = parseInt(
      episodeMatch?.[1] || totalEpisodeMatch?.[1] || updatedMatch?.[1] || allMatch?.[1] || '0',
      10
    );
    if (epNum > 1) return 'TV';
  }

  if (pf && pf.includes('$') && r.includes('第') && r.includes('集')) {
    return 'TV';
  }

  for (const kw of MOVIE_KEYWORDS) {
    if (r.includes(kw)) return 'MOVIE';
  }

  // 「XX片」结尾（喜剧片/爱情片/恐怖片…）及舞台类剧种是电影类目固有命名，不是电视剧。
  // 动画片/纪录片已在前置分支返回，不会落到这里；此判定必须先于下方含「剧」兜底。
  if (/片$/.test(t) || MOVIE_LIKE_DRAMA_WORDS.some((w) => t.includes(w))) return 'MOVIE';

  const isDramaWord = t.includes('剧') && !NON_DRAMA_SUFFIXES.some(s => t.includes(s));
  if (isDramaWord) return 'TV';

  if (r.includes('集') && (r.includes('第') || r.includes('更新') || r.includes('连载'))) {
    return 'TV';
  }

  return 'MOVIE';
}

export function needsSeason(type: MediaType): boolean {
  return type === 'TV' || type === 'VARIETY' || type === 'ANIME' || type === 'DOCUMENTARY';
}

export function needsShortDramaCheck(type: MediaType): boolean {
  return type === 'TV';
}

export function isVersionTitle(title: string): boolean {
  if (!title) return false;
  const t = title.trim();

  if (/^\d+$/.test(t)) return false;

  if (/^第\d+集$/.test(t)) return false;
  if (/^\d+集$/.test(t)) return false;

  if (/\d+集/.test(t) && !/(版|字|语)$/.test(t)) return false;

  for (const kw of VERSION_QUALITY_KEYWORDS) {
    if (t.toUpperCase().includes(kw.toUpperCase())) return true;
  }

  for (const kw of VERSION_LANGUAGE_KEYWORDS) {
    if (t.includes(kw)) return true;
  }

  for (const kw of VERSION_TYPE_KEYWORDS) {
    if (t.includes(kw)) return true;
  }

  if (/^[A-Za-z0-9]+$/.test(t) && t.length <= 4 && !/集/.test(t)) return true;

  return false;
}

export function refineTypeByEpisodes(
  episodes: { title: string; number: number }[],
  currentType: MediaType,
  title?: string
): MediaType {
  if (currentType === 'MOVIE') return currentType;
  if (currentType === 'VARIETY' || currentType === 'DOCUMENTARY') return currentType;
  if (!episodes || episodes.length === 0) return currentType;

  if (episodes.length <= 10) {
    const allVersionTitles = episodes.every(ep => isVersionTitle(ep.title));
    if (allVersionTitles) {
      return 'MOVIE';
    }
  }

  if (title && episodes.length === 1 && isAiDrama(title)) {
    return 'MOVIE';
  }

  return currentType;
}
