import { useEffect, useState } from 'react';
import { Image, Text, View, type ImageStyle, type StyleProp } from 'react-native';
import { useThemeColors } from '@openreel/expo-ui';

/**
 * TV 榜单海报：豆瓣图床要求 Referer，RN Image 的自定义 header 在 Android 上仍会被判 418，
 * 故用 fetch 取回后转 data URI（与手机端 AwardPoster 同策略）。
 */
const DOUBAN_HOST = /doubanio\.com|douban\.com/;
const REFERER = 'https://movie.douban.com/';
const UA =
  'Mozilla/5.0 (Linux; Android 14; Android TV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const dataCache = new Map<string, string>();
const pendingCache = new Map<string, Promise<string | null>>();
const MAX_CACHE = 120;

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('read blob failed'));
    reader.readAsDataURL(blob);
  });
}

async function loadDoubanImage(src: string): Promise<string | null> {
  const cached = dataCache.get(src);
  if (cached) return cached;
  const pending = pendingCache.get(src);
  if (pending) return pending;
  const task = (async () => {
    try {
      const res = await fetch(src, { headers: { Referer: REFERER, 'User-Agent': UA } });
      if (!res.ok) return null;
      const dataUrl = await blobToDataUrl(await res.blob());
      if (!dataUrl) return null;
      if (dataCache.size >= MAX_CACHE) {
        const oldest = dataCache.keys().next().value;
        if (oldest) dataCache.delete(oldest);
      }
      dataCache.set(src, dataUrl);
      return dataUrl;
    } catch {
      return null;
    } finally {
      pendingCache.delete(src);
    }
  })();
  pendingCache.set(src, task);
  return task;
}

export default function AwardPoster({
  uri,
  style,
  placeholderText,
}: {
  uri?: string | null;
  style: StyleProp<ImageStyle>;
  placeholderText?: string;
}) {
  const colors = useThemeColors();
  const isDouban = !!uri && DOUBAN_HOST.test(uri);
  const [resolved, setResolved] = useState<string | null>(() => {
    if (!uri) return null;
    return isDouban ? dataCache.get(uri) ?? null : uri;
  });
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
    if (!uri) {
      setResolved(null);
      return;
    }
    if (!DOUBAN_HOST.test(uri)) {
      setResolved(uri);
      return;
    }
    let alive = true;
    const cached = dataCache.get(uri);
    if (cached) {
      setResolved(cached);
      return;
    }
    void loadDoubanImage(uri).then((dataUrl) => {
      if (!alive) return;
      if (dataUrl) setResolved(dataUrl);
      else setFailed(true);
    });
    return () => {
      alive = false;
    };
  }, [uri]);

  if (!uri || failed || !resolved) {
    return (
      <View style={[style as any, { alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface }]}>
        <Text style={{ fontSize: 20, fontWeight: '700', color: colors.mutedForeground, opacity: 0.7 }}>
          {(placeholderText || '影').slice(0, 1)}
        </Text>
      </View>
    );
  }

  return <Image source={{ uri: resolved }} style={style} onError={() => setFailed(true)} />;
}
