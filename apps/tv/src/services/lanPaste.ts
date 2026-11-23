import { NativeModules } from 'react-native';

/**
 * AI 导入「手机扫码粘贴」的局域网桥 JS 封装。
 * 原生实现：android/app/src/main/java/com/openreel/tvlauncher/LanPasteModule.kt
 *
 * 电视没有 AI 应用、系统 WebView 过旧，无法在电视上直接打开 AI 网页；
 * 故由 TV 起一个一次性 HTTP 服务，手机扫码打开页面，在手机上完成 AI 对话，
 * 再把回答 POST 回来，TV 轮询取到文本填入「AI 返回数据」。
 */

export interface LanPasteSession {
  /** 本机局域网 IPv4 */
  ip: string;
  port: number;
  /** 本次会话一次性口令，URL 已带在 query 里 */
  token: string;
  /** 手机可打开的完整地址 */
  url: string;
}

interface LanPasteNativeModule {
  start?: (html: string, timeoutMs: number) => Promise<LanPasteSession>;
  poll?: () => Promise<string | null>;
  stop?: () => Promise<boolean>;
}

const mod: LanPasteNativeModule | undefined = (NativeModules as any).LanPaste;

/** 原生模块缺失（例如还没重新编译安装 APK）时返回 false，调用方据此隐藏入口 */
export function isLanPasteSupported(): boolean {
  return typeof mod?.start === 'function';
}

export async function startLanPaste(html: string, timeoutMs = 15 * 60 * 1000): Promise<LanPasteSession> {
  if (!mod?.start) throw new Error('当前安装包不支持手机扫码（缺少 LanPaste 原生模块）');
  return mod.start(html, timeoutMs);
}

/** 取手机提交的文本；没有则返回 null */
export async function pollLanPaste(): Promise<string | null> {
  if (!mod?.poll) return null;
  return mod.poll();
}

export async function stopLanPaste(): Promise<void> {
  if (!mod?.stop) return;
  try {
    await mod.stop();
  } catch {
    // 关闭失败不影响页面（端口会在超时后由原生侧兜底关闭）
  }
}
