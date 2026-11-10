/*!
 * DSH 侧边栏扩展 · service worker（background.js）
 * ---------------------------------------------------------------------------
 * 数据流：
 *   tabs.onActivated / onUpdated / onRemoved  ┐
 *   content 报「页面变了」                     ├─→ 通知 content 抽取草稿
 *   侧边栏点「读取当前页」                     ┘        ↓
 *                                            buildSnapshot（统一截断到规格上限）
 *                                                     ↓
 *                                  POST <bridge>/__bridge/context（3s 超时，重试 1 次）
 *                                                     ↓
 *                                  chrome.storage.session 缓存最近快照
 *
 * 隐私边界：
 *   - 只处理「当前活动标签页」（sender.tab.active 且 windowId 匹配），后台标签页永不抽取；
 *   - chrome:// / chrome-extension:// 等受限页面直接跳过（不注入、不上报）；
 *   - 跨域取文本（FETCH_TEXT）只允许 YouTube timedtext 主机，避免变成任意 URL 代理。
 *
 * 依赖：lib/core.js + lib/net.js（importScripts，经典脚本）
 */

importScripts('lib/core.js', 'lib/net.js');

const core = globalThis.DSHSidebarCore;
const net = globalThis.DSHNet;
const MESSAGES = core.MESSAGES;

const STORAGE = {
  settings: 'settings',
  health: 'bridgeHealth',
  lastResult: 'lastResult',
  activeTabId: 'activeTabId',
  snapshotPrefix: 'snap:',
  maxCachedTabs: 20,
};

const state = {
  inFlight: new Map(),      // tabId -> Promise（合并并发同步）
  lastSyncAt: new Map(),    // tabId -> 时间戳（节流）
};

// ===========================================================================
// 存储 / 广播
// ===========================================================================

async function getSettings() {
  try {
    const data = await chrome.storage.local.get({ settings: null });
    return core.normalizeSettings(data.settings);
  } catch (_) {
    return core.normalizeSettings({});
  }
}

async function getSession(keys) {
  try {
    const data = await chrome.storage.session.get(keys === undefined ? null : keys);
    return data || {};
  } catch (_) {
    return {};
  }
}

async function setSession(values) {
  try {
    await chrome.storage.session.set(values);
  } catch (_) { /* 忽略 session 存储失败，不影响主流程 */ }
}

async function removeSession(keys) {
  try {
    await chrome.storage.session.remove(keys);
  } catch (_) { /* ignore */ }
}

/** 向所有扩展页面（side panel / options）广播；没有监听者时会 reject，忽略即可 */
function broadcast(message) {
  try {
    const maybe = chrome.runtime.sendMessage(message);
    if (maybe && typeof maybe.catch === 'function') maybe.catch(() => {});
  } catch (_) { /* 无接收方 */ }
}

// ===========================================================================
// bridge 健康检查
// ===========================================================================

/**
 * 探测 /__bridge/health。
 * @returns {Promise<{status:'ok'|'degraded'|'down', ok:boolean, bridgeUrl:string, checkedAt:string,
 *   latencyMs:number, version?:string, upstream?:any, error?:string}>}
 */
async function probeHealth(options) {
  const opts = options || {};
  const settings = await getSettings();
  const endpoints = core.buildBridgeEndpoints(settings.bridgeUrl);
  const result = await net.getJson(endpoints.health, { timeoutMs: settings.requestTimeoutMs });
  const checkedAt = new Date().toISOString();
  let health;
  if (!result.ok) {
    health = {
      status: 'down',
      ok: false,
      bridgeUrl: endpoints.base,
      checkedAt,
      latencyMs: result.durationMs || 0,
      error: result.error || '无法连接 bridge',
    };
  } else {
    const data = result.data && typeof result.data === 'object' ? result.data : {};
    const upstreamOk = !!(data.upstream && data.upstream.ok);
    const alive = data.ok !== false;
    health = {
      status: alive ? (upstreamOk ? 'ok' : 'degraded') : 'down',
      ok: alive,
      bridgeUrl: endpoints.base,
      checkedAt,
      latencyMs: result.durationMs || 0,
      version: typeof data.version === 'string' ? data.version : '',
      upstream: data.upstream || null,
      context: data.context || null,
      error: alive ? (upstreamOk ? '' : 'bridge 已启动，但代理上游（DSH Host）不可达') : 'bridge 自检返回 ok=false',
    };
  }
  await setSession({ [STORAGE.health]: health });
  if (opts.broadcast !== false) broadcast({ type: MESSAGES.STATE_CHANGED, health });
  return health;
}

// ===========================================================================
// 与 content script 通信
// ===========================================================================

function sendToTab(tabId, message, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, error: 'content script 响应超时' });
    }, timeoutMs || 10000);
    try {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          resolve({ ok: false, error: lastError.message || String(lastError) });
          return;
        }
        resolve(response === undefined ? { ok: false, error: 'content script 无响应' } : response);
      });
    } catch (error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: (error && error.message) || String(error) });
    }
  });
}

/** 确保目标标签页有 content script：先 ping，失败则手动注入（新装扩展/旧页面场景） */
async function ensureContentScript(tabId) {
  const ping = await sendToTab(tabId, { type: MESSAGES.CHECK_HEALTH }, 2000);
  if (ping && ping.ok) return true;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['lib/core.js', 'lib/net.js', 'content.js'],
    });
    return true;
  } catch (error) {
    // 受限页面（chrome://、Web Store、PDF 查看器等）会失败，属预期
    return false;
  }
}

/** 在 page world 读取 ytInitialPlayerResponse（只回传必要字段，避免几 MB 的大对象） */
function ytProbeInPage() {
  const out = {
    hasPlayerResponse: false,
    title: '',
    author: '',
    durationSec: 0,
    videoId: '',
    playability: '',
    tracks: [],
  };
  const titleFromDom = () => {
    const og = document.querySelector('meta[property="og:title"]');
    return (og && og.getAttribute('content')) || document.title || '';
  };
  let pr = null;
  try { pr = window.ytInitialPlayerResponse; } catch (_) { pr = null; }
  if (!pr || typeof pr !== 'object') {
    out.title = titleFromDom();
    return out;
  }
  out.hasPlayerResponse = true;
  const vd = pr.videoDetails || {};
  out.title = vd.title || titleFromDom();
  out.author = vd.author || '';
  out.durationSec = Number(vd.lengthSeconds) || 0;
  out.videoId = vd.videoId || '';
  out.playability = (pr.playabilityStatus && pr.playabilityStatus.status) || '';
  const renderer = pr.captions && pr.captions.playerCaptionsTracklistRenderer;
  const list = (renderer && renderer.captionTracks) || [];
  out.tracks = list.map((t) => {
    let name = '';
    if (t && t.name) {
      if (typeof t.name.simpleText === 'string') name = t.name.simpleText;
      else if (Array.isArray(t.name.runs)) name = t.name.runs.map((r) => (r && r.text) || '').join('');
    }
    return {
      lang: (t && t.languageCode) || '',
      name,
      kind: (t && t.kind) || '',
      baseUrl: (t && t.baseUrl) || '',
    };
  });
  return out;
}

/** 只允许 YouTube timedtext 主机，防止被当成通用 CORS 代理 */
const CAPTION_URL_ALLOWLIST = [
  /^https:\/\/(?:www\.|m\.)?youtube\.com\/api\/timedtext\b/i,
  /^https:\/\/video\.google\.com\/api\/timedtext\b/i,
  /^https:\/\/(?:www\.)?youtube-nocookie\.com\/api\/timedtext\b/i,
];

function isAllowedCaptionUrl(url) {
  return CAPTION_URL_ALLOWLIST.some((re) => re.test(String(url || '')));
}

/** 在 page world 读 B 站 window.__INITIAL_STATE__，只回传少量字段 */
function biliProbeInPage() {
  const out = {
    hasInitialState: false,
    bvid: '',
    aid: 0,
    cid: 0,
    title: '',
    durationSec: 0,
    author: '',
    pageCount: 0,
    pageIndex: 1,
    pageNo: 1,
    subtitleTracks: [],
    allowSubmit: false,
  };
  let state = null;
  try { state = window.__INITIAL_STATE__; } catch (_) { state = null; }
  if (!state || typeof state !== 'object') {
    out.title = document.title || '';
    return out;
  }
  out.hasInitialState = true;
  const vd = state.videoData || {};
  if (!vd || typeof vd !== 'object') {
    out.title = document.title || '';
    return out;
  }
  out.bvid = vd.bvid || state.bvid || '';
  out.aid = Number(vd.aid || state.aid) || 0;
  out.cid = Number(vd.cid) || 0;
  out.title = vd.title || document.title || '';
  out.durationSec = Number(vd.duration) || 0;
  out.author = (vd.owner && (vd.owner.name || vd.owner.uname)) || '';
  const pages = Array.isArray(vd.pages) ? vd.pages : [];
  out.pageCount = pages.length;
  // 当前分 P：videoData.pageNo 优先（B 站 1-based），URL ?p= 兜底
  let pageIndex = Number(vd.pageNo) || 0;
  if (!pageIndex) {
    try {
      const p = Number(new URL(location.href).searchParams.get('p'));
      if (Number.isFinite(p) && p >= 1) pageIndex = Math.trunc(p);
    } catch (_) { pageIndex = 0; }
  }
  if (!pageIndex) pageIndex = 1;
  out.pageIndex = pageIndex;
  out.pageNo = pageIndex;
  if (pages.length) {
    const page = pages[Math.min(pageIndex, pages.length) - 1];
    if (page && page.cid) out.cid = Number(page.cid) || out.cid;
  }
  if (!out.cid && pages.length && pages[0] && pages[0].cid) out.cid = Number(pages[0].cid) || 0;

  // 关键：登录态下 videoData.subtitle.list 自带 subtitle_url（零 API 路径）
  const subtitle = vd.subtitle || state.subtitle;
  if (subtitle && typeof subtitle === 'object') {
    out.allowSubmit = !!subtitle.allow_submit;
    const list = Array.isArray(subtitle.list) ? subtitle.list : [];
    out.subtitleTracks = list.slice(0, 20).map((item) => {
      const lan = (item && item.lan) || '';
      const lanDoc = (item && (item.lan_doc || item.lanDoc)) || lan;
      const url = (item && (item.subtitle_url || item.subtitle_url_v2)) || '';
      return {
        lan,
        lanDoc,
        url: String(url || ''),
        isAi: /^ai[-_]/i.test(String(lan)) || /自动生成|AI|机器/i.test(String(lanDoc)),
        isLock: !!(item && item.is_lock),
      };
    }).filter((track) => !!track.url);
  }
  return out;
}

/**
 * 取 B 站字幕。
 *
 * 两种模式：
 *   A) 页面态零 API：message.subtitleUrl = __INITIAL_STATE__.videoData.subtitle.list[i].subtitle_url
 *      → 直接拉字幕 JSON（登录态下最常见，也最快）
 *   B) API 兜底：message.bvid/aid + cid → player/v2（credentials: include）→ 选轨 → 拉字幕 JSON
 *
 * 全部失败都返回 {ok:false, error, stage}，不 throw；由 content script 决定退化为 page-text。
 */
async function fetchBiliSubtitles(message) {
  const timeoutMs = 5000;
  const bvid = String((message && message.bvid) || '').trim();
  const aid = Number(message && message.aid) || 0;
  const cid = Number(message && message.cid) || 0;
  const directUrl = core.normalizeProtocolRelativeUrl(String((message && message.subtitleUrl) || '').trim());
  const durationSec = Number(message && message.durationSec) || 0;

  // A) 页面态字幕 URL：跳过 player/v2
  if (directUrl) {
    if (!core.isAllowedBiliFetchUrl(directUrl)) {
      return { ok: false, error: `字幕地址不在白名单：${directUrl.slice(0, 120)}`, stage: 'page-state' };
    }
    const direct = await fetchBiliSubtitleBody(directUrl, timeoutMs, durationSec);
    if (!direct.ok) return Object.assign({ stage: 'page-state' }, direct);
    return {
      ok: true,
      source: 'page-state',
      track: (message && message.track) || null,
      cues: direct.cues,
      via: 'service-worker',
    };
  }

  if (!cid || (!bvid && !aid)) {
    return { ok: false, error: '缺少 bvid/aid/cid，无法查询字幕', stage: 'input' };
  }
  const apiUrl = core.buildBiliPlayerV2Url({ bvid, aid, cid });
  if (!core.isAllowedBiliFetchUrl(apiUrl)) {
    return { ok: false, error: 'player/v2 地址不在白名单', stage: 'input' };
  }

  // B1) player/v2（带登录态 cookie；扩展 SW 有 host 权限可跨域）
  let apiResult;
  try {
    apiResult = await net.getJson(apiUrl, {
      timeoutMs,
      credentials: 'include',
      headers: {
        accept: 'application/json, text/plain, */*',
        // 说明：Referer 是浏览器禁止头，扩展无法伪造；部分风控接口可能因此返回 -352/-403
        'x-requested-with': 'XMLHttpRequest',
      },
    });
  } catch (error) {
    return { ok: false, error: `player/v2 请求异常：${(error && error.message) || error}`, stage: 'api' };
  }
  if (!apiResult.ok) {
    return { ok: false, error: apiResult.error || 'player/v2 请求失败', stage: 'api' };
  }
  const parsed = core.parseBiliPlayerv2Response(apiResult.data);
  if (!parsed.ok) {
    return { ok: false, error: parsed.message || `B 站接口返回 code=${parsed.code}`, stage: 'api', code: parsed.code };
  }
  const track = core.pickBiliSubtitleTrack(parsed.subtitles);
  if (!track) {
    return {
      ok: false,
      error: '该视频没有可用字幕（未登录时 player/v2 的 subtitle.subtitles 为空，属预期）',
      stage: 'tracks',
      empty: true,
    };
  }

  // B2) 字幕 JSON（subtitle_url 常见为协议相对 //aisubtitle.hdslb.com/...）
  const subtitleUrl = core.normalizeProtocolRelativeUrl(track.url);
  if (!core.isAllowedBiliFetchUrl(subtitleUrl)) {
    return { ok: false, error: `字幕地址不在白名单：${subtitleUrl.slice(0, 120)}`, stage: 'tracks' };
  }
  const body = await fetchBiliSubtitleBody(subtitleUrl, timeoutMs, durationSec);
  if (!body.ok) return Object.assign({ stage: 'body' }, body);
  return {
    ok: true,
    source: 'api',
    track: { lan: track.lan, lanDoc: track.lanDoc, ai: track.isAi },
    cues: body.cues,
    via: 'service-worker',
  };
}

/** 拉 B 站字幕 JSON（{body:[{from,to,content}]}）并解析成 cues */
async function fetchBiliSubtitleBody(url, timeoutMs, durationSec) {
  let result;
  try {
    result = await net.fetchWithTimeout(url, {
      timeoutMs: timeoutMs || 5000,
      credentials: 'include',
      headers: { accept: 'application/json, text/plain, */*' },
    });
  } catch (error) {
    return { ok: false, error: `字幕请求异常：${(error && error.message) || error}` };
  }
  if (!result.ok) return { ok: false, error: result.error || '字幕请求失败' };
  if (!result.response.ok) return { ok: false, error: `字幕 HTTP ${result.response.status}` };
  let text = '';
  try {
    text = await result.response.text();
  } catch (error) {
    return { ok: false, error: `字幕读取失败：${(error && error.message) || error}` };
  }
  const cues = core.parseBiliSubtitleText(text, { durationSec: Number(durationSec) || 0 });
  if (!cues.length) return { ok: false, error: '字幕内容为空或解析失败', empty: true };
  return { ok: true, cues };
}

/** 跨域取 timedtext（SW 有 <all_urls> host 权限，不受 CORS 限制） */
async function fetchCaptionText(url) {
  if (!isAllowedCaptionUrl(url)) {
    return { ok: false, error: '拒绝：只允许抓取 YouTube timedtext 地址' };
  }
  const settings = await getSettings();
  const result = await net.fetchWithTimeout(url, { timeoutMs: Math.max(settings.requestTimeoutMs, 5000) });
  if (!result.ok) return { ok: false, error: result.error };
  const { response } = result;
  if (!response.ok) return { ok: false, error: `timedtext HTTP ${response.status}` };
  try {
    const body = await response.text();
    return { ok: true, body, contentType: response.headers.get('content-type') || '' };
  } catch (error) {
    return { ok: false, error: `读取 timedtext 失败：${(error && error.message) || error}` };
  }
}

// ===========================================================================
// 同步一个标签页
// ===========================================================================

async function cacheSnapshot(tabId, snapshot, meta) {
  const session = await getSession(null);
  const prefix = STORAGE.snapshotPrefix;
  const entries = Object.keys(session)
    .filter((key) => key.startsWith(prefix))
    .map((key) => ({ key, savedAt: (session[key] && session[key].savedAt) || 0 }))
    .sort((a, b) => b.savedAt - a.savedAt);
  await setSession({
    [prefix + tabId]: { tabId, snapshot, savedAt: Date.now(), source: meta && meta.source },
  });
  // 超出上限时裁剪最旧的
  const extra = entries
    .filter((entry) => entry.key !== `${prefix}${tabId}`)
    .slice(STORAGE.maxCachedTabs - 1)
    .map((entry) => entry.key);
  if (extra.length) await removeSession(extra);
}

async function getCachedSnapshot(tabId) {
  const session = await getSession(null);
  const entry = session[`${STORAGE.snapshotPrefix}${tabId}`];
  return entry ? entry.snapshot : null;
}

async function recordResult(tabId, result) {
  const payload = Object.assign({
    tabId,
    at: new Date().toISOString(),
  }, result);
  await setSession({ [STORAGE.lastResult]: payload });
  broadcast({ type: MESSAGES.STATE_CHANGED, lastResult: payload });
  return payload;
}

/**
 * 只更新 bridge 的「活动标签页」，不重发整页内容（切页时内容可能没变）。
 * 失败不重试、不影响主流程：active 只是 browser_page 的默认目标。
 */
async function reportActive(settings, tabId) {
  if (!Number.isSafeInteger(tabId)) return;
  try {
    const endpoints = core.buildBridgeEndpoints(settings.bridgeUrl);
    await net.postJson(endpoints.active, { tabId, at: new Date().toISOString() }, { timeoutMs: 1500 });
  } catch (_) { /* bridge 不在线时忽略 */ }
}

/**
 * 抽取 + 推送。同一标签页并发调用会复用同一个 Promise。
 * @param {number} tabId
 * @param {{reason?:string, force?:boolean}} [options]
 */
function syncTab(tabId, options) {
  const opts = options || {};
  if (state.inFlight.has(tabId)) return state.inFlight.get(tabId);
  const task = doSyncTab(tabId, opts).finally(() => state.inFlight.delete(tabId));
  state.inFlight.set(tabId, task);
  return task;
}

async function doSyncTab(tabId, options) {
  const opts = options || {};
  const settings = await getSettings();
  const source = opts.reason || 'manual';
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (_) {
    return recordResult(tabId, { ok: false, source, error: '标签页已关闭' });
  }
  if (!tab || !tab.url || core.isRestrictedUrl(tab.url)) {
    return recordResult(tabId, { ok: false, source, skipped: true, error: '受限页面（chrome:// / 扩展页 / 非 http(s)）不读取' });
  }
  // 侧边栏 iframe 指向 bridge 代理（http://127.0.0.1:41789/），它本身是一个
  // 普通 http 页面；如果用户在新标签页里打开了同一个地址，不要把它当成
  // “当前网页”同步回 DSH（否则会把侧边栏自己当作内容源）。
  if (core.isBridgeOrigin(tab.url, settings.bridgeUrl)) {
    return recordResult(tabId, { ok: false, source, skipped: true, error: '这是 DSH 侧边栏自身页面，不同步' });
  }

  const ready = await ensureContentScript(tabId);
  if (!ready) {
    return recordResult(tabId, { ok: false, source, error: '无法注入内容脚本（页面受限或尚未加载完成）' });
  }

  const extraction = await sendToTab(tabId, { type: MESSAGES.EXTRACT }, 15000);
  if (!extraction || !extraction.ok) {
    const reason = extraction && extraction.error ? extraction.error : '抽取失败';
    return recordResult(tabId, { ok: false, source, error: reason });
  }
  const draft = extraction.draft || {};

  const snapshot = core.buildSnapshot({
    tabId,
    windowId: tab.windowId,
    active: !!tab.active,
    url: draft.url || tab.url,
    title: draft.title || tab.title,
    siteName: draft.siteName || core.siteNameFromUrl(draft.url || tab.url),
    selection: draft.selection,
    meta: draft.meta,
    content: draft.content,
    video: draft.video,
    limits: core.settingsToLimits(settings),
  });

  const validation = core.validateSnapshot(snapshot);
  if (!validation.ok) {
    return recordResult(tabId, {
      ok: false,
      source,
      error: `快照结构校验失败：${validation.errors.slice(0, 3).join('；')}`,
      summary: core.snapshotSummary(snapshot),
    });
  }

  // 自动同步去重：同一标签页内容签名没变就跳过网络请求
  const cached = await getCachedSnapshot(tabId);
  if (!opts.force && cached && core.snapshotSignature(cached) === core.snapshotSignature(snapshot)) {
    // 内容没变，但「哪个标签页是当前页」可能刚变过（切页/聚焦）。仍然把
    // activeTabId 告诉 bridge，否则 DSH agent 的 browser_page 会读到上一个
    // 标签页的内容。
    void reportActive(settings, tabId);
    return recordResult(tabId, {
      ok: true,
      deduped: true,
      source,
      summary: core.snapshotSummary(snapshot),
    });
  }

  const endpoints = core.buildBridgeEndpoints(settings.bridgeUrl);
  const posted = await net.withRetry(
    () => net.postJson(endpoints.context, snapshot, { timeoutMs: settings.requestTimeoutMs }),
    { retries: 1, delayMs: 200 },
  );

  if (!posted.ok) {
    // 推送失败也缓存本地快照，方便「最近一次成功读取」展示
    await cacheSnapshot(tabId, snapshot, { source });
    const health = await probeHealth({ broadcast: false });
    const failure = await recordResult(tabId, { ok: false, source, error: posted.error, bridge: endpoints.base });
    broadcast({ type: MESSAGES.STATE_CHANGED, health });
    return Object.assign({ health, summary: core.snapshotSummary(snapshot) }, failure);
  }

  await cacheSnapshot(tabId, snapshot, { source });
  const health = await probeHealth({ broadcast: false });
  const result = {
    ok: true,
    source,
    id: (posted.data && posted.data.id) || snapshot.id,
    updatedAt: (posted.data && posted.data.updatedAt) || snapshot.capturedAt,
    attempts: posted.attempts,
    summary: core.snapshotSummary(snapshot),
    bridge: endpoints.base,
  };
  await recordResult(tabId, result);
  broadcast({ type: MESSAGES.STATE_CHANGED, health, lastResult: result });
  return result;
}

// ===========================================================================
// 状态汇总（给 side panel / options）
// ===========================================================================

async function buildState() {
  const settings = await getSettings();
  const session = await getSession(null);
  let activeTabId = typeof session[STORAGE.activeTabId] === 'number' ? session[STORAGE.activeTabId] : null;
  if (activeTabId === null) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      activeTabId = tab ? tab.id : null;
    } catch (_) { activeTabId = null; }
  }
  const snapEntry = activeTabId !== null ? session[`${STORAGE.snapshotPrefix}${activeTabId}`] : null;
  const snapshot = snapEntry ? snapEntry.snapshot : null;
  // 「当前页面」状态条必须以**实时活动标签页**为准（不能用快照里的旧 title/url，否则会掩盖「页面已变化」）
  let title = '';
  let url = '';
  let tabMatched = false;
  if (activeTabId !== null) {
    try {
      const tab = await chrome.tabs.get(activeTabId);
      title = tab.title || '';
      url = tab.url || '';
      tabMatched = true;
    } catch (_) { /* 标签页可能刚关闭 */ }
  }
  if (!tabMatched && snapshot) {
    // 拿不到实时标签页时退回快照信息（只影响展示，statusBar 会按 tab 不一致给警告）
    title = snapshot.title;
    url = snapshot.url;
  }
  // 全量快照里最新的一条：用户切到「还没同步过的新页面」时，状态条要能说出
  // agent 现在实际看到的是哪一页（而不是只显示“尚未读取”）。
  let lastSnapshot = null;
  if (session !== null && typeof session === 'object') {
    for (const [key, entry] of Object.entries(session)) {
      if (!key.startsWith(STORAGE.snapshotPrefix)) continue;
      const cached = entry && entry.snapshot;
      if (!cached || typeof cached.tabId !== 'number') continue;
      const savedAt = Number(entry.savedAt) || 0;
      if (lastSnapshot === null || savedAt > lastSnapshot.savedAt) {
        lastSnapshot = { tabId: cached.tabId, title: cached.title || '', url: cached.url || '', savedAt };
      }
    }
  }
  return {
    ok: true,
    settings,
    health: session[STORAGE.health] || null,
    lastResult: session[STORAGE.lastResult] || null,
    activeTabId,
    // 侧边栏「当前页面」状态条需要：快照属于哪个 tab、是哪一页、什么时候同步的
    snapshotTabId: snapshot ? snapshot.tabId : null,
    snapshotTitle: snapshot ? snapshot.title : '',
    snapshotUrl: snapshot ? snapshot.url : '',
    snapshotSavedAt: snapEntry ? snapEntry.savedAt : 0,
    syncedAt: snapEntry ? snapEntry.savedAt : 0,
    snapshotSummary: snapshot ? core.snapshotSummary(snapshot) : null,
    lastSnapshot,
    tab: { title, url, restricted: core.isRestrictedUrl(url || '') },
    summary: snapshot ? core.snapshotSummary(snapshot) : null,
    version: chrome.runtime.getManifest().version,
  };
}

// ===========================================================================
// 消息路由
// ===========================================================================

async function readActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

async function handleMessage(message, sender) {
  const type = message && message.type;
  const senderTab = sender && sender.tab ? sender.tab : null;

  switch (type) {
    case MESSAGES.CONTENT_READY: {
      const settings = await getSettings();
      if (senderTab && senderTab.active && settings.autoSync) {
        await setSession({ [STORAGE.activeTabId]: senderTab.id });
        syncTab(senderTab.id, { reason: 'ready' });
      }
      return { ok: true };
    }

    case MESSAGES.PAGE_CHANGED: {
      const settings = await getSettings();
      if (!settings.autoSync || !senderTab || !senderTab.active) return { ok: true, ignored: true };
      // 每个标签页一个节流窗口（content 侧已 debounce，这里再兜一层）
      const last = state.lastSyncAt.get(senderTab.id) || 0;
      if (Date.now() - last < Math.max(500, settings.throttleMs)) return { ok: true, throttled: true };
      state.lastSyncAt.set(senderTab.id, Date.now());
      syncTab(senderTab.id, { reason: message.reason || 'changed' });
      return { ok: true };
    }

    case MESSAGES.YT_PROBE: {
      if (!senderTab || typeof senderTab.id !== 'number') return { ok: false, error: '无标签页上下文' };
      const youtubeWorld = { ok: false, error: '读取 ytInitialPlayerResponse 失败' };
      if (!core.parseYouTubeUrl(senderTab.url || '').isYouTube) {
        return { ok: false, error: '非 YouTube 页面' };
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const results = await chrome.scripting.executeScript({
            target: { tabId: senderTab.id },
            world: 'MAIN',
            func: ytProbeInPage,
          });
          const probe = results && results[0] ? results[0].result : null;
          if (probe && (probe.hasPlayerResponse || probe.title)) {
            return { ok: true, probe };
          }
        } catch (error) {
          youtubeWorld.error = (error && error.message) || String(error);
        }
        if (attempt === 0) await net.sleep(400); // 有些页面 player response 稍晚出现
      }
      return youtubeWorld;
    }

    case MESSAGES.BILI_PROBE: {
      if (!senderTab || typeof senderTab.id !== 'number') return { ok: false, error: '无标签页上下文' };
      if (!core.parseBilibiliUrl(senderTab.url || '').isBilibili) {
        return { ok: false, error: '非 B 站页面' };
      }
      const failure = { ok: false, error: '读取 __INITIAL_STATE__ 失败' };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const results = await chrome.scripting.executeScript({
            target: { tabId: senderTab.id },
            world: 'MAIN',
            func: biliProbeInPage,
          });
          const probe = results && results[0] ? results[0].result : null;
          if (probe && (probe.hasInitialState || probe.title || probe.bvid)) {
            return { ok: true, probe };
          }
        } catch (error) {
          failure.error = (error && error.message) || String(error);
        }
        if (attempt === 0) await net.sleep(400);
      }
      return failure;
    }

    case MESSAGES.BILI_SUBTITLES:
      return fetchBiliSubtitles(message);

    case MESSAGES.FETCH_TEXT: {
      return fetchCaptionText(message && message.url);
    }

    case MESSAGES.SYNC_ACTIVE: {
      const tab = (senderTab && senderTab.active ? senderTab : null) || await readActiveTab();
      if (!tab) return { ok: false, error: '没有活动标签页' };
      return syncTab(tab.id, { reason: 'manual', force: true });
    }

    case MESSAGES.GET_STATE:
      return buildState();

    case MESSAGES.CHECK_HEALTH:
      return probeHealth({ broadcast: false });

    case MESSAGES.SETTINGS_UPDATED: {
      const settings = await getSettings();
      broadcast({ type: MESSAGES.STATE_CHANGED, settings });
      const health = await probeHealth({ broadcast: false });
      broadcast({ type: MESSAGES.STATE_CHANGED, health });
      return { ok: true, settings, health };
    }

    default:
      return { ok: false, error: `未知消息类型：${type}` };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({ ok: false, error: (error && error.message) || String(error) }));
  return true; // 异步响应
});

// ===========================================================================
// 标签页事件
// ===========================================================================

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  await setSession({ [STORAGE.activeTabId]: activeInfo.tabId });
  broadcast({ type: MESSAGES.STATE_CHANGED, activeTabId: activeInfo.tabId });
  const settings = await getSettings();
  if (settings.autoSync) syncTab(activeInfo.tabId, { reason: 'activated' });
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!tab || !tab.active) return;              // 只在活动标签页上自动同步
  const settings = await getSettings();
  if (changeInfo.url) {
    broadcast({ type: MESSAGES.STATE_CHANGED, activeTabId: tabId });
    // 自动同步关闭时，只更新「当前活动标签」状态，不推送内容。
    if (settings.autoSync) syncTab(tabId, { reason: 'navigation' });
    else broadcast({ type: MESSAGES.STATE_CHANGED, activeTabId: tabId });
    return;
  }
  if (changeInfo.status === 'complete' && settings.autoSync) {
    syncTab(tabId, { reason: 'load' });
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  state.lastSyncAt.delete(tabId);
  await removeSession([`${STORAGE.snapshotPrefix}${tabId}`]);
  broadcast({ type: MESSAGES.STATE_CHANGED, removedTabId: tabId });
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (tab) {
      await setSession({ [STORAGE.activeTabId]: tab.id });
      const settings = await getSettings();
      if (settings.autoSync) syncTab(tab.id, { reason: 'focus' });
    }
  } catch (_) { /* ignore */ }
});

// action 点击 → 打开侧边栏（≥Chrome 116 支持 chrome.sidePanel.open，需用户手势）
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch (error) {
    console.warn('[DSH sidepanel] 打开侧边栏失败：', error);
  }
  try {
    const settings = await getSettings();
    if (tab && typeof tab.id === 'number' && settings.autoSync) {
      syncTab(tab.id, { reason: 'action' });
    }
  } catch (_) { /* ignore */ }
});

// ===========================================================================
// 生命周期
// ===========================================================================

chrome.runtime.onInstalled.addListener(async (details) => {
  try {
    const stored = await chrome.storage.local.get({ settings: null });
    if (!stored.settings) {
      await chrome.storage.local.set({ settings: core.normalizeSettings({}) });
    }
  } catch (_) { /* ignore */ }
  probeHealth({ broadcast: false });
  // 扩展被重新加载/更新后，已打开标签页里的旧内容脚本会失效，自动同步会静默停掉。
  // 这里对当前活动标签补一次注入 + 同步，避免用户以为“切了页但 agent 一直看旧页”。
  if (details && (details.reason === 'install' || details.reason === 'update')) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const settings = await getSettings();
      if (tab && typeof tab.id === 'number' && tab.url && !core.isRestrictedUrl(tab.url) && settings.autoSync) {
        await syncTab(tab.id, { reason: 'installed' });
      }
    } catch (_) { /* best effort */ }
  }
  if (details && details.reason === 'install') {
    try { await chrome.runtime.openOptionsPage(); } catch (_) { /* ignore */ }
  }
});

chrome.runtime.onStartup.addListener(() => {
  probeHealth({ broadcast: false });
});
