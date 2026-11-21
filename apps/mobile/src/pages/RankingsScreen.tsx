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
import type { AwardCatalog, AwardEdition, AwardOverview } from '@openreel/core';
import { getEditionActionLabel, getEditionShortTitle } from '@openreel/core';
import { useThemeColors } from '../themes/useThemeColors';
import { useThemeStore } from '../themes/store';
import { useScaledFontSize } from '../themes/useScaledFontSize';
import { hexToRgba } from '../themes/colorUtils';
import { radius } from '../themes/radiusTokens';
import BlurredBackground from '../components/BlurredBackground';
import AwardPoster from '../components/AwardPoster';
import { ArrowLeft, ChevronRight, Film, History, RefreshCw, Trophy } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getAwardService } from '../awards/useAwards';

const KIND_LABEL: Record<string, string> = {
  FESTIVAL: '电影节',
  TV: '电视',
  ANNUAL: '年度',
  MOVIE: '电影',
};

export default function RankingsScreen() {
  const navigation = useNavigation<any>();
  const colors = useThemeColors();
  const cardOpacity = useThemeStore((s) => s.cardOpacity);
  const s = useScaledFontSize();
  const insets = useSafeAreaInsets();
  const service = useMemo(() => getAwardService(), []);

  const [catalog, setCatalog] = useState<AwardCatalog>(() => service.getBundledCatalog());
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

  const groups = useMemo(() => service.getAwardOverviews(), [catalog, service]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      for (const group of groups) {
        for (const { latest } of group.awards) {
          if (!latest || cancelled) continue;
          let local = 0;
          let total = 0;
          for (const list of latest.lists) {
            if (cancelled) return;
            total += list.items.length;
            try {
              const matches = await service.matchList(list, { refineMissing: false });
              local += matches.filter((m) => m.status === 'PLAYABLE').length;
            } catch {
              // 单份名单统计失败不影响其余
            }
          }
          if (!cancelled) setProgress((prev) => ({ ...prev, [latest.id]: { local, total } }));
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
        latestTitle: { fontSize: s(13), fontWeight: '600', color: colors.text },
        latestMeta: { fontSize: s(11), color: colors.mutedForeground, marginTop: 3 },
        progressText: { fontSize: s(11), marginTop: 3 },
        actionText: { fontSize: s(11), color: colors.textSecondary, marginTop: 5 },
        chevron: { marginLeft: 6 },
        moreRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 10 },
        moreLabel: { fontSize: s(11), color: colors.mutedForeground },
        moreChip: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 3,
          paddingHorizontal: 10,
          paddingVertical: 5,
          borderRadius: radius.full,
          backgroundColor: hexToRgba(colors.surface, cardOpacity / 100),
        },
        moreChipText: { fontSize: s(11), color: colors.textSecondary },
        footer: { fontSize: s(10), color: colors.mutedForeground, lineHeight: s(16), marginTop: 8 },
      }),
    [colors, cardOpacity, insets.top, s]
  );

  const openEdition = (edition: AwardEdition) => {
    navigation.navigate('RankingDetail', { listId: edition.primary.id });
  };

  const renderCard = (overview: AwardOverview) => {
    const { award, latest, otherEditions, allTime } = overview;
    if (!latest) return null;
    const p = progress[latest.id];
    const posters = latest.primary.items.slice(0, 3).filter((i) => i.posterUrl);
    const yearCount = (latest.year != null ? 1 : 0) + otherEditions.length;
    return (
      <TouchableOpacity
        key={award.id}
        style={styles.awardCard}
        activeOpacity={0.85}
        onPress={() => openEdition(latest)}
      >
        <View style={styles.awardTop}>
          <Trophy size={16} color={colors.warning} />
          <View style={{ flex: 1 }}>
            <Text style={styles.awardTitle}>{award.name}</Text>
            <Text style={styles.awardMeta}>
              {[award.region, yearCount > 0 ? `已收录 ${yearCount} 年` : '历届合集']
                .filter(Boolean)
                .join(' · ')}
            </Text>
          </View>
          <View style={styles.kindBadge}>
            <Text style={styles.kindText}>{KIND_LABEL[award.kind] ?? '电影'}</Text>
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
              {getEditionShortTitle(latest)}
            </Text>
            <Text style={styles.latestMeta}>
              {latest.year != null ? `共 ${latest.totalItems} 部` : `${latest.totalItems} 部`}
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
            <Text style={styles.actionText}>{getEditionActionLabel(latest)} →</Text>
          </View>
          <ChevronRight size={16} color={colors.mutedForeground} style={styles.chevron} />
        </View>

        {(otherEditions.length > 0 || allTime.length > 0) && (
          <View style={styles.moreRow}>
            {otherEditions.length > 0 && <Text style={styles.moreLabel}>往年</Text>}
            {otherEditions.map((edition) => (
              <TouchableOpacity
                key={edition.id}
                style={styles.moreChip}
                onPress={() => openEdition(edition)}
              >
                <Text style={styles.moreChipText}>{edition.year}</Text>
              </TouchableOpacity>
            ))}
            {allTime.map((edition) => (
              <TouchableOpacity
                key={edition.id}
                style={styles.moreChip}
                onPress={() => openEdition(edition)}
              >
                <History size={11} color={colors.textSecondary} />
                <Text style={styles.moreChipText}>{edition.primary.title}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
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
              豆瓣年度榜单、奥斯卡、金球、电影节与华语电视奖项，一年一个入口。先看本地能不能播，缺的可以一键找源。
            </Text>
          </View>

          {groups.map((group) => (
            <View key={group.groupKey} style={styles.section}>
              <View style={styles.sectionTitleRow}>
                <Text style={styles.sectionTitle}>{group.group}</Text>
                <Text style={styles.sectionCount}>{group.awards.length} 个奖项</Text>
              </View>
              {group.awards.map(renderCard)}
            </View>
          ))}

          <Text style={styles.footer}>
            榜单按「奖项 → 年份 → 名单」组织，「历届」合集单独列出；豆瓣一年内的多份片单在同一页分栏展示。
            榜单与获奖名单来自豆瓣公开页面/片单快照，仅用于影片发现与本地库匹配。数据版本 {catalog.version}
          </Text>
        </ScrollView>
      </View>
    </BlurredBackground>
  );
}
