/**
 * 测试辅助：加载共享核心 + 一个「最小 DOM stub」。
 *
 * 为什么要自己写 stub DOM 而不是 jsdom：
 *   - 规格要求扩展零依赖、`加载已解压`即可用；测试也不想引入 npm 依赖；
 *   - core.js 的 DOM 函数只依赖 nodeType/tagName/childNodes/getAttribute/querySelectorAll，
 *     用一个 100 行的 stub 就能覆盖，且跑得快。
 */

import '../lib/core.js';
import '../lib/net.js';

export const core = globalThis.DSHSidebarCore;
export const net = globalThis.DSHNet;

const TEXT = 3;
const ELEMENT = 1;

function getAttr(node, name) {
  if (!node || !node.attributes) return null;
  return Object.prototype.hasOwnProperty.call(node.attributes, name) ? node.attributes[name] : null;
}

function textNode(value) {
  return { nodeType: TEXT, nodeValue: String(value), textContent: String(value) };
}

function recomputeText(node) {
  if (!node) return '';
  if (node.nodeType === TEXT) return node.nodeValue;
  let out = '';
  for (const child of node.childNodes || []) out += recomputeText(child);
  node.textContent = out;
  return out;
}

/**
 * 创建一个元素。
 * @param {string} tag
 * @param {Record<string,string>} [attrs]
 * @param {...(string|object)} children 字符串会变成文本节点
 */
export function h(tag, attrs, ...children) {
  const node = {
    nodeType: ELEMENT,
    tagName: String(tag).toUpperCase(),
    attributes: Object.assign({}, attrs || {}),
    childNodes: [],
    parentElement: null,
    textContent: '',
    hidden: false,
    getAttribute(name) {
      return getAttr(this, name);
    },
    querySelectorAll(selector) {
      return queryAll(this, selector);
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    },
    appendChild(child) {
      if (child && typeof child === 'object') child.parentElement = this;
      this.childNodes.push(child);
      return child;
    },
    append(...nodes) {
      for (const item of nodes) this.appendChild(item);
      return this;
    },
  };
  for (const child of children) {
    node.appendChild(typeof child === 'string' ? textNode(child) : child);
  }
  recomputeText(node);
  return node;
}

export function p(...children) {
  return h('p', {}, ...children);
}

// ---------------------------------------------------------------------------
// 极简选择器引擎：支持 tag / #id / .class / [attr] / [attr="v"] / [attr*="v"]
// 以及后代组合器（空格）与逗号分组。
// ---------------------------------------------------------------------------

function parseSimple(part) {
  const out = { tag: '', id: '', classes: [], attrs: [] };
  let rest = String(part).trim();
  const tagMatch = /^[a-zA-Z][\w-]*/.exec(rest);
  if (tagMatch) {
    out.tag = tagMatch[0].toUpperCase();
    rest = rest.slice(tagMatch[0].length);
  }
  while (rest.length) {
    if (rest[0] === '.') {
      const m = /^\.([\w-]+)/.exec(rest);
      if (!m) break;
      out.classes.push(m[1]);
      rest = rest.slice(m[0].length);
    } else if (rest[0] === '#') {
      const m = /^#([\w-]+)/.exec(rest);
      if (!m) break;
      out.id = m[1];
      rest = rest.slice(m[0].length);
    } else if (rest[0] === '[') {
      const m = /^\[([\w-]+)(?:([*^$]?=)"?([^"\]]*)"?)?\]/.exec(rest);
      if (!m) break;
      out.attrs.push({ name: m[1], op: m[2] || '', value: m[3] === undefined ? '' : m[3] });
      rest = rest.slice(m[0].length);
    } else {
      rest = rest.slice(1);
    }
  }
  return out;
}

function matchSimple(node, simple) {
  if (!node || node.nodeType !== ELEMENT) return false;
  if (simple.tag && node.tagName !== simple.tag) return false;
  if (simple.id && getAttr(node, 'id') !== simple.id) return false;
  if (simple.classes.length) {
    const classAttr = getAttr(node, 'class') || '';
    const list = classAttr.split(/\s+/).filter(Boolean);
    for (const cls of simple.classes) if (list.indexOf(cls) < 0) return false;
  }
  for (const attr of simple.attrs) {
    const value = getAttr(node, attr.name);
    if (value === null || value === undefined) return false;
    if (attr.op === '=' && value !== attr.value) return false;
    if (attr.op === '*=' && String(value).indexOf(attr.value) < 0) return false;
    if (attr.op === '^=' && !String(value).startsWith(attr.value)) return false;
    if (attr.op === '$=' && !String(value).endsWith(attr.value)) return false;
  }
  return true;
}

function allElements(root) {
  const out = [];
  const walk = (node) => {
    if (!node || node.nodeType !== ELEMENT) return;
    out.push(node);
    for (const child of node.childNodes || []) walk(child);
  };
  walk(root);
  return out;
}

export function queryAll(root, selector) {
  const results = [];
  for (const group of String(selector).split(',')) {
    const parts = group.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) continue;
    const simples = parts.map(parseSimple);
    const last = simples[simples.length - 1];
    for (const node of allElements(root)) {
      if (!matchSimple(node, last)) continue;
      if (simples.length > 1) {
        let ok = true;
        let ancestor = node.parentElement;
        let index = simples.length - 2;
        while (index >= 0) {
          let found = false;
          while (ancestor) {
            if (matchSimple(ancestor, simples[index])) {
              found = true;
              ancestor = ancestor.parentElement;
              break;
            }
            ancestor = ancestor.parentElement;
          }
          if (!found) { ok = false; break; }
          index -= 1;
        }
        if (!ok) continue;
      }
      results.push(node);
    }
  }
  return results;
}

/**
 * 创建 document stub。
 * @param {{title?:string, lang?:string, body?:object, head?:object[]}} options
 */
export function makeDocument(options) {
  const opts = options || {};
  const html = h('html', opts.lang ? { lang: opts.lang } : {});
  const headChildren = (opts.head || []).slice();
  // 真实文档的 <title> 在 head 里；显式给了 title 且 head 里没有时补一个
  if (opts.title && !headChildren.some((node) => node && node.tagName === 'TITLE')) {
    headChildren.unshift(h('title', {}, opts.title));
  }
  const head = h('head', {}, ...headChildren);
  const body = opts.body || h('body', {}, p('empty'));
  html.appendChild(head);
  html.appendChild(body);
  const doc = {
    nodeType: 9,
    title: opts.title || '',
    documentElement: html,
    head,
    body,
    querySelectorAll(selector) {
      return queryAll(html, selector);
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    },
  };
  return doc;
}

/** meta 标签 */
export function meta(nameOrProperty, content, kind) {
  if (kind === 'property') return h('meta', { property: nameOrProperty, content });
  return h('meta', { name: nameOrProperty, content });
}

/** <video> stub（含 textTracks/cues） */
export function makeVideo(options) {
  const opts = options || {};
  const video = h('video', opts.attrs || {});
  video.duration = opts.duration === undefined ? 0 : opts.duration;
  video.currentTime = opts.currentTime === undefined ? 0 : opts.currentTime;
  video.paused = opts.paused === undefined ? true : opts.paused;
  video.textTracks = (opts.tracks || []).map((track) => ({
    kind: track.kind || 'subtitles',
    label: track.label || '',
    mode: track.mode || 'disabled',
    cues: (track.cues || []).map((cue) => ({
      startTime: cue.start === undefined ? 0 : cue.start,
      endTime: cue.end === undefined ? 0 : cue.end,
      text: cue.text || '',
    })),
  }));
  return video;
}

/** 构造一个「像真实文章页」的文档 */
export function makeArticleDocument(options) {
  const opts = options || {};
  const paragraph = opts.paragraph || '这是正文第一段，用于验证正文抽取逻辑是否正确工作。'.repeat(6);
  const article = h('article', {},
    h('h1', {}, opts.heading || '标题：一篇用于测试的文章'),
    p(paragraph),
    h('h2', {}, '小节标题'),
    p(paragraph),
    h('blockquote', {}, '引用内容也应该保留。'),
    h('a', { href: 'https://example.com' }, '站内链接'),
  );
  const body = h('body', {},
    h('nav', {}, h('a', { href: '/' }, '首页'), h('a', { href: '/login' }, '登录')),
    h('header', {}, h('h1', {}, '站点标题')),
    article,
    h('aside', {}, p('侧边栏广告，应该被忽略')),
    h('footer', {}, p('版权所有，不应进入正文')),
    h('script', {}, 'var shouldNotAppear = true;'),
    h('style', {}, '.noise{}'),
  );
  const head = [
    h('title', {}, opts.title || '测试文章标题'),
    meta('description', opts.description || '这是一段用于测试的页面摘要描述。'),
    meta('og:title', opts.ogTitle || 'OG 标题', 'property'),
    meta('og:image', '/cover.png', 'property'),
    meta('og:site_name', opts.siteName || '示例站点', 'property'),
    h('meta', { name: 'author', content: opts.author || '张三' }),
    h('meta', { property: 'article:published_time', content: '2026-01-02T03:04:05Z' }),
  ];
  return makeDocument({ title: opts.title || '测试文章标题', lang: opts.lang || 'zh-CN', body, head });
}

/** 简单的 window stub（只提供 getSelection） */
export function makeWindow(selection) {
  return {
    getSelection() {
      return {
        toString() {
          return selection === undefined ? '' : selection;
        },
      };
    },
  };
}

export const SAMPLE_SELECTION = '这是用户选中的一段文字，应当出现在快照的 selection 字段里。';
