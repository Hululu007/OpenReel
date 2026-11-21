import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { AwardCatalog } from '@openreel/core';
import { getEditionShortTitle } from '@openreel/core';
import { useThemeColors, useScaledFontSize, radius, useThemeStore, hexToRgba } from '@openreel/expo-ui';

import { TVFocusable } from '../focus/TVFocusable';
import { TVScrollContainer } from '../focus/TVScrollContainer';
import { TVButton } from '../components/TVButton';
import { focusRegistry } from '../focus/registry';
import { TV_LAYOUT, tv } from '../theme/tokens';
import { useBackgroundImageStore } from '../stores/backgroundImageStore';
import type { RootStackParamList } from '../navigation/types';
import { getAwardService } from '../awards/useAwards';

type Nav = NativeStackNavigationProp<RootStackParamList>;

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
