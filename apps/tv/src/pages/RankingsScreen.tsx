import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { AwardCatalog, LiveRankingBoardKey, LiveRankingSnapshot, LiveRankingTypeKey } from '@openreel/core';
import {
  getEditionShortTitle,
  LIVE_RANKING_BOARDS,
  LIVE_RANKING_TYPES,
  liveRankingListId,
} from '@openreel/core';
import { useThemeColors, useScaledFontSize, radius, useThemeStore, hexToRgba } from '@openreel/expo-ui';

import { TVFocusable } from '../focus/TVFocusable';
import { TVScrollContainer } from '../focus/TVScrollContainer';
import { TVButton } from '../components/TVButton';
import { focusRegistry } from '../focus/registry';
import { TV_LAYOUT, tv } from '../theme/tokens';
import { useBackgroundImageStore } from '../stores/backgroundImageStore';
import type { RootStackParamList } from '../navigation/types';
import { getAwardService, getLiveRankingService } from '../awards/useAwards';

type Nav = NativeStackNavigationProp<RootStackParamList>;


/**
 * 红果短剧实时榜：每次进入榜单页都重新读取，缓存只做读取失败兜底。
 * 首页只拉第 1 页做预览，完整 TOP100 在详情页读取。
 */
function LiveRankingSection({ onOpen }: { onOpen: (listId: string) => void }) {
  const colors = useThemeColors();
  const scale = useScaledFontSize();
  const cardOpacity = useThemeStore((s) => s.cardOpacity);
  const service = useMemo(() => getLiveRankingService(), []);
  const [board, setBoard] = useState<LiveRankingBoardKey>('hot');
  const [type, setType] = useState<LiveRankingTypeKey>('all');
  const [snapshot, setSnapshot] = useState<LiveRankingSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void service
      .loadPreview(board, type)
      .then((snap) => {
        if (!cancelled) setSnapshot(snap);
      })
      .catch((err: any) => {
        if (!cancelled) setError(err?.message ?? '读取失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [board, type, service]);

  const boardDef = LIVE_RANKING_BOARDS.find((b) => b.key === board);
  const chipStyle = {
    paddingHorizontal: tv(14),
    height: tv(46),
    borderRadius: radius.full,
    justifyContent: 'center' as const,
    backgroundColor: hexToRgba(colors.card, cardOpacity / 100),
  };

  return (
    <View style={{ marginBottom: tv(18) }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: tv(10), marginBottom: tv(10) }}>
        <Text style={[styles.groupTitle, { color: colors.foreground, fontSize: scale(19), marginBottom: 0 }]}>
          红果短剧 · 实时榜
        </Text>
        <Text style={{ color: colors.mutedForeground, fontSize: scale(13), flex: 1 }} numberOfLines={1}>
          {loading ? '正在读取…' : error ? `读取失败：${error}` : snapshot?.updatedText || '日更'}
        </Text>
      </View>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: tv(8), marginBottom: tv(10) }}>
        {LIVE_RANKING_BOARDS.map((b) => (
          <TVFocusable
            key={b.key}
            id={`live-board:${b.key}`}
            onPress={() => setBoard(b.key)}
            style={{
              ...chipStyle,
              backgroundColor:
                b.key === board
                  ? hexToRgba(colors.mutedForeground, 0.35)
                  : chipStyle.backgroundColor,
            }}
          >
            <Text
              style={{
                color: b.key === board ? colors.foreground : colors.textSecondary,
                fontSize: scale(14),
                fontWeight: '600',
              }}
            >
              {b.label}
            </Text>
          </TVFocusable>
        ))}
        {boardDef?.supportsType &&
          LIVE_RANKING_TYPES.map((t) => (
            <TVFocusable
              key={t.key}
              id={`live-type:${t.key}`}
              onPress={() => setType(t.key)}
              style={{
                ...chipStyle,
                backgroundColor:
                  t.key === type ? hexToRgba(colors.mutedForeground, 0.35) : chipStyle.backgroundColor,
              }}
            >
              <Text
                style={{
                  color: t.key === type ? colors.foreground : colors.textSecondary,
                  fontSize: scale(14),
                }}
              >
                {t.label}
              </Text>
            </TVFocusable>
          ))}
      </View>

      {snapshot && snapshot.items.length > 0 ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: tv(10) }}>
          {snapshot.items.slice(0, 10).map((item) => (
            <TVFocusable
              key={`${item.seriesId}-${item.rank}`}
              id={`live-item:${item.rank}`}
              onPress={() => onOpen(liveRankingListId(board, type))}
              style={{
                width: tv(320),
                borderRadius: radius.md,
                padding: tv(12),
                backgroundColor: hexToRgba(colors.card, cardOpacity / 100),
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: tv(8) }}>
                <Text
                  style={{
                    color: item.rank <= 3 ? '#fb7185' : colors.mutedForeground,
                    fontSize: scale(15),
                    fontWeight: '700',
                  }}
                >
                  {item.rank}
                </Text>
                <Text style={{ color: colors.foreground, fontSize: scale(14) }} numberOfLines={1}>
                  {item.title}
                </Text>
              </View>
              <Text style={{ color: colors.mutedForeground, fontSize: scale(12), marginTop: tv(4) }}>
                {item.heatText}
              </Text>
            </TVFocusable>
          ))}
          <TVFocusable
            id="live-open-top100"
            onPress={() => onOpen(liveRankingListId(board, type))}
            style={{
              width: tv(200),
              borderRadius: radius.md,
              padding: tv(12),
              justifyContent: 'center',
              backgroundColor: hexToRgba(colors.card, cardOpacity / 100),
            }}
          >
            <Text style={{ color: colors.textSecondary, fontSize: scale(14) }}>查看完整 TOP100 →</Text>
            <Text style={{ color: colors.mutedForeground, fontSize: scale(12), marginTop: tv(4) }}>
              {snapshot.fromCache ? '上次读取的数据' : '进入后重新读取'}
            </Text>
          </TVFocusable>
        </View>
      ) : (
        <Text style={{ color: colors.mutedForeground, fontSize: scale(14) }}>
          {loading ? '正在读取红果实时榜…' : '暂时没有读到榜单数据'}
        </Text>
      )}
    </View>
  );
}

/** TV 榜单首页：奖项分组 → 进入该奖项最新一届名单 */
export function RankingsScreen() {
  const nav = useNavigation<Nav>();
  const colors = useThemeColors();
  const scale = useScaledFontSize();
  const cardOpacity = useThemeStore((s) => s.cardOpacity);
  const service = useMemo(() => getAwardService(), []);
  const [catalog, setCatalog] = useState<AwardCatalog>(() => service.getBundledCatalog());
  const setBackgroundImage = useBackgroundImageStore((s) => s.setImageUrl);

  useEffect(() => {
    let cancelled = false;
    void service.loadCatalog().then((c) => {
      if (!cancelled) setCatalog(c);
    });
    return () => {
      cancelled = true;
    };
  }, [service]);

  useFocusEffect(
    useCallback(() => {
      setBackgroundImage(null);
      return () => setBackgroundImage(null);
    }, [setBackgroundImage])
  );

  useEffect(() => {
    const t = setTimeout(() => focusRegistry.requestInitialFocus('rankings-back'), 120);
    return () => clearTimeout(t);
  }, []);

  const groups = useMemo(() => service.getAwardOverviews(), [catalog, service]);

  return (
    <View style={styles.container}>
      <View style={[styles.topBar, { borderBottomColor: colors.border, paddingHorizontal: TV_LAYOUT.paddingX }]}>
        <TVButton id="rankings-back" label="返回" onPress={() => nav.goBack()} testID="tv-rankings-back" />
        <Text style={[styles.topTitle, { color: colors.foreground, fontSize: scale(23) }]}>年度榜单</Text>
        <Text style={[styles.topHint, { color: colors.mutedForeground, fontSize: scale(15) }]}>
          豆瓣年度 / 奥斯卡 / 电影节 / 华语电视奖项
        </Text>
      </View>

      <TVScrollContainer
        style={styles.scroll}
        contentContainerStyle={{ paddingHorizontal: TV_LAYOUT.paddingX, paddingTop: tv(14), paddingBottom: tv(40) }}
      >
        <LiveRankingSection onOpen={(listId) => nav.navigate('RankingDetail', { listId })} />

        {groups.map((group) => (
          <View key={group.groupKey} style={{ marginBottom: tv(18) }}>
            <Text style={[styles.groupTitle, { color: colors.foreground, fontSize: scale(19) }]}>
              {group.group}
            </Text>
            <View style={styles.awardGrid}>
              {group.awards.map(({ award, latest, otherEditions, allTime }) => {
                if (!latest) return null;
                const yearCount = (latest.year != null ? 1 : 0) + otherEditions.length;
                return (
                  <TVFocusable
                    key={award.id}
                    id={`ranking-award:${award.id}`}
                    onPress={() => nav.navigate('RankingDetail', { listId: latest.primary.id })}
                    style={[
                      styles.awardCard,
                      { backgroundColor: hexToRgba(colors.card, cardOpacity / 100) },
                    ]}
                  >
                    <View style={styles.awardTop}>
                      <Text style={[styles.awardName, { color: colors.foreground, fontSize: scale(18) }]} numberOfLines={1}>
                        {award.name}
                      </Text>
                      <Text style={[styles.awardTag, { color: colors.mutedForeground, fontSize: scale(13) }]}>
                        {award.kind === 'FESTIVAL' ? '电影节' : award.kind === 'TV' ? '电视' : award.kind === 'ANNUAL' ? '年度' : '电影'}
                      </Text>
                    </View>
                    <Text style={[styles.awardLatest, { color: colors.textSecondary, fontSize: scale(14) }]} numberOfLines={1}>
                      {getEditionShortTitle(latest)}
                    </Text>
                    <Text style={[styles.awardMeta, { color: colors.mutedForeground, fontSize: scale(12) }]}>
                      {award.region ? `${award.region} · ` : ''}
                      {yearCount > 0 ? `已收录 ${yearCount} 年 · ` : ''}
                      {latest.totalItems} 部
                      {allTime.length > 0 ? ' · 含历届合集' : ''}
                    </Text>
                  </TVFocusable>
                );
              })}
            </View>
          </View>
        ))}
      </TVScrollContainer>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: tv(14),
    borderBottomWidth: 1,
    gap: tv(16),
  },
  topTitle: { fontWeight: '700' },
  topHint: { marginLeft: 'auto' },
  scroll: { flex: 1 },
  groupTitle: { fontWeight: '700', marginBottom: tv(10) },
  awardGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: tv(14) },
  awardCard: {
    width: tv(255),
    borderRadius: radius.md,
    padding: tv(14),
  },
  awardTop: { flexDirection: 'row', alignItems: 'center', gap: tv(8) },
  awardName: { flex: 1, fontWeight: '600' },
  awardTag: {},
  awardLatest: { marginTop: tv(8) },
  awardMeta: { marginTop: tv(4) },
});

export default RankingsScreen;
