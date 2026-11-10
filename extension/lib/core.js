/*!
 * DSH 侧边栏扩展 · 共享纯函数核心（lib/core.js）
 * ---------------------------------------------------------------------------
 * 这个文件是「无副作用、无 chrome API、无 DOM 全局依赖」的纯函数库，被 4 种环境复用：
 *   1. content script —— manifest 里按经典脚本注入（`lib/core.js`, `content.js`），
 *      执行后挂到 `globalThis.DSHSidebarCore`；
 *   2. service worker  —— `importScripts('lib/core.js')`（经典脚本）；
 *   3. sidepanel / options —— `<script src="lib/core.js">` 之后再用 ES module 加载页面逻辑；
 *   4. `node --test`   —— `.js` 在 Node 里按 CJS 加载，走 `module.exports`；
 *      若宿主改成 ESM（package.json type=module），则退回读 `globalThis.DSHSidebarCore`。
 * 因此本文件里 **不能出现 import / export 语法**。
 *
 * 所有跟 DOM 相关的函数都接受「doc-like / element-like」对象（只要求
 * `nodeType / tagName / childNodes / getAttribute / querySelectorAll` 这几个能力），
 * 这样单元测试可以用极小的 stub 注入，不需要 jsdom。
 */

(function (global) {
  'use strict';

  // =========================================================================
  // 常量
  // =========================================================================

  /** 规格 §2 的硬上限（用户可下调，不可超过） */
  const LIMITS = Object.freeze({
    contentChars: 60000,        // 正文 ≤ 60000 字符
    transcriptItems: 5000,      // 字幕 ≤ 5000 条
    transcriptChars: 80000,     // 字幕总长 ≤ 80000 字符
    selectionChars: 20000,      // 选中文本单独截断
    titleChars: 500,
    descriptionChars: 2000,
    pageTextLines: 400,         // page-text 兜底最多取多少行
    pageTextChars: 12000,
  });

  /** bridge 默认地址（规格 §2：默认端口 41789） */
  const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:41789';

  /** 设置项默认值；选项页/background 都用 normalizeSettings 兜底 */
  const DEFAULT_SETTINGS = Object.freeze({
    bridgeUrl: DEFAULT_BRIDGE_URL,
    autoSync: true,
    throttleMs: 1500,                 // 自动同步 debounce
    maxContentChars: LIMITS.contentChars,
    maxTranscriptItems: LIMITS.transcriptItems,
    maxTranscriptChars: LIMITS.transcriptChars,
    requestTimeoutMs: 3000,           // bridge 请求超时（规格：3s）
  });

  /** 设置页可选的「档位」：默认档必须等于规格上限 */
  const SETTING_CHOICES = Object.freeze({
    maxContentChars: [30000, 60000, 120000],
    maxTranscriptItems: [2000, 5000, 10000],
    maxTranscriptChars: [40000, 80000, 160000],
    throttleMs: [1000, 1500, 3000, 5000],
    requestTimeoutMs: [3000],
  });

  /** 不是「正文」的块级标签：抽取时直接跳过（避免把导航/页脚当正文） */
  const SKIP_TAGS = Object.freeze([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED',
    'NAV', 'HEADER', 'FOOTER', 'ASIDE', 'FORM', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION',
    'BUTTON', 'DIALOG', 'VIDEO', 'AUDIO', 'MAP',
  ]);

  /** 跳过这些 role 的容器（隐形导航、脚注、cookie 条…） */
  const SKIP_ROLES = Object.freeze([
    'navigation', 'banner', 'contentinfo', 'complementary', 'search', 'menu', 'menubar',
    'toolbar', 'dialog', 'alertdialog',
  ]);

  /** 需要换行分隔的块级标签 */
  const BLOCK_TAGS = Object.freeze([
    'ADDRESS', 'ARTICLE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION',
    'FIGURE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'LI', 'MAIN', 'OL', 'P', 'PRE',
    'SECTION', 'TABLE', 'TR', 'TD', 'TH', 'UL', 'BR', 'SUMMARY', 'DETAILS',
  ]);

  /** 正文容器的候选选择器（按优先级） */
  const MAIN_SELECTORS = Object.freeze([
    'article',
    'main',
    '[role="main"]',
    '[itemprop="articleBody"]',
    '.article-content', '.article-body', '.post-content', '.post-body', '.entry-content',
    '#article', '.article', '#content', '.content', '#main', '.main',
  ]);

  /** chrome.* 等内部页面不能/不该注入 */
  const RESTRICTED_SCHEMES = Object.freeze([
    'chrome:', 'chrome-extension:', 'chrome-untrusted:', 'chrome-search:', 'devtools:',
    'edge:', 'about:', 'view-source:', 'brave:', 'moz-extension:', 'opera:',
  ]);

  /**
   * 扩展内部消息类型（content ↔ background ↔ sidepanel ↔ options）。
   * 集中在这里，避免各文件各写一份字符串拼错。
   */
  const MESSAGES = Object.freeze({
    CONTENT_READY: 'dsh:content-ready',        // content → SW：我已注入
    EXTRACT: 'dsh:extract',                    // SW → content：抽取当前页
    PAGE_CHANGED: 'dsh:page-changed',          // content → SW：SPA/内容变化
    YT_PROBE: 'dsh:yt-probe',                  // content → SW：读 page world 的 playerResponse
    BILI_PROBE: 'dsh:bili-probe',              // content → SW：读 page world 的 __INITIAL_STATE__
    BILI_SUBTITLES: 'dsh:bili-subtitles',      // content → SW：取 B 站 player/v2 + 字幕 JSON
    FETCH_TEXT: 'dsh:fetch-text',              // content → SW：跨域取 timedtext（仅 YouTube）
    SYNC_ACTIVE: 'dsh:sync-active',            // sidepanel → SW：读取当前页
    GET_STATE: 'dsh:get-state',                // sidepanel → SW：拿状态
    CHECK_HEALTH: 'dsh:check-health',          // sidepanel/options → SW：探测 bridge
    SETTINGS_UPDATED: 'dsh:settings-updated',  // sidepanel/options → SW：设置变更
    STATE_CHANGED: 'dsh:state-changed',        // SW → 扩展页面：状态广播
  });

  /** 站点名映射（host 后缀 → 展示名），取不到就用 hostname */
  const SITE_NAMES = Object.freeze({
    'youtube.com': 'YouTube',
    'youtu.be': 'YouTube',
    'bilibili.com': '哔哩哔哩',
    'zhihu.com': '知乎',
    'juejin.cn': '掘金',
    'github.com': 'GitHub',
    'developer.mozilla.org': 'MDN',
    'stackoverflow.com': 'Stack Overflow',
    'twitter.com': 'X',
    'x.com': 'X',
    'weibo.com': '微博',
    'reddit.com': 'Reddit',
    'medium.com': 'Medium',
    'notion.so': 'Notion',
    'wikipedia.org': 'Wikipedia',
    'arxiv.org': 'arXiv',
  });

  // =========================================================================
  // 通用小工具
  // =========================================================================

  function clampInt(value, min, max, fallback) {
    const n = typeof value === 'number' ? value : parseInt(value, 10);
    if (!Number.isFinite(n)) return fallback;
    const i = Math.trunc(n);
    if (i < min) return min;
    if (i > max) return max;
    return i;
  }

  /** 字符数按 UTF-16 code unit 计（与 String.length 一致，规格里的“字符”按此口径） */
  function countChars(input) {
    if (input === null || input === undefined) return 0;
    return String(input).length;
  }

  function uuid() {
    const c = global.crypto;
    if (c && typeof c.randomUUID === 'function') {
      try { return c.randomUUID(); } catch (_) { /* 某些非安全上下文会 throw */ }
    }
    const bytes = new Uint8Array(16);
    if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
    else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  /** FNV-1a 32 位哈希，返回 base36 字符串；用于「内容有没有变」的廉价签名 */
  function hashString(input) {
    const s = String(input === null || input === undefined ? '' : input);
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return `${h.toString(36)}${s.length.toString(36)}`;
  }

  // =========================================================================
  // 文本清洗 / 截断
  // =========================================================================

  /** 规范化空白：统一换行、去零宽字符、折叠空格、去掉空行堆叠 */
  function normalizeText(input) {
    if (input === null || input === undefined) return '';
    let s = String(input);
    s = s.replace(/\r\n?/g, '\n');
    s = s.replace(/\u00a0/g, ' ').replace(/[\u200b\u200c\u200d\ufeff]/g, '');
    s = s.replace(/[ \t\f\v]+/g, ' ');
    s = s.split('\n').map((line) => line.trim()).join('\n');
    s = s.replace(/\n{3,}/g, '\n\n');
    return s.trim();
  }

  /**
   * 按上限截断，尽量落在换行/句末，避免半句话。
   * @returns {{text:string, truncated:boolean, charCount:number, originalCharCount:number}}
   */
  function truncateText(input, maxChars) {
    const text = input === null || input === undefined ? '' : String(input);
    const max = clampInt(maxChars, 0, 10000000, LIMITS.contentChars);
    if (text.length <= max) {
      return { text, truncated: false, charCount: text.length, originalCharCount: text.length };
    }
    let cut = max;
    const windowStart = Math.max(0, Math.floor(max * 0.8));
    const tail = text.slice(windowStart, max);
    const candidates = [
      tail.lastIndexOf('\n'),
      tail.lastIndexOf('。'),
      tail.lastIndexOf('！'),
      tail.lastIndexOf('？'),
      tail.lastIndexOf('；'),
      tail.lastIndexOf('. '),
      tail.lastIndexOf('! '),
      tail.lastIndexOf('? '),
    ];
    const rel = Math.max.apply(null, candidates);
    if (rel > 0) cut = windowStart + rel + 1;
    const out = text.slice(0, cut).trim();
    return { text: out, truncated: true, charCount: out.length, originalCharCount: text.length };
  }

  /** 只保留有意义的行：去掉纯标点/纯数字行、重复行、常见导航词 */
  const NOISE_LINE_RE = /^(?:[\s\-–—•·|/\\.:;,+*#=_~"'`()\[\]{}<>0-9]+)$/;
  const NOISE_WORDS = new Set([
    '首页', '登录', '注册', '退出', '更多', '分享', '收藏', '评论', '点赞', '广告', '赞助',
    '上一页', '下一页', '返回顶部', '目录', '菜单', '搜索', '关注', '订阅', '免责声明',
    'home', 'login', 'log in', 'sign in', 'sign up', 'register', 'menu', 'search', 'share',
    'subscribe', 'advertisement', 'cookie', 'skip to content', 'back to top', 'next', 'prev',
    'previous', 'more', 'read more', 'comments', 'loading',
  ]);

  /**
   * 逐行清洗：丢弃噪音行、连续重复行、过短的无信息行。
   * @param {string} input
   * @param {{aggressive?: boolean}} [options] aggressive 用于「全页退化」抽取（噪音最多）
   */
  function stripNoiseLines(input, options) {
    const aggressive = !!(options && options.aggressive);
    const text = normalizeText(input);
    if (!text) return '';
    const seen = new Set();
    const out = [];
    let prev = null;
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line) {
        if (out.length && out[out.length - 1] !== '') out.push('');
        continue;
      }
      if (line === prev) continue;                       // 连续重复
      if (NOISE_LINE_RE.test(line)) continue;            // 纯符号/数字
      const wordKey = line.toLowerCase().replace(/[.!·、，,：:]+$/, '');
      if (NOISE_WORDS.has(wordKey)) continue;            // 常见导航词
      if (aggressive) {
        if (line.length <= 2) continue;                  // 一两个字的碎片
        if (seen.has(line)) continue;                    // 全页里重复出现的导航串
      }
      seen.add(line);
      prev = line;
      out.push(line);
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  /** 合并相邻重复行（不做词表过滤），用于正文容器内部 */
  function dedupeConsecutiveLines(input) {
    const text = normalizeText(input);
    if (!text) return '';
    const out = [];
    let prev = null;
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (line && line === prev) continue;
      prev = line;
      out.push(line);
    }
    return out.join('\n');
  }

  // =========================================================================
  // doc-like 对象的最小访问器（stub 友好）
  // =========================================================================

  function nodeTypeOf(node) {
    if (!node) return 0;
    if (typeof node.nodeType === 'number') return node.nodeType;
    if (typeof node.tagName === 'string') return 1;
    if (typeof node.nodeValue === 'string') return 3;
    return 0;
  }

  function tagNameOf(node) {
    return node && typeof node.tagName === 'string' ? node.tagName.toUpperCase() : '';
  }

  function getAttribute(node, name) {
    if (!node) return null;
    if (typeof node.getAttribute === 'function') {
      try {
        const v = node.getAttribute(name);
        if (v !== null && v !== undefined) return v;
      } catch (_) { /* ignore */ }
    }
    if (node.attributes && typeof node.attributes === 'object') {
      const direct = node.attributes[name];
      if (typeof direct === 'string') return direct;
      const arr = node.attributes;
      if (typeof arr.length === 'number') {
        for (let i = 0; i < arr.length; i += 1) {
          const a = arr[i];
          if (a && (a.name === name || a.nodeName === name)) return a.value;
        }
      }
    }
    const camel = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (Object.prototype.hasOwnProperty.call(node, camel) && typeof node[camel] === 'string') return node[camel];
    return null;
  }

  /** querySelectorAll 的安全封装：没有该 API 的对象返回 [] */
  function safeQueryAll(root, selector) {
    if (!root || typeof root.querySelectorAll !== 'function') return [];
    let list;
    try {
      list = root.querySelectorAll(selector);
    } catch (_) {
      return [];
    }
    if (!list) return [];
    if (Array.isArray(list)) return list.filter(Boolean);
    if (typeof list.length === 'number') {
      const out = [];
      for (let i = 0; i < list.length; i += 1) out.push(list[i]);
      return out.filter(Boolean);
    }
    return [];
  }

  function safeQuery(root, selector) {
    const all = safeQueryAll(root, selector);
    return all.length ? all[0] : null;
  }

  /** 元素的纯文本长度（用于选主容器；不排除隐藏节点，够用且便宜） */
  function rawTextLength(node) {
    if (!node) return 0;
    if (typeof node.textContent === 'string') return node.textContent.length;
    return 0;
  }

  // =========================================================================
  // DOM 正文抽取（纯函数，可注入 stub document）
  // =========================================================================

  function isSkippedElement(node, skipTags) {
    const tag = tagNameOf(node);
    if (tag && skipTags.has(tag)) return true;
    const role = (getAttribute(node, 'role') || '').toLowerCase();
    if (role && SKIP_ROLES.indexOf(role) >= 0) return true;
    if (node.hidden === true) return true;
    if ((getAttribute(node, 'aria-hidden') || '').toLowerCase() === 'true') return true;
    if ((getAttribute(node, 'type') || '').toLowerCase() === 'hidden') return true;
    const style = getAttribute(node, 'style');
    if (style && /display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)) return true;
    return false;
  }

  /**
   * 递归收集可见文本；跳过导航/页脚/表单控件/脚本，输入框内容一律不读。
   * @param {any} root doc-like 或 element-like
   * @param {{maxChars?:number, maxDepth?:number, skipTags?:string[]}} [options]
   */
  function collectVisibleText(root, options) {
    const opts = options || {};
    const maxChars = clampInt(opts.maxChars, 100, 10000000, 200000);
    const maxDepth = clampInt(opts.maxDepth, 4, 300, 80);
    const skipTags = new Set((opts.skipTags || SKIP_TAGS).map((t) => String(t).toUpperCase()));
    const blocks = new Set(BLOCK_TAGS);
    const chunks = [];
    let total = 0;

    function push(s) {
      if (!s) return;
      chunks.push(s);
      total += s.length;
    }

    function walk(node, depth) {
      if (!node || total > maxChars || depth > maxDepth) return;
      const nt = nodeTypeOf(node);
      if (nt === 3) {
        const value = typeof node.nodeValue === 'string' ? node.nodeValue : node.textContent;
        push(value || '');
        return;
      }
      if (nt !== 1) return;
      if (isSkippedElement(node, skipTags)) return;

      const tag = tagNameOf(node);
      const isBlock = !!tag && blocks.has(tag);
      if (isBlock) push('\n');

      const children = node.childNodes;
      if (children && typeof children.length === 'number') {
        for (let i = 0; i < children.length && total <= maxChars; i += 1) {
          walk(children[i], depth + 1);
        }
      } else if (typeof node.textContent === 'string' && children === undefined) {
        // 极简 stub：没有 childNodes 时退化成 textContent
        push(node.textContent);
      }

      if (isBlock) push('\n');
    }

    walk(root, 0);
    return normalizeText(chunks.join(''));
  }

  function looksLikeDocument(node) {
    return !!node && (typeof node.querySelectorAll === 'function' || !!node.body || !!node.documentElement);
  }

  /**
   * 抽取正文：优先 article/main/[role=main]/常见正文容器，退化到全页文本。
   * @returns {{text:string, charCount:number, truncated:boolean, source:'article'|'body'|'none', selector:string}}
   */
  function extractMainContent(doc, options) {
    const opts = options || {};
    const maxChars = clampInt(opts.maxChars, 1000, 10000000, LIMITS.contentChars);
    const minArticleChars = clampInt(opts.minArticleChars, 0, 100000, 240);
    const empty = { text: '', charCount: 0, truncated: false, source: 'none', selector: '' };
    if (!doc) return empty;

    let bestNode = null;
    let bestSelector = '';
    let bestLength = 0;
    for (const selector of MAIN_SELECTORS) {
      for (const node of safeQueryAll(doc, selector)) {
        const len = rawTextLength(node);
        if (len > bestLength) {
          bestLength = len;
          bestNode = node;
          bestSelector = selector;
        }
      }
      // 已经找到足够大的候选就不再扩大搜索（article 最可信）
      if (bestLength >= minArticleChars * 4) break;
    }

    if (bestNode && bestLength >= minArticleChars) {
      const collected = truncateText(
        dedupeConsecutiveLines(collectVisibleText(bestNode, { maxChars })),
        maxChars,
      );
      if (collected.charCount >= minArticleChars) {
        return {
          text: collected.text,
          charCount: collected.charCount,
          truncated: collected.truncated,
          source: 'article',
          selector: bestSelector,
        };
      }
    }

    const bodyRoot = doc.body || doc.documentElement || (looksLikeDocument(doc) ? doc : null);
    if (!bodyRoot) return empty;
    const bodyText = truncateText(
      stripNoiseLines(collectVisibleText(bodyRoot, { maxChars: maxChars * 2 }), { aggressive: true }),
      maxChars,
    );
    if (!bodyText.charCount) return empty;
    return {
      text: bodyText.text,
      charCount: bodyText.charCount,
      truncated: bodyText.truncated,
      source: 'body',
      selector: 'body',
    };
  }

  function extractTitle(doc) {
    const pick = (selector, attr) => {
      const node = safeQuery(doc, selector);
      if (!node) return '';
      const value = attr ? getAttribute(node, attr) : (typeof node.textContent === 'string' ? node.textContent : '');
      return normalizeText(value || '');
    };
    const candidates = [
      pick('meta[property="og:title"]', 'content'),
      pick('meta[name="twitter:title"]', 'content'),
      pick('title'),
      pick('h1'),
    ];
    for (const c of candidates) {
      if (c) return truncateText(c, LIMITS.titleChars).text;
    }
    const docTitle = doc && typeof doc.title === 'string' ? normalizeText(doc.title) : '';
    return truncateText(docTitle, LIMITS.titleChars).text;
  }

  function metaContent(doc, selector, attr) {
    const node = safeQuery(doc, selector);
    if (!node) return '';
    const v = getAttribute(node, attr || 'content');
    return normalizeText(v || '');
  }

  /** 绝对化 URL（og:image 常见相对路径） */
  function absolutizeUrl(url, baseUrl) {
    const raw = String(url || '').trim();
    if (!raw) return '';
    try {
      return new URL(raw, baseUrl || undefined).toString();
    } catch (_) {
      return raw;
    }
  }

  /** 读取页面元数据：description / ogImage / author / publishedAt / lang */
  function extractMeta(doc, pageUrl) {
    const description = truncateText(
      metaContent(doc, 'meta[name="description"]')
        || metaContent(doc, 'meta[property="og:description"]')
        || metaContent(doc, 'meta[name="twitter:description"]'),
      LIMITS.descriptionChars,
    ).text;
    const ogImage = absolutizeUrl(
      metaContent(doc, 'meta[property="og:image"]') || metaContent(doc, 'meta[name="twitter:image"]'),
      pageUrl,
    );
    const author = normalizeText(
      metaContent(doc, 'meta[name="author"]')
        || metaContent(doc, 'meta[property="article:author"]')
        || metaContent(doc, 'meta[name="twitter:creator"]')
        || (safeQuery(doc, '[rel="author"]') && normalizeText(safeQuery(doc, '[rel="author"]').textContent || '')),
    );
    const publishedAt = normalizeText(
      metaContent(doc, 'meta[property="article:published_time"]')
        || metaContent(doc, 'meta[name="pubdate"]')
        || metaContent(doc, 'meta[name="publish_date"]')
        || metaContent(doc, 'meta[name="date"]')
        || metaContent(doc, 'time[datetime]', 'datetime'),
    );
    const htmlEl = doc && doc.documentElement;
    let lang = normalizeText(
      (htmlEl && getAttribute(htmlEl, 'lang'))
        || metaContent(doc, 'meta[http-equiv="content-language"]'),
    );
    if (lang) lang = lang.split(/[-_,;]/)[0].toLowerCase().slice(0, 8);
    return { description, ogImage, author, publishedAt, lang };
  }

  /** 选中文本（只读 window.getSelection()，不触碰输入框 value） */
  function extractSelection(win, maxChars) {
    const limit = clampInt(maxChars, 0, 1000000, LIMITS.selectionChars);
    if (!win || typeof win.getSelection !== 'function') return '';
    let sel = null;
    try { sel = win.getSelection(); } catch (_) { return ''; }
    if (!sel) return '';
    let text = '';
    try { text = sel.toString() || ''; } catch (_) { return ''; }
    return truncateText(normalizeText(text), limit).text;
  }

  const VIDEO_TRACK_KINDS = /^(subtitles|captions|descriptions)$/i;

  /**
   * 读取 <video> 的 textTracks（若浏览器已加载字幕）。
   * 会尝试把 disabled 的轨道切到 hidden 以拿到 cues —— 这是 Chrome 的既有行为，
   * 失败则跳过（某些站点会禁止）。
   */
  function readVideoTracks(video) {
    const tracks = video && video.textTracks;
    if (!tracks || typeof tracks.length !== 'number') return [];
    const cues = [];
    for (let i = 0; i < tracks.length; i += 1) {
      const track = tracks[i];
      if (!track) continue;
      if (track.kind && !VIDEO_TRACK_KINDS.test(String(track.kind))) continue;
      try {
        if (track.mode === 'disabled') track.mode = 'hidden';
      } catch (_) { /* 某些实现只读 */ }
      const list = track.cues;
      if (!list || typeof list.length !== 'number') continue;
      for (let j = 0; j < list.length; j += 1) {
        const cue = list[j];
        if (!cue) continue;
        cues.push({
          start: Number(cue.startTime) || 0,
          end: Number(cue.endTime) || 0,
          text: String(cue.text || ''),
        });
      }
    }
    return normalizeCues(cues);
  }

  /** 页面上的视频元素（多个时挑「最长/正在播放」的那个） */
  function pickPrimaryVideo(doc) {
    const videos = safeQueryAll(doc, 'video');
    if (!videos.length) return null;
    let best = videos[0];
    let bestScore = -1;
    for (const v of videos) {
      const duration = Number(v && v.duration) || 0;
      const playing = v && v.paused === false ? 1 : 0;
      const score = playing * 100000 + duration;
      if (score > bestScore) {
        bestScore = score;
        best = v;
      }
    }
    return best;
  }

  function guessMediaTitle(doc, pageUrl) {
    const og = metaContent(doc, 'meta[property="og:title"]');
    if (og) return truncateText(og, LIMITS.titleChars).text;
    const h1 = safeQuery(doc, 'h1');
    const h1Text = h1 && normalizeText(h1.textContent || '');
    if (h1Text) return truncateText(h1Text, LIMITS.titleChars).text;
    return extractTitle(doc) || '';
  }

  /**
   * 通用（非 YouTube）视频信息。
   * @returns {{kind:'html5'|'none', title:string, author:string, durationSec:number,
   *   currentTimeSec:number, cues:Array, transcriptSource:'track'|'page-text'|'none'}}
   */
  function extractVideoInfo(doc, pageUrl) {
    const none = {
      kind: 'none', title: '', author: '', durationSec: 0, currentTimeSec: 0,
      cues: [], transcriptSource: 'none',
    };
    if (!doc) return none;
    const video = pickPrimaryVideo(doc);
    if (!video) return none;
    const cues = readVideoTracks(video);
    const duration = Number(video.duration);
    const current = Number(video.currentTime);
    const meta = extractMeta(doc, pageUrl);
    return {
      kind: 'html5',
      title: truncateText(getAttribute(video, 'title') || guessMediaTitle(doc, pageUrl), LIMITS.titleChars).text,
      author: meta.author,
      durationSec: Number.isFinite(duration) ? Math.max(0, Math.round(duration * 10) / 10) : 0,
      currentTimeSec: Number.isFinite(current) ? Math.max(0, Math.round(current * 10) / 10) : 0,
      cues,
      transcriptSource: cues.length ? 'track' : 'page-text',
    };
  }

  /**
   * 视频页文字兜底（没有字幕轨时）：标题 + 简介 + 首屏评论/描述片段。
   * @returns {{lines:string[], text:string, charCount:number, truncated:boolean}}
   */
  function collectPageTextLines(doc, options) {
    const opts = options || {};
    const maxLines = clampInt(opts.maxLines, 1, 5000, LIMITS.pageTextLines);
    const maxChars = clampInt(opts.maxChars, 100, 1000000, LIMITS.pageTextChars);
    const title = normalizeText(opts.title || guessMediaTitle(doc, opts.pageUrl));
    const description = extractMeta(doc, opts.pageUrl).description;

    const lines = [];
    const seen = new Set();
    const push = (raw) => {
      const line = normalizeText(raw);
      if (!line || line.length < 2 || seen.has(line)) return false;
      seen.add(line);
      lines.push(line);
      return true;
    };

    if (title) push(title);
    if (description) push(description);

    const selectors = [
      'article p', 'main p', '[id*="description"]', '[class*="description"]',
      '[class*="summary"]', '[id*="comment"] p', '[class*="comment"] p', 'p',
    ];
    for (const selector of selectors) {
      if (lines.length >= maxLines) break;
      for (const node of safeQueryAll(doc, selector)) {
        if (lines.length >= maxLines) break;
        const text = normalizeText(node.textContent || '');
        if (text.length < 8) continue;
        push(truncateText(text, 500).text);
      }
    }

    const joined = truncateText(stripNoiseLines(lines.join('\n'), { aggressive: false }), maxChars);
    return {
      lines: joined.text ? joined.text.split('\n') : [],
      text: joined.text,
      charCount: joined.charCount,
      truncated: joined.truncated,
    };
  }

  // =========================================================================
  // URL / 站点判断
  // =========================================================================

  function parseUrlSafe(url) {
    try {
      return new URL(String(url));
    } catch (_) {
      return null;
    }
  }

  /** chrome:// / chrome-extension:// / devtools:// 等不能注入，直接跳过 */
  function isRestrictedUrl(url) {
    const raw = String(url || '').trim();
    if (!raw) return true;
    const lower = raw.toLowerCase();
    for (const scheme of RESTRICTED_SCHEMES) {
      if (lower.startsWith(scheme)) return true;
    }
    // 非 http(s)/file 的一律跳过（data:, blob:, javascript: …）
    if (!/^(https?:|file:)/.test(lower)) return true;
    return false;
  }

  function siteNameFromUrl(url, metaSiteName) {
    const explicit = normalizeText(metaSiteName || '');
    if (explicit) return explicit;
    const parsed = parseUrlSafe(url);
    if (!parsed) return '';
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    for (const key of Object.keys(SITE_NAMES)) {
      if (host === key || host.endsWith(`.${key}`)) return SITE_NAMES[key];
    }
    return host;
  }

  const YT_HOSTS = [
    'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
    'youtu.be', 'www.youtu.be',
    'youtube-nocookie.com', 'www.youtube-nocookie.com',
  ];

  /**
   * 解析 YouTube URL：watch?v=、youtu.be/<id>、/shorts/<id>、/embed/<id>、/live/<id>
   * @returns {{isYouTube:boolean, videoId:string, isShorts:boolean, isEmbed:boolean}}
   */
  function parseYouTubeUrl(url) {
    const out = { isYouTube: false, videoId: '', isShorts: false, isEmbed: false };
    const parsed = parseUrlSafe(url);
    if (!parsed) return out;
    const host = parsed.hostname.toLowerCase();
    const isYt = YT_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
    if (!isYt) return out;
    out.isYouTube = true;
    if (host.endsWith('youtu.be')) {
      out.videoId = parsed.pathname.split('/').filter(Boolean)[0] || '';
      return out;
    }
    const v = parsed.searchParams.get('v');
    if (v) {
      out.videoId = v;
      return out;
    }
    const parts = parsed.pathname.split('/').filter(Boolean);
    const kind = (parts[0] || '').toLowerCase();
    if (kind === 'shorts' && parts[1]) {
      out.isShorts = true;
      out.videoId = parts[1];
    } else if ((kind === 'embed' || kind === 'live' || kind === 'v') && parts[1]) {
      out.isEmbed = kind === 'embed';
      out.videoId = parts[1];
    }
    return out;
  }

  /** bridge 地址规范化：补协议、去尾部斜杠、校验 http(s) 与端口 */
  function normalizeBridgeUrl(input) {
    let raw = String(input === null || input === undefined ? '' : input).trim();
    if (!raw) return DEFAULT_BRIDGE_URL;
    if (!/^[a-z]+:\/\//i.test(raw)) raw = `http://${raw}`;
    let parsed;
    try {
      parsed = new URL(raw);
    } catch (_) {
      return DEFAULT_BRIDGE_URL;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return DEFAULT_BRIDGE_URL;
    parsed.hash = '';
    parsed.search = '';
    let origin = parsed.origin;
    if (!parsed.port) {
      // 没写端口时沿用默认 bridge 端口，避免误连 80
      origin = `${parsed.protocol}//${parsed.hostname}:41789`;
    }
    return origin.replace(/\/+$/, '');
  }

  /** 从 bridge 基地址派生各端点 */
  function buildBridgeEndpoints(bridgeUrl) {
    const base = normalizeBridgeUrl(bridgeUrl);
    return {
      base,
      health: `${base}/__bridge/health`,
      context: `${base}/__bridge/context`,
      latest: `${base}/__bridge/context/latest`,
      list: `${base}/__bridge/context/list`,
      active: `${base}/__bridge/active`,
    };
  }

  function isBridgeOrigin(url, bridgeUrl) {
    const target = parseUrlSafe(url);
    const base = parseUrlSafe(normalizeBridgeUrl(bridgeUrl));
    if (!target || !base) return false;
    return target.origin === base.origin;
  }

  // =========================================================================
  // YouTube 字幕：player response → captionTracks → timedtext
  // =========================================================================

  function decodeXmlEntities(input) {
    const s = String(input === null || input === undefined ? '' : input);
    return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
      if (body[0] === '#') {
        const isHex = body[1] === 'x' || body[1] === 'X';
        const code = parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
        if (Number.isFinite(code)) {
          try { return String.fromCodePoint(code); } catch (_) { return match; }
        }
        return match;
      }
      switch (body) {
        case 'amp': return '&';
        case 'lt': return '<';
        case 'gt': return '>';
        case 'quot': return '"';
        case 'apos': return "'";
        case 'nbsp': return ' ';
        default: return match;
      }
    });
  }

  /** 兼容两种入参：页面探针返回的已归一化轨道 / 原始 playerResponse 轨道 */
  function normalizeCaptionTracks(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const raw of list) {
      if (!raw) continue;
      const lang = normalizeText(raw.lang || raw.languageCode || '');
      const baseUrl = String(raw.baseUrl || raw.url || '');
      if (!baseUrl) continue;
      let name = raw.name;
      if (name && typeof name === 'object') name = name.simpleText || name.runs?.[0]?.text || '';
      out.push({
        lang,
        name: normalizeText(name || ''),
        kind: String(raw.kind || ''),
        baseUrl,
      });
    }
    return out;
  }

  /** 把 timedtext 的 baseUrl 变成可 fetch 的绝对地址 */
  function absolutizeTimedtextUrl(rawUrl, origin) {
    let u = String(rawUrl || '').trim();
    if (!u) return '';
    if (u.startsWith('//')) return `https:${u}`;
    if (u.startsWith('/')) return `${origin || 'https://www.youtube.com'}${u}`;
    if (!/^https?:\/\//i.test(u)) return `${origin || 'https://www.youtube.com'}/${u.replace(/^\/+/, '')}`;
    return u;
  }

  /** 给 timedtext url 追加 fmt=json3（若还没有 fmt 参数） */
  function withJson3Format(rawUrl) {
    const u = String(rawUrl || '');
    if (!u) return u;
    if (/[?&]fmt=/.test(u)) return u.replace(/([?&])fmt=[^&]*/, '$1fmt=json3');
    return `${u}${u.includes('?') ? '&' : '?'}fmt=json3`;
  }

  /**
   * 从轨道列表挑一条最合适的：优先人工字幕，其次中文/英文，最后 asr。
   * @param {Array} tracks normalizeCaptionTracks 的结果
   * @param {{preferredLang?:string}} [options]
   */
  function pickCaptionTrack(tracks, options) {
    const list = Array.isArray(tracks) ? tracks.filter((t) => t && t.baseUrl) : [];
    if (!list.length) return null;
    const preferred = normalizeText((options && options.preferredLang) || '').toLowerCase();
    const score = (track) => {
      let s = 0;
      if (track.kind === 'asr') s -= 40;
      if (track.kind === 'forced') s -= 10;
      const lang = String(track.lang || '').toLowerCase();
      if (preferred && lang && (lang === preferred || lang.startsWith(`${preferred}-`) || preferred.startsWith(lang))) s += 50;
      if (lang.startsWith('zh')) s += 30;
      else if (lang.startsWith('en')) s += 20;
      if (!track.kind) s += 5;
      return s;
    };
    let best = list[0];
    let bestScore = score(best);
    for (const track of list) {
      const s = score(track);
      if (s > bestScore) {
        best = track;
        bestScore = s;
      }
    }
    return best;
  }

  /**
   * 把「页面探针结果」或「原始 ytInitialPlayerResponse」统一成视频快照。
   * @param {{probe?:object, playerResponse?:object, preferredLang?:string}} input
   * @returns {{title:string, author:string, durationSec:number, videoId:string,
   *   isLive:boolean, captionsUrl:string, captionLang:string, trackCount:number,
   *   playability:string}|null}
   */
  function extractYtPlayerSnapshot(input) {
    if (!input || typeof input !== 'object') return null;
    const probe = input.probe && typeof input.probe === 'object' ? input.probe : input;
    const pr = probe.playerResponse || probe.player_response || null;
    const source = pr && typeof pr === 'object' ? pr : probe;
    if (!source || typeof source !== 'object') return null;

    const vd = source.videoDetails || {};
    const rawTracks = (source.tracks && Array.isArray(source.tracks))
      ? source.tracks
      : (source.captions && source.captions.playerCaptionsTracklistRenderer
        && source.captions.playerCaptionsTracklistRenderer.captionTracks) || [];
    const tracks = normalizeCaptionTracks(rawTracks);
    const preferredLang = normalizeText(input.preferredLang || vd.defaultAudioLanguage || '');
    const best = pickCaptionTrack(tracks, { preferredLang });
    const title = truncateText(normalizeText(source.title || vd.title || '') || '', LIMITS.titleChars).text;
    const videoId = String(source.videoId || vd.videoId || '');
    // 探测完全失败时返回 null，让调用方走 page-text 兜底
    if (!title && !videoId && !tracks.length && !source.author && !Number(source.durationSec || vd.lengthSeconds)) {
      return null;
    }

    return {
      title,
      author: normalizeText(source.author || vd.author || ''),
      durationSec: Math.max(0, Number(source.durationSec || vd.lengthSeconds) || 0),
      videoId,
      isLive: !!(source.isLive || vd.isLiveContent),
      captionsUrl: best ? absolutizeTimedtextUrl(best.baseUrl) : '',
      captionLang: best ? best.lang : '',
      trackCount: tracks.length,
      playability: String((source.playabilityStatus && source.playabilityStatus.status) || source.playability || ''),
    };
  }

  // =========================================================================
  // 字幕解析：timedtext XML(srv1/srv3) / JSON3
  // =========================================================================

  function attrNumber(attrs, name) {
    const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']([^"']*)["']`);
    const m = re.exec(attrs || '');
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
  }

  function stripInnerTags(input) {
    return String(input || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]*>/g, '');
  }

  /**
   * 解析 timedtext XML。支持：
   *  - srv1: <transcript><text start="1.2" dur="3.4">…</text></transcript>
   *  - srv3: <timedtext><body><p t="1200" d="3400"><s>…</s></p></body></timedtext>
   * @returns {Array<{start:number,end:number,text:string}>}
   */
  function parseTimedtextXml(xml) {
    const raw = String(xml === null || xml === undefined ? '' : xml);
    if (!raw || !/<\s*(text|p|transcript|timedtext|body)\b/i.test(raw)) return [];
    const cues = [];

    const textRe = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
    let m;
    while ((m = textRe.exec(raw)) !== null) {
      const attrs = m[1] || '';
      const start = attrNumber(attrs, 'start') ?? attrNumber(attrs, 't');
      const dur = attrNumber(attrs, 'dur') ?? attrNumber(attrs, 'd');
      const isMillis = attrNumber(attrs, 'start') === null && attrNumber(attrs, 't') !== null;
      if (start === null) continue;
      const startSec = isMillis ? start / 1000 : start;
      const endSec = startSec + (dur === null ? 0 : (isMillis ? dur / 1000 : dur));
      const text = decodeXmlEntities(stripInnerTags(m[2]));
      cues.push({ start: startSec, end: endSec, text });
    }
    if (cues.length) return normalizeCues(cues);

    const pRe = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
    while ((m = pRe.exec(raw)) !== null) {
      const attrs = m[1] || '';
      const tMs = attrNumber(attrs, 't');
      const dMs = attrNumber(attrs, 'd');
      const startAttr = attrNumber(attrs, 'start');
      const durAttr = attrNumber(attrs, 'dur');
      if (tMs === null && startAttr === null) continue;
      const startSec = tMs !== null ? tMs / 1000 : startAttr;
      const durSec = dMs !== null ? dMs / 1000 : (durAttr !== null ? durAttr : 0);
      const text = decodeXmlEntities(stripInnerTags(m[2]));
      cues.push({ start: startSec, end: startSec + durSec, text });
    }
    return normalizeCues(cues);
  }

  /**
   * 解析 YouTube timedtext JSON3：{events:[{tStartMs,dDurationMs,segs:[{utf8}]}]}
   * @returns {Array<{start:number,end:number,text:string}>}
   */
  function parseTimedtextJson3(json) {
    let data = json;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch (_) { return []; }
    }
    if (!data || !Array.isArray(data.events)) return [];
    const cues = [];
    for (const event of data.events) {
      if (!event || !Array.isArray(event.segs)) continue;
      const text = event.segs.map((seg) => (seg && seg.utf8) || '').join('');
      if (!text.trim()) continue;
      const start = (Number(event.tStartMs) || 0) / 1000;
      const end = start + (Number(event.dDurationMs) || 0) / 1000;
      cues.push({ start, end, text });
    }
    return normalizeCues(cues);
  }

  /** 自动判定格式：先尝试 JSON（以 { 开头），否则按 XML 解析 */
  function parseTimedtextAuto(body, contentType) {
    const raw = String(body === null || body === undefined ? '' : body).trim();
    if (!raw) return [];
    const looksJson = raw.startsWith('{') || raw.startsWith('[')
      || /json/i.test(String(contentType || ''));
    if (looksJson) {
      const cues = parseTimedtextJson3(raw);
      if (cues.length) return cues;
    }
    return parseTimedtextXml(raw);
  }

  // =========================================================================
  // 字幕归一化 / 截断
  // =========================================================================

  function looksLikeRolling(prevText, nextText) {
    const a = String(prevText || '').trim();
    const b = String(nextText || '').trim();
    if (!a || !b || a === b) return false;
    const shorter = a.length <= b.length ? a : b;
    const longer = a.length <= b.length ? b : a;
    return shorter.length >= 4 && longer.startsWith(shorter);
  }

  /**
   * 归一化 cues：排序、补 end、去空、合并重复与 YouTube 自动字幕的「滚动累积」。
   * @returns {Array<{start:number,end:number,text:string}>}
   */
  function normalizeCues(input) {
    if (!Array.isArray(input)) return [];
    const items = [];
    for (const cue of input) {
      if (!cue) continue;
      const text = normalizeText(cue.text || '');
      if (!text) continue;
      const start = Number(cue.start) || 0;
      const end = Number(cue.end);
      items.push({ start: Math.max(0, start), end: Number.isFinite(end) ? Math.max(start, end) : start, text });
    }
    items.sort((a, b) => a.start - b.start);

    const out = [];
    for (const cue of items) {
      const prev = out.length ? out[out.length - 1] : null;
      if (!prev) {
        out.push(cue);
        continue;
      }
      const gap = cue.start - prev.end;
      // 同文本相邻条（timedtext 常见的重复段）合并；间隔太远则视为正常重复，各自保留
      if (cue.text === prev.text && gap <= 1.5) {
        prev.end = Math.max(prev.end, cue.end || prev.end);
        continue;
      }
      if (looksLikeRolling(prev.text, cue.text) && gap <= 2.5 && cue.start - prev.start <= 8) {
        // 自动字幕滚动：保留累积到的最新文本，时间轴从头延伸到尾
        prev.text = cue.text;
        prev.end = Math.max(prev.end, cue.end || prev.end);
        continue;
      }
      out.push(cue);
    }
    return out;
  }

  /**
   * 按规格截断字幕：≤ maxItems 条、≤ maxChars 字符。
   * @returns {{transcript:Array, truncated:boolean, charCount:number, itemCount:number}}
   */
  function trimTranscript(input, limits) {
    const opts = limits || {};
    const maxItems = clampInt(opts.maxItems, 0, 100000, LIMITS.transcriptItems);
    const maxChars = clampInt(opts.maxChars, 0, 10000000, LIMITS.transcriptChars);
    const cues = normalizeCues(input);
    const transcript = [];
    let charCount = 0;
    let truncated = false;
    for (const cue of cues) {
      if (transcript.length >= maxItems) {
        truncated = true;
        break;
      }
      const nextCount = charCount + cue.text.length;
      if (nextCount > maxChars) {
        // 还能放下半条吗？放不下就直接标记截断（宁可少，也不超限）
        truncated = true;
        break;
      }
      transcript.push({ start: cue.start, end: cue.end, text: cue.text });
      charCount = nextCount;
    }
    return { transcript, truncated: truncated || cues.length > transcript.length, charCount, itemCount: transcript.length };
  }

  function cuesToPlainText(input, options) {
    const cues = normalizeCues(input);
    const separator = (options && options.separator) || '\n';
    return cues.map((c) => c.text).join(separator);
  }

  function transcriptStats(input, limits) {
    const trimmed = trimTranscript(input, limits);
    const chars = trimmed.transcript.reduce((n, c) => n + c.text.length, 0);
    return {
      itemCount: trimmed.itemCount,
      charCount: chars,
      truncated: trimmed.truncated,
      durationSec: trimmed.transcript.length
        ? Math.max.apply(null, trimmed.transcript.map((c) => c.end || c.start || 0))
        : 0,
    };
  }

  // =========================================================================
  // B 站（bilibili）字幕
  // =========================================================================
  //
  // 链路（页面 → SW → B 站 API）：
  //   1) content script 请 SW 在 page world 读 window.__INITIAL_STATE__ → bvid/aid/cid/标题/时长/UP 主
  //   2) SW fetch https://api.bilibili.com/x/player/v2?bvid=&cid=（credentials: include）
  //      → data.subtitle.subtitles[]（lan / lan_doc / subtitle_url）
  //   3) SW fetch subtitle_url（通常是 //aisubtitle.hdslb.com/... 协议相对）→ {body:[{from,to,content}]}
  //   4) 归一化成 {start,end,text}（B 站是“秒”，带小数；同时容错毫秒格式）
  // 任何一步失败都返回 ok:false，由 content 退化为 page-text。

  const BILI_VIDEO_HOSTS = [
    'bilibili.com', 'www.bilibili.com', 'm.bilibili.com',
    'player.bilibili.com', 'www.bilibili.tv',
  ];

  /** 只允许 SW 拉这些主机的 JSON（B 站接口 + 字幕/资源 CDN） */
  const BILI_FETCH_HOST_SUFFIXES = ['api.bilibili.com', 'hdslb.com', 'bilivideo.com'];

  const BILI_BVID_RE = /\b(BV[0-9A-Za-z]{10})\b/;

  /**
   * 解析 B 站 URL：/video/BVxxx、/video/av123、?p=2 分 P
   * @returns {{isBilibili:boolean, isVideoPage:boolean, bvid:string, aid:number, pageIndex:number}}
   */
  function parseBilibiliUrl(url) {
    const out = { isBilibili: false, isVideoPage: false, bvid: '', aid: 0, pageIndex: 1 };
    const parsed = parseUrlSafe(url);
    if (!parsed) return out;
    const host = parsed.hostname.toLowerCase();
    const isBili = BILI_VIDEO_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
      || host.endsWith('bilibili.com') || host.endsWith('bilibili.tv');
    if (!isBili) return out;
    out.isBilibili = true;
    const p = Number(parsed.searchParams.get('p'));
    out.pageIndex = Number.isFinite(p) && p >= 1 ? Math.trunc(p) : 1;
    const path = parsed.pathname;
    const bvMatch = BILI_BVID_RE.exec(path);
    if (bvMatch) out.bvid = bvMatch[1];
    const avMatch = /\/video\/av(\d+)/i.exec(path);
    if (avMatch) out.aid = Number(avMatch[1]) || 0;
    // /video/BVxxx 且带有效 id 才算视频页
    out.isVideoPage = !!(out.bvid || out.aid);
    return out;
  }

  /**
   * 归一化 page world 的 __INITIAL_STATE__ 探针结果（也接受原始 state 对象，便于单测）。
   *
   * 关键情报（lead 真机实测）：B 站视频页 `videoData.subtitle = {allow_submit, list:[]}`，
   * **已登录**浏览器里 list 会带字幕轨（lan / lan_doc / subtitle_url / is_lock）→ 优先走这条
   * 「零 API」路径；未登录时 list 为空，再退到 player/v2（需要 cookie）。
   *
   * @returns {{bvid:string, aid:number, cid:number, title:string, durationSec:number,
   *   author:string, pageCount:number, pageIndex:number,
   *   subtitleTracks:Array<{lan:string,lanDoc:string,url:string,isAi:boolean,isLock:boolean}>}|null}
   */
  function extractBiliInitialState(input) {
    if (!input || typeof input !== 'object') return null;
    const probe = (input.probe && typeof input.probe === 'object') ? input.probe : input;
    const raw = (probe.__INITIAL_STATE__ && typeof probe.__INITIAL_STATE__ === 'object')
      ? probe.__INITIAL_STATE__
      : (probe.videoData ? probe : null);
    const source = raw || probe;
    const vd = source.videoData && typeof source.videoData === 'object' ? source.videoData : {};

    const bvid = String(source.bvid || probe.bvid || vd.bvid || '').trim();
    const aid = Number(source.aid || probe.aid || vd.aid) || 0;
    const pages = Array.isArray(vd.pages) ? vd.pages : [];
    // 当前分 P：URL ?p= / videoData.pageNo（B 站是 1-based）
    let pageIndex = Number(
      (probe.pageIndex || source.pageNo || vd.pageNo || probe.pageNo || 1),
    ) || 1;
    if (pageIndex < 1) pageIndex = 1;
    if (pages.length && pageIndex > pages.length) pageIndex = pages.length;
    const page = pages.length ? pages[pageIndex - 1] : null;
    let cid = Number((page && page.cid) || probe.cid || vd.cid) || 0;
    if (!cid && pages.length) cid = Number(pages[0].cid) || 0;

    const title = normalizeText(probe.title || vd.title || '');
    const author = normalizeText(
      (vd.owner && (vd.owner.name || vd.owner.uname))
        || probe.author
        || '',
    );
    const durationSec = Math.max(0, Number(probe.durationSec || vd.duration) || 0);
    // pages[] 有长度就用它；探针单独给了 pageCount（分 P 列表可能被裁剪）时兜底
    const pageCount = pages.length || Math.max(0, Number(probe.pageCount || vd.pageCount) || 0);

    // 字幕轨：探针已归一化字段优先，其次原始 state 里的 videoData.subtitle.list
    const rawTracks = Array.isArray(probe.subtitleTracks)
      ? probe.subtitleTracks
      : (vd.subtitle && Array.isArray(vd.subtitle.list) ? vd.subtitle.list : []);
    const subtitleTracks = [];
    const seenUrls = new Set();
    for (const item of rawTracks) {
      if (!item || typeof item !== 'object') continue;
      const url = String(item.url || item.subtitle_url || item.subtitle_url_v2 || '').trim();
      if (!url || seenUrls.has(url)) continue;
      seenUrls.add(url);
      const lan = normalizeText(item.lan || '');
      subtitleTracks.push({
        lan,
        lanDoc: normalizeText(item.lanDoc || item.lan_doc || item.lan_doc_v2 || lan),
        url,
        isAi: !!(item.isAi || /^ai[-_]/i.test(lan) || /自动生成|AI|机器/i.test(String(item.lanDoc || item.lan_doc || ''))),
        isLock: !!(item.isLock || item.is_lock),
      });
    }

    if (!bvid && !aid && !cid && !title) return null;
    return {
      bvid,
      aid,
      cid,
      title,
      durationSec,
      author,
      pageCount,
      pageIndex,
      subtitleTracks: subtitleTracks.slice(0, 20),
    };
  }

  /** 构造 player/v2 请求地址（优先 bvid，没有则 aid） */
  function buildBiliPlayerV2Url(options) {
    const opts = options || {};
    const cid = Math.trunc(Number(opts.cid)) || 0;
    const bvid = String(opts.bvid || '').trim();
    const aid = Math.trunc(Number(opts.aid)) || 0;
    if (!cid) return '';
    const params = [`cid=${cid}`];
    if (bvid) params.push(`bvid=${encodeURIComponent(bvid)}`);
    else if (aid) params.push(`aid=${aid}`);
    else return '';
    params.push('wbi=0');
    return `https://api.bilibili.com/x/player/v2?${params.join('&')}`;
  }

  /** 协议相对 URL（//aisubtitle.hdslb.com/...）补 https；其它原样返回 */
  function normalizeProtocolRelativeUrl(url) {
    const raw = String(url || '').trim();
    if (!raw) return '';
    if (raw.startsWith('//')) return `https:${raw}`;
    if (raw.startsWith('http://')) return `https://${raw.slice('http://'.length)}`;
    return raw;
  }

  /** 字幕/接口地址白名单：只允许 B 站 API 与已知 CDN 后缀（SW 侧网络请求用） */
  function isAllowedBiliFetchUrl(url) {
    const parsed = parseUrlSafe(normalizeProtocolRelativeUrl(url));
    if (!parsed) return false;
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return BILI_FETCH_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  }

  /**
   * 解析 player/v2 响应。
   * @returns {{ok:boolean, code:number, message:string, subtitles:Array<{lan:string,lanDoc:string,url:string,isAi:boolean}>}}
   */
  function parseBiliPlayerv2Response(json) {
    const out = { ok: false, code: 0, message: '', subtitles: [] };
    if (!json || typeof json !== 'object') {
      out.message = '响应不是 JSON 对象';
      return out;
    }
    out.code = Number(json.code);
    if (out.code !== 0) {
      out.message = normalizeText(json.message || json.msg || `B 站接口返回 code=${json.code}`);
      return out;
    }
    const data = json.data && typeof json.data === 'object' ? json.data : {};
    const subtitle = data.subtitle && typeof data.subtitle === 'object' ? data.subtitle : {};
    const list = Array.isArray(subtitle.subtitles) ? subtitle.subtitles : [];
    out.subtitles = list
      .map((item) => {
        if (!item || typeof item !== 'object') return null;
        const lan = normalizeText(item.lan || '');
        const url = String(item.subtitle_url || item.subtitle_url_v2 || '').trim();
        if (!url) return null;
        return {
          lan,
          lanDoc: normalizeText(item.lan_doc || item.lan_doc_v2 || lan),
          url,
          isAi: /^ai[-_]/i.test(lan) || /自动生成|AI|机器/i.test(String(item.lan_doc || '')),
        };
      })
      .filter(Boolean);
    out.ok = true;
    return out;
  }

  /** 文本版（容错 BOM / 前后空白） */
  function parseBiliPlayerv2Text(text) {
    const raw = String(text === null || text === undefined ? '' : text)
      .replace(/^\uFEFF/, '')
      .trim();
    if (!raw) return parseBiliPlayerv2Response(null);
    try {
      return parseBiliPlayerv2Response(JSON.parse(raw));
    } catch (error) {
      return { ok: false, code: 0, message: `player/v2 响应解析失败：${(error && error.message) || error}`, subtitles: [] };
    }
  }

  /** 选轨：zh-Hans > zh-CN > 通用 zh > ai-zh > 其它 zh* > 其它第一条 */
  function pickBiliSubtitleTrack(tracks) {
    const list = Array.isArray(tracks) ? tracks.filter((track) => track && track.url) : [];
    if (!list.length) return null;
    const score = (track) => {
      const lan = String(track.lan || '').toLowerCase();
      if (lan === 'zh-hans') return 120;
      if (lan === 'zh-cn') return 115;
      if (lan === 'zh') return 110;
      if (lan === 'ai-zh' || /^ai[-_]?zh/i.test(lan)) return 105;
      if (lan.startsWith('zh')) return 90;
      if (lan.startsWith('ai-')) return 40;
      return 0;
    };
    let best = list[0];
    let bestScore = score(best);
    for (const track of list) {
      const s = score(track);
      if (s > bestScore) { best = track; bestScore = s; }
    }
    return Object.assign({ isAi: false }, best, {
      isAi: !!(best.isAi || /^ai[-_]/i.test(String(best.lan || ''))),
    });
  }

  /**
   * B 站字幕 body 的时间单位判定：正常是「秒」（浮点），也容错「毫秒」（整数）。
   * 判定依据（按优先级）：
   *   1) 调用方显式 assumeUnit（'s' / 'ms'）
   *   2) 已知视频时长 durationSec：最大值 > 时长*2+30 视为毫秒
   *   3) 兜底：最大值 ≥ 100000 视为毫秒（>27h 的秒数不可能出现）
   * @returns {1|1000} 1=秒，1000=毫秒（调用方除 1000）
   */
  function detectBiliTimeUnit(pairs, options) {
    const opts = options || {};
    if (opts.assumeUnit === 'ms') return 1000;
    if (opts.assumeUnit === 's') return 1;
    let maxValue = 0;
    for (const pair of pairs || []) {
      maxValue = Math.max(maxValue, Math.abs(pair.start) || 0, Math.abs(pair.end) || 0);
    }
    const duration = Number(opts.durationSec) || 0;
    if (duration > 0 && maxValue > duration * 2 + 30) return 1000;
    if (maxValue >= 100000) return 1000;
    return 1;
  }

  /** 把 (from,to) 转成秒；单位由 detectBiliTimeUnit 决定 */
  function biliCueTimesToSeconds(from, to, options) {
    const f = Number(from);
    const t = Number(to);
    const start = Number.isFinite(f) ? f : 0;
    const end = Number.isFinite(t) ? t : 0;
    const divisor = detectBiliTimeUnit([{ start, end }], options);
    return {
      start: Math.max(0, start / divisor),
      end: Math.max(0, end / divisor),
    };
  }

  /**
   * 解析字幕 JSON：{body:[{from,to,content}]}（毫秒/秒都容错）
   * @param {object|Array} json
   * @param {{durationSec?:number, assumeUnit?:'s'|'ms'}} [options]
   * @returns {Array<{start:number,end:number,text:string}>}
   */
  function parseBiliSubtitleResponse(json, options) {
    const opts = options || {};
    let data = json;
    if (!data || typeof data !== 'object') return [];
    if (Array.isArray(data)) data = { body: data };
    const list = Array.isArray(data.body) ? data.body : [];
    const items = [];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const text = normalizeText(item.content || item.text || '');
      if (!text) continue;
      const from = Number(item.from);
      const to = Number(item.to);
      items.push({
        start: Number.isFinite(from) ? from : 0,
        end: Number.isFinite(to) ? to : 0,
        text,
      });
    }
    if (!items.length) return [];
    // 先按整体判定单位，再统一换算（避免逐条判定出现混用）
    const divisor = detectBiliTimeUnit(items, opts);
    const cues = items.map((item) => {
      const start = Math.max(0, item.start / divisor);
      const end = Math.max(0, item.end / divisor);
      return { start, end: Math.max(start, end), text: item.text };
    });
    return normalizeCues(cues);
  }

  /** 文本版（容错 BOM） */
  function parseBiliSubtitleText(text, options) {
    const raw = String(text === null || text === undefined ? '' : text)
      .replace(/^\uFEFF/, '')
      .trim();
    if (!raw) return [];
    try {
      return parseBiliSubtitleResponse(JSON.parse(raw), options);
    } catch (_) {
      return [];
    }
  }

  // =========================================================================
  // 侧边栏「当前页面」状态条（纯函数，便于单测）
  // =========================================================================

  /** 相对时间文案：刚刚 / N 秒前 / N 分钟前 / N 小时前 / N 天前 */
  function formatRelativeTime(thenMs, nowMs) {
    const then = Number(thenMs);
    if (!Number.isFinite(then) || then <= 0) return '';
    const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    const diff = Math.max(0, now - then);
    if (diff < 3000) return '刚刚';
    if (diff < 60000) return `${Math.floor(diff / 1000)} 秒前`;
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
    return `${Math.floor(diff / 86400000)} 天前`;
  }

  /** host 展示：接受完整 URL 或 host，去 www.、去端口、小写 */
  function normalizeHostLabel(input) {
    const raw = normalizeText(input || '');
    if (!raw) return '';
    let host = raw;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
      const parsed = parseUrlSafe(raw);
      host = parsed ? parsed.hostname : raw;
    } else if (raw.includes('/')) {
      host = raw.split('/')[0];
    }
    host = host.toLowerCase().replace(/^www\./, '').replace(/:\d+$/, '');
    return host;
  }

  function truncateLabel(text, maxChars) {
    const s = normalizeText(text || '');
    const max = clampInt(maxChars, 8, 500, 64);
    if (s.length <= max) return s;
    return `${s.slice(0, Math.max(1, max - 1))}…`;
  }

  /**
   * 计算「当前页面」状态条文案（全部纯文本，DOM 只负责渲染）。
   *
   * 输入（均来自 background.buildState / STATE_CHANGED）：
   *   activeTabId, activeTabTitle, activeTabUrl, restricted,
   *   snapshotTabId, snapshotTitle, snapshotUrl, syncedAt, now, titleMax
   *
   * 输出：{tone, title, host, siteLabel, statusText, timeText, warning, action, actionLabel, tooltip}
   *   tone: 'ok'（已同步）| 'idle'（尚未读取/无法读取）| 'warn'（当前页未同步，agent 看到的是旧页）
   */
  function computePageStatus(input) {
    const src = input || {};
    const titleMax = clampInt(src.titleMax, 8, 500, 60);
    const hasSnapshot = !!(src.snapshotTabId !== null && src.snapshotTabId !== undefined && src.snapshotTabId !== '')
      || !!(src.snapshotTitle && String(src.snapshotTitle).trim());
    const snapshotTitle = String(src.snapshotTitle || '').trim();
    const snapshotUrl = String(src.snapshotUrl || '').trim();
    const activeUrl = String(src.activeTabUrl || '').trim();
    const activeTitle = String(src.activeTabTitle || '').trim();
    const activeHost = normalizeHostLabel(activeUrl) || normalizeHostLabel(src.hostLabel || '');
    // 有站点映射时用可读站点名（哔哩哔哩 / YouTube / 知乎…），否则回落 host
    const mappedSite = activeUrl ? siteNameFromUrl(activeUrl) : '';
    const activeSite = mappedSite && mappedSite.toLowerCase() !== activeHost ? mappedSite : '';

    const base = {
      tone: 'idle',
      title: '',
      host: activeHost,
      siteLabel: activeSite,
      statusText: '',
      timeText: '',
      warning: '',
      action: 'none',
      actionLabel: '同步当前页',
      tooltip: '',
    };

    if (src.restricted) {
      return Object.assign(base, {
        tone: 'idle',
        title: '受限页面',
        host: '',
        siteLabel: '',
        statusText: '无法读取',
        tooltip: 'chrome:// 等受限页面不会被读取',
      });
    }

    const displayTitle = truncateLabel(activeTitle || activeHost || '当前页面', titleMax);

    if (!hasSnapshot) {
      return Object.assign(base, {
        tone: 'idle',
        title: displayTitle,
        statusText: '尚未读取',
        warning: '尚未读取，点 ⟳ 同步当前页',
        action: 'sync',
        tooltip: 'agent 还没有拿到任何网页上下文',
      });
    }

    const activeId = Number(src.activeTabId);
    const snapshotId = Number(src.snapshotTabId);
    const sameTab = Number.isFinite(activeId) && Number.isFinite(snapshotId)
      ? activeId === snapshotId
      : false;
    const sameUrl = activeUrl && snapshotUrl ? activeUrl === snapshotUrl : true;

    if (!sameTab) {
      const oldTitle = truncateLabel(snapshotTitle || '(未知页面)', titleMax);
      const warning = `当前页未同步，agent 看到的是：${oldTitle}`;
      return Object.assign(base, {
        tone: 'warn',
        title: displayTitle,
        statusText: '未同步',
        warning,
        action: 'sync',
        tooltip: warning,
      });
    }

    if (!sameUrl) {
      // 同一标签页内 SPA 跳转但还没同步（快照 url 与当前 url 不同）
      const oldTitle = truncateLabel(snapshotTitle || '(未知页面)', titleMax);
      const warning = `当前页已变化，尚未同步（agent 看到的是：${oldTitle}）`;
      return Object.assign(base, {
        tone: 'warn',
        title: displayTitle,
        statusText: '待同步',
        warning,
        action: 'sync',
        tooltip: warning,
      });
    }

    const timeText = formatRelativeTime(src.syncedAt, src.now);
    return Object.assign(base, {
      tone: 'ok',
      title: displayTitle,
      statusText: timeText ? '已同步' : '已同步',
      timeText,
      action: 'none',
      tooltip: timeText ? `已同步：${timeText}` : '已同步',
    });
  }

  // =========================================================================
  // 快照构建 / 校验
  // =========================================================================

  /**
   * 构建 bridge 快照（规格 §2 上下文模型）。
   * 这是唯一的「形状出口」，background 与测试都走这里。
   *
   * @param {object} input
   *   tabId, windowId, active, url, title, siteName, selection,
   *   meta{description,ogImage,author,publishedAt,lang},
   *   content{text} | contentText, video{kind,title,author,durationSec,currentTimeSec,transcriptSource,cues|transcript},
   *   limits{contentChars,transcriptItems,transcriptChars}, capturedAt, id
   * @returns {object} 符合规格的快照
   */
  function buildSnapshot(input) {
    const src = input || {};
    const limits = src.limits || {};
    const maxContentChars = clampInt(limits.contentChars, 1000, 10000000, LIMITS.contentChars);
    const maxTranscriptItems = clampInt(limits.transcriptItems, 0, 100000, LIMITS.transcriptItems);
    const maxTranscriptChars = clampInt(limits.transcriptChars, 0, 10000000, LIMITS.transcriptChars);

    const rawContent = (src.content && typeof src.content === 'object') ? src.content.text : src.contentText;
    const content = truncateText(normalizeText(rawContent || ''), maxContentChars);

    const meta = src.meta || {};
    const videoRaw = src.video || {};
    const cues = Array.isArray(videoRaw.transcript) ? videoRaw.transcript : (videoRaw.cues || []);
    const trimmed = trimTranscript(cues, { maxItems: maxTranscriptItems, maxChars: maxTranscriptChars });
    const hasVideo = !!videoRaw.kind && videoRaw.kind !== 'none';
    const transcriptSource = hasVideo
      ? (videoRaw.transcriptSource || (trimmed.itemCount ? 'track' : 'none'))
      : 'none';

    const capturedAt = src.capturedAt
      && !Number.isNaN(Date.parse(src.capturedAt))
      ? new Date(src.capturedAt).toISOString()
      : new Date().toISOString();

    return {
      id: typeof src.id === 'string' && src.id ? src.id : uuid(),
      tabId: clampInt(src.tabId, -1, Number.MAX_SAFE_INTEGER, -1),
      windowId: clampInt(src.windowId, -1, Number.MAX_SAFE_INTEGER, -1),
      active: src.active !== false,
      url: String(src.url || ''),
      title: truncateText(normalizeText(src.title || ''), LIMITS.titleChars).text,
      siteName: normalizeText(src.siteName || ''),
      capturedAt,
      selection: truncateText(normalizeText(src.selection || ''), LIMITS.selectionChars).text,
      meta: {
        description: truncateText(normalizeText(meta.description || ''), LIMITS.descriptionChars).text,
        ogImage: String(meta.ogImage || ''),
        author: normalizeText(meta.author || ''),
        publishedAt: normalizeText(meta.publishedAt || ''),
        lang: normalizeText(meta.lang || ''),
      },
      content: {
        text: content.text,
        charCount: content.charCount,
        truncated: content.truncated,
      },
      video: {
        kind: hasVideo ? String(videoRaw.kind) : 'none',
        title: truncateText(normalizeText(videoRaw.title || ''), LIMITS.titleChars).text,
        author: normalizeText(videoRaw.author || ''),
        durationSec: Math.max(0, Number(videoRaw.durationSec) || 0),
        currentTimeSec: Math.max(0, Number(videoRaw.currentTimeSec) || 0),
        transcriptSource: transcriptSource === 'track' && !trimmed.itemCount
          ? 'page-text'
          : String(transcriptSource),
        transcript: trimmed.transcript,
      },
    };
  }

  const SNAPSHOT_META_KEYS = ['description', 'ogImage', 'author', 'publishedAt', 'lang'];
  const SNAPSHOT_CONTENT_KEYS = ['text', 'charCount', 'truncated'];
  const SNAPSHOT_VIDEO_KEYS = [
    'kind', 'title', 'author', 'durationSec', 'currentTimeSec', 'transcriptSource', 'transcript',
  ];
  const TRANSCRIPT_SOURCES = [
    'youtube-captions', 'bilibili-page', 'bilibili-api', 'track', 'page-text', 'none',
  ];
  const VIDEO_KINDS = ['youtube', 'bilibili', 'html5', 'none'];

  /**
   * 结构校验（防御其他端乱传 + mock bridge / 测试用）。
   * @returns {{ok:boolean, errors:string[]}}
   */
  function validateSnapshot(snapshot) {
    const errors = [];
    const push = (msg) => errors.push(msg);
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      return { ok: false, errors: ['snapshot 必须是对象'] };
    }
    const required = ['id', 'tabId', 'windowId', 'active', 'url', 'title', 'siteName', 'capturedAt', 'selection', 'meta', 'content', 'video'];
    for (const key of required) {
      if (!(key in snapshot)) push(`缺少字段 ${key}`);
    }
    if (typeof snapshot.id !== 'string' || !snapshot.id) push('id 必须是非空字符串');
    if (!Number.isInteger(snapshot.tabId)) push('tabId 必须是整数');
    if (!Number.isInteger(snapshot.windowId)) push('windowId 必须是整数');
    if (typeof snapshot.active !== 'boolean') push('active 必须是布尔值');
    if (typeof snapshot.url !== 'string') push('url 必须是字符串');
    if (typeof snapshot.title !== 'string') push('title 必须是字符串');
    if (typeof snapshot.siteName !== 'string') push('siteName 必须是字符串');
    if (typeof snapshot.selection !== 'string') push('selection 必须是字符串');
    if (typeof snapshot.capturedAt !== 'string' || Number.isNaN(Date.parse(snapshot.capturedAt))) {
      push('capturedAt 必须是 ISO 时间字符串');
    }
    const meta = snapshot.meta;
    if (!meta || typeof meta !== 'object') push('meta 必须是对象');
    else for (const key of SNAPSHOT_META_KEYS) if (typeof meta[key] !== 'string') push(`meta.${key} 必须是字符串`);

    const content = snapshot.content;
    if (!content || typeof content !== 'object') push('content 必须是对象');
    else {
      for (const key of SNAPSHOT_CONTENT_KEYS) if (!(key in content)) push(`缺少字段 content.${key}`);
      if (typeof content.text !== 'string') push('content.text 必须是字符串');
      if (!Number.isInteger(content.charCount)) push('content.charCount 必须是整数');
      if (typeof content.truncated !== 'boolean') push('content.truncated 必须是布尔值');
      if (typeof content.text === 'string' && content.text.length > LIMITS.contentChars) {
        push(`content.text 超过规格上限 ${LIMITS.contentChars}`);
      }
      if (typeof content.text === 'string' && content.text.length !== content.charCount) {
        push('content.charCount 与 content.text 长度不一致');
      }
    }

    const video = snapshot.video;
    if (!video || typeof video !== 'object') push('video 必须是对象');
    else {
      for (const key of SNAPSHOT_VIDEO_KEYS) if (!(key in video)) push(`缺少字段 video.${key}`);
      if (VIDEO_KINDS.indexOf(video.kind) < 0) push(`video.kind 非法：${video.kind}`);
      if (TRANSCRIPT_SOURCES.indexOf(video.transcriptSource) < 0) {
        push(`video.transcriptSource 非法：${video.transcriptSource}`);
      }
      if (typeof video.durationSec !== 'number' || video.durationSec < 0) push('video.durationSec 必须是非负数');
      if (typeof video.currentTimeSec !== 'number' || video.currentTimeSec < 0) push('video.currentTimeSec 必须是非负数');
      if (!Array.isArray(video.transcript)) push('video.transcript 必须是数组');
      else {
        if (video.transcript.length > LIMITS.transcriptItems) push(`video.transcript 超过 ${LIMITS.transcriptItems} 条`);
        let chars = 0;
        for (const cue of video.transcript) {
          if (!cue || typeof cue !== 'object') { push('video.transcript 元素必须是对象'); break; }
          if (typeof cue.start !== 'number' || typeof cue.end !== 'number' || typeof cue.text !== 'string') {
            push('video.transcript 元素必须含 start/end/text');
            break;
          }
          chars += cue.text.length;
        }
        if (chars > LIMITS.transcriptChars) push(`video.transcript 超过 ${LIMITS.transcriptChars} 字符`);
      }
    }
    return { ok: errors.length === 0, errors };
  }

  /** 「内容有没有变」的廉价签名（自动同步去重用） */
  function snapshotSignature(input) {
    const src = input || {};
    const content = src.content && typeof src.content === 'object' ? src.content.text : (src.contentText || '');
    const video = src.video || {};
    const cues = Array.isArray(video.transcript) ? video.transcript : (video.cues || []);
    const parts = [
      String(src.url || ''),
      String(src.title || ''),
      String(content || '').length,
      String(content || '').slice(0, 2000),
      String(src.selection || ''),
      String(video.kind || ''),
      String(cues.length),
      cues.length ? String(cues[0].text || '').slice(0, 200) : '',
    ];
    return hashString(parts.join('\u0001'));
  }

  /** 给工具条/日志用的快照摘要 */
  function snapshotSummary(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return { ok: false, label: '无快照' };
    const chars = snapshot.content && snapshot.content.charCount ? snapshot.content.charCount : 0;
    const video = snapshot.video || {};
    const cueCount = Array.isArray(video.transcript) ? video.transcript.length : 0;
    const source = String(video.transcriptSource || '');
    let kindLabel = '';
    if (video.kind === 'youtube') kindLabel = 'YouTube';
    else if (video.kind === 'bilibili' || source.startsWith('bilibili-')) kindLabel = 'B 站';
    else if (video.kind && video.kind !== 'none') kindLabel = '视频';
    const label = kindLabel
      ? `${kindLabel} · ${cueCount} 条字幕 · 正文 ${chars} 字`
      : `正文 ${chars} 字`;
    return {
      ok: true,
      label,
      url: snapshot.url || '',
      title: snapshot.title || '',
      charCount: chars,
      transcriptCount: cueCount,
      hasSelection: !!(snapshot.selection && snapshot.selection.length),
      hasVideo: !!(video.kind && video.kind !== 'none'),
    };
  }

  // =========================================================================
  // 设置
  // =========================================================================

  /** 规范化设置对象（缺省补默认、越界夹紧、bridge 地址纠正） */
  function normalizeSettings(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    return {
      bridgeUrl: normalizeBridgeUrl(src.bridgeUrl),
      autoSync: src.autoSync === undefined ? DEFAULT_SETTINGS.autoSync : !!src.autoSync,
      throttleMs: clampInt(src.throttleMs, 300, 60000, DEFAULT_SETTINGS.throttleMs),
      maxContentChars: clampInt(src.maxContentChars, 2000, LIMITS.contentChars, LIMITS.contentChars),
      maxTranscriptItems: clampInt(src.maxTranscriptItems, 100, LIMITS.transcriptItems, LIMITS.transcriptItems),
      maxTranscriptChars: clampInt(src.maxTranscriptChars, 1000, LIMITS.transcriptChars, LIMITS.transcriptChars),
      requestTimeoutMs: clampInt(src.requestTimeoutMs, 500, 20000, DEFAULT_SETTINGS.requestTimeoutMs),
    };
  }

  /** 局部更新设置并返回新对象（用于 toolbar / options 保存） */
  function patchSettings(current, patch) {
    return normalizeSettings(Object.assign({}, normalizeSettings(current), patch || {}));
  }

  /** 把设置转换成 limits（background/内容脚本共用） */
  function settingsToLimits(settings) {
    const s = normalizeSettings(settings);
    return {
      contentChars: s.maxContentChars,
      transcriptItems: s.maxTranscriptItems,
      transcriptChars: s.maxTranscriptChars,
    };
  }

  // =========================================================================
  // 导出（经典脚本 / CJS 双兼容）
  // =========================================================================

  const api = {
    LIMITS,
    DEFAULT_SETTINGS,
    DEFAULT_BRIDGE_URL,
    SETTING_CHOICES,
    MESSAGES,
    SKIP_TAGS,
    BLOCK_TAGS,
    MAIN_SELECTORS,
    // 工具
    clampInt,
    countChars,
    uuid,
    hashString,
    normalizeText,
    truncateText,
    stripNoiseLines,
    dedupeConsecutiveLines,
    // DOM
    nodeTypeOf,
    tagNameOf,
    getAttribute,
    safeQueryAll,
    safeQuery,
    collectVisibleText,
    extractMainContent,
    extractTitle,
    extractMeta,
    extractSelection,
    readVideoTracks,
    pickPrimaryVideo,
    extractVideoInfo,
    collectPageTextLines,
    // URL / 站点
    parseUrlSafe,
    isRestrictedUrl,
    siteNameFromUrl,
    parseYouTubeUrl,
    normalizeBridgeUrl,
    buildBridgeEndpoints,
    isBridgeOrigin,
    // YouTube
    decodeXmlEntities,
    normalizeCaptionTracks,
    absolutizeTimedtextUrl,
    withJson3Format,
    pickCaptionTrack,
    extractYtPlayerSnapshot,
    parseTimedtextXml,
    parseTimedtextJson3,
    parseTimedtextAuto,
    // 字幕
    looksLikeRolling,
    normalizeCues,
    trimTranscript,
    cuesToPlainText,
    transcriptStats,
    // B 站
    parseBilibiliUrl,
    extractBiliInitialState,
    buildBiliPlayerV2Url,
    normalizeProtocolRelativeUrl,
    isAllowedBiliFetchUrl,
    parseBiliPlayerv2Response,
    parseBiliPlayerv2Text,
    pickBiliSubtitleTrack,
    detectBiliTimeUnit,
    biliCueTimesToSeconds,
    parseBiliSubtitleResponse,
    parseBiliSubtitleText,
    // 侧边栏「当前页面」状态条
    formatRelativeTime,
    normalizeHostLabel,
    truncateLabel,
    computePageStatus,
    // 快照
    buildSnapshot,
    validateSnapshot,
    snapshotSignature,
    snapshotSummary,
    // 设置
    normalizeSettings,
    patchSettings,
    settingsToLimits,
  };

  try {
    global.DSHSidebarCore = api;
  } catch (_) { /* ignore */ }
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis
  : typeof self !== 'undefined' ? self
    : this));
