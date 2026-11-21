import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Modal,
  ActivityIndicator,
  Switch,
  Dimensions,
  ScrollView,
} from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import type {
  AwardCatalog,
  AwardCollectPending,
  AwardCollectProgress,
  AwardItem,
  AwardItemMatch,
  AwardList,
} from '@openreel/core';
import { getEditionTitle, parseLiveRankingListId } from '@openreel/core';
import { getProvider } from '../init';
import { openMediaPlay } from '../utils/openMediaPlay';
import { useThemeColors } from '../themes/useThemeColors';
import { useThemeStore } from '../themes/store';
import { useScaledFontSize } from '../themes/useScaledFontSize';
import { hexToRgba } from '../themes/colorUtils';
import { radius } from '../themes/radiusTokens';
import BlurredBackground from '../components/BlurredBackground';
import AwardPoster from '../components/AwardPoster';
import { showToast } from '../components/Toast';
import {
  ArrowLeft,
  Check,
  Download,
  Loader2,
  Play,
  RefreshCw,
  Search,
  Star,
  Trophy,
  X,
} from 'lucide-react-native';
import { AWARD_STATUS_LABEL, TYPE_LABEL, getAwardService, getLiveRankingService } from '../awards/useAwards';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const CARD_WIDTH = (SCREEN_WIDTH - 15 * 2 - 10) / 2;

export default function RankingDetailScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const listId: string = route.params?.listId ?? '';
  const colors = useThemeColors();
  const cardOpacity = useThemeStore((s) => s.cardOpacity);
  const s = useScaledFontSize();
  const service = useMemo(() => getAwardService(), []);

  const [catalog, setCatalog] = useState<AwardCatalog>(() => service.getBundledCatalog());
  const [matches, setMatches] = useState<Record<string, AwardItemMatch>>({});
  const [loading, setLoading] = useState(true);
  const [onlyLocal, setOnlyLocal] = useState(false);
  const [actionItem, setActionItem] = useState<{ item: AwardItem; index: number } | null>(null);
  const [collecting, setCollecting] = useState(false);
  const [pending, setPending] = useState<AwardCollectPending | null>(null);
  const [pendingSelected, setPendingSelected] = useState<Set<string>>(new Set());
  const [savingPending, setSavingPending] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchProgress, setBatchProgress] = useState<AwardCollectProgress | null>(null);
  const [batchResult, setBatchResult] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const liveService = useMemo(() => getLiveRankingService(), []);
  const liveId = useMemo(() => parseLiveRankingListId(listId), [listId]);
  const [liveList, setLiveList] = useState<AwardList | null>(null);
  const [liveLoading, setLiveLoading] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  const list = useMemo(
    () => catalog.lists.find((l) => l.id === listId) ?? (liveList?.id === listId ? liveList : undefined),
    [catalog, listId, liveList]
  );

  // 实时榜：每次进入页面都重新读取。
  useEffect(() => {
    if (!liveId) return;
    if (catalog.lists.some((l) => l.id === listId)) return;
    let cancelled = false;
    setLiveLoading(true);
    setLiveError(null);
    void liveService
      .loadList(listId)
      .then((l) => {
        if (!cancelled) setLiveList(l);
      })
      .catch((err: any) => {
        if (!cancelled) setLiveError(err?.message ?? '读取失败');
      })
      .finally(() => {
        if (!cancelled) setLiveLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [listId, liveId, catalog, liveService]);
  const award = useMemo(
    () => catalog.awards.find((a) => a.id === list?.awardId),
    [catalog, list]
  );
  /** 当前榜单所属的「届」：同届多份名单 = 页内分栏，不同届 = 年份切换。 */
  const edition = useMemo(
    () => (list && catalog ? service.getEditionOfList(list.id) : undefined),
    [catalog, list, service]
  );
  const sectionLists = edition?.lists ?? [];
  const otherEditions = useMemo(() => {
    if (!edition) return [];
    return service.getAwardEditions(edition.award.id).filter((e) => e.id !== edition.id);
  }, [catalog, edition, service]);

  const refreshMatches = useCallback(async () => {
    if (!list) return;
    setLoading(true);
    try {
      service.invalidateMatches();
      const result = await service.matchList(list);
      const next: Record<string, AwardItemMatch> = {};
      for (const m of result) next[`${list.id}:${m.itemIndex}`] = m;
      setMatches(next);
    } finally {
      setLoading(false);
    }
  }, [list, service]);

  useEffect(() => {
    let cancelled = false;
    void service.loadCatalog().then((c) => {
      if (!cancelled) setCatalog(c);
    });
    return () => {
      cancelled = true;
    };
  }, [service]);

  useEffect(() => {
    if (!list) return;
    setMatches({});
    void refreshMatches();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list?.id]);

  const stats = useMemo(() => {
    const values = Object.values(matches);
    return {
      playable: values.filter((m) => m.status === 'PLAYABLE').length,
      library: values.filter((m) => m.status === 'LIBRARY_ONLY').length,
      pending: values.filter((m) => m.status === 'PENDING').length,
      missing: list ? list.items.length - values.filter((m) => m.status !== 'MISSING').length : 0,
    };
  }, [matches, list]);

  const visibleItems = useMemo(() => {
    if (!list) return [];
    return list.items
      .map((item, index) => ({ item, index, match: matches[`${list.id}:${index}`] }))
      .filter(({ match }) => !onlyLocal || match?.status === 'PLAYABLE');
  }, [list, matches, onlyLocal]);

  const playableEntries = useMemo(() => {
    if (!list) return [];
    return list.items
      .map((item, index) => ({ item, index, match: matches[`${list.id}:${index}`] }))
      .filter(({ match }) => match?.status === 'PLAYABLE' && match.media)
      .map(({ match }) => match!.media!);
  }, [list, matches]);

  const playMatched = async (mediaId: number) => {
    if (playingId) return;
    setPlayingId(mediaId);
    try {
      const media = await getProvider().getMediaById(mediaId);
      if (!media) {
        showToast('本地记录已失效，请刷新匹配', 'error');
        return;
      }
      const ids = playableEntries.map((m) => m.id);
      const currentIndex = ids.indexOf(mediaId);
      await openMediaPlay(navigation, media, {
        type: 'list',
        mediaIds: ids.length > 0 ? ids : [mediaId],
        currentIndex: currentIndex >= 0 ? currentIndex : 0,
      });
    } finally {
      setPlayingId(null);
    }
  };

  const runCollect = async (item: AwardItem, index: number) => {
    setCollecting(true);
    try {
      const outcome = await service.collectItem(item, index);
      if (outcome.saved > 0) {
        showToast(`已收录 ${outcome.saved} 个片源`, 'success');
        setActionItem(null);
        await refreshMatches();
      } else if (outcome.pending.length > 0) {
        const p = outcome.pending[0];
        setPending(p);
        setPendingSelected(new Set());
      } else {
        showToast('未找到匹配片源，可换片名或到搜索页再试', 'error');
      }
    } catch (err: any) {
      showToast(err?.message || '搜索片源失败', 'error');
    } finally {
      setCollecting(false);
    }
  };

  const savePending = async () => {
    if (!pending) return;
    const picked = pending.previews.filter((p) => pendingSelected.has(p.previewId));
    if (picked.length === 0) {
      showToast('请至少选择一个片源', 'error');
      return;
    }
    setSavingPending(true);
    try {
      const saved = await service.savePendingPreviews(picked);
      if (saved > 0) {
        showToast(`已收录 ${saved} 个片源`, 'success');
        setPending(null);
        setActionItem(null);
        await refreshMatches();
      } else {
        showToast('保存失败，请重试', 'error');
      }
    } finally {
      setSavingPending(false);
    }
  };

  const collectTargets = useMemo(() => {
    if (!list) return [];
    return list.items
      .map((item, index) => ({ item, index, match: matches[`${list.id}:${index}`] }))
      .filter(
        ({ match }) =>
          !match || match.status === 'MISSING' || match.status === 'PENDING' || match.status === 'LIBRARY_ONLY'
      );
  }, [list, matches]);

  const startBatch = async () => {
    if (!list || collectTargets.length === 0) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setBatchOpen(true);
    setBatchResult(null);
    setBatchProgress(null);
    const result = await service.collectItems(
      collectTargets.map(({ item, index }) => ({ item, itemIndex: index })),
      (p) => setBatchProgress(p),
      controller.signal
    );
    setBatchResult(
      `${result.cancelled ? '已取消' : '完成'}：新增 ${result.saved} 部，待确认 ${result.pending.length}，失败 ${result.failed.length}${
        result.stoppedReason ? `；${result.stoppedReason}` : ''
      }`
    );
    if (result.pending.length > 0) {
      const first = result.pending[0];
      setPending(first);
      setPendingSelected(new Set());
      setBatchOpen(false);
      setActionItem({ item: first.item, index: first.itemIndex });
      showToast(`${result.cancelled ? '已取消' : '补齐完成'}：新增 ${result.saved} 部，待确认 ${result.pending.length} 部`, 'success');
    }
    abortRef.current = null;
    await refreshMatches();
  };

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: { flex: 1 },
        header: {
          paddingTop: 50,
          paddingHorizontal: 15,
          paddingBottom: 8,
          flexDirection: 'row',
          alignItems: 'center',
        },
        backBtn: { padding: 8, marginRight: 2 },
        headerTitle: { flex: 1, fontSize: s(18), fontWeight: '700', color: colors.text },
        headerSub: { fontSize: s(11), color: colors.mutedForeground, marginTop: 2 },
        iconBtn: { padding: 8 },
        statsBar: {
          marginHorizontal: 15,
          padding: 12,
          borderRadius: radius.lg,
          backgroundColor: hexToRgba(colors.card, cardOpacity / 100),
          flexDirection: 'row',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 10,
        },
        statText: { fontSize: s(11) },
        switchRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginLeft: 'auto' },
        switchLabel: { fontSize: s(11), color: colors.mutedForeground },
        actionsRow: { flexDirection: 'row', gap: 10, marginHorizontal: 15, marginTop: 10 },        actionBtn: {
          flex: 1,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          paddingVertical: 10,
          borderRadius: radius.md,
          backgroundColor: hexToRgba(colors.card, cardOpacity / 100),
        },
        actionBtnPrimary: { backgroundColor: hexToRgba(colors.buttonPrimaryBg, 0.9) },
        actionBtnText: { fontSize: s(13), color: colors.text },
        actionBtnTextPrimary: { color: colors.buttonPrimaryText },
        listTab: {
          paddingHorizontal: 12,
          paddingVertical: 7,
          borderRadius: radius.full,
          backgroundColor: hexToRgba(colors.surface, cardOpacity / 100),
        },
        listTabActive: { backgroundColor: hexToRgba(colors.mutedForeground, 0.35) },
        listTabText: { fontSize: s(12), color: colors.textSecondary },
        listTabTextActive: { color: colors.text, fontWeight: '600' },
        card: {
          width: CARD_WIDTH,
          marginBottom: 14,
          borderRadius: radius.md,
          overflow: 'hidden',
          backgroundColor: hexToRgba(colors.card, cardOpacity / 100),
        },
        posterWrap: { width: CARD_WIDTH, height: CARD_WIDTH * 1.4, overflow: 'hidden' },
        poster: { width: '100%', height: '100%' },
        rankBadge: {
          position: 'absolute',
          top: 6,
          left: 6,
          minWidth: 22,
          height: 22,
          paddingHorizontal: 4,
          borderRadius: 6,
          backgroundColor: 'rgba(0,0,0,0.62)',
          alignItems: 'center',
          justifyContent: 'center',
        },
        rankText: { color: '#fff', fontSize: s(11), fontWeight: '700' },
        winnerBadge: {
          position: 'absolute',
          top: 6,
          right: 6,
          width: 22,
          height: 22,
          borderRadius: 11,
          backgroundColor: 'rgba(251,191,36,0.92)',
          alignItems: 'center',
          justifyContent: 'center',
        },
        statusBadge: {
          position: 'absolute',
          left: 6,
          bottom: 6,
          paddingHorizontal: 7,
          paddingVertical: 3,
          borderRadius: radius.full,
          backgroundColor: 'rgba(0,0,0,0.62)',
        },
        statusText: { fontSize: s(10) },
        playOverlay: {
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          alignItems: 'center',
          justifyContent: 'center',
        },
        playCircle: {
          width: 38,
          height: 38,
          borderRadius: 19,
          backgroundColor: 'rgba(255,255,255,0.9)',
          alignItems: 'center',
          justifyContent: 'center',
        },
        cardInfo: { paddingHorizontal: 8, paddingVertical: 7 },
        cardTitle: { fontSize: s(13), color: colors.text },
        cardMeta: { fontSize: s(10), color: colors.mutedForeground, marginTop: 2 },
        localHint: { fontSize: s(10), color: colors.mutedForeground, marginTop: 2 },
        empty: { paddingVertical: 40, alignItems: 'center' },
        emptyText: { fontSize: s(13), color: colors.mutedForeground },
        modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
        sheet: {
          backgroundColor: colors.background,
          borderTopLeftRadius: radius.lg,
          borderTopRightRadius: radius.lg,
          padding: 16,
          paddingBottom: 28,
          maxHeight: '86%',
        },
        sheetTitle: { fontSize: s(17), fontWeight: '700', color: colors.text, paddingRight: 30 },
        sheetMeta: { fontSize: s(12), color: colors.mutedForeground, marginTop: 4 },
        sheetClose: { position: 'absolute', right: 12, top: 12, padding: 6 },
        sheetPosterRow: { flexDirection: 'row', gap: 12, marginTop: 14 },
        sheetPoster: { width: 82, height: 118, borderRadius: radius.sm, overflow: 'hidden' },
        sheetInfo: { flex: 1, gap: 4 },
        sheetInfoText: { fontSize: s(12), color: colors.textSecondary },
        sheetAction: {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          paddingVertical: 12,
          borderRadius: radius.md,
          backgroundColor: hexToRgba(colors.card, cardOpacity / 100),
          marginTop: 10,
        },
        sheetActionPrimary: { backgroundColor: colors.buttonPrimaryBg },
        sheetActionText: { fontSize: s(14), color: colors.text },
        sheetActionTextPrimary: { color: colors.buttonPrimaryText },
        previewRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 },
        checkbox: {
          width: 22,
          height: 22,
          borderRadius: 6,
          borderWidth: 1,
          borderColor: colors.mutedForeground,
          alignItems: 'center',
          justifyContent: 'center',
        },
        checkboxOn: { backgroundColor: colors.buttonPrimaryBg, borderColor: colors.buttonPrimaryBg },
        previewTitle: { fontSize: s(14), color: colors.text },
        previewMeta: { fontSize: s(11), color: colors.mutedForeground, marginTop: 2 },
        progressBar: {
          height: 6,
          borderRadius: 3,
          backgroundColor: hexToRgba(colors.surface, cardOpacity / 100),
          overflow: 'hidden',
          marginTop: 12,
        },
        progressFill: { height: '100%', backgroundColor: colors.buttonPrimaryBg },
        progressText: { fontSize: s(12), color: colors.textSecondary, marginTop: 8 },
      }),
    [colors, cardOpacity, s]
  );

  if (!list) {
    return (
      <BlurredBackground imageUrl={null}>
        <View style={styles.container}>
          <View style={styles.header}>
            <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()}>
              <ArrowLeft size={20} color={colors.text} />
            </TouchableOpacity>
            <Text style={styles.headerTitle}>榜单</Text>
          </View>
          <View style={styles.empty}>
            {liveLoading ? <ActivityIndicator color={colors.mutedForeground} /> : null}
            <Text style={styles.emptyText}>
              {liveLoading
                ? '正在读取红果实时榜（TOP100）…'
                : liveError
                  ? `读取失败：${liveError}`
                  : '榜单不存在或数据已更新'}
            </Text>
          </View>
        </View>
      </BlurredBackground>
    );
  }

  const statusColor = (status: string) =>
    status === 'PLAYABLE'
      ? colors.success
      : status === 'LIBRARY_ONLY'
        ? '#38bdf8'
        : status === 'PENDING'
          ? colors.warning
          : colors.mutedForeground;

  const renderItem = ({ item, index, match }: { item: AwardItem; index: number; match?: AwardItemMatch }) => {
    const status = match?.status ?? 'MISSING';
    const poster = match?.media?.posterUrl || item.posterUrl;
    const isPlayable = status === 'PLAYABLE' && match?.media;
    return (
      <TouchableOpacity
        style={styles.card}
        activeOpacity={0.85}
        onPress={() => {
          if (isPlayable && match?.media) void playMatched(match.media.id);
          else setActionItem({ item, index });
        }}
      >
        <View style={styles.posterWrap}>
          <AwardPoster uri={poster} placeholderText={item.title} style={styles.poster} />
          {typeof item.rank === 'number' && (
            <View style={styles.rankBadge}>
              <Text style={styles.rankText}>{item.rank}</Text>
            </View>
          )}
          {item.winner && (
            <View style={styles.winnerBadge}>
              <Trophy size={12} color="#111" />
            </View>
          )}
          <View style={styles.statusBadge}>
            <Text style={[styles.statusText, { color: statusColor(status) }]}>
              {AWARD_STATUS_LABEL[status] ?? status}
            </Text>
          </View>
          {isPlayable && (
            <View style={styles.playOverlay}>
              <View style={styles.playCircle}>
                {playingId === match?.media?.id ? (
                  <ActivityIndicator size="small" color="#111" />
                ) : (
                  <Play size={18} color="#111" fill="#111" />
                )}
              </View>
            </View>
          )}
        </View>
        <View style={styles.cardInfo}>
          <Text style={styles.cardTitle} numberOfLines={1}>
            {item.title}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Text style={styles.cardMeta}>
              {list.kind === 'LIVE' ? item.note || '短剧' : `${item.year} · ${TYPE_LABEL[item.type] ?? item.type}`}
            </Text>
            {item.rating != null && item.rating > 0 && (
              <View style={{ flexDirection: 'row', alignItems: 'center', marginLeft: 'auto', gap: 2 }}>
                <Star size={9} color={colors.warning} fill={colors.warning} />
                <Text style={{ fontSize: s(10), color: colors.warning }}>{item.rating.toFixed(1)}</Text>
              </View>
            )}
          </View>
          {match?.media && status !== 'PLAYABLE' && (
            <Text style={styles.localHint} numberOfLines={1}>
              本地：{match.media.title}（{match.media.year}）
            </Text>
          )}
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <BlurredBackground imageUrl={null}>
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()}>
            <ArrowLeft size={20} color={colors.text} />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={styles.headerTitle} numberOfLines={1}>
              {edition ? getEditionTitle(edition) : list.title}
            </Text>
            <Text style={styles.headerSub} numberOfLines={1}>
              {list.kind === 'LIVE'
                ? `${list.items.length} 部 · ${list.updatedText || '红果日更'}`
                : `${award?.name ?? ''}${edition?.year != null ? ` · ${edition.year}` : ''} · ${list.items.length} 部${
                    edition && sectionLists.length > 1 ? `（共 ${edition.totalItems} 部）` : ''
                  }`}
            </Text>
          </View>
          <TouchableOpacity style={styles.iconBtn} onPress={refreshMatches} disabled={loading}>
            {loading ? (
              <ActivityIndicator size="small" color={colors.mutedForeground} />
            ) : (
              <RefreshCw size={18} color={colors.mutedForeground} />
            )}
          </TouchableOpacity>
        </View>

        <View style={styles.statsBar}>
          <Text style={[styles.statText, { color: colors.success }]}>可播放 {stats.playable}</Text>
          <Text style={[styles.statText, { color: '#38bdf8' }]}>已入库 {stats.library}</Text>
          <Text style={[styles.statText, { color: colors.warning }]}>待确认 {stats.pending}</Text>
          <Text style={[styles.statText, { color: colors.mutedForeground }]}>未收录 {stats.missing}</Text>
          <View style={styles.switchRow}>
            <Text style={styles.switchLabel}>只看可播放</Text>
            <Switch value={onlyLocal} onValueChange={setOnlyLocal} />
          </View>
        </View>

        <View style={styles.actionsRow}>
          <TouchableOpacity
            style={[styles.actionBtn, styles.actionBtnPrimary]}
            onPress={startBatch}
            disabled={collectTargets.length === 0 || collecting}
            activeOpacity={0.85}
          >
            <Download size={15} color={colors.buttonPrimaryText} />
            <Text style={[styles.actionBtnText, styles.actionBtnTextPrimary]}>
              一键补齐{collectTargets.length > 0 ? ` (${collectTargets.length})` : ''}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.actionBtn}
            onPress={() => setOnlyLocal((v) => !v)}
            activeOpacity={0.85}
          >
            <Search size={15} color={colors.text} />
            <Text style={styles.actionBtnText}>{onlyLocal ? '显示全部' : '只看可播'}</Text>
          </TouchableOpacity>
        </View>

        {sectionLists.length > 1 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: 15, paddingTop: 10, gap: 8 }}
          >
            {sectionLists.map((l) => (
              <TouchableOpacity
                key={l.id}
                style={[styles.listTab, l.id === list.id && styles.listTabActive]}
                onPress={() => navigation.replace('RankingDetail', { listId: l.id })}
                activeOpacity={0.85}
              >
                <Text style={[styles.listTabText, l.id === list.id && styles.listTabTextActive]}>
                  {l.sectionLabel ?? l.title}（{l.items.length}）
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}

        {otherEditions.length > 0 && (
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: 15, paddingTop: 8 }}>
            <Text style={{ fontSize: s(11), color: colors.mutedForeground, marginRight: 8 }}>
              其他年份
            </Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
              {otherEditions.map((e) => (
                <TouchableOpacity
                  key={e.id}
                  style={styles.listTab}
                  onPress={() => navigation.replace('RankingDetail', { listId: e.primary.id })}
                  activeOpacity={0.85}
                >
                  <Text style={styles.listTabText}>{e.year != null ? e.year : '历届'}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        )}

        <FlatList
          data={visibleItems}
          keyExtractor={(x) => `${list.id}:${x.index}`}
          renderItem={({ item: row }) => renderItem(row)}
          numColumns={2}
          columnWrapperStyle={{ justifyContent: 'space-between', paddingHorizontal: 15 }}
          contentContainerStyle={{ paddingTop: 12, paddingBottom: 40 }}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyText}>
                {onlyLocal ? '暂无可直接播放的影片，关掉「只看可播放」查看全部' : '暂无条目'}
              </Text>
            </View>
          }
        />

        {/* 单条找片 / 待确认 */}
        <Modal visible={!!actionItem} transparent animationType="fade" onRequestClose={() => setActionItem(null)}>
          <View style={styles.modalBackdrop}>
            <View style={styles.sheet}>
              <ScrollView showsVerticalScrollIndicator={false}>
                {actionItem && (
                  <>
                    <Text style={styles.sheetTitle}>{actionItem.item.title}</Text>
                    <TouchableOpacity style={styles.sheetClose} onPress={() => setActionItem(null)}>
                      <X size={20} color={colors.mutedForeground} />
                    </TouchableOpacity>
                    <Text style={styles.sheetMeta}>
                      {actionItem.item.year} · {TYPE_LABEL[actionItem.item.type] ?? actionItem.item.type}
                      {actionItem.item.winner ? ' · 获奖' : ''}
                      {actionItem.item.rating != null && actionItem.item.rating > 0
                        ? ` · 豆瓣 ${actionItem.item.rating.toFixed(1)}`
                        : ''}
                    </Text>
                    <View style={styles.sheetPosterRow}>
                      <View style={styles.sheetPoster}>
                        <AwardPoster
                          uri={actionItem.item.posterUrl}
                          placeholderText={actionItem.item.title}
                          style={{ width: '100%', height: '100%' }}
                        />
                      </View>
                      <View style={styles.sheetInfo}>
                        <Text style={styles.sheetInfoText}>
                          当前状态：
                          {AWARD_STATUS_LABEL[matches[`${list.id}:${actionItem.index}`]?.status ?? 'MISSING']}
                        </Text>
                        {matches[`${list.id}:${actionItem.index}`]?.media && (
                          <Text style={styles.sheetInfoText}>
                            本地匹配：{matches[`${list.id}:${actionItem.index}`]?.media?.title}（
                            {matches[`${list.id}:${actionItem.index}`]?.media?.year}）
                          </Text>
                        )}
                        <Text style={styles.sheetInfoText}>在已启用的视频源里按片名搜索并入库。</Text>
                      </View>
                    </View>

                    {pending && pending.item.title === actionItem.item.title ? (
                      <View style={{ marginTop: 10 }}>
                        <Text style={[styles.sheetInfoText, { marginBottom: 4 }]}>
                          找到以下候选，请勾选要收录的片源：
                        </Text>
                        {pending.previews.map((p) => {
                          const checked = pendingSelected.has(p.previewId);
                          return (
                            <TouchableOpacity
                              key={p.previewId}
                              style={styles.previewRow}
                              onPress={() =>
                                setPendingSelected((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(p.previewId)) next.delete(p.previewId);
                                  else next.add(p.previewId);
                                  return next;
                                })
                              }
                            >
                              <View style={[styles.checkbox, checked && styles.checkboxOn]}>
                                {checked && <Check size={14} color={colors.buttonPrimaryText} />}
                              </View>
                              <View style={{ flex: 1 }}>
                                <Text style={styles.previewTitle}>
                                  {p.title}（{p.year}）
                                </Text>
                                <Text style={styles.previewMeta}>
                                  {p.sourceName} · {TYPE_LABEL[p.type] ?? p.type}
                                </Text>
                              </View>
                            </TouchableOpacity>
                          );
                        })}
                        <TouchableOpacity
                          style={[styles.sheetAction, styles.sheetActionPrimary]}
                          onPress={savePending}
                          disabled={savingPending}
                          activeOpacity={0.85}
                        >
                          {savingPending ? (
                            <ActivityIndicator size="small" color={colors.buttonPrimaryText} />
                          ) : (
                            <Check size={16} color={colors.buttonPrimaryText} />
                          )}
                          <Text style={[styles.sheetActionText, styles.sheetActionTextPrimary]}>
                            收录所选（{pendingSelected.size}）
                          </Text>
                        </TouchableOpacity>
                      </View>
                    ) : (
                      <>
                        <TouchableOpacity
                          style={[styles.sheetAction, styles.sheetActionPrimary]}
                          onPress={() => runCollect(actionItem.item, actionItem.index)}
                          disabled={collecting}
                          activeOpacity={0.85}
                        >
                          {collecting ? (
                            <ActivityIndicator size="small" color={colors.buttonPrimaryText} />
                          ) : (
                            <Search size={16} color={colors.buttonPrimaryText} />
                          )}
                          <Text style={[styles.sheetActionText, styles.sheetActionTextPrimary]}>
                            在全部视频源中搜索
                          </Text>
                        </TouchableOpacity>
                        {collecting && (
                          <Text style={[styles.progressText, { textAlign: 'center' }]}>
                            正在逐个搜索已启用的视频源，源多时可能需要约 1 分钟…
                          </Text>
                        )}
                        <TouchableOpacity
                          style={styles.sheetAction}
                          onPress={() => {
                            setActionItem(null);
                            navigation.navigate('Search', { keyword: actionItem.item.title });
                          }}
                          activeOpacity={0.85}
                        >
                          <Search size={16} color={colors.text} />
                          <Text style={styles.sheetActionText}>在本地库搜索</Text>
                        </TouchableOpacity>
                        {(() => {
                          const m = matches[`${list.id}:${actionItem.index}`]?.media;
                          return m?.hasSource ? (
                            <TouchableOpacity
                              style={styles.sheetAction}
                              onPress={() => playMatched(m.id)}
                              activeOpacity={0.85}
                            >
                              <Play size={16} color={colors.text} />
                              <Text style={styles.sheetActionText}>按当前匹配直接播放</Text>
                            </TouchableOpacity>
                          ) : null;
                        })()}
                      </>
                    )}
                  </>
                )}
              </ScrollView>
            </View>
          </View>
        </Modal>

        {/* 一键补齐进度 */}
        <Modal visible={batchOpen} transparent animationType="fade" onRequestClose={() => abortRef.current?.abort()}>
          <View style={styles.modalBackdrop}>
            <View style={styles.sheet}>
              <Text style={styles.sheetTitle}>一键补齐本榜单</Text>
              <TouchableOpacity
                style={styles.sheetClose}
                onPress={() => {
                  abortRef.current?.abort();
                  setBatchOpen(false);
                }}
              >
                <X size={20} color={colors.mutedForeground} />
              </TouchableOpacity>
              {batchProgress ? (
                <>
                  <Text style={styles.progressText}>
                    {batchProgress.current}/{batchProgress.total} · {batchProgress.title}
                  </Text>
                  <View style={styles.progressBar}>
                    <View
                      style={[
                        styles.progressFill,
                        {
                          width: `${Math.max(
                            2,
                            (batchProgress.current / Math.max(1, batchProgress.total)) * 100
                          )}%`,
                        },
                      ]}
                    />
                  </View>
                  <Text style={styles.progressText}>
                    新增 {batchProgress.saved} · 待确认 {batchProgress.pending} · 失败 {batchProgress.failed}
                  </Text>
                </>
              ) : (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16 }}>
                  <Loader2 size={16} color={colors.mutedForeground} />
                  <Text style={styles.progressText}>准备开始…</Text>
                </View>
              )}
              {batchResult && (
                <TouchableOpacity
                  style={[styles.sheetAction, styles.sheetActionPrimary]}
                  onPress={() => setBatchOpen(false)}
                  activeOpacity={0.85}
                >
                  <Text style={[styles.sheetActionText, styles.sheetActionTextPrimary]}>{batchResult}，完成</Text>
                </TouchableOpacity>
              )}
              {!batchResult && (
                <TouchableOpacity
                  style={styles.sheetAction}
                  onPress={() => abortRef.current?.abort()}
                  activeOpacity={0.85}
                >
                  <X size={16} color={colors.text} />
                  <Text style={styles.sheetActionText}>取消</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        </Modal>
      </View>
    </BlurredBackground>
  );
}
