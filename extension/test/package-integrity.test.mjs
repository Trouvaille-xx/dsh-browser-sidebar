/**
 * 扩展包完整性 的单元测试
 * 目的：保证「加载已解压」时的 manifest / 资源引用不会断链，
 *       并且规格 §3 要求的权限、side_panel、options_page、图标尺寸都在位。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(HERE, '..');

const readJson = (name) => JSON.parse(readFileSync(join(EXT, name), 'utf8'));
const readText = (name) => readFileSync(join(EXT, name), 'utf8');
const exists = (name) => existsSync(join(EXT, name));

const manifest = readJson('manifest.json');

test('manifest：MV3 与规格要求的 permissions/host_permissions', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.match(manifest.version, /^1\.\d+\.\d+$/, '版本号应是 x.y.z');
  for (const permission of ['sidePanel', 'tabs', 'scripting', 'storage', 'activeTab']) {
    assert.ok(manifest.permissions.includes(permission), `缺少 permission: ${permission}`);
  }
  assert.deepEqual(manifest.host_permissions, ['<all_urls>']);
  // v1.1.0 的 B 站字幕只复用 scripting/host_permissions，不需要新增任何权限
  assert.equal(manifest.permissions.length, 5, 'v1.1.0 不应新增权限');
});

test('manifest：side_panel / action / options_page / background 指向真实文件', () => {
  assert.equal(manifest.side_panel.default_path, 'sidepanel.html');
  assert.equal(manifest.options_page, 'options.html');
  assert.equal(manifest.background.service_worker, 'background.js');
  const referenced = [
    manifest.side_panel.default_path,
    manifest.options_page,
    manifest.background.service_worker,
  ];
  for (const file of referenced) assert.ok(exists(file), `manifest 引用的文件不存在：${file}`);
});

test('manifest：图标 16/32/48/128 均为真实 PNG 且尺寸正确', () => {
  const sizes = { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' };
  assert.deepEqual(manifest.icons, sizes);
  assert.deepEqual(manifest.action.default_icon, sizes);
  for (const [expected, file] of Object.entries(sizes)) {
    const buffer = readFileSync(join(EXT, file));
    assert.ok(buffer.length > 100, `${file} 太小`);
    // PNG signature
    assert.deepEqual([...buffer.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${file} 不是 PNG`);
    // IHDR 宽高（大端）
    assert.equal(buffer.readUInt32BE(16), Number(expected), `${file} 宽度不对`);
    assert.equal(buffer.readUInt32BE(20), Number(expected), `${file} 高度不对`);
  }
});

test('manifest：content script 先注入 lib/core.js、lib/net.js 再注入 content.js，且只跑顶层文档', () => {
  assert.equal(manifest.content_scripts.length, 1);
  const [entry] = manifest.content_scripts;
  assert.deepEqual(entry.matches, ['<all_urls>']);
  // v1.1.0：B 站字幕的内容脚本兜底需要 lib/net.js（带超时 fetch）
  assert.deepEqual(entry.js, ['lib/core.js', 'lib/net.js', 'content.js']);
  assert.equal(entry.all_frames, false, '跨域 iframe 不能被读取');
  assert.equal(entry.run_at, 'document_idle');
  for (const file of entry.js) assert.ok(exists(file), `content script 文件不存在：${file}`);
});

test('HTML：引用的 css/js 都存在，且 iframe 带 referrerpolicy=no-referrer', () => {
  const sidepanel = readText('sidepanel.html');
  const refs = [...sidepanel.matchAll(/(?:src|href)="([^"#]+)"/g)].map((match) => match[1]);
  for (const ref of refs) {
    assert.ok(!/^https?:/.test(ref), `sidepanel 不应引用远程资源：${ref}`);
    assert.ok(exists(ref), `sidepanel.html 引用不存在的文件：${ref}`);
  }
  assert.match(sidepanel, /referrerpolicy="no-referrer"/);
  assert.match(sidepanel, /id="bridgeFrame"/);

  const options = readText('options.html');
  const optionRefs = [...options.matchAll(/(?:src|href)="([^"#]+)"/g)].map((match) => match[1]);
  for (const ref of optionRefs) {
    assert.ok(!/^https?:/.test(ref), `options 不应引用远程资源：${ref}`);
    assert.ok(exists(ref), `options.html 引用不存在的文件：${ref}`);
  }
});

test('视频/正文抽取依赖的 lib 已被 sidepanel 与 content 加载', () => {
  for (const page of ['sidepanel.html', 'options.html']) {
    const html = readText(page);
    assert.ok(html.includes('lib/core.js'), `${page} 应加载 lib/core.js`);
    assert.ok(html.includes('lib/net.js'), `${page} 应加载 lib/net.js`);
  }
});

test('UI 约束：工具条 40px、深色跟随系统、窄屏降级', () => {
  const css = readText('sidepanel.css');
  assert.match(css, /--toolbar-h:\s*40px/);
  assert.match(css, /@media \(prefers-color-scheme: dark\)/);
  assert.match(css, /@media \(max-width: 420px\)/);
  assert.match(css, /\.toast/);
});

test('v1.1.0：侧边栏有固定高度的「当前页面」状态条（不挤压 iframe）', () => {
  const html = readText('sidepanel.html');
  for (const id of ['pagebar', 'pagebarIcon', 'pagebarTitle', 'pagebarHost', 'pagebarStatus', 'btnSyncCurrent']) {
    assert.ok(html.includes(`id="${id}"`), `sidepanel.html 缺少 #${id}`);
  }
  // 顺序：toolbar → pagebar → stage（iframe）
  const toolbarAt = html.indexOf('class="toolbar"');
  const pagebarAt = html.indexOf('class="pagebar"');
  const stageAt = html.indexOf('class="stage"');
  assert.ok(toolbarAt > 0 && pagebarAt > toolbarAt && stageAt > pagebarAt, '状态条必须在工具条与 iframe 之间');

  const css = readText('sidepanel.css');
  assert.match(css, /\.pagebar\s*\{[^}]*flex:\s*0 0 30px/s);
  assert.match(css, /\.pagebar\s*\{[^}]*height:\s*30px/s);
  assert.match(css, /\.pagebar\[data-tone="warn"\]/);
  // 窄侧栏：状态条隐藏 host、按钮更紧凑
  const narrow = css.slice(css.indexOf('@media (max-width: 420px)'));
  assert.ok(narrow.includes('.pagebar-host'), '窄屏应隐藏 host');
  assert.ok(narrow.includes('.pagebar-sync'), '窄屏应压缩同步按钮');
});

test('v1.1.0：sidepanel 用纯函数渲染状态条，并在 STATE_CHANGED 时刷新', () => {
  const js = readText('sidepanel.js');
  assert.ok(js.includes('computePageStatus'), '应调用 core.computePageStatus');
  assert.ok(js.includes('scheduleStateRefresh'), 'STATE_CHANGED 后应刷新状态条');
  assert.ok(js.includes('pagebarTimer'), '应有相对时间刷新定时器');
  assert.ok(js.includes('btnSyncCurrent') || js.includes('syncCurrent'), '状态条的「同步当前页」按钮应接线');
});

test('v1.1.0：background.buildState 提供状态条所需的快照归属字段', () => {
  const js = readText('background.js');
  for (const field of ['snapshotTabId', 'snapshotTitle', 'snapshotUrl', 'syncedAt']) {
    assert.ok(js.includes(field), `buildState 应返回 ${field}`);
  }
});

test('v1.1.0：B 站字幕链路（page world probe + 白名单 fetch + 降级）', () => {
  const background = readText('background.js');
  assert.ok(background.includes('biliProbeInPage'), '缺少 B 站 page-world 探针');
  assert.ok(background.includes('__INITIAL_STATE__'), '探针应读取 __INITIAL_STATE__');
  assert.ok(background.includes('fetchBiliSubtitles'), '缺少 B 站字幕抓取');
  assert.ok(background.includes('credentials: \'include\'') || background.includes("credentials: 'include'"), 'B 站请求应带 cookie');
  assert.ok(background.includes('isAllowedBiliFetchUrl'), 'B 站请求应走 host 白名单');
  assert.ok(background.includes('buildBiliPlayerV2Url'), 'API 兜底应走 player/v2');

  const content = readText('content.js');
  assert.ok(content.includes('extractBilibiliVideo'), 'content 应有 B 站抽取分支');
  assert.ok(content.includes('bilibili-page'), '应支持页面态字幕来源');
  assert.ok(content.includes('bilibili-api'), '应支持 API 字幕来源');
  assert.ok(content.includes('fetchBiliApiLocally'), 'SW 拿不到登录态时应由内容脚本补一次');
  assert.ok(content.includes('page-text'), '失败时应退化为 page-text');
});

test('README 存在且包含手动验证清单', () => {
  assert.ok(exists('README.md'), '缺少 extension/README.md');
  const readme = readText('README.md');
  assert.ok(readme.length > 4000, 'README 内容过少');
  assert.ok(readme.includes('加载已解压的扩展程序'), 'README 应包含加载步骤');
  assert.ok(readme.includes('手动验证') || readme.includes('验收'), 'README 应包含手动验证清单');
  assert.ok(readme.includes('1.1.0'), 'README 应记录 1.1.0 变更');
  assert.ok(readme.includes('B 站') || readme.includes('哔哩哔哩'), 'README 应包含 B 站字幕说明');
  assert.ok(readme.includes('未联网实测') || readme.includes('未登录'), 'README 应写清 B 站未联网实测/登录态限制');
  assert.ok(readme.includes('当前页面'), 'README 应说明顶部「当前页面」状态条');
});

test('选项页包含规格要求的全部设置项与「测试连接」', () => {
  const html = readText('options.html');
  for (const id of ['bridgeUrl', 'autoSync', 'throttleMs', 'maxContentChars', 'maxTranscriptItems', 'maxTranscriptChars', 'btnTest']) {
    assert.ok(html.includes(`id="${id}"`), `选项页缺少 #${id}`);
  }
  const js = readText('options.js');
  assert.ok(js.includes('__bridge/health') || js.includes('buildBridgeEndpoints'), '选项页应能测试 bridge 连接');
});

test('background：服务 worker 用 importScripts 加载共享模块，且注册了标签页事件', () => {
  const js = readText('background.js');
  assert.ok(js.includes("importScripts('lib/core.js', 'lib/net.js')"), 'SW 需要先加载共享模块');
  for (const api of ['chrome.tabs.onActivated', 'chrome.tabs.onUpdated', 'chrome.tabs.onRemoved', 'chrome.action.onClicked']) {
    assert.ok(js.includes(api), `background 缺少 ${api}`);
  }
  assert.ok(js.includes('chrome.sidePanel.open'), 'action 点击应调用 chrome.sidePanel.open');
  assert.ok(js.includes('/__bridge/health') || js.includes('endpoints.health'), 'background 应探测 bridge 健康');
});

test('content：读页面但不读输入框内容，并做 SPA/内容变化节流上报', () => {
  const js = readText('content.js');
  assert.ok(js.includes('MutationObserver'), '缺少内容变化监听');
  assert.ok(js.includes('popstate'), '缺少 SPA 路由监听');
  assert.ok(js.includes('selectionchange'), '缺少选中文本监听');
  assert.ok(js.includes('isRestrictedUrl'), '应跳过 chrome:// 等受限页面');
  assert.ok(!/\.value\b/.test(js), 'content script 不应读取任何输入框 value');
  // 输入框/表单由 core 的 SKIP_TAGS 保证不被采集
  assert.ok(readText('lib/core.js').includes("'INPUT'"), 'core 应在抽取时跳过 INPUT');
});

test('README 存在且包含手动验证清单', () => {
  assert.ok(exists('README.md'), '缺少 extension/README.md');
  const readme = readText('README.md');
  assert.ok(readme.length > 2000, 'README 内容过少');
  assert.ok(readme.includes('加载已解压的扩展程序'), 'README 应包含加载步骤');
  assert.ok(readme.includes('手动验证') || readme.includes('验收'), 'README 应包含手动验证清单');
});

test('打包脚本排除开发文件，但运行时文件一个都不能少', () => {
  // pack-extension.mjs 的必需清单与真实文件一致（脚本本身会二次校验）
  const required = [
    'manifest.json', 'background.js', 'content.js', 'sidepanel.html', 'sidepanel.css', 'sidepanel.js',
    'options.html', 'options.css', 'options.js', 'lib/core.js', 'lib/net.js',
    'icons/icon16.png', 'icons/icon32.png', 'icons/icon48.png', 'icons/icon128.png',
  ];
  for (const file of required) {
    assert.ok(exists(file), `运行时文件缺失：${file}`);
    assert.ok(statSync(join(EXT, file)).size > 0, `运行时文件为空：${file}`);
  }
});
