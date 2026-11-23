import { NativeModules } from 'react-native';

/**
 * 手机 → 电视「整库替换」同步。
 * 原生实现：android/app/src/main/java/com/openreel/tvlauncher/LibrarySyncModule.kt
 *
 * 流程：电视起一次性 HTTP 服务并展示二维码 → 手机扫码分片上传数据库快照 →
 * 电视校验（大小/自检/结构版本/标记行）→ 用户确认 → 关库 + 原子替换 + 重启。
 * 不备份：任何校验失败都不会动电视旧库（详见方案文档）。
 */

export type LibrarySyncPhase =
  | 'idle'
  | 'serving'
  | 'uploading'
  | 'validating'
  | 'ready'
  | 'applying'
  | 'error';

export interface LibrarySyncSession {
  ip: string;
  port: number;
  /** 手机扫的二维码内容（openreel-sync://sync?...） */
  url: string;
  token: string;
  /** 电视端当前数据库结构版本（migrations MAX(version)） */
  schemaVersion: number;
  /** 当前电视数据库占用（含 WAL） */
  dbSize: number;
  /** 电视可用空间 */
  freeBytes: number;
}

export interface LibrarySyncSummary {
  schemaVersion: number;
  bytes: number;
  media: number;
  sources: number;
  favorites: number;
  history: number;
}

export interface LibrarySyncState {
  phase: LibrarySyncPhase;
  message: string;
  received: number;
  total: number;
  summary: LibrarySyncSummary | null;
}

interface LibrarySyncNativeModule {
  startServer?: (schemaVersion: number, timeoutMs: number) => Promise<LibrarySyncSession>;
  poll?: () => Promise<LibrarySyncState>;
  applyAndRestart?: () => Promise<boolean>;
  cancel?: () => Promise<boolean>;
}

const mod: LibrarySyncNativeModule | undefined = (NativeModules as any).LibrarySync;

/** 原生模块缺失（旧安装包）时返回 false，页面据此隐藏入口 */
export function isLibrarySyncSupported(): boolean {
  return typeof mod?.startServer === 'function';
}

export async function startLibrarySync(
  schemaVersion: number,
  timeoutMs = 15 * 60 * 1000,
): Promise<LibrarySyncSession> {
  if (!mod?.startServer) throw new Error('当前安装包不支持手机同步（缺少 LibrarySync 原生模块）');
  return mod.startServer(schemaVersion, timeoutMs);
}

export async function pollLibrarySync(): Promise<LibrarySyncState> {
  if (!mod?.poll) {
    return { phase: 'idle', message: '', received: 0, total: 0, summary: null };
  }
  return mod.poll();
}

/** 应用手机数据并重启（调用前必须先 provider.close()） */
export async function applyLibrarySyncAndRestart(): Promise<boolean> {
  if (!mod?.applyAndRestart) throw new Error('当前安装包不支持应用手机数据');
  return mod.applyAndRestart();
}

export async function cancelLibrarySync(): Promise<void> {
  if (!mod?.cancel) return;
  try {
    await mod.cancel();
  } catch {
    // 取消失败不影响页面；服务会在超时后由原生侧兜底关闭
  }
}
