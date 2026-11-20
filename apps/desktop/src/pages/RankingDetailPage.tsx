import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type {
  AwardCatalog,
  AwardCollectPending,
  AwardCollectProgress,
  AwardItem,
  AwardItemMatch,
} from '@openreel/core';
import { getProvider } from '../init';
import { openMediaPlay } from '../utils/openMediaPlay';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { AwardPoster } from '@/components/AwardPoster';
import { useToast } from '@/components/Layout';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  ArrowLeft,
  Award,
  Check,
  Download,
  ExternalLink,
  Loader2,
  Play,
  RefreshCw,
  Search,
  Star,
  Trophy,
  X,
} from 'lucide-react';
import { AWARD_STATUS_META, getAwardService } from './rankings/useAwards';

const TYPE_LABEL: Record<string, string> = {
  MOVIE: '电影',
  TV: '电视剧',
  VARIETY: '综艺',
  ANIME: '动漫',
  DOCUMENTARY: '纪录片',
};

export default function RankingDetailPage() {
  const { listId = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const service = useMemo(() => getAwardService(), []);
  const [searchParams, setSearchParams] = useSearchParams();
  const onlyLocal = searchParams.get('local') === '1';

  const [catalog, setCatalog] = useState<AwardCatalog>(() => service.getBundledCatalog());
  const [matches, setMatches] = useState<Record<string, AwardItemMatch>>({});
  const [loadingMatches, setLoadingMatches] = useState(true);
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
  const restoredScroll = useRef(false);

  const list = useMemo(
    () => catalog.lists.find((l) => l.id === listId),
    [catalog, listId]
  );
  const award = useMemo(
    () => catalog.awards.find((a) => a.id === list?.awardId),
    [catalog, list]
  );
  const siblingLists = useMemo(
    () =>
      catalog.lists
        .filter((l) => l.awardId === list?.awardId)
        .sort((a, b) => (b.year ?? 0) - (a.year ?? 0)),
    [catalog, list]
  );

  const refreshMatches = useCallback(async () => {
    if (!list) return;
    setLoadingMatches(true);
    try {
      service.invalidateMatches();
      const result = await service.matchList(list);
      const next: Record<string, AwardItemMatch> = {};
      for (const m of result) {
        next[`${list.id}:${m.itemIndex}`] = m;
      }
      setMatches(next);
    } finally {
      setLoadingMatches(false);
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
    // 只依赖 list id：切年份/榜单才重算，筛选不重算
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list?.id]);

  // 从播放页返回时恢复滚动位置（页面会重新挂载）
  useEffect(() => {
    if (!list || loadingMatches || restoredScroll.current) return;
    const main = document.getElementById('main-content');
    const raw = sessionStorage.getItem(`awardScroll:${list.id}`);
    const top = raw ? Number(raw) : 0;
    if (main) main.scrollTop = Number.isFinite(top) && top > 0 ? top : 0;
    restoredScroll.current = true;
  }, [list, loadingMatches]);

  useEffect(() => {
    if (!list) return;
    const main = document.getElementById('main-content');
    const onScroll = () => {
      if (main) sessionStorage.setItem(`awardScroll:${list.id}`, String(main.scrollTop));
    };
    main?.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      onScroll();
      main?.removeEventListener('scroll', onScroll);
    };
  }, [list]);

  useEffect(() => {
    restoredScroll.current = false;
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

  const toggleOnlyLocal = (checked: boolean) => {
    const next = new URLSearchParams(searchParams);
    if (checked) next.set('local', '1');
    else next.delete('local');
    setSearchParams(next, { replace: true });
  };

  const playMatched = async (mediaId: number) => {
    if (playingId) return;
    setPlayingId(mediaId);
    try {
      const media = await getProvider().getMediaById(mediaId);
      if (!media) {
        toast('本地记录已失效，请刷新匹配', 'error');
        return;
      }
      await openMediaPlay(navigate, media, {});
    } finally {
      setPlayingId(null);
    }
  };

  const runCollect = async (item: AwardItem, index: number) => {
    setCollecting(true);
    try {
      const outcome = await service.collectItem(item, index);
      if (outcome.saved > 0) {
        toast(`已收录 ${outcome.saved} 个片源，正在刷新匹配`, 'success');
        setActionItem(null);
        await refreshMatches();
      } else if (outcome.pending.length > 0) {
        const p = outcome.pending[0];
        setPending(p);
        setPendingSelected(new Set());
      } else {
        toast('未在已启用视频源中找到匹配，可换片名或到搜索页再试', 'error');
      }
    } catch (err: any) {
      toast(err?.message || '搜索片源失败', 'error');
    } finally {
      setCollecting(false);
    }
  };

  const savePending = async () => {
    if (!pending) return;
    const picked = pending.previews.filter((p) => pendingSelected.has(p.previewId));
    if (picked.length === 0) {
      toast('请至少选择一个片源', 'error');
      return;
    }
    setSavingPending(true);
    try {
      const saved = await service.savePendingPreviews(picked);
      if (saved > 0) {
        toast(`已收录 ${saved} 个片源`, 'success');
        setPending(null);
        setActionItem(null);
        await refreshMatches();
      } else {
        toast('保存失败，请重试', 'error');
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
    if (result.cancelled) {
      setBatchResult(
        `已取消：新增 ${result.saved} 部，待确认 ${result.pending.length}，失败 ${result.failed.length}`
      );
    } else {
      const summary = `完成：新增 ${result.saved} 部，待确认 ${result.pending.length}，失败 ${result.failed.length}${
        result.stoppedReason ? `；${result.stoppedReason}` : ''
      }`;
      const firstPending = result.pending[0];
      if (firstPending) {
        setPending(firstPending);
        setPendingSelected(new Set());
        setBatchOpen(false);
        setActionItem({ item: firstPending.item, index: firstPending.itemIndex });
        toast(summary, 'success');
      } else {
        setBatchResult(summary);
      }
    }
    abortRef.current = null;
    await refreshMatches();
  };

  if (!list) {
    return (
      <div className="p-6 max-w-7xl mx-auto">
        <Button variant="ghost" onClick={() => navigate('/rankings')}>
          <ArrowLeft className="size-4 mr-2" /> 返回榜单
        </Button>
        <Card className="mt-4 p-8 text-center text-muted-foreground">
          榜单不存在或数据已更新，请返回榜单首页重新进入。
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-5 max-w-7xl mx-auto">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Button variant="ghost" size="sm" onClick={() => navigate('/rankings')} className="mb-2 -ml-2">
            <ArrowLeft className="size-4 mr-2" /> 返回榜单
          </Button>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Award className="size-6 text-amber-400 shrink-0" />
            <span className="truncate">{list.title}</span>
          </h1>
          <div className="mt-1 text-sm text-muted-foreground flex flex-wrap items-center gap-2">
            <span>{award?.name}</span>
            <span>·</span>
            <span>{list.year ?? '历届'}</span>
            <span>·</span>
            <span>{list.items.length} 部</span>
            {list.kind === 'WINNERS' && (
              <Badge variant="secondary" className="text-[10px]">
                获奖名单
              </Badge>
            )}
            {list.sourceUrl && (
              <a
                href={list.sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 hover:text-text"
              >
                来源 <ExternalLink className="size-3" />
              </a>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void refreshMatches()} disabled={loadingMatches}>
            <RefreshCw className={`size-4 mr-2 ${loadingMatches ? 'animate-spin' : ''}`} />
            刷新匹配
          </Button>
          <Button
            size="sm"
            onClick={() => void startBatch()}
            disabled={collectTargets.length === 0 || collecting}
          >
            <Download className="size-4 mr-2" />
            一键补齐{collectTargets.length > 0 ? ` (${collectTargets.length})` : ''}
          </Button>
        </div>
      </div>

      {siblingLists.length > 1 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">切换榜单</span>
          {siblingLists.map((l) => (
            <button
              key={l.id}
              type="button"
              onClick={() => navigate(`/rankings/${encodeURIComponent(l.id)}`)}
              className={`text-xs px-3 py-1.5 rounded-full transition-colors ${
                l.id === list.id
                  ? 'bg-[var(--color-muted-alpha)] text-text'
                  : 'bg-[var(--color-secondary-alpha)] text-text-secondary hover:bg-[var(--color-hover-alpha)] hover:text-text'
              }`}
            >
              {l.edition ?? l.year ?? l.title}
            </button>
          ))}
        </div>
      )}

      <Card className="p-3 flex flex-wrap items-center gap-4 text-sm">
        <span className="text-emerald-400">可播放 {stats.playable}</span>
        <span className="text-sky-400">已入库 {stats.library}</span>
        <span className="text-amber-400">待确认 {stats.pending}</span>
        <span className="text-muted-foreground">未收录 {stats.missing}</span>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted-foreground">只看可播放</span>
          <Switch checked={onlyLocal} onCheckedChange={toggleOnlyLocal} />
        </div>
      </Card>

      {loadingMatches && (
        <div className="text-xs text-muted-foreground flex items-center gap-2">
          <Loader2 className="size-3.5 animate-spin" /> 正在核对本地库…
        </div>
      )}

      {visibleItems.length === 0 ? (
        <Card className="p-10 text-center text-muted-foreground">
          {onlyLocal ? '本榜单暂无可直接播放的影片，关掉「只看可播放」查看全部。' : '暂无条目。'}
        </Card>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-4">
          {visibleItems.map(({ item, index, match }) => {
            const status = match?.status ?? 'MISSING';
            const meta = AWARD_STATUS_META[status];
            const poster = match?.media?.posterUrl || item.posterUrl;
            const isPlayable = status === 'PLAYABLE' && match?.media;
            return (
              <Card
                key={`${list.id}:${index}`}
                className="group overflow-hidden p-0 gap-0 cursor-pointer hover:shadow-card transition-shadow"
                onClick={() => {
                  if (isPlayable && match.media) {
                    void playMatched(match.media.id);
                  } else {
                    setActionItem({ item, index });
                  }
                }}
              >
                <div className="aspect-[2/3] relative bg-[var(--color-secondary-alpha)] overflow-hidden">
                  <AwardPoster
                    src={poster}
                    alt={item.title}
                    className="size-full object-cover group-hover:scale-[1.03] transition-transform duration-300"
                  />
                  {typeof item.rank === 'number' && (
                    <span className="absolute top-1.5 left-1.5 min-w-6 h-6 px-1 rounded-md bg-black/60 backdrop-blur-sm text-white text-xs font-bold flex items-center justify-center">
                      {item.rank}
                    </span>
                  )}
                  {item.winner && (
                    <span className="absolute top-1.5 right-1.5 size-6 rounded-full bg-amber-400/90 text-black flex items-center justify-center">
                      <Trophy className="size-3.5" />
                    </span>
                  )}
                  {isPlayable ? (
                    <span className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
                      <span className="opacity-0 group-hover:opacity-100 transition-opacity size-10 rounded-full bg-white/90 text-black flex items-center justify-center">
                        {playingId === match?.media?.id ? (
                          <Loader2 className="size-5 animate-spin" />
                        ) : (
                          <Play className="size-5 fill-current" />
                        )}
                      </span>
                    </span>
                  ) : (
                    <span className="absolute inset-x-0 bottom-0 px-2 py-1 bg-gradient-to-t from-black/70 to-transparent text-[11px] text-white flex items-center justify-center gap-1">
                      点击找片
                    </span>
                  )}
                  <Badge
                    variant="outline"
                    className={`absolute bottom-1.5 left-1.5 text-[10px] px-1.5 py-0.5 border ${meta.className}`}
                  >
                    {meta.label}
                  </Badge>
                </div>
                <div className="px-2 py-2">
                  <div className="text-sm font-medium truncate" title={item.title}>
                    {item.title}
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground flex items-center gap-1.5">
                    <span>{item.year}</span>
                    <span>·</span>
                    <span>{TYPE_LABEL[item.type] ?? item.type}</span>
                    {item.rating != null && item.rating > 0 && (
                      <span className="ml-auto inline-flex items-center gap-0.5 text-amber-400">
                        <Star className="size-2.5 fill-current" />
                        {item.rating.toFixed(1)}
                      </span>
                    )}
                  </div>
                  {match?.media && match.status !== 'PLAYABLE' && (
                    <div className="mt-1 text-[10px] text-muted-foreground truncate">
                      本地：{match.media.title}（{match.media.year}）
                    </div>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* 单条找片 / 待确认 */}
      <Dialog open={!!actionItem} onOpenChange={(open) => !open && setActionItem(null)}>
        <DialogContent className="max-w-lg">
          {actionItem && (
            <>
              <DialogHeader>
                <DialogTitle className="pr-8">{actionItem.item.title}</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <div className="flex gap-4">
                  <div className="w-24 shrink-0 aspect-[2/3] rounded-md overflow-hidden bg-[var(--color-secondary-alpha)]">
                    <AwardPoster
                      src={actionItem.item.posterUrl}
                      alt={actionItem.item.title}
                      className="size-full object-cover"
                    />
                  </div>
                  <div className="text-sm space-y-1 min-w-0">
                    <div className="text-muted-foreground">
                      {actionItem.item.year} · {TYPE_LABEL[actionItem.item.type] ?? actionItem.item.type}
                      {actionItem.item.winner ? ' · 获奖' : ''}
                    </div>
                    {actionItem.item.rating != null && actionItem.item.rating > 0 && (
                      <div className="text-amber-400">豆瓣 {actionItem.item.rating.toFixed(1)}</div>
                    )}
                    {matches[`${list.id}:${actionItem.index}`]?.media && (
                      <div className="text-xs text-muted-foreground">
                        本地匹配：{matches[`${list.id}:${actionItem.index}`]?.media?.title}（
                        {matches[`${list.id}:${actionItem.index}`]?.media?.year}）
                      </div>
                    )}
                    <div className="text-xs text-muted-foreground">
                      {AWARD_STATUS_META[matches[`${list.id}:${actionItem.index}`]?.status ?? 'MISSING'].label}
                    </div>
                  </div>
                </div>

                {pending && pending.item.title === actionItem.item.title ? (
                  <div className="space-y-2">
                    <div className="text-sm font-medium">找到这些候选，请勾选要收录的片源：</div>
                    <div className="max-h-64 overflow-auto space-y-1">
                      {pending.previews.map((p) => {
                        const checked = pendingSelected.has(p.previewId);
                        return (
                          <button
                            key={p.previewId}
                            type="button"
                            onClick={() => {
                              setPendingSelected((prev) => {
                                const next = new Set(prev);
                                if (next.has(p.previewId)) next.delete(p.previewId);
                                else next.add(p.previewId);
                                return next;
                              });
                            }}
                            className={`w-full flex items-center gap-3 p-2 rounded-md text-left transition-colors ${
                              checked ? 'bg-[var(--color-hover-alpha)]' : 'hover:bg-[var(--color-hover-alpha)]'
                            }`}
                          >
                            <span
                              className={`size-5 rounded border flex items-center justify-center ${
                                checked
                                  ? 'bg-[var(--color-muted-alpha)] border-transparent'
                                  : 'border-white/20'
                              }`}
                            >
                              {checked && <Check className="size-3.5" />}
                            </span>
                            <div className="min-w-0">
                              <div className="text-sm truncate">
                                {p.title}（{p.year}）
                              </div>
                              <div className="text-[11px] text-muted-foreground">
                                {p.sourceName} · {TYPE_LABEL[p.type] ?? p.type}
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setPending(null)}>
                        取消
                      </Button>
                      <Button onClick={() => void savePending()} disabled={savingPending}>
                        {savingPending ? <Loader2 className="size-4 mr-2 animate-spin" /> : null}
                        收录所选（{pendingSelected.size}）
                      </Button>
                    </DialogFooter>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <Button
                      className="w-full"
                      onClick={() => void runCollect(actionItem.item, actionItem.index)}
                      disabled={collecting}
                    >
                      {collecting ? (
                        <Loader2 className="size-4 mr-2 animate-spin" />
                      ) : (
                        <Search className="size-4 mr-2" />
                      )}
                      在全部视频源中搜索
                    </Button>
                    {collecting && (
                      <p className="text-[11px] text-muted-foreground text-center">
                        正在逐个搜索已启用的视频源，源多时可能需要约 1 分钟…
                      </p>
                    )}
                    <Button
                      variant="outline"
                      className="w-full"
                      onClick={() => {
                        setActionItem(null);
                        navigate(`/search?q=${encodeURIComponent(actionItem.item.title)}`);
                      }}
                    >
                      <Search className="size-4 mr-2" /> 在本地库搜索
                    </Button>
                    {(() => {
                      const m = matches[`${list.id}:${actionItem.index}`]?.media;
                      return m?.hasSource ? (
                        <Button
                          variant="outline"
                          className="w-full"
                          onClick={() => void playMatched(m.id)}
                        >
                          <Play className="size-4 mr-2" /> 按当前匹配直接播放
                        </Button>
                      ) : null;
                    })()}
                  </div>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* 一键补齐进度 */}
      <Dialog
        open={batchOpen}
        onOpenChange={(open) => {
          if (!open && abortRef.current) abortRef.current.abort();
          if (!open) setBatchOpen(false);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>一键补齐本榜单</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {batchProgress ? (
              <>
                <div className="text-sm">
                  {batchProgress.current}/{batchProgress.total} · {batchProgress.title}
                </div>
                <div className="h-2 rounded-full bg-[var(--color-secondary-alpha)] overflow-hidden">
                  <div
                    className="h-full bg-[var(--color-button-primary-bg)] transition-all"
                    style={{
                      width: `${Math.max(2, (batchProgress.current / Math.max(1, batchProgress.total)) * 100)}%`,
                    }}
                  />
                </div>
                <div className="text-xs text-muted-foreground">
                  新增 {batchProgress.saved} · 待确认 {batchProgress.pending} · 失败 {batchProgress.failed}
                </div>
              </>
            ) : (
              <div className="text-sm text-muted-foreground flex items-center gap-2">
                <Loader2 className="size-4 animate-spin" /> 准备开始…
              </div>
            )}
            {batchResult && <div className="text-sm">{batchResult}</div>}
            <DialogFooter>
              {!batchResult ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    abortRef.current?.abort();
                  }}
                >
                  <X className="size-4 mr-2" /> 取消
                </Button>
              ) : (
                <Button onClick={() => setBatchOpen(false)}>完成</Button>
              )}
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
