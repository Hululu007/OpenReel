/**
 * 「手机中转」页面 HTML（TV 端 AI 导入用）。
 *
 * 背景：电视端没有 AI 应用、内嵌浏览器引擎过旧且无法升级（参考机 WebView 66），
 * 遥控器也无法舒适地操作 AI 网页与登录。故采用「电视出二维码 → 手机打开本页面 →
 * 手机上的 AI App 对话 → 把回答发回电视」的中转方式：AI 交互全部留在手机，
 * 电视只负责把提示词交出去、把回答收回来。
 *
 * 本函数只产出一段独立 HTML 字符串（无外部资源依赖），由 TV 端原生局域网服务
 * 直接返回给手机浏览器。`__TOKEN__` 由原生侧在响应时替换为本次会话的一次性口令，
 * 页面用它向 `/submit?t=__TOKEN__` 提交文本。提示词按 HTML 转义后作为文本节点展示，
 * 不参与任何脚本拼接，避免提示词里的特殊字符破坏页面。
 */

export interface PhoneBridgePageOptions {
  /** 展示给用户复制的提示词（通常是 AI_SOURCE_PROMPT） */
  prompt: string;
  /** 输入框上限（字符），默认 200000 */
  maxLength?: number;
  /** 页面顶部标题，默认「把 AI 的回答发到电视」 */
  title?: string;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildPhoneBridgePage(options: PhoneBridgePageOptions): string {
  const prompt = escapeHtml(options.prompt);
  const maxLength = Math.max(1000, Math.min(500000, options.maxLength ?? 200000));
  const title = escapeHtml(options.title ?? '把 AI 的回答发到电视');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#111111">
<title>${title}</title>
<style>
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  body{margin:0;padding:18px 16px 40px;background:#111;color:#f2f2f2;
    font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
    font-size:16px;line-height:1.55}
  h1{margin:4px 0 6px;font-size:20px;line-height:1.3}
  .sub{margin:0 0 16px;color:#9aa0a6;font-size:13px}
  .card{background:#1b1b1b;border:1px solid #2c2c2c;border-radius:12px;padding:14px;margin-bottom:14px}
  .row{display:flex;align-items:center;gap:8px;margin-bottom:10px;font-weight:600;font-size:15px}
  .num{flex:0 0 22px;height:22px;border-radius:50%;background:#3b82f6;color:#fff;
    font-size:13px;display:flex;align-items:center;justify-content:center;font-weight:700}
  pre{margin:0;max-height:34vh;overflow:auto;white-space:pre-wrap;word-break:break-word;
    background:#141414;border:1px solid #2a2a2a;border-radius:8px;padding:10px;
    color:#c8c8c8;font-size:13px;line-height:1.5;font-family:ui-monospace,Menlo,Consolas,monospace}
  textarea{width:100%;min-height:150px;resize:vertical;padding:10px;border-radius:8px;
    border:1px solid #2f2f2f;background:#141414;color:#f2f2f2;font-size:15px;line-height:1.5;
    font-family:ui-monospace,Menlo,Consolas,monospace}
  button{width:100%;border:0;border-radius:10px;padding:13px;font-size:16px;font-weight:600;
    color:#fff;background:#333;margin-top:10px}
  button.primary{background:#3b82f6}
  button.send{background:#22c55e;margin-top:2px;font-size:17px;padding:15px}
  button:disabled{opacity:.55}
  .links{display:flex;flex-wrap:wrap;gap:10px;margin-top:12px;font-size:13px;color:#9aa0a6;align-items:center}
  .links a{color:#60a5fa;text-decoration:none;border:1px solid #2f2f2f;border-radius:999px;
    padding:6px 12px;background:#161616}
  .status{min-height:22px;margin:12px 0 0;text-align:center;font-size:14px;color:#9aa0a6}
  .status.ok{color:#4ade80}
  .status.err{color:#f87171}
  .tip{margin:10px 0 0;font-size:12px;color:#7a7f85}
</style>
</head>
<body>
<h1>${title}</h1>
<p class="sub">手机要和电视连同一个 WiFi。AI 对话在手机上完成，回答从这里发回电视。</p>

<section class="card">
  <div class="row"><span class="num">1</span><span>复制提示词，发给手机上的 AI（DeepSeek / 豆包 / Kimi 等）</span></div>
  <pre id="prompt">${prompt}</pre>
  <button id="copy" class="primary" type="button">复制提示词</button>
  <div class="links">
    <span>手机没装 AI 应用？网页版：</span>
    <a href="https://chat.deepseek.com/" target="_blank" rel="noopener">DeepSeek</a>
    <a href="https://www.doubao.com/chat/" target="_blank" rel="noopener">豆包</a>
    <a href="https://kimi.com/" target="_blank" rel="noopener">Kimi</a>
    <a href="https://tongyi.aliyun.com/" target="_blank" rel="noopener">通义</a>
  </div>
</section>

<section class="card">
  <div class="row"><span class="num">2</span><span>把 AI 返回的内容粘贴到这里</span></div>
  <textarea id="text" maxlength="${maxLength}" placeholder="粘贴 AI 返回的 JSON 数据…" autocapitalize="off" autocorrect="off" spellcheck="false"></textarea>
  <button id="readClip" type="button">从剪贴板读取</button>
  <p class="tip">若读取剪贴板被浏览器拦截，请长按输入框选择「粘贴」。</p>
</section>

<button id="send" class="send" type="button">发送到电视</button>
<p id="status" class="status"></p>

<script>
(function () {
  var TOKEN = '__TOKEN__';
  var statusEl = document.getElementById('status');
  var textEl = document.getElementById('text');
  var sendEl = document.getElementById('send');
  var promptEl = document.getElementById('prompt');

  function setStatus(msg, kind) {
    statusEl.textContent = msg || '';
    statusEl.className = 'status' + (kind ? ' ' + kind : '');
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
    return Promise.resolve();
  }

  document.getElementById('copy').addEventListener('click', function () {
    copyText(promptEl.textContent || '')
      .then(function () { setStatus('提示词已复制，去 AI 应用里粘贴提问吧', 'ok'); })
      .catch(function () { setStatus('复制失败，请长按提示词手动选择复制', 'err'); });
  });

  document.getElementById('readClip').addEventListener('click', function () {
    if (!(navigator.clipboard && navigator.clipboard.readText)) {
      setStatus('当前浏览器不支持读取剪贴板，请长按输入框粘贴', 'err');
      return;
    }
    navigator.clipboard.readText()
      .then(function (t) {
        if (!t) { setStatus('剪贴板是空的', 'err'); return; }
        textEl.value = t;
        setStatus('已读取 ' + t.length + ' 个字符', 'ok');
      })
      .catch(function () { setStatus('读取剪贴板被拦截，请长按输入框粘贴', 'err'); });
  });

  sendEl.addEventListener('click', function () {
    var text = textEl.value || '';
    if (!text.trim()) {
      setStatus('请先把 AI 返回的内容粘贴进来', 'err');
      return;
    }
    sendEl.disabled = true;
    setStatus('正在发送到电视…');
    fetch('/submit?t=' + encodeURIComponent(TOKEN), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text })
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (data) {
      if (data && data.ok) {
        setStatus('已发送到电视，看电视屏幕即可（共 ' + text.length + ' 个字符）', 'ok');
      } else {
        setStatus('电视没有接受这条数据，请重试', 'err');
        sendEl.disabled = false;
      }
    }).catch(function (e) {
      setStatus('发送失败：' + (e && e.message ? e.message : '网络错误') + '，请确认手机和电视仍在同一个 WiFi', 'err');
      sendEl.disabled = false;
    });
  });
})();
</script>
</body>
</html>`;
}
