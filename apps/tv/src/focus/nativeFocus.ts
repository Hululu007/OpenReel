import { NativeModules } from 'react-native';

/**
 * 原生焦点补位（TV 端弹层初始焦点用）。
 * 原生实现：android/app/src/main/java/com/openreel/tvlauncher/TvFocusModule.kt
 *
 * 背景：RN 0.86 在本机（酷开 Android 9 / 新架构）上 JS 侧 `view.focus()` 返回成功但
 * 不产生任何焦点事件（registry 的 focusedId 恒为空），导致弹层打开后必须先按一次
 * 方向键才能进入。这里按 view id（= reactTag）走原生 requestFocus()。
 */
interface TvFocusNativeModule {
  requestFocus?: (reactTag: number) => Promise<boolean>;
}

const mod: TvFocusNativeModule | undefined = (NativeModules as any).TvFocus;

export function isNativeFocusSupported(): boolean {
  return typeof mod?.requestFocus === 'function';
}

/** 请求原生焦点；模块缺失时静默跳过（旧安装包） */
export function requestNativeFocus(reactTag: number): void {
  if (!mod?.requestFocus) return;
  try {
    void mod.requestFocus(reactTag);
  } catch {
    // 补焦点失败不影响页面，方向键仍可由原生 FocusFinder 正常导航
  }
}
