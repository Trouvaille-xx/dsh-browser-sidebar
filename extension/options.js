/*!
 * DSH 浏览器侧边栏扩展 · 设置页逻辑（ES module）
 * 依赖：lib/core.js（纯函数）、lib/net.js（带超时 fetch）
 */

const core = globalThis.DSHSidebarCore;
const net = globalThis.DSHNet;
const MESSAGES = core.MESSAGES;

const $ = (id) => document.getElementById(id);

const ui = {
  version: $('version'),
  bridgeUrl: $('bridgeUrl'),
  autoSync: $('autoSync'),
  throttleMs: $('throttleMs'),
  maxContentChars: $('maxContentChars'),
  maxTranscriptItems: $('maxTranscriptItems'),
  maxTranscriptChars: $('maxTranscriptChars'),
  btnTest: $('btnTest'),
  testStatus: $('testStatus'),
  testDetail: $('testDetail'),
  btnSave: $('btnSave'),
  btnReset: $('btnReset'),
  saveStatus: $('saveStatus'),
};

let current = core.normalizeSettings({});

// ---------------------------------------------------------------------------
// 渲染 / 读取
// ---------------------------------------------------------------------------

function setSaveStatus(text, kind) {
  ui.saveStatus.textContent = text || '';
  ui.saveStatus.dataset.kind = kind || 'idle';
}

function setTestStatus(text, kind) {
  ui.testStatus.textContent = text || '';
  ui.testStatus.dataset.kind = kind || 'idle';
}

function fillForm(settings) {
  const s = core.normalizeSettings(settings);
  ui.bridgeUrl.value = s.bridgeUrl;
  ui.autoSync.checked = s.autoSync;
  // 档位下拉兜底：设置里出现自定义值时，选择最接近的一项
  const selectClosest = (select, value) => {
    const values = Array.from(select.options).map((o) => Number(o.value));
    const exact = values.indexOf(Number(value));
    if (exact >= 0) {
      select.selectedIndex = exact;
      return;
    }
    let bestIndex = 0;
    let bestDiff = Infinity;
    values.forEach((v, index) => {
      const diff = Math.abs(v - Number(value));
      if (diff < bestDiff) { bestDiff = diff; bestIndex = index; }
    });
    select.selectedIndex = bestIndex;
  };
  selectClosest(ui.throttleMs, s.throttleMs);
  selectClosest(ui.maxContentChars, s.maxContentChars);
  selectClosest(ui.maxTranscriptItems, s.maxTranscriptItems);
  selectClosest(ui.maxTranscriptChars, s.maxTranscriptChars);
}

function readForm() {
  return core.normalizeSettings({
    bridgeUrl: ui.bridgeUrl.value,
    autoSync: ui.autoSync.checked,
    throttleMs: Number(ui.throttleMs.value),
    maxContentChars: Number(ui.maxContentChars.value),
    maxTranscriptItems: Number(ui.maxTranscriptItems.value),
    maxTranscriptChars: Number(ui.maxTranscriptChars.value),
    requestTimeoutMs: current.requestTimeoutMs,
  });
}

// ---------------------------------------------------------------------------
// 保存 / 重置
// ---------------------------------------------------------------------------

async function save() {
  const next = readForm();
  // 用户输入被 normalize 纠正时（例如丢了协议），回填到输入框，避免“保存后看起来变了”
  ui.bridgeUrl.value = next.bridgeUrl;
  try {
    await chrome.storage.local.set({ settings: next });
  } catch (error) {
    setSaveStatus(`保存失败：${(error && error.message) || error}`, 'error');
    return;
  }
  current = next;
  try {
    const response = await chrome.runtime.sendMessage({ type: MESSAGES.SETTINGS_UPDATED });
    const health = response && response.health ? response.health : null;
    if (health && health.status && health.status !== 'ok') {
      setSaveStatus(`已保存；但 bridge 当前状态：${health.status}`, 'warn');
    } else {
      setSaveStatus('已保存', 'ok');
    }
  } catch (_) {
    setSaveStatus('已保存（service worker 未响应，稍后自动生效）', 'ok');
  }
  setTimeout(() => setSaveStatus(''), 4000);
}

function resetDefaults() {
  const defaults = core.normalizeSettings({});
  current = defaults;
  fillForm(defaults);
  setSaveStatus('已恢复默认值，记得点保存', 'ok');
  setTimeout(() => setSaveStatus(''), 4000);
}

// ---------------------------------------------------------------------------
// 测试连接
// ---------------------------------------------------------------------------

async function testConnection() {
  const candidate = readForm();
  const endpoints = core.buildBridgeEndpoints(candidate.bridgeUrl);
  ui.btnTest.disabled = true;
  setTestStatus('正在连接…', 'idle');
  ui.testDetail.hidden = true;

  const started = Date.now();
  const result = await net.getJson(endpoints.health, { timeoutMs: candidate.requestTimeoutMs });
  ui.btnTest.disabled = false;

  if (!result.ok) {
    setTestStatus('连接失败', 'error');
    ui.testDetail.hidden = false;
    ui.testDetail.textContent = [
      `地址: ${endpoints.health}`,
      `耗时: ${Date.now() - started}ms`,
      `错误: ${result.error}`,
      '',
      '排查建议：',
      '1) 确认 DSH 已启动（桌面端，或 `dsh web --port 4064`）；',
      '2) 确认 dsh-browser-sidecar 插件已安装并启用，bridge 监听 127.0.0.1:41789；',
      '3) 用浏览器直接打开上面的地址，应返回 JSON。',
    ].join('\n');
    return;
  }

  const data = result.data && typeof result.data === 'object' ? result.data : {};
  const upstreamOk = !!(data.upstream && data.upstream.ok);
  setTestStatus(
    upstreamOk ? `连接正常（${Date.now() - started}ms）` : 'bridge 可达，但上游 DSH 未就绪',
    upstreamOk ? 'ok' : 'warn',
  );
  ui.testDetail.hidden = false;
  ui.testDetail.textContent = [
    `地址: ${endpoints.health}`,
    `HTTP: ${result.status}  耗时: ${Date.now() - started}ms`,
    `ok: ${data.ok}`,
    `version: ${data.version || '—'}`,
    `upstream: ${data.upstream ? JSON.stringify(data.upstream) : '—'}`,
    `context: ${data.context ? JSON.stringify(data.context) : '—'}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

async function init() {
  try {
    ui.version.textContent = chrome.runtime.getManifest().version;
  } catch (_) {
    ui.version.textContent = '—';
  }
  try {
    const stored = await chrome.storage.local.get({ settings: null });
    current = core.normalizeSettings(stored && stored.settings ? stored.settings : {});
  } catch (_) {
    current = core.normalizeSettings({});
  }
  fillForm(current);
}

ui.btnSave.addEventListener('click', save);
ui.btnReset.addEventListener('click', resetDefaults);
ui.btnTest.addEventListener('click', testConnection);
ui.bridgeUrl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    save();
  }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  current = core.normalizeSettings(changes.settings.newValue);
  fillForm(current);
});

init();
