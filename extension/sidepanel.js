/*!
 * DSH 侧边栏扩展 · side panel 逻辑（ES module，无构建工具）
 * ---------------------------------------------------------------------------
 * 顶部工具条状态全部由 service worker 汇总（GET_STATE / CHECK_HEALTH），
 * 这样 side panel 反复开关也不会丢状态；SW 睡眠时消息会把 SW 唤醒。
 *
 * 依赖（经典脚本，先加载）：globalThis.DSHSidebarCore、globalThis.DSHNet
 */

const core = globalThis.DSHSidebarCore;
const net = globalThis.DSHNet;
const MESSAGES = core.MESSAGES;

const $ = (id) => document.getElementById(id);

const ui = {
  dot: $('statusDot'),
  label: $('statusLabel'),
  status: $('status'),
  sync: $('btnSync'),
  autoSync: $('autoSync'),
  open: $('btnOpen'),
  options: $('btnOptions'),
  frame: $('bridgeFrame'),
  loading: $('loading'),
  guide: $('guideCard'),
  guideReason: $('guideReason'),
  addr: $('bridgeAddr'),
  healthLink: $('healthLink'),
  retry: $('btnRetry'),
  guideOptions: $('btnGuideOptions'),
  toast: $('toast'),
  // 「当前页面」状态条
  pagebar: $('pagebar'),
  pagebarIcon: $('pagebarIcon'),
  pagebarTitle: $('pagebarTitle'),
  pagebarHost: $('pagebarHost'),
  pagebarStatus: $('pagebarStatus'),
  syncCurrent: $('btnSyncCurrent'),
};

const state = {
  settings: core.normalizeSettings({}),
  health: null,
  loadedSrc: '',
  frameLoaded: false,
  syncing: false,
  pollTimer: null,
  toastTimer: null,
  loadWatchTimer: null,
  lastErrorAt: 0,
  remote: null,        // 最近一次 GET_STATE 的结果（当前页面状态条的数据源）
  pagebarTimer: null,
  stateRefreshTimer: null,
  contextStale: false, // 扩展被重新加载后，旧侧边栏页面的 chrome.runtime 会失效
};

const HEALTH_LABEL = { ok: '已连接', degraded: '降级', down: '未连接', unknown: '未检测' };

// ---------------------------------------------------------------------------
// 与 service worker 通信
// ---------------------------------------------------------------------------

function isStaleContextError(message) {
  const text = String(message || '').toLowerCase();
  return text.includes('extension context invalidated')
    || text.includes('context invalidated')
    || text.includes('receiving end does not exist')
    || text.includes('message port closed');
}

function send(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          const text = lastError.message || String(lastError);
          if (isStaleContextError(text)) markContextStale();
          resolve({ ok: false, error: text });
          return;
        }
        if (state.contextStale) {
          state.contextStale = false;
          renderPagebar();
        }
        resolve(response === undefined ? { ok: false, error: '无响应' } : response);
      });
    } catch (error) {
      const text = (error && error.message) || String(error);
      if (isStaleContextError(text)) markContextStale();
      resolve({ ok: false, error: text });
    }
  });
}

/**
 * 扩展在 chrome://extensions 里被「重新加载」后，已经打开的侧边栏页面会失去
 * chrome.runtime 上下文：所有按钮点了都没反应。这里把它变成一条可见提示，
 * 并给出「重新打开侧边栏」的按钮（老版本是静默失败，用户以为读取没生效）。
 */
function markContextStale() {
  if (state.contextStale) return;
  state.contextStale = true;
  try { renderPagebar(); } catch (_) { /* ignore */ }
}

/** 问 SW 要健康状态；SW 不可用时退化成 side panel 自己 fetch（bridge CORS 允许扩展源） */
async function checkHealth() {
  const viaSw = await send({ type: MESSAGES.CHECK_HEALTH });
  if (viaSw && typeof viaSw.status === 'string') return viaSw;

  const endpoints = core.buildBridgeEndpoints(state.settings.bridgeUrl);
  const result = await net.getJson(endpoints.health, { timeoutMs: state.settings.requestTimeoutMs });
  const checkedAt = new Date().toISOString();
  if (!result.ok) {
    return { status: 'down', ok: false, checkedAt, bridgeUrl: endpoints.base, latencyMs: result.durationMs || 0, error: result.error };
  }
  const data = result.data && typeof result.data === 'object' ? result.data : {};
  const upstreamOk = !!(data.upstream && data.upstream.ok);
  const alive = data.ok !== false;
  return {
    status: alive ? (upstreamOk ? 'ok' : 'degraded') : 'down',
    ok: alive,
    checkedAt,
    bridgeUrl: endpoints.base,
    latencyMs: result.durationMs || 0,
    version: typeof data.version === 'string' ? data.version : '',
    upstream: data.upstream || null,
    error: alive ? (upstreamOk ? '' : '代理上游不可达') : 'bridge 自检失败',
  };
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

function toast(text, kind) {
  if (!ui.toast) return;
  ui.toast.textContent = text;
  ui.toast.dataset.kind = kind || 'info';
  ui.toast.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => { ui.toast.hidden = true; }, kind === 'error' ? 6000 : 3200);
}

function showLoading(visible) {
  ui.loading.hidden = !visible;
  if (visible) ui.loading.style.display = 'flex';
  else ui.loading.style.display = 'none';
}

function showGuide(reason, options) {
  const opts = options || {};
  if (state.frameLoaded && !opts.force) return; // 已经能用就不要因为一次探测失败把 UI 换掉
  ui.guideReason.textContent = reason || '请确认本机 DSH 与 bridge 插件已启动。';
  ui.guide.hidden = false;
  ui.frame.hidden = true;
  showLoading(false);
}

function hideGuide() {
  ui.guide.hidden = true;
  ui.frame.hidden = false;
}

function renderHealth() {
  const health = state.health;
  const status = health && health.status ? health.status : 'unknown';
  ui.dot.dataset.status = status;
  ui.label.textContent = HEALTH_LABEL[status] || '未检测';

  const parts = [];
  if (health && health.bridgeUrl) parts.push(`bridge: ${health.bridgeUrl}`);
  if (health && health.version) parts.push(`v${health.version}`);
  if (health && typeof health.latencyMs === 'number') parts.push(`${health.latencyMs}ms`);
  if (health && health.upstream) parts.push(`DSH: ${health.upstream.ok ? 'ok' : '挂起'}`);
  if (health && health.error) parts.push(health.error);
  ui.status.title = parts.length ? parts.join(' · ') : '连接状态未知';

  ui.addr.textContent = state.settings.bridgeUrl;
  ui.healthLink.textContent = `${state.settings.bridgeUrl}/__bridge/health`;

  if (status === 'ok') {
    hideGuide();
    ensureFrame();
  } else if (status === 'degraded') {
    showGuide('bridge 已启动，但它到 DSH Web（http://127.0.0.1:4064）的上游连接不可用。请先启动 DSH，再点重试。');
  } else if (status === 'down') {
    showGuide((health && health.error) || '无法连接 bridge。请确认 DSH 与桥接插件已启动、端口正确。');
  }
}

/** 设置/加载 iframe；只有 bridge 地址变化时才重新指向 */
function ensureFrame() {
  const base = `${state.settings.bridgeUrl.replace(/\/+$/, '')}/`;
  if (state.loadedSrc === base) {
    if (state.frameLoaded) {
      ui.frame.hidden = false;
      showLoading(false);
    }
    return;
  }
  state.loadedSrc = base;
  state.frameLoaded = false;
  ui.frame.hidden = false;
  ui.frame.src = base;
  showLoading(true);
  clearTimeout(state.loadWatchTimer);
  state.loadWatchTimer = setTimeout(() => {
    if (state.frameLoaded) return;
    showLoading(false);
    const status = state.health ? state.health.status : 'unknown';
    if (status === 'ok') {
      // bridge 健康但 iframe 没加载出来：通常是上游返回了拒绝嵌入的响应
      showGuide('DSH UI 迟迟没有加载出来。可先点 ↗ 在新标签页打开验证，或重试。', { force: true });
    } else {
      showGuide('DSH UI 加载超时：无法连到 bridge。');
    }
  }, 6000);
}

function updateAutoSyncCheckbox() {
  ui.autoSync.checked = !!state.settings.autoSync;
}

/**
 * 渲染「当前页面」状态条。
 * 全部文案来自纯函数 core.computePageStatus（单测覆盖），这里只做 DOM 映射：
 *   ok   → 🌐 当前页面：<标题> · <host>      ● 已同步 · 12 秒前
 *   idle → 🌐 当前页面：<标题> · <host>      尚未读取，点 ⟳
 *   warn → ⚠ 当前页未同步，agent 看到的是：<旧标题>   [同步当前页]
 */
function renderPagebar() {
  if (state.contextStale) {
    ui.pagebar.dataset.tone = 'warn';
    ui.pagebar.title = '扩展在 chrome://extensions 里被重新加载过，这个侧边栏页面已经失效；重新打开即可恢复';
    ui.pagebarIcon.textContent = '⟳';
    ui.pagebarTitle.textContent = '扩展已更新，请重新打开侧边栏';
    ui.pagebarHost.textContent = '';
    ui.pagebarStatus.textContent = '';
    ui.syncCurrent.textContent = '重新打开';
    ui.syncCurrent.hidden = false;
    ui.syncCurrent.disabled = false;
    return;
  }
  const remote = state.remote || {};
  const tab = remote.tab || {};
  // 活动标签页最近一次读取失败（页面没加载完 / 注入失败 / 桥接报错）：
  // 直接把错误挂在状态条上，而不是只弹一个会消失的 toast。
  const lastResult = remote.lastResult || null;
  const activeIdNum = Number(remote.activeTabId);
  const hasSnapshotForActive = remote.snapshotTabId !== null && remote.snapshotTabId !== undefined
    && remote.snapshotTabId !== ''
    && Number(remote.snapshotTabId) === activeIdNum;
  if (!hasSnapshotForActive
    && lastResult && lastResult.ok === false && !lastResult.skipped
    && Number(lastResult.tabId) === activeIdNum
    && (lastResult.error || lastResult.reason)) {
    ui.pagebar.dataset.tone = 'warn';
    ui.pagebar.title = String(lastResult.error || lastResult.reason);
    ui.pagebarIcon.textContent = '⚠';
    ui.pagebarTitle.textContent = `读取失败：${String(lastResult.error || lastResult.reason).slice(0, 80)}`;
    ui.pagebarHost.textContent = '';
    ui.pagebarStatus.textContent = '';
    ui.syncCurrent.textContent = '重试';
    ui.syncCurrent.hidden = false;
    ui.syncCurrent.disabled = state.syncing;
    return;
  }
  // 活动标签页还没有自己的快照时，退回到「最近一次同步过的快照」，
  // 让状态条能明确警告：agent 现在看到的其实是上一个页面。
  const hasActiveSnapshot = remote.snapshotTabId !== null && remote.snapshotTabId !== undefined
    && remote.snapshotTabId !== '';
  const fallback = !hasActiveSnapshot && remote.lastSnapshot ? remote.lastSnapshot : null;
  const view = core.computePageStatus({
    activeTabId: remote.activeTabId,
    activeTabTitle: tab.title || '',
    activeTabUrl: tab.url || '',
    restricted: !!tab.restricted,
    snapshotTabId: fallback ? fallback.tabId : remote.snapshotTabId,
    snapshotTitle: fallback ? fallback.title || '' : remote.snapshotTitle || '',
    snapshotUrl: fallback ? fallback.url || '' : remote.snapshotUrl || '',
    syncedAt: fallback ? fallback.savedAt || 0 : remote.syncedAt || remote.snapshotSavedAt || 0,
    now: Date.now(),
  });

  ui.pagebar.dataset.tone = view.tone;
  ui.pagebar.title = view.tooltip || '';

  if (view.tone === 'warn') {
    ui.pagebarIcon.textContent = '⚠';
    ui.pagebarTitle.textContent = view.warning || '当前页未同步';
    ui.pagebarHost.textContent = '';
    ui.pagebarStatus.textContent = '';
    ui.syncCurrent.textContent = '同步当前页';
    ui.syncCurrent.hidden = false;
    ui.syncCurrent.disabled = state.syncing;
    return;
  }

  ui.pagebarIcon.textContent = '🌐';
  ui.syncCurrent.hidden = true;
  ui.syncCurrent.textContent = '同步当前页';
  ui.pagebarTitle.textContent = view.tone === 'ok' || view.title
    ? `当前页面：${view.title}`
    : '当前页面';
  const siteLabel = view.siteLabel || view.host;
  ui.pagebarHost.textContent = siteLabel ? `· ${siteLabel}` : '';
  if (view.tone === 'ok') {
    ui.pagebarStatus.textContent = view.timeText ? `● 已同步 · ${view.timeText}` : '● 已同步';
  } else if (view.statusText === '无法读取') {
    ui.pagebarStatus.textContent = '无法读取';
  } else {
    ui.pagebarStatus.textContent = '尚未读取，点 ⟳';
  }
}

/** STATE_CHANGED 可能成串到达，合并成一次状态刷新 */
function scheduleStateRefresh() {
  if (state.stateRefreshTimer) clearTimeout(state.stateRefreshTimer);
  state.stateRefreshTimer = setTimeout(() => {
    state.stateRefreshTimer = null;
    refreshState();
  }, 120);
}

async function refreshState() {
  const response = await send({ type: MESSAGES.GET_STATE });
  if (response && response.ok) {
    state.remote = response;
    if (response.settings) state.settings = core.normalizeSettings(response.settings);
    if (response.health) state.health = response.health;
    updateAutoSyncCheckbox();
    renderHealth();
    renderPagebar();
  }
  return response;
}

// ---------------------------------------------------------------------------
// 操作
// ---------------------------------------------------------------------------

async function syncNow(options) {
  const opts = options || {};
  if (state.syncing) return;
  state.syncing = true;
  ui.sync.disabled = true;
  ui.sync.classList.add('spinning');
  ui.syncCurrent.disabled = true;
  try {
    const response = await send({ type: MESSAGES.SYNC_ACTIVE });
    if (!opts.silent) {
      if (response && response.ok) {
        const summary = response.summary && response.summary.label ? `：${response.summary.label}` : '';
        toast(response.deduped ? '内容未变化，已跳过重复推送' : `已同步${summary}`, 'ok');
      } else {
        const reason = (response && (response.error || response.reason)) || '读取失败';
        toast(reason, 'error');
      }
    }
    await refreshState();
  } finally {
    state.syncing = false;
    ui.sync.disabled = false;
    ui.sync.classList.remove('spinning');
    ui.syncCurrent.disabled = false;
    renderPagebar();
  }
}

async function retryConnection() {
  ui.retry.disabled = true;
  state.health = await checkHealth();
  renderHealth();
  ui.retry.disabled = false;
  toast(state.health && state.health.status === 'ok' ? '已连接 bridge' : '仍然连不上 bridge', state.health && state.health.status === 'ok' ? 'ok' : 'error');
}

async function saveAutoSync(checked) {
  const next = core.patchSettings(state.settings, { autoSync: checked });
  state.settings = next;
  try { await chrome.storage.local.set({ settings: next }); } catch (_) { /* ignore */ }
  await send({ type: MESSAGES.SETTINGS_UPDATED });
  toast(checked ? '自动同步已开启' : '自动同步已关闭');
  if (checked) syncNow({ silent: true });
}

function openInNewTab() {
  const url = `${state.settings.bridgeUrl.replace(/\/+$/, '')}/`;
  try {
    chrome.tabs.create({ url });
  } catch (_) {
    window.open(url, '_blank', 'noopener');
  }
}

function openOptions() {
  try { chrome.runtime.openOptionsPage(); } catch (_) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// 事件
// ---------------------------------------------------------------------------

ui.frame.addEventListener('load', () => {
  if (!state.loadedSrc) return;
  state.frameLoaded = true;
  clearTimeout(state.loadWatchTimer);
  showLoading(false);
  hideGuide();
});

ui.sync.addEventListener('click', () => syncNow());
ui.syncCurrent.addEventListener('click', () => {
  if (state.contextStale) { location.reload(); return; }
  syncNow();
});
ui.autoSync.addEventListener('change', () => saveAutoSync(ui.autoSync.checked));
ui.open.addEventListener('click', openInNewTab);
ui.options.addEventListener('click', openOptions);
ui.guideOptions.addEventListener('click', openOptions);
ui.retry.addEventListener('click', retryConnection);

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== MESSAGES.STATE_CHANGED) return;
  if (message.settings) {
    state.settings = core.normalizeSettings(message.settings);
    updateAutoSyncCheckbox();
  }
  if (message.health) state.health = message.health;
  if (message.lastResult) {
    const result = message.lastResult;
    // 自动同步失败时给一次提示（5s 内不重复刷屏）
    if (!result.ok && !result.skipped && Date.now() - state.lastErrorAt > 5000) {
      state.lastErrorAt = Date.now();
      toast(`自动同步失败：${result.error || '未知错误'}`, 'error');
    }
  }
  renderHealth();
  // 切页 / 同步成功或失败都可能改变「当前页面」状态条 → 拉一次完整状态
  scheduleStateRefresh();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  state.settings = core.normalizeSettings(changes.settings.newValue);
  updateAutoSyncCheckbox();
  renderHealth();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    checkHealth().then((health) => {
      state.health = health;
      renderHealth();
    });
    if (state.remote) refreshState();
  }
});

function startPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(async () => {
    if (document.visibilityState === 'hidden') return;
    state.health = await checkHealth();
    renderHealth();
  }, 20000);
}

/** 「N 秒前」需要随时间自己走，10s 刷新一次状态条即可 */
function startPagebarTicker() {
  if (state.pagebarTimer) clearInterval(state.pagebarTimer);
  state.pagebarTimer = setInterval(() => {
    if (document.visibilityState === 'hidden') return;
    if (state.remote) renderPagebar();
  }, 10000);
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

async function init() {
  updateAutoSyncCheckbox();
  try {
    const version = chrome.runtime.getManifest().version;
    ui.sync.title = `读取当前页并同步到 DSH（扩展 v${version}）`;
  } catch (_) { /* ignore */ }
  try {
    const stored = await chrome.storage.local.get({ settings: null });
    if (stored && stored.settings) state.settings = core.normalizeSettings(stored.settings);
  } catch (_) { /* 用默认设置 */ }
  updateAutoSyncCheckbox();
  ui.addr.textContent = state.settings.bridgeUrl;
  ui.healthLink.textContent = `${state.settings.bridgeUrl}/__bridge/health`;

  state.health = await checkHealth();
  renderHealth();
  renderPagebar();
  await refreshState();      // 让 SW 汇总的 health/settings 覆盖一次，避免两边判断不一致
  startPolling();
  startPagebarTicker();
}

init();
