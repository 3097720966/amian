// 微信手机（SillyTavern / TauriTavern 扩展）
// 悬浮球 → 只有「微信」的手机界面；聊天时读取「记忆表格」里的数据。
// 设计取向：轻。设置的子页面点进去才创建、退出即销毁；不使用毛玻璃；
// 设置只走宿主标准的 extensionSettings，不触发页面重载。
(() => {
  'use strict';

  const NAME = 'WeChatPhone';
  const LS_KEY = 'WeChatPhone_settings';
  const DEFAULTS = {
    apiUrl: '',
    apiKey: '',
    model: '',
    models: [],
    useMemory: true,
    eventRows: 15, // 带入提示词的「事件历史」最近条数
    mainChatMsgs: 4, // 带入主线聊天最近几条
    historyMsgs: 20, // 与该角色的微信历史带几条
    charCols: ['角色名称', '角色性格', '身份定位', '居住地点', '角色特质', '角色其他信息', '心爱的人'],
    ball: null,
    snapshot: null, // 导入的表格快照（已裁剪）
    threads: {}, // { [chatKey]: { [角色名]: [{ r:'u'|'a', t, ts }] } }
  };
  const MAX_THREAD = 80;

  // ───────────────────────── 宿主与设置 ─────────────────────────
  const clone = (v) => (v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v);

  function getCtx() {
    try {
      return globalThis.SillyTavern?.getContext?.() || globalThis.Luker?.getContext?.() || null;
    } catch {
      return null;
    }
  }

  let fallback = null;
  let useFallback = false;

  function applyDefaults(s) {
    let changed = false;
    for (const [k, v] of Object.entries(DEFAULTS)) {
      if (s[k] === undefined) {
        s[k] = clone(v);
        changed = true;
      }
    }
    return changed;
  }

  function S() {
    if (!useFallback) {
      try {
        const ctx = getCtx();
        if (ctx && ctx.extensionSettings && typeof ctx.extensionSettings === 'object') {
          const root = ctx.extensionSettings;
          if (!root[NAME] || typeof root[NAME] !== 'object') root[NAME] = {};
          if (applyDefaults(root[NAME])) save();
          return root[NAME];
        }
      } catch (e) {
        console.warn(`[${NAME}] 宿主设置不可用，改用 localStorage`, e);
      }
      useFallback = true;
    }
    if (!fallback) {
      try {
        fallback = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
      } catch {
        fallback = {};
      }
      applyDefaults(fallback);
    }
    return fallback;
  }

  function save() {
    try {
      if (useFallback) {
        localStorage.setItem(LS_KEY, JSON.stringify(fallback));
        return;
      }
      const ctx = getCtx();
      const fn = ctx?.saveSettingsDebounced || ctx?.saveSettings;
      if (typeof fn === 'function') {
        const r = fn.call(ctx);
        if (r && typeof r.catch === 'function') r.catch(() => {});
      }
    } catch (e) {
      console.warn(`[${NAME}] 保存设置失败`, e);
    }
  }

  function chatKey() {
    const c = getCtx();
    if (!c) return 'local';
    if (c.chatId) return String(c.chatId);
    if (c.groupId != null) return `g${c.groupId}`;
    if (c.characterId != null) return `c${c.characterId}`;
    return 'local';
  }

  // ───────────────────────── 记忆表格读取 ─────────────────────────
  const CLEAN = (s) => {
    const t = String(s ?? '').trim();
    return t === 'None' || t === 'null' ? '' : t;
  };
  const stripEmoji = (s) => CLEAN(s).replace(/[\p{Extended_Pictographic}\uFE0F\u200d]/gu, '').trim();

  // 记忆增强的 chatSheets：{ sheet_xxx: { name, enable, content: [[None, 表头…], [序号, 值…], …] }, mate }
  // 统一成 [{ name, headers, rows }]（去掉第 0 列序号）。
  function normalize(raw) {
    const out = [];
    const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.values(raw) : [];
    for (const t of list) {
      if (!t || typeof t !== 'object') continue;
      const content = t.content ?? t.rows;
      if (!Array.isArray(content) || !content.length || !Array.isArray(content[0])) continue;
      if (t.enable === false) continue;
      const name = CLEAN(t.name ?? t.tableName);
      if (!name) continue;
      out.push({
        name,
        headers: content[0].slice(1).map(CLEAN),
        rows: content.slice(1).map((r) => (Array.isArray(r) ? r.slice(1).map(CLEAN) : [])),
      });
    }
    return out;
  }

  function looksLikeSheets(v) {
    if (!v || typeof v !== 'object') return false;
    if (v.mate?.type === 'chatSheets') return true;
    return Object.values(v).some((x) => x && typeof x === 'object' && x.uid && Array.isArray(x.content));
  }

  // 实时读取：在最近的聊天消息 / 聊天元数据里找 chatSheets 形状的字段。
  function loadLive() {
    const ctx = getCtx();
    if (!ctx) return null;
    const scan = (obj) => {
      if (!obj || typeof obj !== 'object') return null;
      for (const k of Object.keys(obj)) {
        if (looksLikeSheets(obj[k])) {
          const t = normalize(obj[k]);
          if (t.length) return t;
        }
      }
      return null;
    };
    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
    for (let i = chat.length - 1, n = 0; i >= 0 && n < 30; i--, n++) {
      const r = scan(chat[i]);
      if (r) return r;
    }
    return scan(ctx.chatMetadata);
  }

  function getTables() {
    const s = S();
    const live = loadLive();
    if (live) return { tables: live, source: '实时（聊天记录）' };
    if (Array.isArray(s.snapshot) && s.snapshot.length) return { tables: s.snapshot, source: '导入的快照' };
    return { tables: [], source: '未读取到' };
  }

  // 导入时裁剪：事件历史只留最后 60 行，避免把几十万字写进酒馆设置。
  function trimSnapshot(tables) {
    return tables.map((t) => (t.name === '事件历史' ? { ...t, rows: t.rows.slice(-60) } : t));
  }

  const findTable = (tables, name) => tables.find((t) => t.name === name);
  const colOf = (t, name) => (t ? t.headers.indexOf(name) : -1);

  function presentNames(tables) {
    const t = findTable(tables, '当前信息');
    const i = colOf(t, '当前在场角色');
    if (!t || i < 0) return [];
    const text = t.rows[t.rows.length - 1]?.[i] || '';
    return text
      .split(/[\/、,，|]/)
      .map((x) => stripEmoji(x.replace(/[（(].*?[）)]/g, '')))
      .filter(Boolean);
  }

  function contactsOf(tables) {
    const t = findTable(tables, '角色信息');
    const i = colOf(t, '角色名称');
    if (!t || i < 0) return [];
    const here = new Set(presentNames(tables));
    const seen = new Set();
    const list = [];
    for (const r of t.rows) {
      const name = stripEmoji(r[i]);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      list.push({ name, present: here.has(name) });
    }
    return list.sort((a, b) => Number(b.present) - Number(a.present));
  }

  const csv = (headers, rows) => [headers.join(' | '), ...rows.map((r) => r.join(' | '))].join('\n');
  const TABLE_ORDER = ['当前信息', '时间轴', '房屋居住人员', '角色信息', '事件历史'];

  function memoryBlock(tables, contact, s) {
    const sorted = [...tables].sort((a, b) => {
      const ia = TABLE_ORDER.indexOf(a.name);
      const ib = TABLE_ORDER.indexOf(b.name);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    const parts = [];
    for (const t of sorted) {
      let headers = t.headers;
      let rows = t.rows;
      if (t.name === '角色信息') {
        const ni = colOf(t, '角色名称');
        rows = rows.filter((r) => stripEmoji(r[ni]) === contact);
        const keep = headers.map((h, i) => (s.charCols.includes(h) ? i : -1)).filter((i) => i >= 0);
        headers = keep.map((i) => t.headers[i]);
        rows = rows.map((r) => keep.map((i) => r[i]));
      } else if (t.name === '事件历史') {
        rows = s.eventRows > 0 ? rows.slice(-s.eventRows) : [];
      } else {
        rows = rows.slice(-40);
      }
      if (rows.length) parts.push(`## ${t.name}\n${csv(headers, rows)}`);
    }
    return parts.length ? `<memory_table>\n${parts.join('\n\n')}\n</memory_table>` : '';
  }

  function mainExcerpt(n) {
    const ctx = getCtx();
    const chat = ctx?.chat;
    if (!n || !Array.isArray(chat)) return '';
    const lines = chat
      .filter((m) => m && !m.is_system && m.mes)
      .slice(-n)
      .map((m) => {
        const text = String(m.mes)
          .replace(/<tableEdit>[\s\S]*?<\/tableEdit>/g, '')
          .replace(/<!--[\s\S]*?-->/g, '')
          .replace(/<[^>]*>/g, '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 300);
        return `${m.name || ''}：${text}`;
      });
    return lines.length ? `<main_story_recent>\n${lines.join('\n')}\n</main_story_recent>` : '';
  }

  function buildMessages(contact, tables, thread) {
    const s = S();
    const user = getCtx()?.name1 || '我';
    const system = [
      `你正在扮演「${contact}」，通过微信与「${user}」聊天。请严格依据下面的资料保持人设、关系与剧情进度，不要编造资料里没有的重大设定。`,
      '回复要求：像真人发微信，口语化；一次回 1-4 条短消息，每条单独一行；不要写动作、神态或旁白；不要加引号，不要加名字前缀；可以偶尔用 emoji。',
      s.useMemory ? memoryBlock(tables, contact, s) : '',
      mainExcerpt(s.mainChatMsgs),
    ]
      .filter(Boolean)
      .join('\n\n');
    const history = thread.slice(-s.historyMsgs).map((m) => ({
      role: m.r === 'u' ? 'user' : 'assistant',
      content: m.t,
    }));
    return [{ role: 'system', content: system }, ...history];
  }

  function parseReply(text, contact) {
    const clean = String(text || '')
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*/g, ''))
      .trim();
    const prefix = new RegExp(`^(?:${contact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\s*[:：]\\s*`);
    return clean
      .split(/\n+/)
      .map((l) => l.trim().replace(prefix, '').replace(/^["“「]+|["”」]+$/g, '').trim())
      .filter(Boolean)
      .slice(0, 6);
  }

  // ───────────────────────── API ─────────────────────────
  const normBase = (u) =>
    String(u || '').trim().replace(/\/+$/, '').replace(/\/(chat\/completions|models)$/i, '').replace(/\/+$/, '');
  const crossOrigin = (url) => {
    try {
      return new URL(url, location.href).origin !== location.origin;
    } catch {
      return false;
    }
  };
  const tryJson = (t) => {
    try {
      return JSON.parse(t);
    } catch {
      return null;
    }
  };

  function hostHeaders() {
    const h = { 'Content-Type': 'application/json' };
    try {
      const ctx = getCtx();
      const x = ctx?.getRequestHeaders?.() || globalThis.getRequestHeaders?.();
      if (x && typeof x === 'object') {
        for (const [k, v] of Object.entries(x)) if (v !== null && v !== undefined && v !== '') h[k] = String(v);
      }
    } catch {}
    try {
      const m = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/);
      if (m && !h['X-CSRF-Token']) h['X-CSRF-Token'] = decodeURIComponent(m[1]);
    } catch {}
    return h;
  }

  async function request(url, { method = 'POST', headers, body, ms = 120000 }) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ms);
    try {
      const r = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ac.signal,
        cache: 'no-cache',
      });
      return { r, text: await r.text() };
    } finally {
      clearTimeout(timer);
    }
  }

  function extractContent(data) {
    if (data && typeof data === 'object' && data.response != null && data.choices == null) {
      const nested = typeof data.response === 'string' ? tryJson(data.response) : data.response;
      if (nested && typeof nested === 'object') data = nested;
    }
    const c = data?.choices?.[0];
    const content = c?.message?.content ?? c?.text;
    if (typeof content === 'string' && content.trim()) return content;
    const reasoning = c?.message?.reasoning_content ?? c?.message?.reasoning;
    return typeof reasoning === 'string' && reasoning.trim() ? reasoning : null;
  }
  const isHostError = (t) => /^\[[^\]]*错误\]/.test(String(t).trim()) || /^(?:网络请求失败|Network request failed)/i.test(String(t).trim());

  async function chatCompletion(messages) {
    const s = S();
    const base = normBase(s.apiUrl);
    if (!base) throw new Error('请先在「设置 → API 连接」填写服务器地址');
    if (!s.model) throw new Error('请先在「设置 → API 连接」选择模型');
    const body = { model: s.model, messages, stream: false };
    const url = `${base}/chat/completions`;
    let reply = null;
    let proxyNote = '';
    if (crossOrigin(url)) {
      try {
        const { r, text } = await request('/api/backends/chat-completions/generate', {
          headers: hostHeaders(),
          body: {
            chat_completion_source: 'custom',
            custom_url: base,
            custom_include_headers: s.apiKey ? `Authorization: "Bearer ${s.apiKey}"` : '',
            ...body,
          },
        });
        const c = extractContent(tryJson(text));
        if (r.ok && c != null && !isHostError(c)) reply = c;
        else proxyNote = text.slice(0, 160);
      } catch (e) {
        proxyNote = String(e?.message || e);
      }
    }
    if (reply == null) {
      const headers = { 'Content-Type': 'application/json' };
      if (s.apiKey) headers.Authorization = `Bearer ${s.apiKey}`;
      const { r, text } = await request(url, { headers, body });
      if (!r.ok) throw new Error(`请求失败 ${r.status}：${text.slice(0, 160)}`);
      const data = tryJson(text);
      if (data?.error) throw new Error(`API 报错：${String(data.error.message || data.error).slice(0, 160)}`);
      reply = extractContent(data);
      if (reply == null) throw new Error(`API 没有返回内容${proxyNote ? `（代理：${proxyNote}）` : ''}`);
    }
    return reply;
  }

  async function fetchModels() {
    const s = S();
    const base = normBase(s.apiUrl);
    if (!base) throw new Error('请先填写服务器地址');
    let text = '';
    let ok = false;
    if (crossOrigin(`${base}/models`)) {
      try {
        const res = await request('/api/backends/chat-completions/status', {
          headers: hostHeaders(),
          ms: 30000,
          body: {
            chat_completion_source: 'custom',
            custom_url: base,
            reverse_proxy: base,
            proxy_password: s.apiKey,
            custom_include_headers: s.apiKey ? `Authorization: "Bearer ${s.apiKey}"` : '',
          },
        });
        text = res.text;
        ok = res.r.ok;
      } catch {}
    }
    if (!ok) {
      const headers = {};
      if (s.apiKey) headers.Authorization = `Bearer ${s.apiKey}`;
      const res = await request(`${base}/models`, { method: 'GET', headers, ms: 30000 });
      text = res.text;
      if (!res.r.ok) throw new Error(`获取失败 ${res.r.status}：${text.slice(0, 120)}`);
    }
    const data = tryJson(text);
    const arr = Array.isArray(data) ? data : data?.data || data?.models || [];
    const ids = arr.map((m) => (typeof m === 'string' ? m : m?.id || m?.name)).filter(Boolean);
    if (!ids.length) throw new Error('没有解析到模型列表');
    return [...new Set(ids)].sort();
  }

  // ───────────────────────── DOM 工具 ─────────────────────────
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v !== false && v !== null && v !== undefined) el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid !== null && kid !== undefined && kid !== false) {
        el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
      }
    }
    return el;
  }
  const svg = (markup) => {
    const t = document.createElement('template');
    t.innerHTML = markup.trim();
    return t.content.firstChild;
  };
  const ICON = {
    chat: '<svg viewBox="0 0 24 24" width="26" height="26" fill="#fff"><path d="M9.5 3C5.4 3 2 5.9 2 9.5c0 2 1 3.7 2.6 4.9l-.7 2.4 2.7-1.4c.9.3 1.9.4 2.9.4h.4c-.2-.5-.3-1-.3-1.5 0-3.2 3.1-5.8 6.9-5.8h.5C16.4 5 13.2 3 9.5 3zm-2.7 4.2a.9.9 0 110 1.8.9.9 0 010-1.8zm5.4 0a.9.9 0 110 1.8.9.9 0 010-1.8zM22 14.5c0-2.8-2.7-5-6-5s-6 2.2-6 5 2.7 5 6 5c.7 0 1.4-.1 2-.3l2.1 1.1-.5-1.9c1.5-.9 2.4-2.4 2.4-4zm-7.8-1.1a.8.8 0 110 1.6.8.8 0 010-1.6zm3.6 0a.8.8 0 110 1.6.8.8 0 010-1.6z"/></svg>',
    back: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
    close: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    gear: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.9.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.9 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.9l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.9.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.9-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.9V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/></svg>',
    chev: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#c4c4c6" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>',
  };
  const icon = (k) => svg(ICON[k]);

  const AVATAR_COLORS = ['#7c9cbf', '#c58f7d', '#8fae8b', '#b59bc4', '#c9ae6b', '#7fb0b0', '#c4849a', '#9a9a9a'];
  function avatarOf(name) {
    let n = 0;
    for (const ch of name) n = (n * 31 + ch.codePointAt(0)) >>> 0;
    return h('span', { class: 'wxp-avatar', style: `background:${AVATAR_COLORS[n % AVATAR_COLORS.length]}` }, [...name][0] || '?');
  }
  const hhmm = (ts) => {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  // ───────────────────────── 手机界面 ─────────────────────────
  let overlay = null;
  let bodyEl = null;
  let clockEl = null;
  let clockTimer = null;

  const setPage = (el) => bodyEl && bodyEl.replaceChildren(el);

  function toast(msg) {
    if (!overlay) return;
    const t = h('div', { class: 'wxp-toast' }, msg);
    overlay.firstChild.append(t);
    setTimeout(() => t.remove(), 3200);
  }

  function bar({ left, title, right }) {
    return h(
      'header',
      { class: 'wxp-bar' },
      h('div', { class: 'wxp-bar-side' }, left || null),
      h('h1', { class: 'wxp-bar-title' }, title),
      h('div', { class: 'wxp-bar-side wxp-bar-side--right' }, right || null),
    );
  }
  const barBtn = (label, ic, onclick) => h('button', { class: 'wxp-bar-btn', type: 'button', 'aria-label': label, onclick }, icon(ic));

  function openPhone() {
    if (overlay) return;
    clockEl = h('span', { class: 'wxp-clock' }, hhmm(Date.now()));
    bodyEl = h('main', { class: 'wxp-body' });
    overlay = h(
      'div',
      {
        class: 'wxp-overlay',
        onclick: (e) => {
          if (e.target === overlay) closePhone();
        },
      },
      h(
        'div',
        { class: 'wxp-phone' },
        h('div', { class: 'wxp-status' }, clockEl, h('span', { class: 'wxp-island' }), h('span', { class: 'wxp-status-r' }, '5G')),
        bodyEl,
        h('button', { class: 'wxp-home', type: 'button', 'aria-label': '关闭', onclick: closePhone }, h('span')),
      ),
    );
    document.body.append(overlay);
    clockTimer = setInterval(() => {
      if (clockEl) clockEl.textContent = hhmm(Date.now());
    }, 30000);
    showList();
  }

  function closePhone() {
    clearInterval(clockTimer);
    overlay?.remove();
    overlay = bodyEl = clockEl = null;
  }

  // 会话列表
  function showList() {
    const { tables } = getTables();
    const contacts = contactsOf(tables);
    const s = S();
    const threads = s.threads[chatKey()] || {};

    const list = h('div', { class: 'wxp-scroll' });
    const search = h('input', { class: 'wxp-search', type: 'search', placeholder: '搜索', enterkeyhint: 'search' });

    const render = () => {
      const q = search.value.trim();
      const shown = contacts.filter((c) => !q || c.name.includes(q));
      if (!contacts.length) {
        list.replaceChildren(
          h(
            'div',
            { class: 'wxp-empty' },
            h('p', {}, '还没有读取到角色'),
            h('p', { class: 'wxp-empty-sub' }, '请确认「记忆表格」插件已启用并有数据，或导入表格文件。'),
            h('button', { class: 'wxp-btn', type: 'button', onclick: showMemory }, '去导入'),
          ),
        );
        return;
      }
      list.replaceChildren(
        ...shown.map((c) => {
          const last = (threads[c.name] || []).slice(-1)[0];
          return h(
            'button',
            { class: 'wxp-item', type: 'button', onclick: () => showChat(c.name) },
            avatarOf(c.name),
            h(
              'span',
              { class: 'wxp-item-main' },
              h('span', { class: 'wxp-item-top' }, h('span', { class: 'wxp-item-name' }, c.name), c.present ? h('span', { class: 'wxp-tag' }, '在场') : null),
              h('span', { class: 'wxp-item-sub' }, last ? last.t : ''),
            ),
            last ? h('span', { class: 'wxp-item-time' }, hhmm(last.ts)) : null,
          );
        }),
      );
    };
    search.addEventListener('input', render);
    render();

    setPage(
      h(
        'div',
        { class: 'wxp-page' },
        bar({ left: barBtn('关闭', 'close', closePhone), title: '微信', right: barBtn('设置', 'gear', showSettings) }),
        h('div', { class: 'wxp-searchwrap' }, search),
        list,
      ),
    );
  }

  // 聊天页
  function showChat(contact) {
    const s = S();
    const key = chatKey();
    if (!s.threads[key]) s.threads[key] = {};
    if (!s.threads[key][contact]) s.threads[key][contact] = [];
    const thread = s.threads[key][contact];

    const titleEl = h('h1', { class: 'wxp-bar-title' }, contact);
    const msgBox = h('div', { class: 'wxp-msgs' });
    const input = h('textarea', { class: 'wxp-input', rows: '1', placeholder: '' });
    let busy = false;

    const bubble = (m) =>
      h(
        'div',
        { class: `wxp-row ${m.r === 'u' ? 'is-me' : 'is-them'}` },
        m.r === 'u' ? null : avatarOf(contact),
        h('div', { class: 'wxp-bubble' }, m.t),
        m.r === 'u' ? avatarOf(getCtx()?.name1 || '我') : null,
      );
    const toBottom = () => {
      msgBox.scrollTop = msgBox.scrollHeight;
    };
    const push = (r, t) => {
      const m = { r, t, ts: Date.now() };
      thread.push(m);
      if (thread.length > MAX_THREAD) thread.splice(0, thread.length - MAX_THREAD);
      msgBox.append(bubble(m));
      toBottom();
    };

    const send = async () => {
      const text = input.value.trim();
      if (!text || busy) return;
      busy = true;
      input.value = '';
      input.style.height = '';
      push('u', text);
      save();
      titleEl.textContent = '对方正在输入…';
      try {
        const { tables } = getTables();
        const reply = await chatCompletion(buildMessages(contact, tables, thread));
        const lines = parseReply(reply, contact);
        if (!lines.length) throw new Error('模型返回为空');
        lines.forEach((l) => push('a', l));
      } catch (e) {
        toast(String(e?.message || e));
      } finally {
        busy = false;
        titleEl.textContent = contact;
        save();
      }
    };

    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 110)}px`;
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !matchMedia('(pointer: coarse)').matches) {
        e.preventDefault();
        send();
      }
    });

    thread.forEach((m) => msgBox.append(bubble(m)));
    setPage(
      h(
        'div',
        { class: 'wxp-page wxp-page--chat' },
        h('header', { class: 'wxp-bar' }, h('div', { class: 'wxp-bar-side' }, barBtn('返回', 'back', showList)), titleEl, h('div', { class: 'wxp-bar-side wxp-bar-side--right' })),
        msgBox,
        h('div', { class: 'wxp-composer' }, input, h('button', { class: 'wxp-send', type: 'button', onclick: send }, '发送')),
      ),
    );
    toBottom();
  }

  // 设置：子页面点进去才创建，返回即丢弃
  const settingRow = (label, detail, onclick, danger) =>
    h(
      'button',
      { class: `wxp-srow${danger ? ' is-danger' : ''}`, type: 'button', onclick },
      h('span', { class: 'wxp-srow-label' }, label),
      h('span', { class: 'wxp-srow-detail' }, detail || ''),
      danger ? null : icon('chev'),
    );

  function subPage(title, back, ...content) {
    setPage(h('div', { class: 'wxp-page wxp-page--grey' }, bar({ left: barBtn('返回', 'back', back), title }), h('div', { class: 'wxp-scroll wxp-pad' }, ...content)));
  }

  function showSettings() {
    const s = S();
    const { tables, source } = getTables();
    subPage(
      '设置',
      showList,
      h('div', { class: 'wxp-group' }, settingRow('API 连接', s.model || (normBase(s.apiUrl) ? '未选模型' : '未配置'), showApi), settingRow('记忆表格', `${source}${tables.length ? ` · ${tables.length} 张表` : ''}`, showMemory)),
      h(
        'div',
        { class: 'wxp-group' },
        settingRow(
          '清空当前聊天的微信记录',
          '',
          () => {
            if (!confirm('清空当前酒馆聊天下所有角色的微信记录？')) return;
            delete S().threads[chatKey()];
            save();
            toast('已清空');
          },
          true,
        ),
      ),
    );
  }

  const field = (label, control) => h('label', { class: 'wxp-field' }, h('span', { class: 'wxp-field-label' }, label), control);
  const textInput = (type, key, placeholder, extra) => {
    const el = h('input', { class: 'wxp-text', type, placeholder, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', ...(extra || {}) });
    el.value = S()[key] || '';
    el.addEventListener('change', () => {
      S()[key] = el.value.trim();
      save();
    });
    return el;
  };
  const numInput = (key, min, max) => {
    const el = h('input', { class: 'wxp-text', type: 'number', inputmode: 'numeric', min, max });
    el.value = S()[key];
    el.addEventListener('change', () => {
      const n = Math.min(max, Math.max(min, Math.floor(Number(el.value) || 0)));
      el.value = n;
      S()[key] = n;
      save();
    });
    return el;
  };
  const switchEl = (checked, onchange) => {
    const el = h('input', { class: 'wxp-switch', type: 'checkbox' });
    el.checked = !!checked;
    el.addEventListener('change', () => onchange(el.checked));
    return el;
  };

  function showApi() {
    const s = S();
    const urlEl = textInput('url', 'apiUrl', 'https://example.com/v1', { inputmode: 'url' });
    const keyEl = textInput('password', 'apiKey', 'sk-…');
    const modelEl = textInput('text', 'model', '模型名称');
    const dl = h('datalist', { id: 'wxp-models' }, (s.models || []).map((m) => h('option', { value: m })));
    modelEl.setAttribute('list', 'wxp-models');
    const status = h('p', { class: 'wxp-note' }, s.models?.length ? `已缓存 ${s.models.length} 个模型` : '');
    const btn = h(
      'button',
      {
        class: 'wxp-btn',
        type: 'button',
        onclick: async () => {
          S().apiUrl = urlEl.value.trim();
          S().apiKey = keyEl.value.trim();
          btn.disabled = true;
          status.textContent = '获取中…';
          try {
            const ids = await fetchModels();
            S().models = ids;
            save();
            dl.replaceChildren(...ids.map((m) => h('option', { value: m })));
            status.textContent = `获取到 ${ids.length} 个模型，点上面的模型框选择`;
          } catch (e) {
            status.textContent = String(e?.message || e);
          } finally {
            btn.disabled = false;
          }
        },
      },
      '获取模型',
    );
    subPage('API 连接', showSettings, h('div', { class: 'wxp-group wxp-group--form' }, field('服务器地址', urlEl), field('API Key', keyEl), field('模型', modelEl), dl), btn, status);
  }

  function showMemory() {
    const s = S();
    const { tables, source } = getTables();
    const total = tables.reduce((n, t) => n + t.rows.length, 0);
    const file = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      if (!f) return;
      try {
        const text = (await f.text()).replace(/^\uFEFF/, '');
        const t = normalize(JSON.parse(text));
        if (!t.length) throw new Error('没有识别到表格（需要记忆增强导出的表格 JSON）');
        S().snapshot = trimSnapshot(t);
        save();
        toast(`已导入 ${t.length} 张表`);
        showMemory();
      } catch (e) {
        toast(`导入失败：${String(e?.message || e)}`);
      }
    });

    const charTable = findTable(tables, '角色信息');
    const colBox = h(
      'div',
      { class: 'wxp-group' },
      (charTable?.headers || []).map((hd) =>
        h(
          'label',
          { class: 'wxp-srow' },
          h('span', { class: 'wxp-srow-label' }, hd),
          switchEl(s.charCols.includes(hd), (on) => {
            const set = new Set(S().charCols);
            on ? set.add(hd) : set.delete(hd);
            S().charCols = [...set];
            save();
          }),
        ),
      ),
    );

    subPage(
      '记忆表格',
      showSettings,
      h('div', { class: 'wxp-group' }, h('label', { class: 'wxp-srow' }, h('span', { class: 'wxp-srow-label' }, '聊天时读取记忆表格'), switchEl(s.useMemory, (on) => { S().useMemory = on; save(); }))),
      h('p', { class: 'wxp-note' }, `当前来源：${source}${tables.length ? `，${tables.length} 张表 / ${total} 行` : ''}`),
      h('div', { class: 'wxp-group wxp-group--form' }, field('带入「事件历史」最近几条', numInput('eventRows', 0, 100)), field('带入主线剧情最近几条', numInput('mainChatMsgs', 0, 20)), field('带入微信聊天历史几条', numInput('historyMsgs', 0, 60))),
      charTable ? h('p', { class: 'wxp-note' }, '「角色信息」里发给模型的列（默认不含外貌与隐藏信息）：') : null,
      charTable ? colBox : null,
      h('div', { class: 'wxp-btnrow' }, h('button', { class: 'wxp-btn', type: 'button', onclick: () => file.click() }, '导入表格文件'), S().snapshot ? h('button', { class: 'wxp-btn wxp-btn--ghost', type: 'button', onclick: () => { S().snapshot = null; save(); showMemory(); } }, '清除导入') : null),
      file,
    );
  }

  // ───────────────────────── 悬浮球 ─────────────────────────
  function mountBall() {
    if (globalThis.__wxpMounted) return;
    globalThis.__wxpMounted = true;
    const SIZE = 52;
    const ball = h('button', { class: 'wxp-ball', type: 'button', 'aria-label': '打开微信' }, icon('chat'));
    const clamp = (x, y) => [Math.min(Math.max(4, x), innerWidth - SIZE - 4), Math.min(Math.max(4, y), innerHeight - SIZE - 4)];
    const place = (x, y) => {
      [x, y] = clamp(x, y);
      ball.style.left = `${x}px`;
      ball.style.top = `${y}px`;
      return [x, y];
    };
    const p = S().ball;
    place(p ? p.x : innerWidth - SIZE - 12, p ? p.y : Math.round(innerHeight * 0.6));

    let start = null;
    ball.addEventListener('pointerdown', (e) => {
      ball.setPointerCapture(e.pointerId);
      start = { px: e.clientX, py: e.clientY, x: ball.offsetLeft, y: ball.offsetTop, moved: false };
    });
    ball.addEventListener('pointermove', (e) => {
      if (!start) return;
      const dx = e.clientX - start.px;
      const dy = e.clientY - start.py;
      if (!start.moved && Math.hypot(dx, dy) < 6) return;
      start.moved = true;
      place(start.x + dx, start.y + dy);
    });
    const end = () => {
      if (!start) return;
      const { moved } = start;
      start = null;
      if (moved) {
        S().ball = { x: ball.offsetLeft, y: ball.offsetTop };
        save();
      } else {
        openPhone();
      }
    };
    ball.addEventListener('pointerup', end);
    ball.addEventListener('pointercancel', () => (start = null));
    addEventListener('resize', () => place(ball.offsetLeft, ball.offsetTop));
    document.body.append(ball);
  }

  if (typeof document !== 'undefined') {
    if (document.body) mountBall();
    else document.addEventListener('DOMContentLoaded', mountBall, { once: true });
  }

  // 供本地脚本测试（酒馆里以 ES 模块加载，没有 module，下面一行不会执行）
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { normalize, contactsOf, presentNames, memoryBlock, parseReply, buildMessages, trimSnapshot, stripEmoji, DEFAULTS };
  }
})();
