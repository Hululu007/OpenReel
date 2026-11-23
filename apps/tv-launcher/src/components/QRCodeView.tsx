import React, { useMemo } from 'react';
import { View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import qrcode from 'qrcode-generator';

interface Props {
  /** 二维码内容（手机中转页地址，含一次性 token） */
  value: string;
  /** 渲染边长（正方形，单位 px） */
  size?: number;
}

/**
 * 纯 JS 二维码（qrcode-generator 生成矩阵 + react-native-svg 绘制）。
 *
 * 不用原生二维码模块：项目只需要「把一段 URL 变成可扫的图」，纯 JS 依赖
 * 不需要 prebuild/重编，也不会在 Android TV 老机型上引入新的原生兼容风险。
 * 深色模块合并为一条 Path，避免上千个 Rect 节点影响性能。
 */
export function QRCodeView({ value, size = 260 }: Props) {
  const { path, count } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    const moduleCount = qr.getModuleCount();
    let d = '';
    for (let row = 0; row < moduleCount; row++) {
      for (let col = 0; col < moduleCount; col++) {
        if (qr.isDark(row, col)) d += `M${col} ${row}h1v1h-1z`;
      }
    }
    return { path: d, count: moduleCount };
  }, [value]);

  // 静区 4 个模块（扫码识别所需），用 viewBox 负数偏移实现
  const quiet = 4;
  const box = count + quiet * 2;

  return (
    <View style={{ width: size, height: size, backgroundColor: '#ffffff', borderRadius: 2 }}>
      <Svg width={size} height={size} viewBox={`${-quiet} ${-quiet} ${box} ${box}`}>
        <Rect x={-quiet} y={-quiet} width={box} height={box} fill="#ffffff" />
        <Path d={path} fill="#000000" />
      </Svg>
    </View>
  );
}

export default QRCodeView;
