/**
 * dsh-browser-sidecar agent tool: `browser_page`.
 *
 * One tool with a `mode` switch instead of five tools — it keeps the model's
 * tool list small and every mode is a bounded read of data the user explicitly
 * synced from the Chrome side panel.
 */
import { formatSnapshotForTool } from './core.js';

const MODES = ['summary', 'page', 'selection', 'video', 'transcript'];

const DESCRIPTION = [
  '读取用户通过 Chrome 侧边栏主动同步过来的当前网页上下文（标题/URL/正文/选中文本/视频字幕）。',
  '当用户问「总结这个页面」「这个视频讲了什么」「我屏幕上这页」时先调用 mode=summary，确认有没有上下文以及有哪些内容，',
  '再按需读取：page=正文（默认 2 万字上限）, selection=选中文本, video=视频信息+字幕预览, transcript=完整字幕文本（默认 3 万字上限）。',
  '返回文本总带来源 URL、标题和抓取时间，引用时请说明数据来自用户同步、可能略有延迟。',
  '没有上下文时返回提示，请让用户在侧边栏点击「读取当前页」，不要凭空猜测页面内容。',
].join(' ');

/**
 * @param {{ store: import('./context-store.js').ContextStore }} options
 * @returns {object} raw ToolDefinition accepted by ctx.tools.register()
 */
export function createBrowserPageTool(options) {
  const store = options.store;
  return {
    name: 'browser_page',
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['mode'],
      properties: {
        mode: {
          type: 'string',
          enum: MODES,
          description: 'summary=概览(便宜，先看有什么) | page=正文 | selection=选中文本 | video=视频信息 | transcript=完整字幕',
        },
        tabId: {
          type: 'integer',
          description: '可选：指定 Chrome 标签页 id；缺省用用户当前活动标签页',
        },
        maxChars: {
          type: 'integer',
          description: '可选：返回文本上限（500-60000）；缺省 page/video 为 20000、transcript 为 30000',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'text'],
        properties: {
          ok: { type: 'boolean', description: '是否有可用的浏览器上下文' },
          text: { type: 'string', description: '模型可读的有界文本' },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: value.text }];
      },
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const mode = typeof args?.mode === 'string' ? args.mode : '';
      if (MODES.includes(mode) !== true) {
        throw new Error('browser_page: `mode` 必须是 ' + MODES.join(' | ') + ' 之一');
      }
      const tabId = Number.isSafeInteger(args?.tabId) ? args.tabId : undefined;
      const snapshot = store.latest(tabId);
      const text = formatSnapshotForTool(mode, snapshot, {
        maxChars: typeof args?.maxChars === 'number' ? args.maxChars : undefined,
      });
      return { ok: snapshot !== undefined, text };
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: 'browser_page: ' + String(args?.mode ?? ''),
        kind: 'other',
        rawInput: args,
      };
    },
  };
}
