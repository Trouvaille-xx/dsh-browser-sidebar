/*!
 * DSH 侧边栏扩展 · content script（content.js）
 * ---------------------------------------------------------------------------
 * 职责：只在「被要求时」抽取当前页面的可读内容，并作为草稿返回给 service worker。
 *   - 不直接访问网络（跨域 timedtext / bridge 请求都交给 SW，避 CORS）；
 *   - 不读取 input/textarea/select/button 的内容，不读密码框；
 *   - 只跑在顶层文档（manifest all_frames=false），跨域 iframe 一律不读；
 *   - 不主动上传任何东西：只发「页面变了」的信号，是否同步由 SW 按自动同步开关决定。
 *
 * 依赖：lib/core.js（manifest 里先于本文件注入，挂在 globalThis.DSHSidebarCore）
 */

(function () {
  'use strict';

  const core = globalThis.DSHSidebarCore;
  if (!core) {
    // 理论上不会发生（manifest 保证顺序），防御一下便于排错
    console.warn('[DSH sidepanel] core.js 未加载，content script 退出');
    return;
  }
  const net = globalThis.DSHNet;
  const MESSAGES = core.MESSAGES;

  // 幂等：同一文档被重复注入（例如 SW 手动 executeScript 兜底）时只生效一次
  if (globalThis.__DSH_SIDEBAR_CONTENT_LOADED__) return;
  globalThis.__DSH_SIDEBAR_CONTENT_LOADED__ = true;

  const REPORT = {
    urlPollMs: 1000,        // SPA 兜底轮询（隔离世界无法拦截页面自己的 pushState）
    selectionDebounceMs: 700,
    messageTimeoutMs: 8000,
    maxWaitMs: 4000,        // 变化风暴时的强制上报上限（避免 debounce 被无限推迟）
  };

  const state = {
    settings: core.normalizeSettings({}),
    lastReportAt: 0,
    lastCheapSignature: '',
    lastUrl: location.href,
    pendingReason: '',
    pendingSince: 0,
    debounceTimer: null,
    trailingTimer: null,
    scrollTimer: null,
    selectionTimer: null,
    urlTimer: null,
    requesting: false,
  };

  // ---------------------------------------------------------------------------
  // 工具
  // ---------------------------------------------------------------------------

  function sendMessage(message, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ ok: false, error: `扩展内部消息超时：${message && message.type}` });
      }, timeoutMs || REPORT.messageTimeoutMs);
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            resolve({ ok: false, error: lastError.message || String(lastError) });
            return;
          }
          resolve(response === undefined ? { ok: false, error: '无响应' } : response);
        });
      } catch (error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, error: (error && error.message) || String(error) });
      }
    });
  }

  function loadSettings() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get({ settings: null }, (data) => {
          const lastError = chrome.runtime.lastError;
          if (!lastError && data && data.settings) {
            state.settings = core.normalizeSettings(data.settings);
          }
          resolve(state.settings);
        });
      } catch (_) {
        resolve(state.settings);
      }
    });
  }

  function bodyTextLength() {
    try {
      const body = document.body;
      if (!body) return 0;
      const text = typeof body.innerText === 'string' ? body.innerText : body.textContent;
      return text ? text.length : 0;
    } catch (_) {
      return 0;
    }
  }

  function cheapSignature() {
    const quantized = Math.round(bodyTextLength() / 40) * 40;
    return `${location.href}|${document.title}|${quantized}`;
  }

  // ---------------------------------------------------------------------------
  // 抽取
  // ---------------------------------------------------------------------------

  /** HTML5 <video> 的 currentTime（读不到就是 0） */
  function currentVideoTime() {
    const video = core.pickPrimaryVideo(document);
    const t = Number(video && video.currentTime);
    return Number.isFinite(t) && t > 0 ? Math.round(t * 10) / 10 : 0;
  }

  /**
   * YouTube 字幕：page world 读 ytInitialPlayerResponse → SW 跨域 fetch timedtext → 这里解析。
   * 任何一步失败都退化成 page-text（标题/简介/首屏评论）。
   */
  async function extractYouTubeVideo(baseTitle) {
    const fallback = { kind: 'youtube', title: baseTitle, author: '', durationSec: 0, currentTimeSec: currentVideoTime(), transcriptSource: 'none', cues: [] };
    let snapshot = null;
    try {
      const probe = await sendMessage({ type: MESSAGES.YT_PROBE });
      if (probe && probe.ok && probe.probe) {
        snapshot = core.extractYtPlayerSnapshot({ probe: probe.probe, preferredLang: navigator.language || '' });
      }
    } catch (_) { /* ignore */ }

    if (snapshot) {
      fallback.title = snapshot.title || baseTitle;
      fallback.author = snapshot.author || '';
      fallback.durationSec = snapshot.durationSec || 0;
      if (snapshot.captionsUrl) {
        let fetchResult = await sendMessage({ type: MESSAGES.FETCH_TEXT, url: core.withJson3Format(snapshot.captionsUrl) });
        let cues = fetchResult && fetchResult.ok ? core.parseTimedtextAuto(fetchResult.body, fetchResult.contentType) : [];
        if (!cues.length) {
          // 有些视频不支持 fmt=json3，退回原始 XML
          fetchResult = await sendMessage({ type: MESSAGES.FETCH_TEXT, url: snapshot.captionsUrl });
          cues = fetchResult && fetchResult.ok ? core.parseTimedtextAuto(fetchResult.body, fetchResult.contentType) : [];
        }
        if (cues.length) {
          return Object.assign({}, fallback, { transcriptSource: 'youtube-captions', cues });
        }
      }
    }

    // 兜底：用视频页文字（标题/简介/评论首屏）
    const pageText = core.collectPageTextLines(document, { title: fallback.title || baseTitle, pageUrl: location.href });
    return Object.assign({}, fallback, {
      transcriptSource: pageText.lines.length ? 'page-text' : 'none',
      cues: pageText.lines.map((text) => ({ start: 0, end: 0, text })),
      pageText: pageText.text,
    });
  }

  // ---------------------------------------------------------------------------
  // B 站（bilibili）字幕
  // ---------------------------------------------------------------------------
  // 优先顺序（与真机情报一致）：
  //   1) page world 的 __INITIAL_STATE__.videoData.subtitle.list
  //      —— 登录态浏览器里自带 subtitle_url，零 API、最快；
  //   2) player/v2（SW 带 cookie 优先；SW 拿不到登录态时，内容脚本用页面 cookie 再试一次）；
  //   3) page-text（标题/简介/UP 主等页面文字，别让 agent 空手）。
  // 任一步失败都只是往下退化，不抛异常、不阻塞页面。

  async function fetchTextInPage(url, timeoutMs) {
    if (!net || typeof net.fetchWithTimeout !== 'function') return { ok: false, error: 'net 模块未加载' };
    let result;
    try {
      result = await net.fetchWithTimeout(url, {
        timeoutMs: timeoutMs || 5000,
        credentials: 'include',
        headers: { accept: 'application/json, text/plain, */*' },
      });
    } catch (error) {
      return { ok: false, error: (error && error.message) || String(error) };
    }
    if (!result.ok) return { ok: false, error: result.error };
    if (!result.response.ok) return { ok: false, error: `HTTP ${result.response.status}` };
    try {
      return { ok: true, text: await result.response.text() };
    } catch (error) {
      return { ok: false, error: `读取响应失败：${(error && error.message) || error}` };
    }
  }

  /** 页面内直接拉字幕 JSON（CORS 可能拦，失败返回 null） */
  async function fetchBiliBodyLocally(subtitleUrl, timeoutMs, durationSec) {
    const url = core.normalizeProtocolRelativeUrl(subtitleUrl);
    if (!url || !core.isAllowedBiliFetchUrl(url)) return null;
    const result = await fetchTextInPage(url, timeoutMs);
    if (!result.ok) return null;
    const cues = core.parseBiliSubtitleText(result.text, { durationSec: Number(durationSec) || 0 });
    return cues.length ? cues : null;
  }

  /** 页面内走 player/v2（带页面 cookie；CORS 可能拦，失败返回 null） */
  async function fetchBiliApiLocally(info) {
    const apiUrl = core.buildBiliPlayerV2Url({ bvid: info.bvid, aid: info.aid, cid: info.cid });
    if (!apiUrl) return null;
    const result = await fetchTextInPage(apiUrl, 5000);
    if (!result.ok) return null;
    const parsed = core.parseBiliPlayerv2Text(result.text);
    if (!parsed.ok) return null;
    const track = core.pickBiliSubtitleTrack(parsed.subtitles);
    if (!track) return null;
    return fetchBiliBodyLocally(track.url, 5000, info.durationSec);
  }

  async function extractBilibiliVideo(baseTitle, bili) {
    const fallback = {
      kind: 'bilibili',
      title: baseTitle,
      author: '',
      durationSec: 0,
      currentTimeSec: currentVideoTime(),
      transcriptSource: 'none',
      cues: [],
    };

    // page world 读 __INITIAL_STATE__（bvid/aid/cid/标题/分P/字幕轨）
    let probe = null;
    try {
      const probeResult = await sendMessage({ type: MESSAGES.BILI_PROBE });
      if (probeResult && probeResult.ok && probeResult.probe) {
        probe = core.extractBiliInitialState({ probe: probeResult.probe });
      }
    } catch (_) { /* 走兜底 */ }

    if (probe) {
      fallback.title = probe.title || baseTitle || '';
      fallback.author = probe.author || '';
      fallback.durationSec = probe.durationSec || 0;
    }
    const bvid = (probe && probe.bvid) || bili.bvid;
    const aid = (probe && probe.aid) || bili.aid;
    const cid = probe && probe.cid;

    // 1) 页面态字幕（登录态 __INITIAL_STATE__ 自带 subtitle_url）
    const tracks = (probe && probe.subtitleTracks) || [];
    if (tracks.length) {
      const track = core.pickBiliSubtitleTrack(tracks);
      if (track) {
        const viaSw = await sendMessage({
          type: MESSAGES.BILI_SUBTITLES,
          subtitleUrl: track.url,
          track: { lan: track.lan, lanDoc: track.lanDoc, ai: track.isAi },
          bvid,
          aid,
          cid,
          durationSec: fallback.durationSec,
        });
        if (viaSw && viaSw.ok && viaSw.cues && viaSw.cues.length) {
          return Object.assign({}, fallback, { transcriptSource: 'bilibili-page', cues: viaSw.cues });
        }
        const localCues = await fetchBiliBodyLocally(track.url, 5000, fallback.durationSec);
        if (localCues) {
          return Object.assign({}, fallback, { transcriptSource: 'bilibili-page', cues: localCues });
        }
      }
    }

    // 2) player/v2（SW 带 cookie 优先；失败再内容脚本带 cookie 一次）
    if (cid && (bvid || aid)) {
      const viaSw = await sendMessage({ type: MESSAGES.BILI_SUBTITLES, bvid, aid, cid, durationSec: fallback.durationSec });
      if (viaSw && viaSw.ok && viaSw.cues && viaSw.cues.length) {
        return Object.assign({}, fallback, { transcriptSource: 'bilibili-api', cues: viaSw.cues });
      }
      const localCues = await fetchBiliApiLocally({ bvid, aid, cid, durationSec: fallback.durationSec });
      if (localCues) {
        return Object.assign({}, fallback, { transcriptSource: 'bilibili-api', cues: localCues });
      }
    }

    // 3) page-text 兜底（保留 B 站标题/UP 主 + 页面文字）
    const pageText = core.collectPageTextLines(document, {
      title: fallback.title || baseTitle,
      pageUrl: location.href,
    });
    return Object.assign({}, fallback, {
      transcriptSource: pageText.lines.length ? 'page-text' : 'none',
      cues: pageText.lines.map((text) => ({ start: 0, end: 0, text })),
    });
  }

  /**
   * 抽取草稿（不做任何截断外的加工；截断/校验在 SW 里用 buildSnapshot 统一做）。
   * @returns {Promise<{ok:boolean, skipped?:boolean, reason?:string, draft?:object}>}
   */
  async function extractDraft() {
    const url = location.href;
    if (core.isRestrictedUrl(url)) {
      return { ok: false, skipped: true, reason: 'chrome:// 或扩展页面不读取' };
    }
    let settings = state.settings;
    try { settings = await loadSettings(); } catch (_) { /* 用缓存 */ }
    const limits = core.settingsToLimits(settings);

    const title = core.extractTitle(document) || document.title || '';
    const meta = core.extractMeta(document, url);
    // 站点名：优先 og:site_name，其次 host 映射
    const siteNameNode = core.safeQuery(document, 'meta[property="og:site_name"]');
    const siteNameExplicit = siteNameNode ? (core.getAttribute(siteNameNode, 'content') || '') : '';
    const siteName = core.siteNameFromUrl(url, siteNameExplicit);
    const selection = core.extractSelection(window);

    // 正文：多留一点余量给 SW 里的最终截断
    const main = core.extractMainContent(document, { maxChars: limits.contentChars });

    const yt = core.parseYouTubeUrl(url);
    const bili = core.parseBilibiliUrl(url);
    let video;
    if (yt.isYouTube) {
      video = await extractYouTubeVideo(title);
    } else if (bili.isBilibili && bili.isVideoPage) {
      video = await extractBilibiliVideo(title, bili);
    } else {
      const info = core.extractVideoInfo(document, url);
      if (info.kind === 'none') {
        video = info;
      } else if (info.cues.length) {
        video = info;
      } else {
        // 有 <video> 但没有可用字幕轨 → 视频页文字兜底
        const pageText = core.collectPageTextLines(document, { title: info.title || title, pageUrl: url });
        video = Object.assign({}, info, {
          transcriptSource: pageText.lines.length ? 'page-text' : 'none',
          cues: pageText.lines.map((text) => ({ start: 0, end: 0, text })),
        });
      }
    }

    const draft = {
      url,
      title,
      siteName: siteName || core.siteNameFromUrl(url),
      meta,
      selection,
      content: { text: main.text, charCount: main.charCount, truncated: main.truncated, source: main.source },
      video,
      isYouTube: yt.isYouTube,
      videoId: yt.videoId,
      lang: meta.lang || document.documentElement.lang || '',
      extractedAt: new Date().toISOString(),
    };
    return { ok: true, draft };
  }

  // ---------------------------------------------------------------------------
  // 「页面变了」上报（不含内容，避免频繁传输大文本）
  // ---------------------------------------------------------------------------

  function emitChange(reason) {
    state.lastReportAt = Date.now();
    state.pendingReason = '';
    state.pendingSince = 0;
    state.lastCheapSignature = cheapSignature();
    state.lastUrl = location.href;
    sendMessage({ type: MESSAGES.PAGE_CHANGED, reason, url: location.href, at: new Date().toISOString() });
  }

  function reportChange(reason, options) {
    const opts = options || {};
    const now = Date.now();
    const throttle = Math.max(700, Number(state.settings.throttleMs) || 1500);
    const elapsed = now - state.lastReportAt;
    if (!opts.force && elapsed < throttle) {
      // 节流窗口内：记下原因，窗口结束后补发一次（trailing）
      state.pendingReason = reason;
      if (!state.pendingSince) state.pendingSince = now;
      if (!state.trailingTimer) {
        state.trailingTimer = setTimeout(() => {
          state.trailingTimer = null;
          const pending = state.pendingReason;
          if (pending) reportChange(pending, { force: true });
        }, Math.max(150, throttle - Math.max(0, elapsed)));
      }
      return;
    }
    emitChange(reason);
  }

  /** 变化风暴（动态页面）时也有强制上限，避免 debounce 一直被推迟 */
  function scheduleReport(reason, delayMs) {
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    if (!state.pendingSince) state.pendingSince = Date.now();
    const maxWait = Math.max(1500, (state.settings.throttleMs || 1500) * 3, REPORT.maxWaitMs);
    const remaining = Math.max(150, maxWait - (Date.now() - state.pendingSince));
    const delay = Math.min(Math.max(150, delayMs || state.settings.throttleMs || 1500), remaining);
    state.debounceTimer = setTimeout(() => {
      state.debounceTimer = null;
      reportChange(reason, { force: true });
    }, delay);
  }

  function onMaybeChanged(reason) {
    const signature = cheapSignature();
    const urlChanged = location.href !== state.lastUrl;
    if (urlChanged) {
      state.lastUrl = location.href;
      scheduleReport('navigation', 300);
      return;
    }
    if (signature !== state.lastCheapSignature) {
      scheduleReport(reason, state.settings.throttleMs || 1500);
    }
  }

  // ---------------------------------------------------------------------------
  // 监听器
  // ---------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const type = message && message.type;
    if (type === MESSAGES.EXTRACT) {
      if (state.requesting) {
        sendResponse({ ok: false, error: '正在抽取中' });
        return false;
      }
      state.requesting = true;
      extractDraft()
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ ok: false, error: (error && error.message) || String(error) }))
        .finally(() => { state.requesting = false; });
      return true; // async response
    }
    if (type === MESSAGES.CHECK_HEALTH) {
      sendResponse({ ok: true, url: location.href });
      return false;
    }
    return false;
  });

  // popstate / hashchange：SPA 前进后退
  window.addEventListener('popstate', () => scheduleReport('navigation', 300), true);
  window.addEventListener('hashchange', () => scheduleReport('navigation', 300), true);

  // 隔离世界拦不到页面自己的 history.pushState，用低频轮询兜底（页面隐藏时停掉）
  function startUrlWatch() {
    if (state.urlTimer) clearInterval(state.urlTimer);
    state.urlTimer = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      if (location.href !== state.lastUrl) {
        state.lastUrl = location.href;
        scheduleReport('navigation', 300);
      }
    }, REPORT.urlPollMs);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      startUrlWatch();
      onMaybeChanged('visible');
    }
  });

  // 内容变化：MutationObserver + trailing debounce
  function startObserver() {
    if (typeof MutationObserver !== 'function' || !document.body) return;
    const observer = new MutationObserver(() => onMaybeChanged('mutation'));
    observer.observe(document.body, { childList: true, subtree: true, characterData: false });
  }

  // 滚动停止后再上报（规格：滚动节流后重新上报）
  window.addEventListener('scroll', () => {
    if (state.scrollTimer) clearTimeout(state.scrollTimer);
    state.scrollTimer = setTimeout(() => {
      state.scrollTimer = null;
      onMaybeChanged('scroll');
    }, Math.max(800, state.settings.throttleMs || 1500));
  }, { passive: true, capture: true });

  // 选中文本变化（自动同步开启时才上报，否则只影响手动读取）
  document.addEventListener('selectionchange', () => {
    if (!state.settings.autoSync) return;
    if (state.selectionTimer) clearTimeout(state.selectionTimer);
    state.selectionTimer = setTimeout(() => {
      state.selectionTimer = null;
      if (core.extractSelection(window).length > 0) scheduleReport('selection', 400);
    }, REPORT.selectionDebounceMs);
  });

  // SW 可能重启，重连后重新告知设置（设置变更由 SW broadcast 到本频道）
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) {
      state.settings = core.normalizeSettings(changes.settings.newValue);
    }
  });

  // ---------------------------------------------------------------------------
  // 启动
  // ---------------------------------------------------------------------------

  async function bootstrap() {
    await loadSettings();
    state.lastCheapSignature = cheapSignature();
    startObserver();
    startUrlWatch();
    sendMessage({ type: MESSAGES.CONTENT_READY, url: location.href });
  }

  bootstrap();
}());
