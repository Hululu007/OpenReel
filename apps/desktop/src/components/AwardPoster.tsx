import { useEffect, useState } from 'react';

const DOUBAN_HOST = /doubanio\.com|douban\.com/;
const REFERER = 'https://movie.douban.com/';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const blobCache = new Map<string, string>();
const pendingCache = new Map<string, Promise<string | null>>();
const MAX_CACHE = 150;
/** 单张图 12s 超时 + 2 次尝试：图床偶发抖动时不至于永久留白。 */
const IMAGE_TIMEOUT_MS = 12000;
const MAX_ATTEMPTS = 2;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * 豆瓣图床要求 Referer，WebView 的 <img> 带不了自定义头，故用 Tauri HTTP 插件取回后转 blob URL。
 * 注意：生产环境会注入 tauri.conf.json 的 CSP，`img-src` 必须包含 `blob:`（v1.0.250 之前的包漏了，
 * 表现为榜单页海报全部空白、详情页因用本地源站 https 封面反而正常）。
 */
async function loadDoubanImage(src: string): Promise<string | null> {
  const cached = blobCache.get(src);
  if (cached) return cached;
  const pending = pendingCache.get(src);
  if (pending) return pending;
  const task = (async () => {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http');
        const res = await withTimeout(
          tauriFetch(src, {
            method: 'GET',
            headers: { Referer: REFERER, 'User-Agent': UA },
          }),
          IMAGE_TIMEOUT_MS
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        const blob = new Blob([buf], { type: res.headers.get('content-type') || 'image/jpeg' });
        const url = URL.createObjectURL(blob);
        if (blobCache.size >= MAX_CACHE) {
          const oldest = blobCache.keys().next().value;
          if (oldest) {
            const oldUrl = blobCache.get(oldest);
            if (oldUrl) URL.revokeObjectURL(oldUrl);
            blobCache.delete(oldest);
          }
        }
        blobCache.set(src, url);
        return url;
      } catch (err) {
        if (attempt === MAX_ATTEMPTS - 1) {
          console.warn('[AwardPoster] 海报加载失败', src, err instanceof Error ? err.message : err);
          return null;
        }
        await new Promise((r) => setTimeout(r, 800));
      }
    }
    return null;
  })();
  pendingCache.set(src, task);
  return task;
}

export function AwardPoster({
  src,
  alt = '',
  className = '',
}: {
  src?: string | null;
  alt?: string;
  className?: string;
}) {
  const isDouban = !!src && DOUBAN_HOST.test(src);
  const [resolved, setResolved] = useState<string | null>(() => {
    if (!src) return null;
    return isDouban ? blobCache.get(src) ?? null : src;
  });
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
    if (!src) {
      setResolved(null);
      return;
    }
    if (!DOUBAN_HOST.test(src)) {
      setResolved(src);
      return;
    }
    let alive = true;
    const cached = blobCache.get(src);
    if (cached) {
      setResolved(cached);
      return;
    }
    void loadDoubanImage(src).then((url) => {
      if (!alive) return;
      if (url) setResolved(url);
      else setFailed(true);
    });
    return () => {
      alive = false;
    };
  }, [src]);

  if (!src || failed || !resolved) {
    return (
      <div
        className={`flex items-center justify-center bg-[var(--color-secondary-alpha)] text-muted-foreground ${className}`}
      >
        <span className="text-lg font-semibold opacity-60">{alt.trim().slice(0, 1) || '影'}</span>
      </div>
    );
  }

  return <img src={resolved} alt={alt} className={className} loading="lazy" onError={() => setFailed(true)} />;
}

export default AwardPoster;
