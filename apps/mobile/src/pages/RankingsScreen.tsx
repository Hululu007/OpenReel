import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { AwardCatalog, AwardList } from '@openreel/core';
import { useThemeColors } from '../themes/useThemeColors';
import { useThemeStore } from '../themes/store';
import { useScaledFontSize } from '../themes/useScaledFontSize';
import { hexToRgba } from '../themes/colorUtils';
import { radius } from '../themes/radiusTokens';
import BlurredBackground from '../components/BlurredBackground';
import AwardPoster from '../components/AwardPoster';
import { ArrowLeft, ChevronRight, Film, RefreshCw, Trophy } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getAwardService } from '../awards/useAwards';

const GROUP_ORDER: AwardCatalog['awards'][number]['group'][] = ['AWARDS', 'CHINESE', 'TV', 'DOUBAN'];
const GROUP_LABEL: Record<string, string> = {
  AWARDS: '国际颁奖季',
  CHINESE: '华语奖项',
  TV: '剧集与电视',
  DOUBAN: '豆瓣年度榜单',
};

export default function RankingsScreen() {
  const navigation = useNavigation<any>();
  const colors = useThemeColors();
  const cardOpacity = useThemeStore((s) => s.cardOpacity);
  const s = useScaledFontSize();
  const insets = useSafeAreaInsets();
  const service = useMemo(() => getAwardService(), []);

  const [catalog, setCatalog] = useState<AwardCatalog>(() => service.getBundledCatalog());
  const [year, setYear] = useState<number | 'all'>('all');
  const [progress, setProgress] = useState<Record<string, { local: number; total: number }>>({});
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void service.loadCatalog().then((c) => {
      if (!cancelled) setCatalog(c);
    });
    void service.refreshRemoteCatalog().then((updated) => {
      if (updated && !cancelled) {
        void service.loadCatalog().then((c) => {
          if (!cancelled) setCatalog(c);
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [service]);

  const years = useMemo(() => {
    const set = new Set<number>();
    for (const l of catalog.lists) if (l.year) set.add(l.year);
    return [...set].sort((a, b) => b - a);
  }, [catalog]);

  const groups = useMemo(() => {
    const filtered = catalog.lists.filter((l) => year === 'all' || l.year === year);
    return GROUP_ORDER.map((group) => {
      const awards = catalog.awards
        .filter((a) => a.group === group)
        .map((award) => ({
          award,
          lists: filtered
            .filter((l) => l.awardId === award.id)
            .sort((a, b) => (b.year ?? 0) - (a.year ?? 0)),
        }))
        .filter((x) => x.lists.length > 0);
      return { group, awards };
    }).filter((g) => g.awards.length > 0);
  }, [catalog, year]);

  useEffect(() => {
    let cancelled = false;
    const latest = groups.flatMap((g) => g.awards.map(({ lists }) => lists[0])).filter(Boolean);
    if (latest.length === 0) return;
    void (async () => {
      for (const list of latest) {
        if (cancelled) return;
        try {
          const matches = await service.matchList(list, { refineMissing: false });
          if (cancelled) return;
          const local = matches.filter((m) => m.status === 'PLAYABLE').length;
          setProgress((prev) => ({ ...prev, [list.id]: { local, total: list.items.length } }));
        } catch {
          // 单个榜单统计失败不阻塞页面
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [groups, service]);

  const handleCheckUpdate = useCallback(async () => {
    setRefreshing(true);
    try {
      const updated = await service.refreshRemoteCatalog(true);
      if (updated) setCatalog(await service.loadCatalog());
    } finally {
      setRefreshing(false);
    }
  }, [service]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: { flex: 1 },
        header: {
          paddingTop: insets.top + 8,
          paddingHorizontal: 15,
          paddingBottom: 10,
          flexDirection: 'row',
          alignItems: 'center',
        },
        backBtn: { padding: 8, marginRight: 4 },
        headerTitle: { flex: 1, fontSize: s(20), fontWeight: '700', color: colors.text },
        refreshBtn: { padding: 8 },
        scroll: { flex: 1 },
        scrollContent: { paddingHorizontal: 15, paddingBottom: 40 },
        intro: {
          backgroundColor: hexToRgba(colors.card, cardOpacity / 100),
          borderRadius: radius.lg,
          padding: 14,
          marginBottom: 14,
        },
        introTitle: { fontSize: s(15), fontWeight: '600', color: colors.text },
        introDesc: { fontSize: s(12), color: colors.textSecondary, marginTop: 4, lineHeight: s(18) },
        yearRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
        yearChip: {
          paddingHorizontal: 12,
          paddingVertical: 6,
          borderRadius: radius.full,
          backgroundColor: hexToRgba(colors.surface, cardOpacity / 100),
        },
        yearChipActive: { backgroundColor: hexToRgba(colors.mutedForeground, 0.35) },
        yearText: { fontSize: s(12), color: colors.textSecondary },
        yearTextActive: { color: colors.text, fontWeight: '600' },
        section: { marginBottom: 18 },
        sectionTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
        sectionTitle: { fontSize: s(17), fontWeight: '700', color: colors.text },
        sectionCount: { fontSize: s(11), color: colors.mutedForeground },
        awardCard: {
          backgroundColor: hexToRgba(colors.card, cardOpacity / 100),
          borderRadius: radius.lg,
          padding: 14,
          marginBottom: 12,
        },
        awardTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
        awardTitle: { flex: 1, fontSize: s(16), fontWeight: '600', color: colors.text },
        awardMeta: { fontSize: s(11), color: colors.mutedForeground, marginTop: 3 },
        kindBadge: {
          paddingHorizontal: 8,
          paddingVertical: 3,
          borderRadius: radius.full,
          backgroundColor: hexToRgba(colors.surface, cardOpacity / 100),
        },
        kindText: { fontSize: s(10), color: colors.textSecondary },
        latestRow: { flexDirection: 'row', alignItems: 'center', marginTop: 12 },
        posterStack: { flexDirection: 'row', marginRight: 10 },
        poster: { width: 46, height: 66, borderRadius: radius.sm, overflow: 'hidden', backgroundColor: colors.surface },
        posterOverlap: { marginLeft: -12 },
        posterPlaceholder: { alignItems: 'center', justifyContent: 'center' },
        latestInfo: { flex: 1, minWidth: 0 },
        latestTitle: { fontSize: s(13), color: colors.text },
        latestMeta: { fontSize: s(11), color: colors.mutedForeground, marginTop: 3 },
        progressText: { fontSize: s(11), marginTop: 3 },
        chevron: { marginLeft: 6 },
        chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
        chip: {
          paddingHorizontal: 10,
          paddingVertical: 5,
          borderRadius: radius.full,
          backgroundColor: hexToRgba(colors.surface, cardOpacity / 100),
        },
        chipText: { fontSize: s(11), color: colors.textSecondary },
        footer: { fontSize: s(10), color: colors.mutedForeground, lineHeight: s(16), marginTop: 8 },
        loading: { paddingVertical: 30, alignItems: 'center' },
      }),
    [colors, cardOpacity, insets.top, s]
  );

  const openList = (list: AwardList) => {
    navigation.navigate('RankingDetail', { listId: list.id });
  };

  return (
    <BlurredBackground imageUrl={null}>
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()}>
            <ArrowLeft size={20} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>年度榜单</Text>
          <TouchableOpacity style={styles.refreshBtn} onPress={handleCheckUpdate} disabled={refreshing}>
            {refreshing ? (
              <ActivityIndicator size="small" color={colors.mutedForeground} />
            ) : (
              <RefreshCw size={18} color={colors.mutedForeground} />
            )}
          </TouchableOpacity>
        </View>

        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          <View style={styles.intro}>
            <Text style={styles.introTitle}>颁奖季 · 年度榜单</Text>
            <Text style={styles.introDesc}>
              豆瓣年度榜单、奥斯卡、金球、电影节与华语电视奖项。先看本地能不能播，缺的可以一键找源。
            </Text>
            <View style={styles.yearRow}>
              <TouchableOpacity
                style={[styles.yearChip, year === 'all' && styles.yearChipActive]}
                onPress={() => setYear('all')}
              >
                <Text style={[styles.yearText, year === 'all' && styles.yearTextActive]}>全部</Text>
              </TouchableOpacity>
              {years.map((y) => (
                <TouchableOpacity
                  key={y}
                  style={[styles.yearChip, year === y && styles.yearChipActive]}
                  onPress={() => setYear(y)}
                >
                  <Text style={[styles.yearText, year === y && styles.yearTextActive]}>{y}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          {groups.map((group) => (
            <View key={group.group} style={styles.section}>
              <View style={styles.sectionTitleRow}>
                <Text style={styles.sectionTitle}>{GROUP_LABEL[group.group]}</Text>
                <Text style={styles.sectionCount}>{group.awards.length} 个奖项</Text>
              </View>
              {group.awards.map(({ award, lists }) => {
                const latest = lists[0];
                const p = progress[latest.id];
                const posters = latest.items.slice(0, 3).filter((i) => i.posterUrl);
                return (
                  <TouchableOpacity
                    key={award.id}
                    style={styles.awardCard}
                    activeOpacity={0.85}
                    onPress={() => openList(latest)}
                  >
                    <View style={styles.awardTop}>
                      <Trophy size={16} color={colors.warning} />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.awardTitle}>{award.name}</Text>
                        <Text style={styles.awardMeta}>
                          {[award.region, `${lists.length} 个榜单`].filter(Boolean).join(' · ')}
                        </Text>
                      </View>
                      <View style={styles.kindBadge}>
                        <Text style={styles.kindText}>
                          {award.kind === 'FESTIVAL'
                            ? '电影节'
                            : award.kind === 'TV'
                              ? '电视'
                              : award.kind === 'ANNUAL'
                                ? '年度'
                                : '电影'}
                        </Text>
                      </View>
                    </View>

                    <View style={styles.latestRow}>
                      <View style={styles.posterStack}>
                        {posters.length === 0 ? (
                          <View style={[styles.poster, styles.posterPlaceholder]}>
                            <Film size={16} color={colors.mutedForeground} />
                          </View>
                        ) : (
                          posters.map((it, idx) => (
                            <View
                              key={`${it.title}-${idx}`}
                              style={[styles.poster, idx > 0 && styles.posterOverlap, { zIndex: 10 - idx }]}
                            >
                              <AwardPoster uri={it.posterUrl} placeholderText={it.title} style={styles.poster} />
                            </View>
                          ))
                        )}
                      </View>
                      <View style={styles.latestInfo}>
                        <Text style={styles.latestTitle} numberOfLines={1}>
                          {latest.title}
                        </Text>
                        <Text style={styles.latestMeta}>
                          {latest.year ?? '历届'} · {latest.items.length} 部
                        </Text>
                        {p && (
                          <Text
                            style={[
                              styles.progressText,
                              { color: p.local > 0 ? colors.success : colors.mutedForeground },
                            ]}
                          >
                            本地可看 {p.local}/{p.total}
                          </Text>
                        )}
                      </View>
                      <ChevronRight size={16} color={colors.mutedForeground} style={styles.chevron} />
                    </View>

                    <View style={styles.chipRow}>
                      {lists.slice(0, 5).map((l) => (
                        <TouchableOpacity key={l.id} style={styles.chip} onPress={() => openList(l)}>
                          <Text style={styles.chipText}>{l.edition ?? l.year ?? l.title}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
          ))}

          <Text style={styles.footer}>
            榜单与获奖名单来自豆瓣公开页面/片单快照，仅用于影片发现与本地库匹配；「本地可看」表示本地已登记视频源，点击后按需获取播放地址。数据版本 {catalog.version}
          </Text>
        </ScrollView>
      </View>
    </BlurredBackground>
  );
}
