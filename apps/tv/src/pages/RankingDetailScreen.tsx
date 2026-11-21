import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { AwardCatalog, AwardItem, AwardItemMatch, AwardList } from '@openreel/core';
import { getEditionTitle, parseLiveRankingListId } from '@openreel/core';
import { useThemeColors, useScaledFontSize, radius, useThemeStore, hexToRgba } from '@openreel/expo-ui';

import { TVButton } from '../components/TVButton';
import { TVRow } from '../focus/TVRow';
import { TVGrid } from '../focus/TVGrid';
import { TVScrollContainer } from '../focus/TVScrollContainer';
import { focusRegistry } from '../focus/registry';
import { TV_GRID_CARD, TV_LAYOUT, tv } from '../theme/tokens';
import AwardPoster from '../components/AwardPoster';
import { useBackgroundImageStore } from '../stores/backgroundImageStore';
import type { RootStackParamList } from '../navigation/types';
import { AWARD_STATUS_LABEL, TYPE_LABEL, getAwardService, getLiveRankingService } from '../awards/useAwards';

type Nav = NativeStackNavigationProp<RootStackParamList>;
type Rt = RouteProp<RootStackParamList, 'RankingDetail'>;

/** TV 榜单详情：奖项内切换榜单 + 条目网格；条目点开进详情/搜索 */
export function RankingDetailScreen() {
  const nav = useNavigation<Nav>();
  const route = useRoute<Rt>();
  const colors = useThemeColors();
  const scale = useScaledFontSize();
  const cardOpacity = useThemeStore((s) => s.cardOpacity);
  const service = useMemo(() => getAwardService(), []);

  const [catalog, setCatalog] = useState<AwardCatalog>(() => service.getBundledCatalog());
  const [activeListId, setActiveListId] = useState(route.params?.listId ?? '');
  const [matches, setMatches] = useState<Record<string, AwardItemMatch>>({});
  const [loading, setLoading] = useState(true);
  const setBackgroundImage = useBackgroundImageStore((s) => s.setImageUrl);

  const liveService = useMemo(() => getLiveRankingService(), []);
  const liveId = useMemo(() => parseLiveRankingListId(activeListId), [activeListId]);
  const [liveList, setLiveList] = useState<AwardList | null>(null);
  const [liveLoading, setLiveLoading] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  const list = useMemo(
    () => catalog.lists.find((l) => l.id === activeListId) ?? (liveList?.id === activeListId ? liveList : undefined),
    [catalog, activeListId, liveList]
  );

  // 实时榜：每次进入页面都重新读取。
  useEffect(() => {
    if (!liveId) return;
    if (catalog.lists.some((l) => l.id === activeListId)) return;
    let cancelled = false;
    setLiveLoading(true);
    setLiveError(null);
    void liveService
      .loadList(activeListId)
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
  }, [activeListId, liveId, catalog, liveService]);
  const award = useMemo(
    () => catalog.awards.find((a) => a.id === list?.awardId),
    [catalog, list]
  );
  /** 同届多份名单 = 页内分栏；不同届 = 年份切换。 */
  const edition = useMemo(
    () => (list && catalog ? service.getEditionOfList(list.id) : undefined),
    [catalog, list, service]
  );
  const sectionLists = edition?.lists ?? [];
  const otherEditions = useMemo(() => {
    if (!edition) return [];
    return service.getAwardEditions(edition.award.id).filter((e) => e.id !== edition.id);
  }, [catalog, edition, service]);

  useEffect(() => {
    let cancelled = false;
    void service.loadCatalog().then((c) => {
      if (cancelled) return;
      setCatalog(c);
      const exists = c.lists.some((l) => l.id === activeListId);
      if (!exists && c.lists.length > 0) {
        const fallback = c.lists.find((l) => l.awardId === c.awards[0]?.id) ?? c.lists[0];
        setActiveListId(fallback.id);
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service]);

  const loadMatches = useCallback(async () => {
    if (!list) return;
    setLoading(true);
    try {
      const ms = await service.matchList(list);
      const next: Record<string, AwardItemMatch> = {};
      for (const m of ms) next[`${list.id}:${m.itemIndex}`] = m;
      setMatches(next);
    } finally {
      setLoading(false);
    }
  }, [list, service]);

  useEffect(() => {
    void loadMatches();
  }, [loadMatches]);

  useEffect(() => {
    const t = setTimeout(() => focusRegistry.requestInitialFocus('ranking-detail-back'), 120);
    return () => clearTimeout(t);
  }, []);

  useFocusEffectPlayableBackground(list, setBackgroundImage);

  const items = useMemo(() => {
    if (!list) return [];
    return list.items.map((item, index) => ({
      item,
      index,
      match: matches[`${list.id}:${index}`],
    }));
  }, [list, matches]);

  const stats = useMemo(() => {
    const values = Object.values(matches);
    return {
      playable: values.filter((m) => m.status === 'PLAYABLE').length,
      library: values.filter((m) => m.status === 'LIBRARY_ONLY').length,
      pending: values.filter((m) => m.status === 'PENDING').length,
      missing: list ? list.items.length - values.filter((m) => m.status !== 'MISSING').length : 0,
    };
  }, [matches, list]);

  const openItem = (row: { item: AwardItem; index: number; match?: AwardItemMatch }) => {
    if (row.match?.media && (row.match.status === 'PLAYABLE' || row.match.status === 'LIBRARY_ONLY')) {
      nav.navigate('Detail', {
        mediaId: row.match.media.id,
        title: row.match.media.title,
        from: 'home',
      });
      return;
    }
    nav.navigate('Search', { keyword: row.item.title });
  };

  if (!list) {
    return (
      <View style={styles.container}>
        <View style={[styles.topBar, { borderBottomColor: colors.border, paddingHorizontal: TV_LAYOUT.paddingX }]}>
          <TVButton id="ranking-detail-back" label="返回" onPress={() => nav.goBack()} />
          <Text style={[styles.topTitle, { color: colors.foreground, fontSize: scale(23) }]}>榜单</Text>
        </View>
        <Text style={{ color: colors.mutedForeground, textAlign: 'center', marginTop: tv(60), fontSize: scale(18) }}>
          {liveLoading
            ? '正在读取红果实时榜（TOP100）…'
            : liveError
              ? `读取失败：${liveError}`
              : '榜单不存在或数据已更新'}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={[styles.topBar, { borderBottomColor: colors.border, paddingHorizontal: TV_LAYOUT.paddingX }]}>
        <TVButton id="ranking-detail-back" label="返回" onPress={() => nav.goBack()} testID="tv-ranking-detail-back" />
        <View style={{ flex: 1 }}>
          <Text style={[styles.topTitle, { color: colors.foreground, fontSize: scale(22) }]} numberOfLines={1}>
            {edition ? getEditionTitle(edition) : list.title}
          </Text>
          <Text style={[styles.topHint, { color: colors.mutedForeground, fontSize: scale(13) }]} numberOfLines={1}>
            {list.kind === 'LIVE'
              ? `${list.items.length} 部 · ${list.updatedText || '红果日更'}`
              : `${award?.name ?? ''}${edition?.year != null ? ` · ${edition.year}` : ''} · ${list.items.length} 部${
                  edition && sectionLists.length > 1 ? `（共 ${edition.totalItems} 部）` : ''
                }`}
            {loading ? ' · 正在核对本地库…' : ''}
          </Text>
        </View>
        <Text style={[styles.stat, { color: colors.success, fontSize: scale(14) }]}>可播放 {stats.playable}</Text>
        <Text style={[styles.stat, { color: '#38bdf8', fontSize: scale(14) }]}>已入库 {stats.library}</Text>
        <Text style={[styles.stat, { color: colors.warning, fontSize: scale(14) }]}>待确认 {stats.pending}</Text>
        <Text style={[styles.stat, { color: colors.mutedForeground, fontSize: scale(14) }]}>未收录 {stats.missing}</Text>
      </View>

      <TVScrollContainer
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: TV_LAYOUT.paddingX, paddingTop: tv(12), paddingBottom: tv(40) }}
      >
        {sectionLists.length > 1 && (
          <View style={{ marginBottom: tv(12) }}>
            <TVRow
              rowId="ranking-list-tabs"
              data={sectionLists}
              keyExtractor={(l) => l.id}
              itemWidth={tv(210)}
              itemHeight={tv(52)}
              onItemPress={(l) => setActiveListId(l.id)}
              renderItem={(l) => (
                <View
                  style={[
                    styles.listChip,
                    {
                      backgroundColor:
                        l.id === activeListId
                          ? hexToRgba(colors.mutedForeground, 0.35)
                          : hexToRgba(colors.card, cardOpacity / 100),
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.listChipText,
                      {
                        color: l.id === activeListId ? colors.foreground : colors.textSecondary,
                        fontSize: scale(14),
                      },
                    ]}
                    numberOfLines={1}
                  >
                    {l.sectionLabel ?? l.title}（{l.items.length}）
                  </Text>
                </View>
              )}
            />
          </View>
        )}

        {otherEditions.length > 0 && (
          <View style={{ marginBottom: tv(14) }}>
            <Text style={{ color: colors.mutedForeground, fontSize: scale(13), marginBottom: tv(6) }}>
              其他年份
            </Text>
            <TVRow
              rowId="ranking-year-tabs"
              data={otherEditions}
              keyExtractor={(e) => e.id}
              itemWidth={tv(120)}
              itemHeight={tv(52)}
              onItemPress={(e) => setActiveListId(e.primary.id)}
              renderItem={(e) => (
                <View
                  style={[styles.listChip, { backgroundColor: hexToRgba(colors.card, cardOpacity / 100) }]}
                >
                  <Text style={[styles.listChipText, { color: colors.textSecondary, fontSize: scale(14) }]}>
                    {e.year != null ? e.year : '历届'}
                  </Text>
                </View>
              )}
            />
          </View>
        )}

        <TVGrid
          idPrefix="ranking-items"
          data={items}
          keyExtractor={(row) => `${list.id}:${row.index}`}
          columns={TV_GRID_CARD.columns}
          itemWidth={TV_GRID_CARD.width}
          gap={TV_GRID_CARD.gap}
          onItemPress={openItem}
          renderItem={(row: { item: AwardItem; index: number; match?: AwardItemMatch }) => {
            const status = row.match?.status ?? 'MISSING';
            const poster = row.match?.media?.posterUrl || row.item.posterUrl;
            const color =
              status === 'PLAYABLE'
                ? colors.success
                : status === 'LIBRARY_ONLY'
                  ? '#38bdf8'
                  : status === 'PENDING'
                    ? colors.warning
                    : colors.mutedForeground;
            return (
              <View
                style={[
                  styles.card,
                  { backgroundColor: hexToRgba(colors.card, cardOpacity / 100) },
                ]}
              >
                <View style={[styles.posterWrap, { height: TV_GRID_CARD.height * 0.76 }]}>
                  <AwardPoster
                    uri={poster}
                    placeholderText={row.item.title}
                    style={{ width: '100%', height: '100%' }}
                  />
                  {typeof row.item.rank === 'number' && (
                    <View style={styles.rankBadge}>
                      <Text style={[styles.rankText, { fontSize: scale(11) }]}>{row.item.rank}</Text>
                    </View>
                  )}
                  <View style={[styles.statusDot, { backgroundColor: color }]} />
                </View>
                <View style={{ paddingHorizontal: tv(6), paddingVertical: tv(5) }}>
                  <Text style={{ color: colors.foreground, fontSize: scale(13) }} numberOfLines={1}>
                    {row.item.title}
                  </Text>
                  <Text style={{ color, fontSize: scale(11), marginTop: tv(2) }} numberOfLines={1}>
                    {AWARD_STATUS_LABEL[status] ?? status} ·{' '}
                    {list.kind === 'LIVE'
                      ? row.item.note || '短剧'
                      : `${row.item.year} · ${TYPE_LABEL[row.item.type] ?? row.item.type}`}
                  </Text>
                </View>
              </View>
            );
          }}
        />
      </TVScrollContainer>
    </View>
  );
}

/** 抽出背景设置，避免主组件里堆 effect（背景仅用首条海报）。 */
function useFocusEffectPlayableBackground(
  list: AwardList | undefined,
  setBackgroundImage: (url: string | null) => void
) {
  useEffect(() => {
    const first = list?.items?.[0];
    setBackgroundImage(first?.posterUrl ?? null);
    return () => setBackgroundImage(null);
  }, [list, setBackgroundImage]);
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: tv(12),
    borderBottomWidth: 1,
    gap: tv(14),
  },
  topTitle: { fontWeight: '700' },
  topHint: { marginTop: tv(2) },
  stat: { marginLeft: tv(4) },
  listChip: {
    height: tv(46),
    paddingHorizontal: tv(14),
    borderRadius: radius.full,
    justifyContent: 'center',
  },
  listChipText: { fontWeight: '600' },
  card: { borderRadius: radius.md, overflow: 'hidden' },
  posterWrap: { width: '100%', backgroundColor: 'rgba(0,0,0,0.18)' },
  posterPlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  rankBadge: {
    position: 'absolute',
    top: tv(6),
    left: tv(6),
    minWidth: tv(22),
    height: tv(22),
    paddingHorizontal: tv(4),
    borderRadius: radius.sm,
    backgroundColor: 'rgba(0,0,0,0.62)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  rankText: { color: '#fff', fontWeight: '700' },
  statusDot: {
    position: 'absolute',
    right: tv(6),
    bottom: tv(6),
    width: tv(10),
    height: tv(10),
    borderRadius: tv(5),
  },
});

export default RankingDetailScreen;
