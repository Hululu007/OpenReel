/**
 * Expo config plugin：「手机同步到电视」需要访问电视的局域网 HTTP 服务。
 *
 * Android 9+ 默认禁止明文 HTTP（cleartext）。同步走的是 http://<电视IP>:<端口>，
 * 故给 <application> 打开 usesCleartextTraffic。
 *
 * 注意：这与项目既有策略一致（CMS 片源接口大量仍是 http://）。真正落地的
 * AndroidManifest.xml 已同步手工加上该属性，此插件用于 prebuild 时保持不丢。
 */
const { withAndroidManifest } = require('expo/config-plugins');

const withCleartextTraffic = (config) =>
  withAndroidManifest(config, (cfg) => {
    const application = cfg.modResults.manifest.application?.[0];
    if (application) {
      application.$ = application.$ || {};
      application.$['android:usesCleartextTraffic'] = 'true';
    }
    return cfg;
  });

module.exports = withCleartextTraffic;
