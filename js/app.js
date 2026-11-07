'use strict';
/* =====================================================================
   FreeIA – chat con IA gratis (sin compilación, sin servidor propio)
   ===================================================================== */

const APP_VERSION = '1.0.0';

/* ---------- Constantes ---------- */
const STORE_CHATS = 'freeia.chats.v1';
const STORE_SETTINGS = 'freeia.settings.v1';
const STORE_MODELS = 'freeia.models.v1';
const MODELS_TTL = 6 * 60 * 60 * 1000;
const MAX_COMPARE = 3;
const MAX_FILE_CHARS = 120000;
const MAX_FILES = 3;
const MAX_HISTORY_CHARS = 60000;

const PROVIDERS = {
  pollinations: {
    name: 'Pollinations',
    note: 'Sin clave',
    chatUrl: 'https://text.pollinations.ai/openai',
    modelsUrl: 'https://text.pollinations.ai/models',
    imageUrl: 'https://image.pollinations.ai/prompt/',
    needsKey: false,
    fallback: ['openai', 'openai-fast', 'mistral', 'deepseek', 'llama', 'qwen-coder'],
  },
  openrouter: {
    name: 'OpenRouter',
    note: 'Modelos :free · requiere clave gratuita',
    chatUrl: 'https://openrouter.ai/api/v1/chat/completions',
    modelsUrl: 'https://openrouter.ai/api/v1/models',
    needsKey: true,
    fallback: [],
  },
};

const SYSTEM_PROMPTS = {
  chat: 'Eres un asistente de IA útil, claro y honesto. Responde en el idioma del usuario. Usa Markdown cuando ayude.',
  write: 'Eres un redactor profesional. Entrega textos pulidos, bien estructurados y con buen tono, en el idioma del usuario. Si falta contexto clave, haz como máximo una pregunta breve o asume lo razonable y dilo.',
  research: 'Eres un analista que investiga a fondo. Estructura la respuesta con secciones, puntos clave y matices. No inventes datos, cifras ni fuentes: si no estás seguro, dilo. Aclara que no tienes acceso a la web en tiempo real cuando importe.',
};

const SUGGESTION_MODES = { chat: 'Escribe tu mensaje…', write: 'Qué quieres redactar…', research: 'Qué quieres investigar…', image: 'Describe la imagen que quieres crear…' };

/* ---------- Utilidades ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const storage = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  },
  remove(key) { try { localStorage.removeItem(key); } catch { /* sin almacenamiento */ } },
};

const haptic = (ms = 8) => { try { navigator.vibrate && navigator.vibrate(ms); } catch { /* no soportado */ } };

/* ---------- Estado ---------- */
const settings = Object.assign(
  { theme: 'auto', selected: [], compare: false, polKey: '', orKey: '' },
  storage.get(STORE_SETTINGS, {})
);
const state = {
  chats: storage.get(STORE_CHATS, []),
  currentId: null,
  mode: 'chat',
  models: [],            // [{key, provider, id, label, desc}]
  attachments: [],       // [{name, text}]
  busy: false,
  ctrl: null,
  deferredInstall: null,
};

const els = {
  app: $('#app'), sidebar: $('#sidebar'), scrim: $('#scrim'), list: $('#chat-list'),
  messages: $('#messages'), empty: $('#empty'), input: $('#input'), send: $('#btn-send'),
  modelLabel: $('#model-label'), attachments: $('#attachments'), file: $('#file'),
  toast: $('#toast'),
};

const saveSettings = () => storage.set(STORE_SETTINGS, settings);
const saveChats = () => {
  if (!storage.set(STORE_CHATS, state.chats)) {
    // Almacenamiento lleno: conservar solo los 30 chats más recientes
    state.chats = state.chats.slice(0, 30);
    storage.set(STORE_CHATS, state.chats);
  }
};
const currentChat = () => state.chats.find((c) => c.id === state.currentId) || null;

/* ---------- Toast ---------- */
let toastTimer;
function toast(msg, ms = 2600) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), ms);
}

/* ---------- Markdown seguro ---------- */
if (window.DOMPurify) {
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); }
  });
}
function renderMarkdown(text) {
  if (!text) return '';
  try {
    const html = window.marked ? marked.parse(text, { gfm: true, breaks: true }) : null;
    if (html == null || !window.DOMPurify) throw new Error('libs');
    return DOMPurify.sanitize(html);
  } catch {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML.replace(/\n/g, '<br>');
  }
}
function enhanceCode(root) {
  $$('pre', root).forEach((pre) => {
    if ($('.copy', pre)) return;
    const b = document.createElement('button');
    b.className = 'copy'; b.type = 'button'; b.textContent = 'Copiar'; b.setAttribute('aria-label', 'Copiar código');
    pre.appendChild(b);
  });
}
function setBody(el, content, streaming) {
  el.innerHTML = renderMarkdown(content);
  enhanceCode(el);
  el.classList.toggle('streaming', !!streaming);
}

/* ---------- Modelos ---------- */
const modelByKey = (key) => state.models.find((m) => m.key === key);
const makeKey = (provider, id) => `${provider}::${id}`;
const prettify = (id) => id.replace(/^.*\//, '').replace(/:free$/, '').replace(/[-_]/g, ' ');

async function fetchProviderModels(provider) {
  const cfg = PROVIDERS[provider];
  const res = await fetch(cfg.modelsUrl, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const raw = Array.isArray(json) ? json : json.data || [];
  const out = [];
  for (const item of raw) {
    const id = typeof item === 'string' ? item : item.id || item.name;
    if (!id) continue;
    if (provider === 'openrouter') {
      const p = item.pricing || {};
      const free = String(id).endsWith(':free') || (Number(p.prompt) === 0 && Number(p.completion) === 0);
      const textOut = !item.architecture || !item.architecture.output_modalities || item.architecture.output_modalities.includes('text');
      if (!free || !textOut) continue;
    } else {
      const outs = item.output_modalities;
      if (Array.isArray(outs) && !outs.includes('text')) continue;
    }
    out.push({
      key: makeKey(provider, id), provider, id,
      label: (provider === 'openrouter' && item.name) ? String(item.name).replace(/\s*\(free\)\s*$/i, '') : prettify(id),
      desc: typeof item === 'object' ? String(item.description || '').slice(0, 90) : '',
    });
  }
  if (!out.length) throw new Error('vacío');
  return out;
}

function fallbackModels(provider) {
  return PROVIDERS[provider].fallback.map((id) => ({ key: makeKey(provider, id), provider, id, label: prettify(id), desc: '' }));
}

async function loadModels(force = false) {
  const cache = storage.get(STORE_MODELS, null);
  const fresh = cache && Date.now() - cache.at < MODELS_TTL && !force;
  const list = [];
  const providers = Object.keys(PROVIDERS);
  if (cache && cache.data) for (const p of providers) list.push(...(cache.data[p] || []));
  if (!list.length) for (const p of providers) list.push(...fallbackModels(p));
  state.models = list;
  ensureSelection();
  updateModelLabel();
  if (fresh) return;

  const data = {};
  await Promise.all(providers.map(async (p) => {
    try { data[p] = await fetchProviderModels(p); } catch { data[p] = (cache && cache.data && cache.data[p]) || fallbackModels(p); }
  }));
  storage.set(STORE_MODELS, { at: Date.now(), data });
  state.models = providers.flatMap((p) => data[p]);
  ensureSelection();
  updateModelLabel();
  if (!$('#sheet-model').hidden) renderModelList();
}

function ensureSelection() {
  settings.selected = settings.selected.filter((k) => modelByKey(k));
  if (!settings.selected.length) {
    const pick = state.models.find((m) => m.provider === 'pollinations') || state.models[0];
    if (pick) settings.selected = [pick.key];
  }
  saveSettings();
}

function updateModelLabel() {
  const sel = settings.selected.map(modelByKey).filter(Boolean);
  els.modelLabel.textContent = !sel.length ? 'Sin modelos' : sel.length > 1 ? `${sel.length} modelos (comparar)` : sel[0].label;
}

function renderModelList() {
  const q = $('#model-search').value.trim().toLowerCase();
  const box = $('#model-list');
  box.innerHTML = '';
  for (const [pid, cfg] of Object.entries(PROVIDERS)) {
    const all = state.models.filter((m) => m.provider === pid);
    const items = all.filter((m) => !q || m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q));
    if (!items.length && q) continue;
    const head = document.createElement('div');
    head.className = 'group-title';
    const keyOk = !cfg.needsKey || !!settings.orKey;
    head.innerHTML = `<span></span><span class="badge"></span>`;
    head.firstChild.textContent = `${cfg.name} · ${all.length}`;
    head.lastChild.textContent = keyOk ? cfg.note : 'Falta la clave · ve a Ajustes';
    box.appendChild(head);
    for (const m of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'model-row' + (settings.selected.includes(m.key) ? ' sel' : '');
      b.dataset.key = m.key;
      b.innerHTML = '<span class="nm"></span><span class="tick"><svg class="ic"><use href="#i-check"/></svg></span>';
      const nm = $('.nm', b);
      nm.textContent = m.label;
      if (m.desc) { const s = document.createElement('small'); s.textContent = m.desc; nm.appendChild(s); }
      box.appendChild(b);
    }
  }
}

function onModelPick(key) {
  haptic();
  const m = modelByKey(key);
  if (!m) return;
  if (settings.compare) {
    const i = settings.selected.indexOf(key);
    if (i >= 0) { if (settings.selected.length > 1) settings.selected.splice(i, 1); }
    else if (settings.selected.length >= MAX_COMPARE) { toast(`Máximo ${MAX_COMPARE} modelos a la vez`); return; }
    else settings.selected.push(key);
  } else {
    settings.selected = [key];
    closeSheet('sheet-model');
  }
  saveSettings(); updateModelLabel(); renderModelList();
}

/* ---------- Hojas inferiores ---------- */
function openSheet(id) { $('#' + id).hidden = false; }
function closeSheet(id) { $('#' + id).hidden = true; }

/* ---------- Historial / barra lateral ---------- */
function renderChatList() {
  els.list.innerHTML = '';
  if (!state.chats.length) {
    const d = document.createElement('div');
    d.className = 'list-empty'; d.textContent = 'Aún no tienes chats.';
    els.list.appendChild(d);
    return;
  }
  const sorted = [...state.chats].sort((a, b) => b.updated - a.updated);
  for (const c of sorted) {
    const row = document.createElement('div');
    row.className = 'chat-item' + (c.id === state.currentId ? ' active' : '');
    row.setAttribute('role', 'listitem');
    const t = document.createElement('button');
    t.className = 't'; t.type = 'button'; t.textContent = c.title; t.dataset.open = c.id;
    const del = document.createElement('button');
    del.className = 'del'; del.type = 'button'; del.dataset.del = c.id; del.setAttribute('aria-label', 'Borrar chat');
    del.innerHTML = '<svg class="ic sm"><use href="#i-trash"/></svg>';
    row.append(t, del);
    els.list.appendChild(row);
  }
}
function openSidebar() { els.sidebar.classList.add('open'); els.scrim.classList.add('show'); }
function closeSidebar() { els.sidebar.classList.remove('open'); els.scrim.classList.remove('show'); }

function newChat() {
  if (state.busy) abortGeneration();
  state.currentId = null;
  renderChatList(); renderMessages(); closeSidebar();
  els.input.focus();
}
function openChat(id) {
  if (state.busy) abortGeneration();
  state.currentId = id;
  renderChatList(); renderMessages(true); closeSidebar();
}
function deleteChat(id) {
  if (!confirm('¿Borrar este chat?')) return;
  state.chats = state.chats.filter((c) => c.id !== id);
  if (state.currentId === id) state.currentId = null;
  saveChats(); renderChatList(); renderMessages();
}

/* ---------- Render de mensajes ---------- */
function msgContentText(m) {
  if (m.role === 'user') return m.content;
  if (m.image) return `[Imagen generada: ${m.image.prompt}]`;
  const v = (m.variants || []).find((x) => x.content);
  return v ? v.content : '';
}

function userEl(m) {
  const d = document.createElement('div');
  d.className = 'msg';
  const b = document.createElement('div');
  b.className = 'bubble-user';
  if (m.files && m.files.length) {
    const a = document.createElement('span');
    a.className = 'att'; a.textContent = '📎 ' + m.files.join(', ');
    b.appendChild(a);
  }
  b.appendChild(document.createTextNode(m.display != null ? m.display : m.content));
  d.appendChild(b);
  return d;
}

function variantEl(v, vi, mi, multi, isLast) {
  const wrap = document.createElement('div');
  wrap.className = 'variant';
  if (multi) {
    const head = document.createElement('div');
    head.className = 'variant-head';
    head.innerHTML = '<span class="nm"></span>';
    $('.nm', head).textContent = v.label || v.model;
    const pick = document.createElement('button');
    pick.type = 'button'; pick.className = 'pick'; pick.textContent = 'Elegir';
    pick.dataset.act = 'pick'; pick.dataset.m = mi; pick.dataset.v = vi;
    head.appendChild(pick);
    wrap.appendChild(head);
  }
  const body = document.createElement('div');
  body.className = 'md variant-body';
  if (v.error) {
    if (v.content) setBody(body, v.content, false);
    const e = document.createElement('div');
    e.className = 'err'; e.textContent = v.error;
    body.appendChild(e);
  } else {
    setBody(body, v.content, state.busy && isLast && !v.done);
  }
  wrap.appendChild(body);
  return wrap;
}

function actionsEl(mi, canRegen) {
  const a = document.createElement('div');
  a.className = 'msg-actions';
  const mk = (act, icon, label) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'icon-btn'; b.dataset.act = act; b.dataset.m = mi; b.setAttribute('aria-label', label);
    b.innerHTML = `<svg class="ic sm"><use href="#${icon}"/></svg>`;
    return b;
  };
  a.appendChild(mk('copy', 'i-copy', 'Copiar respuesta'));
  if (navigator.share) a.appendChild(mk('share', 'i-share', 'Compartir'));
  if (canRegen) a.appendChild(mk('regen', 'i-refresh', 'Regenerar respuesta'));
  return a;
}

function imageEl(m, mi, isLast) {
  const d = document.createElement('div');
  const card = document.createElement('div');
  card.className = 'img-card';
  const img = document.createElement('img');
  img.alt = m.image.prompt; img.decoding = 'async';
  img.addEventListener('load', () => card.classList.add('loaded'));
  img.addEventListener('error', () => {
    card.classList.add('loaded'); card.innerHTML = '';
    const e = document.createElement('div');
    e.className = 'err'; e.style.padding = '16px'; e.textContent = 'No se pudo generar la imagen. Intenta de nuevo.';
    card.appendChild(e);
  });
  img.src = m.image.url;
  card.appendChild(img);
  d.appendChild(card);
  const a = document.createElement('div');
  a.className = 'msg-actions';
  const dl = document.createElement('button');
  dl.type = 'button'; dl.className = 'icon-btn'; dl.dataset.act = 'download'; dl.dataset.m = mi; dl.setAttribute('aria-label', 'Descargar imagen');
  dl.innerHTML = '<svg class="ic sm"><use href="#i-download"/></svg>';
  a.appendChild(dl);
  if (isLast) {
    const rg = document.createElement('button');
    rg.type = 'button'; rg.className = 'icon-btn'; rg.dataset.act = 'regen-img'; rg.dataset.m = mi; rg.setAttribute('aria-label', 'Otra versión');
    rg.innerHTML = '<svg class="ic sm"><use href="#i-refresh"/></svg>';
    a.appendChild(rg);
  }
  d.appendChild(a);
  return d;
}

function assistantEl(m, mi, isLast) {
  const d = document.createElement('div');
  d.className = 'msg';
  if (m.image) { d.appendChild(imageEl(m, mi, isLast)); return d; }
  const multi = m.variants.length > 1;
  const grid = document.createElement('div');
  grid.className = 'variants' + (multi ? ' multi' : '');
  m.variants.forEach((v, vi) => grid.appendChild(variantEl(v, vi, mi, multi, isLast)));
  d.appendChild(grid);
  const settled = !(state.busy && isLast);
  if (settled && !multi && m.variants[0].content) d.appendChild(actionsEl(mi, isLast));
  else if (settled && !multi && m.variants[0].error && isLast) d.appendChild(actionsEl(mi, true));
  return d;
}

function renderMessages(scrollBottom = false) {
  const chat = currentChat();
  els.messages.innerHTML = '';
  if (!chat || !chat.messages.length) {
    els.messages.appendChild(els.empty);
    els.empty.hidden = false;
    return;
  }
  els.empty.hidden = true;
  const last = chat.messages.length - 1;
  chat.messages.forEach((m, i) => {
    els.messages.appendChild(m.role === 'user' ? userEl(m) : assistantEl(m, i, i === last));
  });
  if (scrollBottom) els.messages.scrollTop = els.messages.scrollHeight;
}

const nearBottom = () => els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight < 140;
const scrollToBottom = () => { els.messages.scrollTop = els.messages.scrollHeight; };

/* ---------- Llamadas a la IA ---------- */
function buildHistory(chat, upToIndex) {
  const sys = SYSTEM_PROMPTS[state.mode] || SYSTEM_PROMPTS.chat;
  const msgs = [];
  let total = 0;
  for (let i = upToIndex - 1; i >= 0; i--) {
    const m = chat.messages[i];
    const content = msgContentText(m);
    if (!content) continue;
    total += content.length;
    if (total > MAX_HISTORY_CHARS && msgs.length) break;
    msgs.unshift({ role: m.role, content });
  }
  return [{ role: 'system', content: sys }, ...msgs];
}

function authHeaders(model) {
  const h = { 'Content-Type': 'application/json' };
  if (model.provider === 'openrouter') { h.Authorization = `Bearer ${settings.orKey}`; h['X-Title'] = 'FreeIA'; }
  else if (settings.polKey) h.Authorization = `Bearer ${settings.polKey}`;
  return h;
}

async function streamVariant(v, model, history, signal, bodyEl) {
  let scheduled = false;
  const paint = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const stick = nearBottom();
      setBody(bodyEl, v.content, !v.done);
      if (stick) scrollToBottom();
    });
  };
  try {
    const res = await fetch(PROVIDERS[model.provider].chatUrl, {
      method: 'POST', headers: authHeaders(model), signal,
      body: JSON.stringify({ model: model.id, messages: history, stream: true }),
    });
    if (!res.ok) {
      let detail = '';
      try { const j = await res.json(); detail = (j.error && (j.error.message || j.error)) || j.message || ''; } catch { /* sin cuerpo */ }
      if (res.status === 401 || res.status === 403) throw new Error('Acceso denegado. Revisa tu clave en Ajustes.' + (detail ? ` (${detail})` : ''));
      if (res.status === 429) throw new Error('Demasiadas solicitudes. Espera un momento o prueba otro modelo.');
      throw new Error(`El modelo respondió con error ${res.status}.${detail ? ' ' + String(detail).slice(0, 140) : ''}`);
    }
    const ctype = res.headers.get('content-type') || '';
    if (!res.body || ctype.includes('application/json')) {
      const j = await res.json();
      v.content = (j.choices && j.choices[0] && (j.choices[0].message || {}).content) || '';
    } else {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          try {
            const j = JSON.parse(data);
            const delta = j.choices && j.choices[0] && j.choices[0].delta;
            if (delta && delta.content) { v.content += delta.content; paint(); }
          } catch { /* línea parcial o keep-alive */ }
        }
      }
    }
    if (!v.content.trim()) throw new Error('El modelo no devolvió respuesta. Prueba con otro.');
  } catch (err) {
    if (err.name === 'AbortError') { /* el usuario detuvo la generación */ }
    else if (err instanceof TypeError) v.error = navigator.onLine ? 'No se pudo conectar con el servicio de IA.' : 'Sin conexión a internet.';
    else v.error = err.message || 'Error desconocido.';
  } finally {
    v.done = true;
  }
}

async function generate(chat) {
  const targets = settings.selected.map(modelByKey).filter(Boolean);
  if (!targets.length) { toast('Elige un modelo primero'); return; }
  const blocked = targets.find((m) => PROVIDERS[m.provider].needsKey && !settings.orKey);
  if (blocked) {
    toast('Ese modelo necesita tu clave gratuita de OpenRouter');
    renderSettings(); openSheet('sheet-settings');
    return;
  }
  state.busy = true; setSendState();
  const msg = { role: 'assistant', variants: targets.map((m) => ({ model: m.key, label: m.label, content: '', error: null, done: false })) };
  chat.messages.push(msg);
  const mi = chat.messages.length - 1;
  const history = buildHistory(chat, mi);
  renderMessages();
  scrollToBottom();
  const bodies = $$('.msg', els.messages).pop().querySelectorAll('.variant-body');
  const ctrl = new AbortController();
  state.ctrl = ctrl;
  await Promise.all(msg.variants.map((v, i) => streamVariant(v, targets[i], history, ctrl.signal, bodies[i])));
  msg.variants.forEach((v) => { delete v.done; });
  state.busy = false; state.ctrl = null; setSendState();
  chat.updated = Date.now();
  saveChats(); renderChatList(); renderMessages();
  if (!els.messages.matches(':hover')) scrollToBottom();
}

function abortGeneration() { if (state.ctrl) state.ctrl.abort(); }

function makeImageUrl(prompt) {
  const seed = Math.floor(Math.random() * 1e9);
  const q = new URLSearchParams({ model: 'flux', width: '1024', height: '1024', nologo: 'true', seed: String(seed) });
  if (settings.polKey) q.set('token', settings.polKey);
  return `${PROVIDERS.pollinations.imageUrl}${encodeURIComponent(prompt)}?${q}`;
}

/* ---------- Enviar ---------- */
function setSendState() {
  els.send.classList.toggle('stop', state.busy);
  els.send.setAttribute('aria-label', state.busy ? 'Detener' : 'Enviar');
  els.send.innerHTML = `<svg class="ic"><use href="#${state.busy ? 'i-stop' : 'i-send'}"/></svg>`;
}

function chatTitle(text) {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 42 ? t.slice(0, 42) + '…' : t || 'Nuevo chat';
}

async function onSend() {
  if (state.busy) { abortGeneration(); return; }
  const text = els.input.value.trim();
  if (!text && !state.attachments.length) return;
  haptic(12);

  let chat = currentChat();
  if (!chat) {
    chat = { id: uid(), title: chatTitle(text || state.attachments[0].name), messages: [], updated: Date.now() };
    state.chats.push(chat);
    state.currentId = chat.id;
  }

  const files = state.attachments;
  let content = text;
  if (files.length) {
    const blocks = files.map((f) => `Archivo adjunto "${f.name}":\n\`\`\`\n${f.text}\n\`\`\``).join('\n\n');
    content = `${text || 'Analiza y resume los archivos adjuntos.'}\n\n${blocks}`;
  }
  chat.messages.push({ role: 'user', content, display: text || 'Analiza los archivos adjuntos.', files: files.map((f) => f.name) });
  chat.updated = Date.now();

  els.input.value = ''; autosize();
  state.attachments = []; renderAttachments();

  if (state.mode === 'image') {
    chat.messages.push({ role: 'assistant', image: { prompt: text, url: makeImageUrl(text) } });
    saveChats(); renderChatList(); renderMessages(); scrollToBottom();
    return;
  }
  saveChats(); renderChatList();
  await generate(chat);
}

/* ---------- Acciones sobre mensajes ---------- */
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copiado'); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('Copiado'); } catch { toast('No se pudo copiar'); }
    ta.remove();
  }
}

async function downloadImage(url, name) {
  try {
    const blob = await (await fetch(url)).blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  } catch { window.open(url, '_blank', 'noopener'); }
}

function onMessageClick(e) {
  const copyBtn = e.target.closest('.copy');
  if (copyBtn) {
    const code = $('code', copyBtn.parentElement);
    copyText(code ? code.textContent : copyBtn.parentElement.textContent);
    return;
  }
  const btn = e.target.closest('[data-act]');
  const chat = currentChat();
  if (!btn || !chat) return;
  const mi = Number(btn.dataset.m);
  const m = chat.messages[mi];
  if (!m) return;
  haptic();
  switch (btn.dataset.act) {
    case 'copy': copyText(msgContentText(m)); break;
    case 'share': navigator.share({ text: msgContentText(m) }).catch(() => {}); break;
    case 'pick': {
      m.variants = [m.variants[Number(btn.dataset.v)]];
      chat.updated = Date.now(); saveChats(); renderMessages();
      break;
    }
    case 'regen': {
      if (state.busy) return;
      chat.messages.splice(mi, 1);
      saveChats(); renderMessages();
      generate(chat);
      break;
    }
    case 'regen-img': {
      m.image.url = makeImageUrl(m.image.prompt);
      saveChats(); renderMessages();
      break;
    }
    case 'download': downloadImage(m.image.url, 'freeia-imagen.png'); break;
    default: break;
  }
}

/* ---------- Adjuntos ---------- */
function renderAttachments() {
  els.attachments.innerHTML = '';
  state.attachments.forEach((f, i) => {
    const c = document.createElement('div');
    c.className = 'att-chip';
    c.innerHTML = '<span></span><button type="button" aria-label="Quitar archivo"><svg class="ic sm"><use href="#i-x"/></svg></button>';
    $('span', c).textContent = f.name;
    $('button', c).addEventListener('click', () => { state.attachments.splice(i, 1); renderAttachments(); });
    els.attachments.appendChild(c);
  });
}

async function onFiles(files) {
  for (const f of files) {
    if (state.attachments.length >= MAX_FILES) { toast(`Máximo ${MAX_FILES} archivos`); break; }
    if (f.size > 2 * 1024 * 1024) { toast(`"${f.name}" es demasiado grande (máx. 2 MB)`); continue; }
    try {
      let text = await f.text();
      if (text.includes('\u0000')) { toast(`"${f.name}" no es un archivo de texto`); continue; }
      if (text.length > MAX_FILE_CHARS) { text = text.slice(0, MAX_FILE_CHARS); toast(`"${f.name}" se recortó a ${MAX_FILE_CHARS / 1000}k caracteres`); }
      state.attachments.push({ name: f.name, text });
    } catch { toast(`No se pudo leer "${f.name}"`); }
  }
  renderAttachments();
}

/* ---------- Compositor ---------- */
function autosize() {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(els.input.scrollHeight, 160) + 'px';
}
function setMode(mode) {
  state.mode = mode;
  $$('.mode').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  els.input.placeholder = SUGGESTION_MODES[mode];
}

/* ---------- Ajustes ---------- */
function renderSettings() {
  $('#set-pol-key').value = settings.polKey || '';
  $('#set-or-key').value = settings.orKey || '';
  $('#ver').textContent = APP_VERSION;
  $('#btn-install').hidden = !state.deferredInstall;
}

/* ---------- Tema ---------- */
function applyTheme() {
  const root = document.documentElement;
  if (settings.theme === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', settings.theme);
  const dark = settings.theme === 'dark' || (settings.theme === 'auto' && !matchMedia('(prefers-color-scheme: light)').matches);
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#0f0b1e' : '#f6f4ff');
}
function toggleTheme() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark'
    || (!document.documentElement.getAttribute('data-theme') && !matchMedia('(prefers-color-scheme: light)').matches);
  settings.theme = isDark ? 'light' : 'dark';
  saveSettings(); applyTheme();
}

/* ---------- Eventos ---------- */
function bindEvents() {
  $('#btn-menu').addEventListener('click', openSidebar);
  $('#btn-close-side').addEventListener('click', closeSidebar);
  els.scrim.addEventListener('click', closeSidebar);
  $('#btn-new').addEventListener('click', newChat);
  $('#btn-theme').addEventListener('click', toggleTheme);
  $('#btn-model').addEventListener('click', () => {
    $('#chk-compare').checked = settings.compare;
    $('#model-search').value = '';
    renderModelList(); openSheet('sheet-model');
  });
  $('#btn-settings').addEventListener('click', () => { renderSettings(); openSheet('sheet-settings'); closeSidebar(); });
  $('#btn-attach').addEventListener('click', () => els.file.click());
  els.file.addEventListener('change', () => { onFiles([...els.file.files]); els.file.value = ''; });
  els.send.addEventListener('click', onSend);
  els.input.addEventListener('input', autosize);
  els.input.addEventListener('keydown', (e) => {
    const touch = matchMedia('(pointer: coarse)').matches;
    if (e.key === 'Enter' && !e.shiftKey && !touch && !e.isComposing) { e.preventDefault(); onSend(); }
  });
  $('#modes').addEventListener('click', (e) => { const b = e.target.closest('.mode'); if (b) setMode(b.dataset.mode); });
  $$('.chip').forEach((c) => c.addEventListener('click', () => { els.input.value = c.dataset.prompt + ' '; autosize(); els.input.focus(); }));

  els.list.addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]'); if (del) { deleteChat(del.dataset.del); return; }
    const open = e.target.closest('[data-open]'); if (open) openChat(open.dataset.open);
  });
  els.messages.addEventListener('click', onMessageClick);

  $$('.sheet-wrap').forEach((w) => w.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) w.hidden = true; }));
  $('#model-list').addEventListener('click', (e) => { const r = e.target.closest('.model-row'); if (r) onModelPick(r.dataset.key); });
  $('#model-search').addEventListener('input', renderModelList);
  $('#chk-compare').addEventListener('change', (e) => {
    settings.compare = e.target.checked;
    if (!settings.compare) settings.selected = settings.selected.slice(0, 1);
    saveSettings(); updateModelLabel(); renderModelList();
  });

  $('#btn-save-set').addEventListener('click', () => {
    settings.polKey = $('#set-pol-key').value.trim();
    settings.orKey = $('#set-or-key').value.trim();
    saveSettings(); closeSheet('sheet-settings');
    toast('Guardado. Actualizando modelos…');
    loadModels(true);
  });
  $('#btn-wipe').addEventListener('click', () => {
    if (!confirm('¿Borrar TODOS los chats de este dispositivo?')) return;
    state.chats = []; state.currentId = null; saveChats(); renderChatList(); renderMessages();
    closeSheet('sheet-settings'); toast('Chats borrados');
  });
  $('#btn-install').addEventListener('click', async () => {
    if (!state.deferredInstall) return;
    state.deferredInstall.prompt();
    await state.deferredInstall.userChoice.catch(() => {});
    state.deferredInstall = null; $('#btn-install').hidden = true;
  });

  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); state.deferredInstall = e; });
  window.addEventListener('online', () => loadModels(true));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $$('.sheet-wrap').forEach((w) => { w.hidden = true; }); });
}

/* ---------- Auto-actualización ---------- */
let reloading = false;
async function checkVersion(reg) {
  try {
    if (reg) reg.update().catch(() => {});
    const res = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return;
    const { version } = await res.json();
    if (version && version !== APP_VERSION) {
      toast('Actualizando FreeIA…', 1800);
      if (reg && reg.waiting) reg.waiting.postMessage('SKIP_WAITING');
      await sleep(900);
      doReload();
    }
  } catch { /* sin conexión: seguimos con la versión actual */ }
}
function doReload() {
  if (reloading) return;
  reloading = true;
  saveChats(); saveSettings();
  location.reload();
}
function setupServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
    checkVersion(reg);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkVersion(reg); });
    setInterval(() => checkVersion(reg), 45 * 60 * 1000);
  }).catch(() => { /* el SW no es imprescindible */ });
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) { hadController = true; return; }
    doReload();
  });
}

/* ---------- Pista de instalación en iPhone ---------- */
function iosInstallHint() {
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  if (!ios || standalone || storage.get('freeia.iosHint', false)) return;
  storage.set('freeia.iosHint', true);
  setTimeout(() => toast('Para instalar: Compartir → Añadir a pantalla de inicio', 6000), 2500);
}

/* ---------- Inicio ---------- */
function init() {
  applyTheme();
  bindEvents();
  setSendState();
  setMode('chat');
  renderChatList();
  renderMessages();
  loadModels();
  setupServiceWorker();
  iosInstallHint();
  $('#ver').textContent = APP_VERSION;
}
init();
