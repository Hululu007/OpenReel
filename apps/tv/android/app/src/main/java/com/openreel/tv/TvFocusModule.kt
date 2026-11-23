package com.openreel.tv

import android.view.View
import android.view.ViewGroup
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * 原生焦点补位（TV 端弹层初始焦点用）。
 *
 * 背景（2026-11-23 实机取证，酷开 Android 9 / RN 0.86 新架构）：
 * JS 侧 `view.focus()`（registry.focusNode）**返回成功但没有任何焦点事件**——
 * 弹层内 debug 面板实测 `focusNode()` 返回 ok，而 registry 的 focusedId 恒为空，
 * 遥控必须先按一次方向键才能进入弹层。方向键本身由系统 FocusFinder 正常工作，
 * 失效的只是「代码主动补焦点」。
 *
 * 这里用 RN 挂载视图时写入的 view id（= reactTag，见 ViewManager.addView 的
 * `view.setId(reactTag)`）在 decorView 中定位目标并直接 requestFocus()，
 * 绕开失效的 JS 侧 focus()。只做补焦点，不改动任何焦点策略。
 */
class TvFocusModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "TvFocus"

  @ReactMethod
  fun requestFocus(reactTag: Double, promise: Promise) {
    val tag = reactTag.toInt()
    reactContext.runOnUiQueueThread {
      try {
        val decor = reactContext.currentActivity?.window?.decorView as? ViewGroup
        val view = decor?.findViewById<View>(tag)
        if (view == null) {
          promise.resolve(false)
          return@runOnUiQueueThread
        }
        // 实测必须同时置 isFocusableInTouchMode：系统处于 touch mode 时，
        // 仅 isFocusable 的 view 调 requestFocus() 会返回 false（拿不到焦点）。
        view.isFocusable = true
        view.isFocusableInTouchMode = true
        val ok = view.requestFocus() || view.requestFocusFromTouch()
        promise.resolve(ok)
      } catch (e: Exception) {
        promise.resolve(false)
      }
    }
  }
}
