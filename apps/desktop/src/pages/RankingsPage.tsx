import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AwardCatalog, AwardList } from '@openreel/core';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { AwardPoster } from '@/components/AwardPoster';
import { useToast } from '@/components/Layout';
import { Award, ChevronRight, RefreshCw, Trophy, Film, CalendarDays } from 'lucide-react';
import { getAwardService } from './rankings/useAwards';

interface AwardCardProps {
  award: AwardCatalog['awards'][number];
  lists: AwardList[];
  progress?: { local: number; total: number };
  onOpen: (listId: string) => void;
}

function AwardCard({ award, lists, progress, onOpen }: AwardCardProps) {
  const latest = lists[0];
  const previews = latest.items.slice(0, 4).filter((i) => i.posterUrl);
  return (
    <Card
      className="group p-4 flex flex-col gap-3 hover:shadow-card transition-shadow cursor-pointer"
      onClick={() => latest && onOpen(latest.id)}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Trophy className="size-4 text-amber-400 shrink-0" />
            <h3 className="font-semibold truncate">{award.name}</h3>
          </div>
          <div className="mt-1 text-xs text-muted-foreground flex items-center gap-2">
            {award.region && <span>{award.region}</span>}
            <span>·</span>
            <span>{lists.length} 个榜单</span>
          </div>
        </div>
        <Badge variant="secondary" className="shrink-0 text-[10px]">
          {award.kind === 'FESTIVAL' ? '电影节' : award.kind === 'TV' ? '电视' : award.kind === 'ANNUAL' ? '年度' : '电影'}
        </Badge>
      </div>

      <div className="flex gap-2 text-left">
        <div className="flex -space-x-3">
          {previews.length === 0 ? (
            <div className="size-16 rounded-md bg-[var(--color-secondary-alpha)] flex items-center justify-center text-muted-foreground">
              <Film className="size-5" />
            </div>
          ) : (
            previews.map((item, idx) => (
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
          <div className="text-sm truncate">{latest.title}</div>
          <div className="mt-1 text-xs text-muted-foreground flex items-center gap-2">
            <CalendarDays className="size-3" />
            {latest.year ?? '历届'}
            <span>·</span>
            {latest.items.length} 部
          </div>
          {progress && (
            <div className="mt-1 text-xs">
              <span className={progress.local > 0 ? 'text-emerald-400' : 'text-muted-foreground'}>
                本地可看 {progress.local}/{progress.total}
              </span>
            </div>
          )}
        </div>
        <ChevronRight className="size-4 text-muted-foreground self-center group-hover:translate-x-0.5 transition-transform" />
      </div>

      <div className="flex flex-wrap gap-1.5">
        {lists.slice(0, 5).map((list) => (
          <button
            key={list.id}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpen(list.id);
            }}
            className="text-[11px] px-2 py-1 rounded-full bg-[var(--color-secondary-alpha)] text-text-secondary hover:bg-[var(--color-hover-alpha)] hover:text-text transition-colors"
          >
            {list.edition ?? list.year ?? list.title}
          </button>
        ))}
      </div>
    </Card>
  );
}

export default function RankingsPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const service = useMemo(() => getAwardService(), []);
  const [catalog, setCatalog] = useState<AwardCatalog>(() => service.getBundledCatalog());
  const [year, setYear] = useState<number | 'all'>('all');
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

  const years = useMemo(() => {
    const set = new Set<number>();
    for (const list of catalog.lists) if (list.year) set.add(list.year);
    return [...set].sort((a, b) => b - a);
  }, [catalog]);

  const groups = useMemo(() => {
    const filtered = catalog.lists.filter((l) => year === 'all' || l.year === year);
    const groupOrder: AwardCatalog['awards'][number]['group'][] = ['AWARDS', 'CHINESE', 'TV', 'DOUBAN'];
    const labels: Record<string, string> = {
      AWARDS: '国际颁奖季',
      CHINESE: '华语奖项',
      TV: '剧集与电视',
      DOUBAN: '豆瓣年度榜单',
    };
    return groupOrder
      .map((group) => {
        const awards = catalog.awards
          .filter((a) => a.group === group)
          .map((award) => ({
            award,
            lists: filtered
              .filter((l) => l.awardId === award.id)
              .sort((a, b) => (b.year ?? 0) - (a.year ?? 0)),
          }))
          .filter((x) => x.lists.length > 0);
        return { group, label: labels[group], awards };
      })
      .filter((g) => g.awards.length > 0);
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
          setProgress((prev) => ({
            ...prev,
            [list.id]: { local, total: list.items.length },
          }));
        } catch {
          // 单条榜单统计失败不影响页面
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [groups, service]);

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

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Award className="size-6 text-amber-400" />
            年度榜单
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            豆瓣年度榜单、奥斯卡、金球、电影节与华语电视奖项，直接看本地能不能播，缺的可以一键找源。
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={handleCheckUpdate} disabled={checking}>
          <RefreshCw className={`size-4 mr-2 ${checking ? 'animate-spin' : ''}`} />
          {checking ? '检查中…' : '检查更新'}
        </Button>
      </div>

      <Card className="p-3 flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground mr-1">年份</span>
        <button
          type="button"
          onClick={() => setYear('all')}
          className={`text-xs px-3 py-1.5 rounded-full transition-colors ${
            year === 'all'
              ? 'bg-[var(--color-muted-alpha)] text-text'
              : 'bg-[var(--color-secondary-alpha)] text-text-secondary hover:text-text'
          }`}
        >
          全部
        </button>
        {years.map((y) => (
          <button
            key={y}
            type="button"
            onClick={() => setYear(y)}
            className={`text-xs px-3 py-1.5 rounded-full transition-colors ${
              year === y
                ? 'bg-[var(--color-muted-alpha)] text-text'
                : 'bg-[var(--color-secondary-alpha)] text-text-secondary hover:text-text'
            }`}
          >
            {y}
          </button>
        ))}
        <span className="ml-auto text-[11px] text-muted-foreground">数据版本 {catalog.version}</span>
      </Card>

      {groups.map((group) => (
        <section key={group.group} className="space-y-3">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">{group.label}</h2>
            <span className="text-xs text-muted-foreground">{group.awards.length} 个奖项</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {group.awards.map(({ award, lists }) => (
              <AwardCard
                key={award.id}
                award={award}
                lists={lists}
                progress={progress[lists[0]?.id]}
                onOpen={(listId) => navigate(`/rankings/${encodeURIComponent(listId)}`)}
              />
            ))}
          </div>
        </section>
      ))}

      <p className="text-[11px] text-muted-foreground leading-relaxed">
        榜单与获奖名单来自豆瓣公开页面/片单快照，仅用于影片发现与本地库匹配；「本地可看」表示本地已登记视频源、点击后按需获取播放地址。
      </p>
    </div>
  );
}
