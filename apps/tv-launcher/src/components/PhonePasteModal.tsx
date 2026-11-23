import React, { useEffect } from 'react';
import { BackHandler, StyleSheet, Text, View } from 'react-native';
import { useScaledFontSize, useThemeColors } from '@openreel/expo-ui';

import { focusRegistry } from '../focus/registry';
import { TVButton } from './TVButton';
import { QRCodeView } from './QRCodeView';
import { tv } from '../theme/tokens';

interface Props {
  visible: boolean;
  /** 手机可打开的地址；null 表示正在启动局域网服务 */
  url: string | null;
  /** 启动失败原因（此时不显示二维码） */
  error?: string | null;
  /** 已收到手机提交的数据时的提示（一般为空，收到后本弹层会关闭） */
  status?: string;
  onClose: () => void;
  /** 服务启动失败时重试 */
  onRetry?: () => void;
}

/**
 * 「手机扫码粘贴」弹层（AI 导入第 2 步）。
 *
 * 交互：电视起局域网服务 → 展示二维码 → 手机扫码打开页面（提示词 + 粘贴框）→
 * 手机上用 AI App 对话后把回答发回 → 电视自动填入并关闭本弹层。
 *
 * 注意：这里刻意**不用 RN Modal**（独立 Dialog 窗口）。实测（2026-11-23，酷开
 * Android 9）Modal 窗口不是焦点窗口，弹层内的按钮拿不到初始焦点，遥控要先按一次
 * 方向键才能进入弹层；改成页面内 absolute 全屏覆盖层后与普通页面同一窗口，
 * 焦点补位直接生效。遮挡用半透明遮罩（规范允许），面板本身实色不透明。
 */
export function PhonePasteModal({ visible, url, error, status, onClose, onRetry }: Props) {
  const colors = useThemeColors();
  const scale = useScaledFontSize();

  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    focusRegistry.pushScope('phone-paste-');
    focusRegistry.requestInitialFocus('phone-paste-close');
    // 背景页仍持有焦点时焦点桥会放弃 pending，故这里按短间隔直接补焦点直到生效
    const startedAt = Date.now();
    const retry = setInterval(() => {
      const cur = focusRegistry.getFocusedId();
      if (cur && cur.startsWith('phone-paste-')) {
        clearInterval(retry);
        return;
      }
      if (Date.now() - startedAt > 3000) {
        clearInterval(retry);
        return;
      }
      focusRegistry.focusNodeNative('phone-paste-close');
    }, 200);
    return () => {
      sub.remove();
      clearInterval(retry);
      focusRegistry.popScope();
    };
  }, [visible, onClose]);

  if (!visible) return null;

  return (
    <View style={styles.overlay} pointerEvents="auto">
      <View style={[styles.panel, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.title, { color: colors.foreground, fontSize: scale(24) }]}>手机扫码粘贴</Text>

        <View style={styles.body}>
          <View style={styles.qrCol}>
            {url ? (
              <QRCodeView value={url} size={tv(200)} />
            ) : (
              <View style={[styles.qrPlaceholder, { borderColor: colors.border }]}>
                <Text style={{ color: colors.textSecondary, fontSize: scale(15), textAlign: 'center' }}>
                  {error ? '服务未启动' : '正在启动…'}
                </Text>
              </View>
            )}
          </View>

          <View style={styles.textCol}>
            <Text style={[styles.step, { color: colors.textSecondary, fontSize: scale(17), lineHeight: scale(25) }]}>
              1. 用手机相机扫码（或手机浏览器打开下方地址）
            </Text>
            <Text style={[styles.step, { color: colors.textSecondary, fontSize: scale(17), lineHeight: scale(25) }]}>
              2. 在手机页面点「复制提示词」，打开手机上的 DeepSeek / 豆包 / Kimi 提问
            </Text>
            <Text style={[styles.step, { color: colors.textSecondary, fontSize: scale(17), lineHeight: scale(25) }]}>
              3. 把 AI 回答粘贴回手机页面，点「发送到电视」
            </Text>

            {url ? (
              <Text style={[styles.url, { color: colors.mutedForeground, fontSize: scale(13) }]} numberOfLines={1}>
                {url}
              </Text>
            ) : null}

            <Text style={[styles.hint, { color: colors.mutedForeground, fontSize: scale(14), lineHeight: scale(21) }]}>
              手机与电视需要连在同一个 WiFi。{status || '收到数据后本窗口会自动关闭。'}
            </Text>

            {error ? (
              <Text style={[styles.error, { color: colors.error, fontSize: scale(15), lineHeight: scale(22) }]}>
                {error}
              </Text>
            ) : null}
          </View>
        </View>

        <View style={styles.actions}>
          {error && onRetry ? (
            <TVButton id="phone-paste-retry" label="重新生成" onPress={onRetry} testID="tv-phone-paste-retry" />
          ) : null}
          <TVButton
            id="phone-paste-close"
            label="关闭"
            variant="primary"
            onPress={onClose}
            testID="tv-phone-paste-close"
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.72)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: tv(40),
    paddingVertical: tv(24),
  },
  panel: {
    width: '100%',
    maxWidth: tv(820),
    borderWidth: 1,
    borderRadius: tv(14),
    padding: tv(22),
  },
  title: { fontWeight: '700', marginBottom: tv(14) },
  body: { flexDirection: 'row' },
  qrCol: { marginRight: tv(20) },
  qrPlaceholder: {
    width: tv(200),
    height: tv(200),
    borderWidth: 1,
    borderRadius: tv(8),
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: tv(10),
  },
  textCol: { flex: 1 },
  step: { marginBottom: tv(6) },
  url: { marginTop: tv(6), marginBottom: tv(4) },
  hint: { marginTop: tv(4) },
  error: { marginTop: tv(6) },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: tv(16) },
});
