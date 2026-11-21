import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AwardCatalog, AwardEdition, AwardOverview } from '@openreel/core';
import { getEditionActionLabel, getEditionShortTitle } from '@openreel/core';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { AwardPoster } from '@/components/AwardPoster';
import { useToast } from '@/components/Layout';
import { Award, ChevronRight, History, RefreshCw, Trophy, Film } from 'lucide-react';
import { getAwardService } from './rankings/useAwards';

interface AwardCardProps {
  overview: AwardOverview;
  progress: Record<string, { local: number; total: number }>;
  onOpen: (edition: AwardEdition) => void;
}

const KIND_LABEL: Record<string, string> = {
  FESTIVAL: '电影节',
  TV: '电视',
  ANNUAL: '年度',
  MOVIE: '电影',
};

/**
 * 奖项卡：一个奖项只出现一次。
 * 主入口是「最新一届」，往年与历届合集中作为次级入口，不再把每份片单平铺成 chip。
 */
function AwardCard({ overview, progress, onOpen }: AwardCardProps) {
  const { award, latest, otherEditions, allTime } = overview;
  if (!latest) return null;
  const p = progress[latest.id];
  const posters = latest.primary.items.slice(0, 4).filter((i) => i.posterUrl);
  const yearCount = (latest.year != null ? 1 : 0) + otherEditions.length;

  return (
    <Card
      className="group p-4 flex flex-col gap-3 hover:shadow-card transition-shadow cursor-pointer"
      onClick={() => onOpen(latest)}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Trophy className="size-4 text-amber-400 shrink-0" />
            <h3 className="font-semibold truncate">{award.name}</h3>
          </div>
          <div className="mt-1 text-xs text-muted-foreground flex items-center gap-1.5">
            {award.region && <span>{award.region}</span>}
            {award.region && <span>·</span>}
            <span>{yearCount > 0 ? `已收录 ${yearCount} 年` : '历届合集'}</span>
          </div>
        </div>
        <Badge variant="secondary" className="shrink-0 text-[10px]">
          {KIND_LABEL[award.kind] ?? '电影'}
        </Badge>
      </div>

      <div className="flex gap-2 text-left">
        <div className="flex -space-x-3">
          {posters.length === 0 ? (
            <div className="size-16 rounded-md bg-[var(--color-secondary-alpha)] flex items-center justify-center text-muted-foreground">
              <Film className="size-5" />
            </div>
          ) : (
            posters.map((item, idx) => (
              <div
                key={`${item.title}-${idx}`}
                className="size-16 rounded-md overflow-hidden border-2 border-[var(--color-background)] bg-[var(--color-secondary-alpha)]"
                style={{ zIndex: 10 - idx }}
              >
                <AwardPoster src={item.posterUrl} alt={item.title} className="size-full object-cover" />
              </div>
            ))
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium truncate">{getEditionShortTitle(latest)}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {latest.year != null ? `共 ${latest.totalItems} 部` : `${latest.totalItems} 部`}
            {p ? ` · 本地可看 ${p.local}/${p.total}` : ''}
          </div>
          <div className="mt-1.5 text-[11px] text-muted-foreground group-hover:text-text transition-colors">
            {getEditionActionLabel(latest)} →
          </div>
        </div>
        <ChevronRight className="size-4 text-muted-foreground self-center group-hover:translate-x-0.5 transition-transform" />
      </div>

      {(otherEditions.length > 0 || allTime.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {otherEditions.length > 0 && (
            <>
              <span className="text-[11px] text-muted-foreground">往年</span>
              {otherEditions.map((edition) => (
                <button
                  key={edition.id}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpen(edition);
                  }}
                  className="text-[11px] px-2 py-1 rounded-full bg-[var(--color-secondary-alpha)] text-text-secondary hover:bg-[var(--color-hover-alpha)] hover:text-text transition-colors"
                >
                  {edition.year}
                </button>
              ))}
            </>
          )}
          {allTime.map((edition) => (
            <button
              key={edition.id}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpen(edition);
              }}
              className="text-[11px] px-2 py-1 rounded-full bg-[var(--color-secondary-alpha)] text-text-secondary hover:bg-[var(--color-hover-alpha)] hover:text-text transition-colors inline-flex items-center gap-1"
            >
              <History className="size-3" />
              {edition.primary.title}
            </button>
          ))}
        </div>
      )}
    </Card>
  );
}

export default function RankingsPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const service = useMemo(() => getAwardService(), []);
  const [catalog, setCatalog] = useState<AwardCatalog>(() => service.getBundledCatalog());
  const [progress, setProgress] = useState<Record<string, { local: number; total: number }>>({});
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const loaded = await service.loadCatalog();
      if (!cancelled) setCatalog(loaded);
      void service.refreshRemoteCatalog().then((updated) => {
        if (updated && !cancelled) {
          void service.loadCatalog().then((c) => {
            if (!cancelled) setCatalog(c);
          });
        }
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [service]);

  useEffect(() => {
    const main = document.getElementById('main-content');
    if (main) main.scrollTop = 0;
  }, []);

  const overviews = useMemo(() => service.getAwardOverviews(), [catalog, service]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      for (const group of overviews) {
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
  }, [overviews, service]);

  const handleCheckUpdate = async () => {
    setChecking(true);
    try {
      const updated = await service.refreshRemoteCatalog(true);
      if (updated) {
        setCatalog(await service.loadCatalog());
        toast('榜单数据已更新', 'success');
      } else {
        toast('已是最新榜单数据');
      }
    } finally {
      setChecking(false);
    }
  };

  const openEdition = (edition: AwardEdition) => {
    navigate(`/rankings/${encodeURIComponent(edition.primary.id)}`);
  };

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Award className="size-6 text-amber-400" />
            年度榜单
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            豆瓣年度榜单、奥斯卡、金球、电影节与华语电视奖项，一年一个入口；直接看本地能不能播，缺的可以一键找源。
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={handleCheckUpdate} disabled={checking}>
          <RefreshCw className={`size-4 mr-2 ${checking ? 'animate-spin' : ''}`} />
          {checking ? '检查中…' : '检查更新'}
        </Button>
      </div>

      {overviews.map((group) => (
        <section key={group.groupKey} className="space-y-3">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">{group.group}</h2>
            <span className="text-xs text-muted-foreground">{group.awards.length} 个奖项</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {group.awards.map((overview) => (
              <AwardCard
                key={overview.award.id}
                overview={overview}
                progress={progress}
                onOpen={openEdition}
              />
            ))}
          </div>
        </section>
      ))}

      <p className="text-[11px] text-muted-foreground leading-relaxed">
        榜单按「奖项 → 年份 → 名单」组织，每个奖项每年一个入口，「历届」合集单独列出；豆瓣一年内的多份片单在同一页分栏展示。
        榜单与获奖名单来自豆瓣公开页面/片单快照，仅用于影片发现与本地库匹配；「本地可看」表示本地已登记视频源、点击后按需获取播放地址。
        数据版本 {catalog.version}
      </p>
    </div>
  );
}
