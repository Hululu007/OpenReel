import { useState, type ReactNode } from 'react';
import { Image, Text, View, type ImageStyle, type StyleProp } from 'react-native';
import { useThemeColors } from '../themes/useThemeColors';

interface PosterImageProps {
  uri?: string | null;
  style: StyleProp<ImageStyle>;
  placeholder?: ReactNode;
  /** 需要防盗链 Referer 的图床（如豆瓣）由调用方传入请求头。 */
  headers?: Record<string, string>;
}

export default function PosterImage({ uri, style, placeholder, headers }: PosterImageProps) {
  const colors = useThemeColors();
  const [failed, setFailed] = useState(false);

  if (!uri || failed) {
    const viewStyle = [style as any, { justifyContent: 'center', alignItems: 'center' }];
    if (placeholder) {
      return <View style={viewStyle}>{placeholder}</View>;
    }
    return (
      <View style={[...viewStyle, { backgroundColor: colors.surface }]}>
        <Text style={{ fontSize: 13, color: colors.mutedForeground }}>无封面</Text>
      </View>
    );
  }

  return <Image source={{ uri, headers }} style={style} onError={() => setFailed(true)} />;
}
