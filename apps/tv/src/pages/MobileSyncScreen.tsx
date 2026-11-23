import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { hexToRgba, useScaledFontSize, useThemeColors, useThemeStore } from '@openreel/expo-ui';
import { formatBytes } from '@openreel/core';

import { TVPageHeader } from '../components/TVPageHeader';
import { TVButton } from '../components/TVButton';
import { QRCodeView } from '../components/QRCodeView';
import { showTVToast } from '../components/TVToast';
import { focusRegistry } from '../focus/registry';
import { getProvider } from '../init';
import {
  applyLibrarySyncAndRestart,
  cancelLibrarySync,
  isLibrarySyncSupported,
  pollLibrarySync,
  startLibrarySync,
  type LibrarySyncPhase,
  type LibrarySyncSession,
  type LibrarySyncSummary,
} from '../services/librarySync';
import { TV_LAYOUT, tv } from '../theme/tokens';

interface LocalStats {
  schemaVersion: number;
  media: number;
  sources: number;
  favorites: number;
  history: number;
}

const EMPTY_PHASE: LibrarySyncPhase = 'idle';

/**
 * 手机 → 电视「整库替换」同步页。
 *
 * 交互：开始 → 电视展示二维码 → 手机 App 扫码上传数据库快照 → 电视校验 →
 * 用户确认「应用并重启」→ 关库、原子替换、重启。
 * 约束：不备份；任何校验失败都不动电视旧库（见方案文档 mobile_to_tv_library_sync_plan.md）。
 */
export function MobileSyncScreen() {
  const colors = useThemeColors();
  const scale = useScaledFontSize();
  const cardOpacity = useThemeStore((s) => s.cardOpacity);
  const nav = useNavigation<any>();

  const supported = React.useMemo(() => isLibrarySyncSupported(), []);
  const [local, setLocal] = useState<LocalStats | null>(null);
  const [session, setSession] = useState<LibrarySyncSession | null>(null);
  const [phase, setPhase] = useState<LibrarySyncPhase>(EMPTY_PHASE);
  const [message, setMessage] = useState('');
  const [received, setReceived] = useState(0);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<LibrarySyncSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const applyingRef = useRef(false);

  const cardStyle = { backgroundColor: hexToRgba(colors.surface, cardOpacity / 100), borderColor: colors.border };

  const loadStats = useCallback(async () => {
    try {
      const provider = getProvider();
      const row = await provider.selectOne<any>(
        `SELECT
           IFNULL((SELECT MAX(version) FROM migrations), 0) AS schemaVersion,
           (SELECT COUNT(*) FROM media) AS media,
           (SELECT COUNT(*) FROM video_source) AS sources,
           (SELECT COUNT(*) FROM favorite) AS favorites,
           (SELECT COUNT(*) FROM watch_history) AS history`,
      );
      setLocal({
        schemaVersion: Number(row?.schemaVersion ?? 0),
        media: Number(row?.media ?? 0),
        sources: Number(row?.sources ?? 0),
        favorites: Number(row?.favorites ?? 0),
        history: Number(row?.history ?? 0),
      });
    } catch (e) {
      setError(`读取电视数据库信息失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  useEffect(() => {
    void loadStats();
    const t = setTimeout(() => focusRegistry.requestInitialFocus('sync-back'), 120);
    return () => {
      clearTimeout(t);
      if (!applyingRef.current) void cancelLibrarySync();
    };
  }, [loadStats]);

  // 轮询手机上传/校验进度（仅在服务进行中）
  useEffect(() => {
    if (!session) return;
    if (phase !== 'serving' && phase !== 'uploading' && phase !== 'validating') return;
    let stopped = false;
    const timer = setInterval(async () => {
      if (stopped) return;
      try {
        const s = await pollLibrarySync();
        if (stopped) return;
        setPhase(s.phase);
        setMessage(s.message || '');
        setReceived(Number(s.received) || 0);
        setTotal(Number(s.total) || 0);
        setSummary(s.summary ?? null);
        if (s.phase === 'error') {
          setError(s.message || '同步失败');
        }
        if (s.phase === 'ready') {
          focusRegistry.requestInitialFocus('sync-apply');
        }
      } catch {
        // 单次轮询失败忽略，下一轮继续
      }
    }, 600);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [session, phase]);

  const ensureNoRunningTasks = useCallback(async () => {
    try {
      const provider = getProvider();
      const row = await provider.selectOne<any>(
        "SELECT COUNT(*) AS c FROM collect_task WHERE status IN ('RUNNING', 'PENDING')",
      );
      const c = Number(row?.c ?? 0);
      if (c > 0) {
        throw new Error('还有采集任务在进行，请等采集结束（或到「采集任务」里停止）后再同步');
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes('采集任务')) throw e;
      // collect_task 表不存在等异常不阻塞同步
    }
  }, []);

  const begin = useCallback(async () => {
    setBusy(true);
    setError(null);
    setSummary(null);
    setReceived(0);
    setTotal(0);
    try {
      if (!local) throw new Error('还没读到电视数据库信息，请稍后重试');
      if (local.media > 0 || local.history > 0) {
        // 覆盖式同步：这里只做提示，最终确认由用户点「应用并重启」
        showTVToast('同步会覆盖电视现有片库/历史，校验通过后才会替换', 'info');
      }
      await ensureNoRunningTasks();
      await cancelLibrarySync();
      const s = await startLibrarySync(local.schemaVersion);
      setSession(s);
      setPhase('serving');
      setMessage('等待手机扫码上传…');
    } catch (e) {
      setError(`启动同步服务失败：${e instanceof Error ? e.message : String(e)}`);
      setPhase('error');
    } finally {
      setBusy(false);
    }
  }, [ensureNoRunningTasks, local]);

  const stop = useCallback(async () => {
    await cancelLibrarySync();
    setSession(null);
    setPhase(EMPTY_PHASE);
    setMessage('');
    setError(null);
    setSummary(null);
    setReceived(0);
    setTotal(0);
    void loadStats();
  }, [loadStats]);

  const applyNow = useCallback(async () => {
    if (!summary) return;
    setBusy(true);
    setError(null);
    applyingRef.current = true;
    try {
      const provider = getProvider();
      // 必须先关库：否则旧连接持有的句柄会把新库写坏（WAL 回放）
      await provider.close();
      await applyLibrarySyncAndRestart();
      setPhase('applying');
      setMessage('数据已替换，正在重启应用…');
      // 兜底：个别 ROM 上 AlarmManager 拉起失败时，提示用户手动重开
      setTimeout(() => {
        setMessage('如果应用没有自动重启，请按遥控器 HOME 键重新打开本应用（数据已替换完成）');
      }, 6000);
    } catch (e) {
      applyingRef.current = false;
      const msg = e instanceof Error ? e.message : String(e);
      setError(`应用手机数据失败：${msg}（电视原数据未被替换）`);
      setPhase('error');
      // 关库后失败：尝试重新打开数据库，避免页面完全不可用
      try {
        await getProvider().init();
      } catch {
        // 打开失败时提示用户重启应用
      }
    } finally {
      setBusy(false);
    }
  }, [summary]);

  const percent = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;

  const renderStats = (stats: LocalStats | null, title: string) => (
    <View style={[styles.card, cardStyle]}>
      <Text style={{ color: colors.foreground, fontSize: scale(18), fontWeight: '700', marginBottom: tv(6) }}>
        {title}
      </Text>
      <Text style={{ color: colors.textSecondary, fontSize: scale(16), lineHeight: tv(24) }}>
        片库 {stats?.media ?? '—'} 部 · 视频源 {stats?.sources ?? '—'} 个 · 收藏 {stats?.favorites ?? '—'} 条 · 观看历史{' '}
        {stats?.history ?? '—'} 条 · 结构版本 {stats?.schemaVersion ?? '—'}
      </Text>
    </View>
  );

  return (
    <View style={styles.container}>
      <TVPageHeader title="手机同步到电视" backId="sync-back" onBack={() => nav.goBack()} />

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, { paddingHorizontal: TV_LAYOUT.paddingX }]}
        showsVerticalScrollIndicator={false}
      >
        <View style={[styles.card, cardStyle, { borderColor: colors.warning }]}>
          <Text style={{ color: colors.warning, fontSize: scale(18), fontWeight: '700', marginBottom: tv(6) }}>
            全覆盖同步（不备份）
          </Text>
          <Text style={{ color: colors.textSecondary, fontSize: scale(16), lineHeight: tv(24) }}>
            校验通过并点「应用并重启」后，电视现有片库、视频源、收藏、观看历史会被手机数据整份替换，且不保留备份。
            手机与电视需连接同一个 WiFi，并保持手机 App 在前台。
          </Text>
        </View>

        {!supported ? (
          <View style={[styles.card, cardStyle]}>
            <Text style={{ color: colors.error, fontSize: scale(17) }}>
              当前安装包不支持手机同步（缺少原生模块），请安装最新版本。
            </Text>
          </View>
        ) : null}

        {renderStats(local, '电视当前数据')}

        {phase === 'idle' || phase === 'error' ? (
          <View style={[styles.card, cardStyle]}>
            {error ? (
              <Text style={{ color: colors.error, fontSize: scale(16), lineHeight: tv(24), marginBottom: tv(10) }}>
                {error}
              </Text>
            ) : null}
            <Text style={{ color: colors.textSecondary, fontSize: scale(16), lineHeight: tv(24), marginBottom: tv(12) }}>
              点「开始」后电视会显示二维码：打开手机端 App → 设置 → 同步到电视 → 扫码上传。
            </Text>
            <TVButton
              id="sync-start"
              label={busy ? '正在启动…' : '开始'}
              variant="primary"
              disabled={busy || !supported}
              onPress={begin}
              testID="tv-sync-start"
            />
          </View>
        ) : null}

        {session ? (
          <View style={[styles.card, cardStyle]}>
            <View style={styles.qrRow}>
              <QRCodeView value={session.url} size={tv(150)} />
              <View style={styles.qrInfo}>
                <Text style={{ color: colors.foreground, fontSize: scale(17), fontWeight: '600', marginBottom: tv(4) }}>
                  手机扫码上传
                </Text>
                <Text style={{ color: colors.textSecondary, fontSize: scale(15), lineHeight: tv(22) }}>
                  1. 手机 App →「设置」→「同步到电视」
                </Text>
                <Text style={{ color: colors.textSecondary, fontSize: scale(15), lineHeight: tv(22) }}>
                  2. 扫码后会显示传输进度，请保持手机 App 在前台
                </Text>
                <Text style={{ color: colors.mutedForeground, fontSize: scale(13), marginTop: tv(6) }} numberOfLines={1}>
                  {`${session.ip}:${session.port} · 电视剩余空间 ${formatBytes(session.freeBytes)}`}
                </Text>
              </View>
            </View>

            {phase === 'uploading' || phase === 'validating' || phase === 'ready' ? (
              <View style={styles.progressWrap}>
                <View style={[styles.progressTrack, { backgroundColor: colors.border }]}>
                  <View
                    style={[
                      styles.progressBar,
                      { backgroundColor: colors.buttonPrimaryBg, width: `${phase === 'ready' ? 100 : percent}%` },
                    ]}
                  />
                </View>
                <Text style={{ color: colors.textSecondary, fontSize: scale(15), marginTop: tv(6) }}>
                  {phase === 'ready'
                    ? '已接收完成'
                    : `已接收 ${formatBytes(received)}${total > 0 ? ` / ${formatBytes(total)}` : ''}`}
                </Text>
              </View>
            ) : null}

            {message ? (
              <Text style={{ color: colors.textSecondary, fontSize: scale(15), marginTop: tv(8) }}>{message}</Text>
            ) : null}
          </View>
        ) : null}

        {summary && phase === 'ready' ? (
          <>
            {renderStats(
              {
                schemaVersion: summary.schemaVersion,
                media: summary.media,
                sources: summary.sources,
                favorites: summary.favorites,
                history: summary.history,
              },
              `手机数据（${formatBytes(summary.bytes)}，校验通过）`,
            )}
            <View style={[styles.card, cardStyle, { borderColor: colors.warning }]}>
              <Text style={{ color: colors.textSecondary, fontSize: scale(16), lineHeight: tv(24), marginBottom: tv(10) }}>
                点「应用并重启」后立即替换电视数据库（不备份），应用会自动重启。
              </Text>
              <View style={styles.actions}>
                <TVButton
                  id="sync-apply"
                  label={busy ? '正在应用…' : '应用并重启'}
                  variant="danger"
                  disabled={busy}
                  onPress={applyNow}
                  testID="tv-sync-apply"
                />
                <TVButton id="sync-drop" label="放弃" disabled={busy} onPress={stop} testID="tv-sync-drop" />
              </View>
            </View>
          </>
        ) : null}

        {phase === 'applying' ? (
          <View style={[styles.card, cardStyle]}>
            <Text style={{ color: colors.success, fontSize: scale(18), fontWeight: '700' }}>数据已替换，正在重启应用…</Text>
          </View>
        ) : null}
      </ScrollView>

      <View style={[styles.footer, { paddingHorizontal: TV_LAYOUT.paddingX }]}>
        {session && phase !== 'applying' ? (
          <TVButton id="sync-cancel" label="取消同步" onPress={stop} testID="tv-sync-cancel" />
        ) : null}
        <TVButton id="sync-back2" label="返回" onPress={() => nav.goBack()} testID="tv-sync-back" />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { flex: 1 },
  content: { paddingTop: tv(8), paddingBottom: tv(24) },
  card: { padding: tv(16), borderRadius: tv(10), borderWidth: 1, marginBottom: tv(12) },
  qrRow: { flexDirection: 'row' },
  qrInfo: { flex: 1, marginLeft: tv(18) },
  progressWrap: { marginTop: tv(12) },
  progressTrack: { height: tv(10), borderRadius: tv(5), overflow: 'hidden' },
  progressBar: { height: tv(10), borderRadius: tv(5) },
  actions: { flexDirection: 'row' },
  footer: { flexDirection: 'row', paddingVertical: tv(14), borderTopWidth: 1, borderTopColor: 'rgba(128,128,128,0.35)' },
});

export default MobileSyncScreen;
