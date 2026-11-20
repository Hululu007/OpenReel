import { useEffect, useState } from 'react';

const DOUBAN_HOST = /doubanio\.com|douban\.com/;
const REFERER = 'https://movie.douban.com/';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const blobCache = new Map<string, string>();
const pendingCache = new Map<string, Promise<string | null>>();
const MAX_CACHE = 150;

/** 豆瓣图床要求 Referer，WebView 的 <img> 带不了自定义头，故用 Tauri HTTP 插件取回后转 blob URL。 */
async function loadDoubanImage(src: string): Promise<string | null> {
  const cached = blobCache.get(src);
  if (cached) return cached;
  const pending = pendingCache.get(src);
  if (pending) return pending;
  const task = (async () => {
    try {
      const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http');
      const res = await tauriFetch(src, {
        method: 'GET',
        headers: { Referer: REFERER, 'User-Agent': UA },
      });
      if (!res.ok) return null;
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
    } catch {
      return null;
    } finally {
      pendingCache.delete(src);
    }
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
