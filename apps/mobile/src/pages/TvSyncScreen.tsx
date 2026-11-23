import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { ArrowLeft, QrCode, RefreshCw, Upload, CheckCircle2, AlertTriangle } from 'lucide-react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as FileSystem from 'expo-file-system/legacy';
import * as Crypto from 'expo-crypto';

import { getProvider } from '../useAppStore';
import { useThemeColors } from '../themes/useThemeColors';
import { useThemeStore } from '../themes/store';
import { useScaledFontSize } from '../themes/useScaledFontSize';
import { hexToRgba } from '../themes/colorUtils';
import { Button } from '../components/ui/Button';
import BlurredBackground from '../components/BlurredBackground';
import { radius } from '../themes/radiusTokens';

interface Props {
  navigation: any;
}

interface SyncTarget {
  ip: string;
  port: number;
  token: string;
  schemaVersion: number;
}

interface Stats {
  schemaVersion: number;
  media: number;
  sources: number;
  favorites: number;
  history: number;
}

type Step = 'scan' | 'confirm' | 'uploading' | 'done' | 'error';

const CHUNK = 4 * 1024 * 1024;
const MARGIN_BYTES = 200 * 1024 * 1024;

function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function parsePayload(raw: string): SyncTarget | null {
  if (!raw.startsWith('openreel-sync://')) return null;
  const m = /[?&]ip=([^&]+)/.exec(raw);
  const p = /[?&]port=(\d+)/.exec(raw);
  const t = /[?&]t=([^&]+)/.exec(raw);
  const sv = /[?&]sv=(-?\d+)/.exec(raw);
  if (!m || !p || !t) return null;
  return {
    ip: decodeURIComponent(m[1]),
    port: Number(p[1]),
    token: decodeURIComponent(t[1]),
    schemaVersion: sv ? Number(sv[1]) : -1,
  };
}

/**
 * 手机 → 电视「整库替换」同步（手机端）。
 *
 * 流程：扫电视二维码 → 校验两端结构版本一致 → 生成数据库快照（VACUUM INTO）→
 * 分片上传 → 电视校验通过后由用户在电视上确认「应用并重启」。
 * 不备份：电视端只要有一步校验不过就不会替换旧库（见方案文档）。
 */
export default function TvSyncScreen({ navigation }: Props) {
  const colors = useThemeColors();
  const cardOpacity = useThemeStore((s) => s.cardOpacity);
  const s = useScaledFontSize();
  const cardBg = hexToRgba(colors.card, cardOpacity / 100);

  const [permission, requestPermission] = useCameraPermissions();
  const [step, setStep] = useState<Step>('scan');
  const [target, setTarget] = useState<SyncTarget | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [uploaded, setUploaded] = useState(0);
  const [total, setTotal] = useState(0);
  const [tvFree, setTvFree] = useState<number | null>(null);
  const scanningRef = useRef(false);
  const snapshotRef = useRef<string | null>(null);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: { flex: 1 },
        header: { paddingTop: 50, paddingHorizontal: 15, paddingBottom: 15 },
        headerRow: { flexDirection: 'row', alignItems: 'center' },
        title: { flex: 1, fontSize: s(18), fontWeight: 'bold', color: colors.text, textAlign: 'center' },
        placeholder: { width: 40 },
        content: { padding: 15, paddingBottom: 40 },
        card: { backgroundColor: cardBg, borderRadius: radius.lg, padding: 15, marginBottom: 16 },
        cardTitle: { fontSize: s(15), color: colors.text, fontWeight: '600', marginBottom: 8 },
        text: { fontSize: s(13), color: colors.mutedForeground, lineHeight: s(20) },
        warning: { fontSize: s(13), color: colors.error, lineHeight: s(20), fontWeight: '600' },
        cameraWrap: { height: 280, borderRadius: radius.lg, overflow: 'hidden', backgroundColor: '#000' },
        center: { alignItems: 'center', justifyContent: 'center', paddingVertical: 20 },
        progressTrack: { height: 8, borderRadius: 4, backgroundColor: hexToRgba(colors.mutedForeground, 0.25), overflow: 'hidden', marginTop: 10 },
        progressBar: { height: 8, borderRadius: 4, backgroundColor: colors.buttonPrimaryBg },
        row: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
        statLine: { fontSize: s(13), color: colors.text, lineHeight: s(21) },
        actions: { marginTop: 6, gap: 10 },
        iconCenter: { alignItems: 'center', marginBottom: 10 },
      }),
    [colors, cardBg, s],
  );

  const loadLocalStats = useCallback(async (): Promise<Stats> => {
    const provider = getProvider();
    const row = await provider.selectOne<any>(
      `SELECT
         IFNULL((SELECT MAX(version) FROM migrations), 0) AS schemaVersion,
         (SELECT COUNT(*) FROM media) AS media,
         (SELECT COUNT(*) FROM video_source) AS sources,
         (SELECT COUNT(*) FROM favorite) AS favorites,
         (SELECT COUNT(*) FROM watch_history) AS history`,
    );
    return {
      schemaVersion: Number(row?.schemaVersion ?? 0),
      media: Number(row?.media ?? 0),
      sources: Number(row?.sources ?? 0),
      favorites: Number(row?.favorites ?? 0),
      history: Number(row?.history ?? 0),
    };
  }, []);

  const onScanned = useCallback(
    async (data: string) => {
      if (scanningRef.current) return;
      const parsed = parsePayload(data);
      if (!parsed) return;
      scanningRef.current = true;
      setError('');
      setTarget(parsed);
      try {
        const local = await loadLocalStats();
        setStats(local);
        if (parsed.schemaVersion >= 0 && parsed.schemaVersion !== local.schemaVersion) {
          setError(
            `两端数据库结构版本不一致（手机 ${local.schemaVersion} / 电视 ${parsed.schemaVersion}）。请先把手机和电视升级到同一个版本再同步。`,
          );
          setStep('error');
          return;
        }
        try {
          const metaRes = await fetch(`http://${parsed.ip}:${parsed.port}/sync/meta?t=${parsed.token}`);
          const meta = await metaRes.json();
          if (meta && typeof meta.freeBytes === 'number') setTvFree(Number(meta.freeBytes));
        } catch {
          setTvFree(null);
        }
        setStep('confirm');
      } catch (e) {
        setError(`读取本机数据库信息失败：${e instanceof Error ? e.message : String(e)}`);
        setStep('error');
      }
    },
    [loadLocalStats],
  );

  const rescan = useCallback(() => {
    scanningRef.current = false;
    setTarget(null);
    setStats(null);
    setError('');
    setStatus('');
    setUploaded(0);
    setTotal(0);
    setStep('scan');
  }, []);

  const runSync = useCallback(async () => {
    if (!target || !stats) return;
    setStep('uploading');
    setError('');
    setStatus('正在准备数据库快照…');
    let snapshotPath: string | null = null;
    try {
      const provider = getProvider();

      // 1) 空间检查（手机端生成快照约需 2× 库大小）
      const pageInfo = await provider.selectOne<any>('PRAGMA page_count');
      const sizeInfo = await provider.selectOne<any>('PRAGMA page_size');
      const dbBytes = Number(pageInfo?.page_count ?? 0) * Number(sizeInfo?.page_size ?? 0);
      const free = Number((await FileSystem.getFreeDiskStorageAsync?.()) ?? 0);
      if (free > 0 && dbBytes > 0 && free < dbBytes * 2 + 100 * 1024 * 1024) {
        throw new Error(
          `手机存储空间不足（数据库约 ${formatBytes(dbBytes)}，剩余 ${formatBytes(free)}），请清理后重试`,
        );
      }

      // 2) 写同步标记行（随快照一起上传，用于电视端确认数据完整性）
      const nonce = Crypto.randomUUID();
      const at = new Date().toISOString();
      const marker = JSON.stringify({
        nonce,
        at,
        counts: {
          media: stats.media,
          sources: stats.sources,
          favorites: stats.favorites,
          history: stats.history,
        },
      });
      await provider.execute(
        `INSERT INTO system_config (key, value, value_type, updated_at)
         VALUES ('sync.lastExport', ?, 'string', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [marker, at],
      );

      // 3) 生成快照（VACUUM INTO 会包含未 checkpoint 的 WAL 内容）
      const dir = FileSystem.cacheDirectory ?? FileSystem.documentDirectory;
      if (!dir) throw new Error('无法获取本机缓存目录');
      snapshotPath = `${dir}openreel-sync.db`;
      snapshotRef.current = snapshotPath;
      await FileSystem.deleteAsync(snapshotPath, { idempotent: true }).catch(() => undefined);
      const escaped = snapshotPath.replace(/'/g, "''");
      await provider.execute(`VACUUM INTO '${escaped}'`);
      const info = await FileSystem.getInfoAsync(snapshotPath);
      const size = Number((info as any)?.size ?? 0);
      if (!size) throw new Error('生成数据库快照失败（文件为空）');
      setTotal(size);

      // 4) 电视空间检查（快照 + 200MB 余量）
      if (tvFree !== null && tvFree < size + MARGIN_BYTES) {
        throw new Error(
          `电视剩余空间不足（需要 ${formatBytes(size + MARGIN_BYTES)}，电视剩余 ${formatBytes(tvFree)}）`,
        );
      }

      // 5) 分片上传
      setStatus('正在上传到电视…');
      let offset = 0;
      while (offset < size) {
        const len = Math.min(CHUNK, size - offset);
        const base64 = await FileSystem.readAsStringAsync(snapshotPath, {
          encoding: FileSystem.EncodingType.Base64,
          position: offset,
          length: len,
        });
        let sent = false;
        let lastErr: any = null;
        for (let attempt = 0; attempt < 3 && !sent; attempt++) {
          try {
            const res = await fetch(
              `http://${target.ip}:${target.port}/sync/chunk?t=${target.token}&offset=${offset}&total=${size}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ data: base64 }),
              },
            );
            const json = await res.json().catch(() => null);
            if (!res.ok || !json?.ok) {
              throw new Error(json?.error ? String(json.error) : `HTTP ${res.status}`);
            }
            sent = true;
          } catch (e) {
            lastErr = e;
            await new Promise((r) => setTimeout(r, 500));
          }
        }
        if (!sent) throw new Error(`上传中断：${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
        offset += len;
        setUploaded(offset);
      }

      // 6) 通知电视完成并等待校验
      setStatus('正在等待电视校验…');
      const finishRes = await fetch(`http://${target.ip}:${target.port}/sync/finish?t=${target.token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ size, nonce, at }),
      });
      const finishJson = await finishRes.json().catch(() => null);
      if (!finishRes.ok || !finishJson?.ok) {
        throw new Error(finishJson?.error ? String(finishJson.error) : `电视校验失败（HTTP ${finishRes.status}）`);
      }

      // 7) 电视校验是异步的（274MB 库 quick_check 可能几十秒），轮询 meta 等结果
      setStatus('电视正在校验数据…');
      let ready = false;
      for (let i = 0; i < 180; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        try {
          const metaRes = await fetch(`http://${target.ip}:${target.port}/sync/meta?t=${target.token}`);
          const meta = await metaRes.json();
          if (meta?.phase === 'ready') {
            ready = true;
            break;
          }
          if (meta?.phase === 'error') {
            throw new Error(String(meta?.message || '电视校验未通过'));
          }
        } catch (e) {
          if (e instanceof Error && e.message.includes('校验未通过')) throw e;
          // 单次轮询失败（网络抖动）继续等
        }
      }
      if (!ready) throw new Error('等待电视校验超时，请到电视上查看同步状态');

      setStep('done');
      setStatus('已上传并通过电视校验。请回到电视上点「应用并重启」完成替换。');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep('error');
    } finally {
      if (snapshotPath) {
        await FileSystem.deleteAsync(snapshotPath, { idempotent: true }).catch(() => undefined);
        snapshotRef.current = null;
      }
    }
  }, [stats, target, tvFree]);

  useEffect(() => {
    return () => {
      scanningRef.current = false;
      const leftover = snapshotRef.current;
      if (leftover) {
        void FileSystem.deleteAsync(leftover, { idempotent: true }).catch(() => undefined);
        snapshotRef.current = null;
      }
    };
  }, []);

  const percent = total > 0 ? Math.min(100, Math.round((uploaded / total) * 100)) : 0;

  return (
    <BlurredBackground imageUrl={null}>
      <ScrollView style={styles.container}>
        <View style={styles.header}>
          <View style={styles.headerRow}>
            <Button variant="icon" size="sm" onPress={() => navigation.goBack()}>
              <ArrowLeft size={20} color={colors.text} />
            </Button>
            <Text style={styles.title}>同步到电视</Text>
            <View style={styles.placeholder} />
          </View>
        </View>

        <View style={styles.content}>
          <View style={styles.card}>
            <Text style={styles.warning}>全覆盖同步（不备份）：电视现有片库/历史会被手机数据整份替换。</Text>
            <Text style={[styles.text, { marginTop: 8 }]}>
              手机与电视需连接同一个 WiFi；上传期间请保持本应用在前台。电视端入口：设置 →「手机同步到电视」。
            </Text>
          </View>

          {step === 'scan' ? (
            <View style={styles.card}>
              <View style={styles.row}>
                <QrCode size={18} color={colors.text} />
                <Text style={styles.cardTitle}>扫描电视上的二维码</Text>
              </View>
              {!permission ? (
                <View style={styles.center}>
                  <ActivityIndicator color={colors.buttonPrimaryBg} />
                </View>
              ) : !permission.granted ? (
                <View style={styles.center}>
                  <Text style={[styles.text, { textAlign: 'center', marginBottom: 12 }]}>
                    需要相机权限才能扫描电视上的同步二维码
                  </Text>
                  <Button variant="primary" onPress={requestPermission}>
                    允许使用相机
                  </Button>
                </View>
              ) : (
                <View style={styles.cameraWrap}>
                  <CameraView
                    style={{ flex: 1 }}
                    facing="back"
                    barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                    onBarcodeScanned={({ data }) => {
                      if (data) void onScanned(data);
                    }}
                  />
                </View>
              )}
            </View>
          ) : null}

          {step === 'confirm' && target && stats ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>确认同步内容</Text>
              <Text style={styles.statLine}>
                手机片库 {stats.media} 部 · 视频源 {stats.sources} 个 · 收藏 {stats.favorites} 条 · 历史 {stats.history} 条
              </Text>
              <Text style={styles.statLine}>
                结构版本：手机 {stats.schemaVersion} / 电视 {target.schemaVersion >= 0 ? target.schemaVersion : '未知'}
              </Text>
              {tvFree !== null ? (
                <Text style={styles.statLine}>电视剩余空间：{formatBytes(tvFree)}</Text>
              ) : null}
              <Text style={[styles.warning, { marginTop: 10 }]}>
                上传完成后，还需要在电视上点「应用并重启」才会真正替换。
              </Text>
              <View style={styles.actions}>
                <Button variant="primary" onPress={runSync}>
                  开始上传
                </Button>
                <Button variant="secondary" onPress={rescan}>
                  重新扫描
                </Button>
              </View>
            </View>
          ) : null}

          {step === 'uploading' ? (
            <View style={styles.card}>
              <View style={styles.row}>
                <Upload size={18} color={colors.text} />
                <Text style={styles.cardTitle}>正在同步</Text>
              </View>
              <Text style={styles.text}>{status}</Text>
              <View style={styles.progressTrack}>
                <View style={[styles.progressBar, { width: `${percent}%` }]} />
              </View>
              <Text style={[styles.text, { marginTop: 8 }]}>
                {formatBytes(uploaded)}
                {total > 0 ? ` / ${formatBytes(total)}（${percent}%）` : ''}
              </Text>
            </View>
          ) : null}

          {step === 'done' ? (
            <View style={styles.card}>
              <View style={styles.iconCenter}>
                <CheckCircle2 size={40} color={colors.success} />
              </View>
              <Text style={[styles.cardTitle, { textAlign: 'center' }]}>上传并校验完成</Text>
              <Text style={[styles.text, { textAlign: 'center' }]}>
                请回到电视上点「应用并重启」，电视会自动重启并加载手机片库与观看历史。
              </Text>
              <View style={styles.actions}>
                <Button variant="secondary" onPress={rescan}>
                  再同步一次
                </Button>
              </View>
            </View>
          ) : null}

          {step === 'error' ? (
            <View style={styles.card}>
              <View style={styles.row}>
                <AlertTriangle size={18} color={colors.error} />
                <Text style={[styles.cardTitle, { color: colors.error }]}>同步失败</Text>
              </View>
              <Text style={[styles.text, { color: colors.error }]}>{error}</Text>
              <View style={styles.actions}>
                <Button variant="primary" onPress={rescan}>
                  重新扫描
                </Button>
              </View>
            </View>
          ) : null}

          {step === 'done' || step === 'error' ? (
            <TouchableOpacity
              style={[styles.card, { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }]}
              onPress={rescan}
              activeOpacity={0.7}
            >
              <RefreshCw size={16} color={colors.mutedForeground} />
              <Text style={styles.text}>重新扫描电视二维码</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </ScrollView>
    </BlurredBackground>
  );
}
