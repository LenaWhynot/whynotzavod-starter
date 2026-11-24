// Контент-завод v4 — онлайн-интерфейс. Все данные выводятся через textContent, без innerHTML.
const $root = document.getElementById('app');
const state = {
  screen: 'idei', ws: null, refs: null, analytics: null, error: '',
  bank: {sel: null, period: 'all', src: 'all', status: 'open', toast: ''},
  scen: {sel: null, filter: 'all', toast: ''},
  cal: {month: null},
  stats: {days: 30},
};

function h(tag, attrs, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'style') node.style.cssText = value; // CSSOM: не блокируется CSP style-src
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'value') node.value = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}
const safeUrl = url => { try { const u = new URL(url); return ['https:', 'http:'].includes(u.protocol) ? u.href : null; } catch { return null; } };
const mediaUrl = url => typeof url === 'string' && url.startsWith('/api/') ? url : null;
const bg = url => url ? `background-image:url("${encodeURI(url).replace(/"/g, '%22')}")` : '';
const dm = iso => iso ? new Date(iso.length === 10 ? iso + 'T12:00:00' : iso).toLocaleDateString('ru', {day: '2-digit', month: '2-digit'}) : '';
const moscowClock = new Intl.DateTimeFormat('ru-RU', {timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit'});
const moscowDateTime = new Intl.DateTimeFormat('ru-RU', {timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit'});
const publicationLabels = {planned: 'В плане', scheduled: 'В очереди', published: 'Опубликовано'};
const num = n => typeof n === 'number' ? n.toLocaleString('ru') : '—';
const uuid = () => crypto.randomUUID();
const store = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
};

async function api(path, options = {}) {
  const response = await fetch(path, {...options, headers: {'content-type': 'application/json', ...(options.headers || {})}});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Не удалось сохранить.');
  return data;
}
const put = (path, body) => api(path, {method: 'PUT', body: JSON.stringify(body)});

async function load(silent) {
  try {
    const [ws, refs] = await Promise.all([api('/api/workspace', {cache: 'no-store'}), api('/api/references', {cache: 'no-store'})]);
    state.ws = ws; state.refs = refs; state.error = '';
  } catch (error) { state.error = error.message; }
  if (!silent) render(); else render();
}
let analyticsRequest;
function loadAnalytics() {
  if (analyticsRequest) return analyticsRequest;
  analyticsRequest = api('/api/workspace/reel-analytics', {cache: 'no-store'})
    .then(data => { state.analytics = data.analytics || {reels: []}; }, () => { state.analytics = {reels: [], failed: true}; })
    .finally(() => { analyticsRequest = null; });
  return analyticsRequest;
}

/* ---------------- Банк идей ---------------- */
function bankItems() {
  const {ws, refs} = state;
  const decisions = ws.decisions || {};
  const items = [];
  for (const rec of refs.records || []) {
    const key = `reference:${rec.id}`;
    const ad = (rec.adaptations || [])[0] || {};
    const mine = (rec.provenance || []).some(p => p.kind === 'user_direct');
    const date = (rec.metrics?.snapshotAt || rec.original?.publishedAt || rec.updatedAt || '').slice(0, 10);
    const ratio = rec.metrics?.ratioToAuthor;
    const decision = decisions[key]?.decision || (rec.selection === 'shortlisted' ? 'take' : null);
    items.push({
      key, kind: 'reference', id: rec.id, title: rec.title || 'Без названия', origin: mine ? 'mine' : 'trend', date,
      author: rec.original?.author ? '@' + String(rec.original.author).replace(/^@/, '') : (rec.original?.platform || ''),
      platform: rec.original?.platform || '',
      metric: ratio ? '×' + Math.round(ratio) + ' к автору' : (rec.metrics?.views ? num(rec.metrics.views) + ' просм.' : ''),
      preview: rec.original?.previewAvailable ? `/api/references/${encodeURIComponent(rec.id)}/preview` : null,
      url: safeUrl(rec.original?.sourceUrl),
      about: rec.analysis?.summary || rec.original?.layers?.spoken?.summary || '',
      literal: [rec.original?.layers?.spoken?.summary, rec.original?.layers?.spoken?.quote ? '«' + rec.original.layers.spoken.quote + '»' : ''].filter(Boolean).join('\n\n'),
      adapt: [ad.hook, ad.body].filter(Boolean).join('\n\n'),
      hooks: (ad.hookVariants || []).map(v => v.text).filter(Boolean).slice(0, 5),
      isPost: ['x', 'threads', 'news', 'notion'].includes(rec.original?.platform),
      decision,
    });
  }
  for (const idea of ws.ideas || []) {
    const key = `idea:${idea.id}`;
    items.push({key, kind: 'idea', id: idea.id, title: idea.title, origin: 'mine', date: (idea.date || '').slice(0, 10), author: 'моя идея',
      about: idea.body || '', adapt: '', hooks: [], literal: '', url: safeUrl(/https?:\/\/\S+/.exec(idea.body || idea.title || '')?.[0]),
      decision: decisions[key]?.decision || null});
  }
  for (const item of ws.backlog || []) {
    const key = `backlog:${item.id}`;
    items.push({key, kind: 'backlog', id: item.id, title: item.title, origin: 'mine', date: '', author: item.group || 'бэклог',
      about: item.body || '', adapt: '', hooks: [], literal: '', decision: decisions[key]?.decision || null});
  }
  return items.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

function filterBank(items) {
  const {period, src, status} = state.bank;
  const now = Date.now();
  const limit = period === 'week' ? 7 : period === 'month' ? 31 : 0;
  return items.filter(item => {
    if (limit && (!item.date || now - Date.parse(item.date) > limit * 86400000)) return false;
    if (src !== 'all' && item.origin !== src) return false;
    if (status === 'open') return item.decision !== 'skip';
    if (status === 'new') return !item.decision;
    if (status === 'take') return item.decision === 'take';
    if (status === 'skip') return item.decision === 'skip';
    return true;
  });
}

async function decide(item, decision) {
  try {
    if (item.kind === 'reference' && decision === 'take') await api(`/api/references/${encodeURIComponent(item.id)}`, {method: 'PATCH', body: JSON.stringify({selection: 'shortlisted'})});
    if (item.kind === 'reference' && decision === 'skip') await api(`/api/references/${encodeURIComponent(item.id)}`, {method: 'PATCH', body: JSON.stringify({selection: 'review'})});
    await put(`/api/workspace/decision/${encodeURIComponent(item.key)}`, {decision});
    state.bank.toast = decision === 'take' ? 'Взято в работу.' : 'Пропущено.';
  } catch (error) { state.bank.toast = error.message; }
  await load(true);
}

async function addLink(event) {
  event.preventDefault();
  const input = event.target.querySelector('input');
  const url = input.value.trim();
  if (!safeUrl(url)) { state.bank.toast = 'Вставь ссылку, начинается с https://'; render(); return; }
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const {idea} = await api('/api/ideas', {method: 'POST', body: JSON.stringify({title: 'Ссылка · ' + host, myText: url})});
    state.bank.sel = `idea:${idea.id}`;
    state.bank.toast = 'Ссылка сохранена в банке.';
  } catch (error) { state.bank.toast = error.message; }
  await load(true);
}

function bankScreen() {
  const all = bankItems();
  const items = filterBank(all);
  if (!items.some(i => i.key === state.bank.sel)) state.bank.sel = items[0]?.key || null;
  const sel = all.find(i => i.key === state.bank.sel);
  const b = state.bank;
  const select = (value, onchange, label, options) => h('select', {class: 'ctl', 'aria-label': label, onchange},
    options.map(([v, t]) => h('option', {value: v, selected: v === value}, t)));
  const originChip = item => h('span', {class: 'chip ' + (item.origin === 'mine' ? 'ok' : 'accent')},
    (item.origin === 'mine' ? 'Моя идея' : 'Тренд') + (item.date ? ' · ' + dm(item.date) : ''));
  const decisionChip = item => item.decision === 'take' ? h('span', {class: 'chip ok'}, 'Взято') : item.decision === 'skip' ? h('span', {class: 'chip'}, 'Пропущено') : null;
  return [
    h('div', {class: 'bar'},
      select(b.period, e => { b.period = e.target.value; render(); }, 'Период', [['all', 'За всё время'], ['week', 'Последняя неделя'], ['month', 'Последний месяц']]),
      select(b.src, e => { b.src = e.target.value; render(); }, 'Источник', [['all', 'Все'], ['trend', 'Тренды'], ['mine', 'Мои идеи']]),
      select(b.status, e => { b.status = e.target.value; render(); }, 'Решение', [['open', 'Без пропущенных'], ['new', 'Новые'], ['take', 'Взятые'], ['skip', 'Пропущенные'], ['any', 'Все решения']]),
      h('span', {class: 'meta'}, items.length + ' идей'),
      h('div', {class: 'grow'}),
      h('button', {class: 'btn', onclick: () => editIdea()}, 'Новая идея'),
      h('form', {class: 'form', style: 'flex:0 1 520px', onsubmit: addLink},
        h('label', {class: 'sr', for: 'link'}, 'Ссылка на рилс или пост'),
        h('input', {id: 'link', class: 'ctl', placeholder: 'Вставь ссылку на рилс или пост для адаптации'}),
        h('button', {class: 'btn-p', type: 'submit'}, 'Взять'))),
    b.toast ? h('div', {class: 'toast'}, b.toast) : null,
    h('div', {class: 'md'},
      h('div', {class: 'list', role: 'list'},
        items.length ? items.map(item => h('button', {class: 'row', role: 'listitem', 'aria-current': item.key === b.sel ? 'true' : null,
          onclick: () => { b.sel = item.key; b.toast = ''; render(); }},
          h('span', {class: 'thumb', style: bg(item.preview)}),
          h('span', {class: 'col'},
            h('span', {class: 't'}, item.title),
            h('span', {class: 's'}, originChip(item), decisionChip(item), item.author, item.metric)))) :
          h('div', {class: 'empty'}, 'Добавь ссылку или создай идею.')),
      sel ? bankDetail(sel, originChip) : null),
  ];
}

function bankDetail(item, originChip) {
  return h('section', {class: 'detail'},
    h('div', {class: 'head'},
      h('div', {class: 'ttl'}, h('span', {class: 'meta'}, [item.author, item.metric].filter(Boolean).join(' · ')), h('h2', {class: 'title'}, item.title)),
      h('div', {class: 'bar'},
        item.kind === 'idea' ? h('button', {class: 'btn', onclick: () => editIdea(item)}, 'Редактировать') : null,
        h('button', {class: 'btn', onclick: () => decide(item, item.decision === 'skip' ? null : 'skip')}, item.decision === 'skip' ? 'Вернуть' : 'Пропустить'),
        h('button', {class: 'btn-p', disabled: item.decision === 'take', onclick: () => decide(item, 'take')}, item.decision === 'take' ? 'Взято ✓' : 'Беру'),
        h('button', {class: 'btn', onclick: () => editScenario(null, item)}, 'Создать сценарий'))),
    item.isPost ?
      h('div', {class: 'panel'}, h('span', {class: 'meta'}, 'Пост · ' + item.platform + ' · без видео'), h('div', {class: 'text'}, item.about || item.literal || '—'),
        item.url ? h('a', {href: item.url, target: '_blank', rel: 'noopener'}, 'Открыть оригинал ↗') : null) :
      h('div', {class: 'preview'},
        h('div', {class: 'img', style: bg(item.preview), role: 'img', 'aria-label': 'Кадр оригинала'}),
        h('div', {class: 'about'}, h('span', {class: 'meta'}, 'О чём'), h('span', {}, item.about || '—'),
          item.url ? h('a', {href: item.url, target: '_blank', rel: 'noopener'}, 'Смотреть оригинал ↗') : null,
          h('span', {class: 'meta'}, 'Видео оригинала не копируем: права автора. Открывается по ссылке.'))),
    item.adapt ? h('section', {style: 'display:flex;flex-direction:column;gap:6px'}, h('h3', {}, 'Адаптация под тебя'), h('div', {class: 'box'}, item.adapt),
      item.literal ? h('details', {}, h('summary', {}, 'Дословно из оригинала'), h('div', {class: 'box', style: 'margin-top:8px;color:#3F3F46'}, item.literal)) : null) : null,
    item.hooks.length ? h('section', {style: 'display:flex;flex-direction:column;gap:6px'}, h('h3', {}, 'Хуки'),
      h('div', {class: 'hooks'}, item.hooks.map((text, i) => h('div', {}, h('b', {}, i + 1), h('span', {}, text))))) : null);
}

function editDialog(title, fields, saveLabel, save) {
  const dialog = h('dialog', {class: 'starter-dialog', 'aria-label': title});
  const feedback = h('p', {class: 'meta', role: 'status'});
  const submit = h('button', {class: 'btn-p', type: 'submit'}, saveLabel);
  const cancel = h('button', {class: 'btn', type: 'button', onclick: () => dialog.close()}, 'Отмена');
  const form = h('form', {onsubmit: async event => {
    event.preventDefault();
    submit.disabled = true;
    feedback.textContent = 'Сохраняю…';
    try {
      await save();
      dialog.close();
    } catch (error) {
      feedback.textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  }}, fields.map(([label, input], index) => {
    input.id = 'starter-field-' + index;
    return h('div', {class: 'starter-field'}, h('label', {for: input.id}, label), input);
  }), feedback,
    h('div', {class: 'bar'}, submit, cancel));
  dialog.append(h('h2', {}, title), form);
  dialog.addEventListener('close', () => dialog.remove(), {once: true});
  document.body.append(dialog);
  dialog.showModal();
}

function editIdea(item) {
  const title = h('input', {class: 'ctl', required: true, maxlength: 160, value: item?.title ?? ''});
  const text = h('textarea', {class: 'ctl', rows: 6, maxlength: 20000, value: item?.about ?? ''});
  editDialog(item ? 'Редактировать идею' : 'Новая идея', [['Название', title], ['Заметка', text]], 'Сохранить', async () => {
    const {idea} = await api(item ? '/api/ideas/' + encodeURIComponent(item.id) : '/api/ideas', {
      method: item ? 'PATCH' : 'POST', body: JSON.stringify({title: title.value, myText: text.value}),
    });
    state.bank.sel = 'idea:' + idea.id;
    state.bank.toast = 'Идея сохранена.';
    await load();
  });
}

/* ---------------- Сценарии ---------------- */
function editScenario(scenario, idea) {
  const title = h('input', {class: 'ctl', required: true, maxlength: 160, value: scenario?.title ?? idea?.title ?? ''});
  const hooks = h('textarea', {class: 'ctl', rows: 3, maxlength: 4009, value: (scenario?.hooks ?? []).map(hook => hook.text).join('\n')});
  const body = h('textarea', {class: 'ctl', required: true, maxlength: 28000, rows: 8, value: scenario?.body ?? (idea?.adapt || idea?.about || '')});
  editDialog(scenario ? 'Редактировать сценарий' : 'Новый сценарий', [
    ['Название', title], ['Хуки, по одному на строку', hooks], ['Сценарий', body],
  ], 'Сохранить', async () => {
    const path = '/api/workspace/scenario' + (scenario ? '/' + encodeURIComponent(scenario.id) : '');
    const input = {title: title.value, body: body.value, hooks: hooks.value.split('\n').map(line => line.trim()).filter(Boolean)};
    const {scenario: saved} = await api(path, {method: scenario ? 'PUT' : 'POST', body: JSON.stringify(input)});
    state.scen.sel = 'studio:' + saved.id;
    state.scen.toast = 'Сценарий сохранён.';
    state.scen.filter = 'all';
    location.hash = '#scen/' + encodeURIComponent(state.scen.sel);
    await load();
  });
}

function uploadVideo(scenario) {
  const video = h('input', {class: 'ctl', type: 'file', accept: '.mp4,video/mp4', required: true});
  const hook = h('select', {class: 'ctl'}, h('option', {value: ''}, 'Без привязки к хуку'),
    scenario.hooks.map(item => h('option', {value: item.id}, item.text)));
  editDialog('Добавить версию', [['Файл MP4 до 50 МБ', video], ['Хук', hook]], 'Загрузить', async () => {
    const file = video.files[0];
    if (!file?.size || file.size > 50 * 1024 * 1024 || !/\.mp4$/i.test(file.name)) throw new Error('Выбери MP4 размером до 50 МБ.');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
    const sha256 = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
    await api('/api/workspace/scenario/' + encodeURIComponent(scenario.id) + '/video', {
      method: 'PUT', body: file, headers: {'content-type': 'video/mp4', 'x-file-sha256': sha256, 'x-hook-id': hook.value},
    });
    if (['shoot', 'montage'].includes(scenario.ws)) {
      await put('/api/workspace/stage/' + encodeURIComponent(scenario.key), {stage: 'review'});
    }
    state.scen.toast = 'Видео сохранено.';
    state.scen.filter = 'all';
    await load();
  });
}

const STAGES = [['shoot', 'Снять', 'warn'], ['montage', 'Монтаж', 'info'], ['review', 'Ревью', 'warn'], ['changes', 'Правки', 'bad'], ['approved', 'Одобрено', 'ok'],
  ['test', 'В тесте', 'accent'], ['winner', 'Победитель', 'solid'], ['flop', 'Не залетел', '']];
const WORK = ['shoot', 'montage', 'review', 'changes', 'approved', 'test'];
const stageMeta = key => STAGES.find(s => s[0] === key) || STAGES[0];
const REV = {queued: ['В очереди', ''], 'in-progress': ['В работе', 'info'], 'needs-input': ['Нужно уточнение', 'warn'], ready: ['Готово к проверке', 'ok'], done: ['Готово', 'ok']};
const revChip = status => { const [t, c] = REV[status] || [status, '']; return h('span', {class: 'chip ' + c}, t); };

function versionReviewComplete(output) {
  if (output.reviewStatus != null) return output.reviewStatus === 'approved';
  return Boolean(output.reviewId) && (state.ws?.hookPublications || []).some(publication =>
    publication.reviewId === output.reviewId && publication.status === 'published');
}

function versionReviewStage(s) {
  if (!s.hookOutputs?.length) return null;
  return s.hookOutputs.every(versionReviewComplete) ? 'approved' : 'review';
}

function revisionReviewStatus(revision, outputs) {
  if (revision.status !== 'ready' || !Array.isArray(revision.resultReviewIds)) return revision.status;
  const results = outputs.filter(output => revision.resultReviewIds.includes(output.reviewId));
  return results.length && results.every(versionReviewComplete) ? 'done' : revision.status;
}

function workStage(s) {
  if (s.workStage && s.workStage !== 'review' && s.workStage !== 'approved') return s.workStage;
  const reviewStage = versionReviewStage(s);
  if (reviewStage || s.workStage) return reviewStage || s.workStage;
  if (s.clips?.length) return 'montage';
  return 'shoot';
}
function studio() {
  const list = (state.ws.scenarios || []).filter(s => s.kind === 'studio').map(s => ({...s, key: `studio:${s.id}`, ws: workStage(s)}));
  const order = store.get('zavod.order', []);
  return list.sort((a, b) => {
    const ia = order.indexOf(a.key), ib = order.indexOf(b.key);
    if (ia >= 0 || ib >= 0) return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib);
    return (b.source?.date || '').localeCompare(a.source?.date || '');
  });
}

let dragKey = null;
function scenScreen() {
  const all = studio().filter(s => WORK.includes(s.ws));
  const f = state.scen.filter;
  const items = all.filter(s => f === 'all' || s.ws === f);
  if (!items.some(s => s.key === state.scen.sel)) state.scen.sel = items[0]?.key || null;
  const sel = all.find(s => s.key === state.scen.sel);
  const pills = [['all', 'Все', all.length], ...WORK.map(k => [k, stageMeta(k)[1], all.filter(s => s.ws === k).length]).filter(p => p[2] || p[0] === f)];
  const reorder = (from, to, after) => {
    const keys = studio().map(s => s.key).filter(k => k !== from);
    keys.splice(keys.indexOf(to) + (after ? 1 : 0), 0, from);
    store.set('zavod.order', keys); render();
  };
  return [
    h('div', {class: 'bar'}, pills.map(([k, t, n]) => h('button', {class: 'pill', 'aria-pressed': String(k === f), onclick: () => { state.scen.filter = k; render(); }}, t, h('span', {}, n))),
      h('div', {class: 'grow'}), h('button', {class: 'btn-p', onclick: () => editScenario()}, 'Новый сценарий')),
    state.scen.toast ? h('div', {class: 'toast'}, state.scen.toast) : null,
    h('div', {class: 'md'},
      h('div', {class: 'list'}, items.length ? items.map(s => {
        const [, label, tone] = stageMeta(s.ws);
        const reviewStage = s.ws === 'test' ? versionReviewStage(s) : null;
        const [, reviewLabel, reviewTone] = stageMeta(reviewStage);
        const row = h('button', {class: 'row', draggable: 'true', 'aria-current': s.key === state.scen.sel ? 'true' : null,
          onclick: () => { state.scen.sel = s.key; state.scen.toast = ''; render(); },
          ondragstart: e => { dragKey = s.key; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', s.key); setTimeout(() => row.classList.add('dragging')); },
          ondragend: () => { dragKey = null; document.querySelectorAll('.row').forEach(r => r.classList.remove('dragging', 'drop-above', 'drop-below')); },
          ondragover: e => { if (!dragKey || dragKey === s.key) return; e.preventDefault(); const r = row.getBoundingClientRect(); const below = e.clientY > r.top + r.height / 2;
            row.classList.toggle('drop-below', below); row.classList.toggle('drop-above', !below); },
          ondragleave: () => row.classList.remove('drop-above', 'drop-below'),
          ondrop: e => { e.preventDefault(); if (dragKey && dragKey !== s.key) reorder(dragKey, s.key, row.classList.contains('drop-below')); }},
          h('span', {class: 'grip', 'aria-hidden': 'true'}, '⋮⋮'),
          h('span', {class: 'col'}, h('span', {class: 't ell'}, s.title),
            h('span', {class: 's'}, h('span', {class: 'chip ' + tone}, label),
              reviewStage ? h('span', {class: 'chip ' + reviewTone}, reviewLabel) : null,
              (s.hooks || []).length + ' хуков', dm(s.source?.date))));
        return row;
      }) : h('div', {class: 'empty'}, 'В этом статусе ничего нет.')),
      sel ? scenDetail(sel) : null),
  ];
}

async function setStage(s, value) {
  try { await put(`/api/workspace/stage/${encodeURIComponent(s.key)}`, {stage: value}); state.scen.toast = ''; }
  catch (error) { state.scen.toast = error.message; }
  await load(true);
}

function scenDetail(s) {
  const ws = state.ws;
  const refUrl = safeUrl((s.references || [])[0]?.url || s.source?.url);
  const hooks = (s.hooks || []).map(x => x.text).filter(Boolean);
  const body = [s.body, s.ending].filter(Boolean).join('\n\n');
  const reviewStage = versionReviewStage(s);
  const head = h('div', {class: 'head'},
    h('div', {class: 'ttl'}, h('span', {class: 'meta'}, [s.source?.title, dm(s.source?.date)].filter(Boolean).join(' · ')), h('h2', {class: 'title'}, s.title),
      h('div', {class: 'bar'},
        h('button', {class: 'btn', onclick: () => editScenario(s)}, 'Редактировать сценарий'),
        h('button', {class: 'btn', onclick: () => uploadVideo(s)}, 'Добавить видео'))),
    h('label', {class: 'meta', style: 'display:flex;flex-direction:column;gap:4px'}, 'Статус',
      h('select', {class: 'ctl', onchange: e => setStage(s, e.target.value)},
        STAGES.map(([k, t]) => h('option', {value: k, selected: k === s.ws,
          disabled: reviewStage === 'review' && k === 'approved' || reviewStage === 'approved' && k === 'review'},
        t)))));
  const hooksBlock = h('div', {class: 'hooks'}, hooks.map((text, i) => h('div', {}, h('b', {}, i + 1), h('span', {}, text))));

  if (s.ws === 'shoot') {
    const copy = async () => {
      const text = hooks.map((t, i) => `Хук ${i + 1}\n${t}`).join('\n\n') + '\n\n— Тело —\n' + body;
      try { await navigator.clipboard.writeText(text); state.scen.toast = 'Хуки и сценарий скопированы — вставь в суфлёр.'; }
      catch { state.scen.toast = 'Не получилось скопировать. Выдели текст ниже вручную.'; }
      render();
    };
    return h('section', {class: 'detail big'}, head,
      h('div', {class: 'bar'}, h('button', {class: 'btn-p', onclick: copy}, 'Добавить в суфлёр'),
        refUrl ? h('a', {class: 'btn', href: refUrl, target: '_blank', rel: 'noopener'}, 'Референс') : null),
      h('section', {style: 'display:flex;flex-direction:column;gap:12px'}, h('h3', {style: 'color:#52525B'}, 'Хуки'), hooksBlock),
      h('section', {style: 'display:flex;flex-direction:column;gap:12px'}, h('h3', {style: 'color:#52525B'}, 'Сценарий'), h('div', {class: 'text'}, body || '—')));
  }

  const revisions = (ws.revisions || []).filter(r => r.scenarioKey === s.key);
  const revisionNote = revision => h('div', {class: 'note'},
    revChip(revisionReviewStatus(revision, s.hookOutputs)), revision.comment);
  const post = (ws.posts || []).find(p => p.scenarioId === s.id || (s.postIds || []).includes(p.id));
  const sendRevision = (comment, reviewId) => put('/api/workspace/revisions', {scenarioKey: s.key, reviewId, comment, clientRequestId: uuid()})
    .then(() => { state.scen.toast = 'Правка сохранена в карточке.'; }, e => { state.scen.toast = e.message; }).then(() => load(true));
  const verLabel = o => o.reviewStatus === 'approved' ? ['Одобрена', 'ok'] : o.reviewStatus === 'changes-requested' ? ['На правке', 'bad'] : ['Ждёт ревью', 'warn'];
  const montage = s.ws === 'montage';
  return h('section', {class: 'detail'}, head,
    montage ? h('div', {class: 'toast'}, `Загружено ${s.hookOutputs.length} из ${hooks.length || '—'} версий.`) : null,
    h('div', {class: 'panel'}, h('h3', {}, 'Правка ко всем версиям'),
      s.hookOutputs.length ? h('form', {class: 'form', onsubmit: async e => { e.preventDefault(); const i = e.target.querySelector('input'); const t = i.value.trim(); if (t) { i.disabled = true; await sendRevision(t); } }},
        h('input', {class: 'ctl', placeholder: 'Например: убрать фото на всех версиях', 'aria-label': 'Правка ко всем версиям'}), h('button', {class: 'btn', type: 'submit'}, 'Отправить')) :
        h('span', {class: 'meta'}, 'Появится, когда будут собраны версии.'),
      revisions.filter(r => r.scope === 'body').map(revisionNote)),
    post?.caption ? h('div', {class: 'panel'}, h('h3', {}, 'Описание'), h('div', {class: 'text'}, post.caption)) : null,
    h('details', {class: 'panel'}, h('summary', {}, 'Сценарий · хуки и тело'),
      h('div', {style: 'display:flex;flex-direction:column;gap:12px;margin-top:4px'},
        h('span', {class: 'meta'}, 'Хуки'), hooksBlock,
        h('span', {class: 'meta', style: 'display:flex;justify-content:space-between;gap:8px'}, h('span', {}, 'Тело — общее для всех версий'),
          (s.clips || []).length ? h('span', {}, 'Исходники: ' + s.clips.map(c => c.file).join(', ')) : null),
        h('div', {class: 'text'}, body || '—'),
        refUrl ? h('a', {href: refUrl, target: '_blank', rel: 'noopener'}, 'Референс ↗') : null)),
    h('div', {style: 'display:flex;flex-direction:column;gap:12px'},
      h('h3', {}, `Версии · ${s.hookOutputs.length}`),
      s.hookOutputs.length ? h('div', {class: 'grid'}, s.hookOutputs.map(o => {
        const badge = h('span', {});
        const publicationInfo = h('div', {class: 'ver-publications'});
        const feedback = h('span', {class: 'meta', role: 'status'});
        let busy = false;
        const handle = action => async () => {
          busy = true;
          drawVersionState();
          feedback.textContent = 'Сохраняю…';
          try {
            await action();
            feedback.textContent = '';
          } catch (error) {
            feedback.textContent = error.message;
          } finally {
            busy = false;
            drawVersionState();
          }
        };
        const review = h('button', {type: 'button', onclick: handle(async () => {
          const status = o.reviewStatus === 'approved' ? 'montage-review' : 'approved';
          const saved = await put('/api/workspace/media-review', {reviewId: o.reviewId, status});
          if (saved.reviewId !== o.reviewId || saved.reviewStatus !== status) throw new Error('Не удалось подтвердить статус версии.');
          const previous = workStage(s);
          const previousRevisionStatuses = revisions.map(r => revisionReviewStatus(r, s.hookOutputs));
          o.reviewStatus = status;
          const next = workStage(s);
          const stageChanged = next !== previous || reviewStage !== versionReviewStage(s);
          const revisionChanged = revisions.some((r, i) => previousRevisionStatuses[i] !== revisionReviewStatus(r, s.hookOutputs));
          if ((stageChanged || revisionChanged) && state.ws === ws && state.screen === 'scen' && state.scen.sel === s.key) {
            if (state.scen.filter === previous) state.scen.filter = next;
            render();
          }
        })});
        const calendar = h('button', {class: 'btn', type: 'button', onclick: handle(async () => {
          const {publication} = await put('/api/workspace/hook-publication', {reviewId: o.reviewId, action: 'plan-trial'});
          if (publication?.reviewId !== o.reviewId) throw new Error('Не удалось подтвердить запись в календаре.');
          ws.hookPublications = [...(ws.hookPublications || []).filter(item => item.id !== publication.id), publication];
        })}, 'В календарь');
        function drawVersionState() {
          const [label, tone] = verLabel(o);
          const approved = o.reviewStatus === 'approved';
          const pubs = (ws.hookPublications || []).filter(item => item.reviewId === o.reviewId);
          const publishedWithoutReview = o.reviewStatus == null && versionReviewComplete(o);
          badge.className = 'chip ' + tone;
          badge.textContent = label;
          badge.hidden = publishedWithoutReview;
          review.className = approved ? 'btn' : 'btn-p';
          review.textContent = approved ? 'Вернуть на ревью' : 'Одобрить';
          review.hidden = publishedWithoutReview;
          review.disabled = busy || !o.reviewId || o.reviewStatus === 'changes-requested' && revisions.some(r =>
            ['queued', 'in-progress', 'needs-input'].includes(r.status) && r.targetReviewIds?.includes(o.reviewId));
          calendar.hidden = !approved || pubs.length > 0;
          calendar.disabled = busy;
          publicationInfo.replaceChildren(...pubs.map(item => {
            const label = publicationLabels[item.status];
            const chip = item.url
              ? h('a', {class: 'chip solid', href: item.url, target: '_blank', rel: 'noopener'}, label)
              : h('span', {class: 'chip ' + (item.status === 'scheduled' ? 'info' : 'warn')}, label);
            return h('div', {class: 'ver-publication'}, h('div', {class: 'drawer-meta'}, chip,
              h('span', {class: 'meta'}, `${dm(item.day)} · ${moscowClock.format(new Date(item.at))} МСК · ${item.placement === 'trial' ? 'Trial' : 'лента'}`)),
              publicationCaption(item), trialRequestNotes(item), trialPublicationActions(item, saved => {
                replaceHookPublication(saved);
                drawVersionState();
              }));
          }));
        }
        drawVersionState();
        return h('div', {class: 'ver'},
          h('video', {controls: true, preload: 'none', playsinline: true, poster: mediaUrl(o.posterUrl), src: mediaUrl(o.url)}),
          h('div', {class: 'ver-badges'}, badge, publicationInfo),
          h('div', {class: 'vt'}, o.hookText || ''),
          revisions.filter(r => r.reviewId === o.reviewId || (r.targetReviewIds || []).includes(o.reviewId) && r.scope === 'video')
            .map(revisionNote),
          h('form', {onsubmit: async e => { e.preventDefault(); const i = e.target.querySelector('input'); const t = i.value.trim(); if (t) { i.disabled = true; await sendRevision(t, o.reviewId); } }},
            h('input', {class: 'ctl', placeholder: 'Что поправить', 'aria-label': 'Правка к версии'}),
            h('div', {}, h('button', {class: 'btn', type: 'submit'}, 'Правка'), review, calendar)), feedback);
      })) : h('div', {class: 'empty'}, 'Версий пока нет.')));
}

/* ---------------- Календарь ---------------- */
function reelCover(url) {
  const src = mediaUrl(url);
  return src ? h('img', {src, alt: '', loading: 'lazy', decoding: 'async', draggable: 'false',
    onerror: e => { e.currentTarget.hidden = true; }}) : null;
}

function instagramKey(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' && ['instagram.com', 'www.instagram.com'].includes(parsed.hostname)) {
      return /^\/(?:reel|p)\/([\w-]+)\/?$/.exec(parsed.pathname)?.[1];
    }
  } catch {}
}

function calendarPostTime(post) {
  if (post.at && Number.isFinite(Date.parse(post.at))) return moscowClock.format(new Date(post.at));
  return post.when?.slice(11, 16) || '';
}

function publicationCaption(post) {
  if (typeof post.caption !== 'string') {
    return h('p', {class: 'meta publication-caption-missing'},
      post.status === 'planned' ? 'Описание публикации ещё не добавлено' : 'Описание публикации ещё не загружено');
  }
  return h('details', {class: 'publication-caption'}, h('summary', {}, 'Описание публикации'),
    post.caption === '' ? h('p', {class: 'meta'}, 'Без описания') : h('p', {class: 'publication-caption-text'}, post.caption));
}

function replaceHookPublication(saved) {
  state.ws.hookPublications = state.ws.hookPublications.map(post => post.id === saved.id ? saved : post);
}

function trialRequestNotes(post) {
  return [
    post.moveRequest ? h('p', {class: 'drawer-move-note'},
      `Перенос на ${dm(post.moveRequest.day)} в ${calendarPostTime(post.moveRequest)} МСК · ждёт подтверждения`) : null,
    post.publishRequest ? h('p', {class: 'drawer-move-note'}, 'Публикация сейчас запрошена · ждёт подтверждения Instagram Trial') : null,
    post.moveResult?.outcome === 'rejected' ? h('p', {class: 'drawer-move-note'}, post.moveResult.reason || 'Перенос не подтверждён') : null,
    post.publishResult?.outcome === 'rejected' ? h('p', {class: 'drawer-move-note'}, post.publishResult.reason || 'Публикация сейчас отклонена') : null,
  ];
}

function drawerPublication(post, compact, moveControl) {
  const published = post.status === 'published' || post.status === 'опубликовано';
  const label = publicationLabels[post.status] || post.status;
  const placement = post.placement === 'trial' || post.targets?.includes('trial') ? 'Trial'
    : post.placement === 'feed' || post.targets?.includes('reel') ? 'Лента' : '';
  const legacyKey = /^ig-([\w-]+)$/.exec(post.id || '')?.[1];
  const key = instagramKey(post.url) || legacyKey;
  const reel = key ? state.analytics?.reels?.find(item => instagramKey(item.url) === key) : null;
  const url = instagramKey(post.url) ? post.url : reel?.url;
  const clock = calendarPostTime(post);
  const metrics = [['views', 'Просмотры'], ['reach', 'Охват'], ['likes', 'Лайки'], ['comments', 'Комментарии'],
    ['saves', 'Сохранения'], ['shares', 'Репосты']].filter(([name]) => Number.isFinite(reel?.metrics?.[name]));
  return h('div', {class: 'drawer-publication'},
    h('div', {class: 'drawer-meta'}, h('span', {class: 'chip ' + (published ? 'solid' : post.status === 'planned' ? 'warn' : 'info')}, label),
      h('span', {class: 'meta'}, [placement, dm(post.day), clock && `${clock} МСК`].filter(Boolean).join(' · ')),
      !compact && url ? h('a', {href: url, target: '_blank', rel: 'noopener'}, 'Instagram ↗') : null),
    metrics.length ? h('dl', {class: 'drawer-metrics'}, metrics.map(([name, label]) => h('div', {},
      h('dt', {}, label), h('dd', {}, num(reel.metrics[name])))))
      : published ? h('p', {class: 'meta'}, !state.analytics ? 'Загружаю статистику…' :
        state.analytics.failed ? 'Статистика не загрузилась' : 'По этой публикации пока нет метрик') : null,
    !compact && post.reviewId ? publicationCaption(post) : null, trialRequestNotes(post), moveControl);
}

const calendarTrialHours = ['09:00', '12:00', '15:00'];
const trialSlotReasons = {current: 'текущий слот', past: 'прошёл', occupied: 'занят'};

function canMoveTrial(post) {
  return post.placement === 'trial' && !post.moveRequest && !post.publishRequest &&
    (post.status === 'planned' || post.status === 'scheduled' && post.at > new Date().toISOString());
}

async function readTrialSlots(post, day) {
  const query = new URLSearchParams({day, reviewId: post.reviewId});
  return (await api('/api/workspace/trial-slots?' + query, {cache: 'no-store'})).slots;
}

async function requestTrialMove(post, day, time) {
  const {publication} = await put('/api/workspace/hook-publication', {
    action: 'move-trial', reviewId: post.reviewId, expectedAt: post.at, day, time,
  });
  if (publication?.id !== post.id) throw new Error('Не удалось подтвердить перенос.');
  return publication;
}

function trialMoveForm(post, onMoved) {
  const today = new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
  const date = h('input', {class: 'ctl', type: 'date', min: today, value: post.day < today ? today : post.day, required: true});
  const picker = h('select', {class: 'ctl', required: true});
  const feedback = h('p', {class: 'meta', role: 'status'});
  const submit = h('button', {class: 'btn-p', type: 'submit', disabled: true}, post.status === 'planned' ? 'Сохранить дату' : 'Запросить перенос');
  const details = h('details', {class: 'drawer-move'});
  let latest = 0;
  async function showSlots() {
    const sequence = ++latest;
    picker.disabled = true;
    submit.disabled = true;
    picker.replaceChildren(h('option', {value: ''}, 'Проверяю слоты…'));
    feedback.textContent = '';
    try {
      const slots = await readTrialSlots(post, date.value);
      if (sequence !== latest) return;
      const available = slots.some(slot => slot.available);
      picker.replaceChildren(h('option', {value: ''}, available ? 'Выбери время' : 'Свободных слотов нет'),
        ...slots.map(slot => h('option', {value: slot.time, disabled: !slot.available},
          slot.time + (slot.reason ? ` · ${trialSlotReasons[slot.reason]}` : ''))));
      picker.disabled = !available;
    } catch (error) {
      if (sequence === latest) feedback.textContent = error.message;
    }
  }
  picker.addEventListener('change', () => { submit.disabled = !picker.value; });
  date.addEventListener('change', showSlots);
  details.addEventListener('toggle', () => { if (details.open) showSlots(); });
  details.append(h('summary', {}, 'Перенести'), h('form', {onsubmit: async e => {
    e.preventDefault();
    submit.disabled = true;
    date.disabled = true;
    picker.disabled = true;
    feedback.textContent = 'Сохраняю…';
    try {
      onMoved(await requestTrialMove(post, date.value, picker.value));
    } catch (error) {
      await showSlots();
      feedback.textContent = error.message;
    } finally { date.disabled = false; }
  }}, h('div', {class: 'drawer-move-inputs'}, h('label', {class: 'meta'}, 'Дата', date),
    h('label', {class: 'meta'}, 'Время, МСК', picker)), submit, feedback));
  return details;
}

function trialPublicationActions(post, onSaved) {
  return post.status === 'planned' && canMoveTrial(post) ? trialMoveForm(post, onSaved) : null;
}

let reelDrawer;
function openReelDrawer({script, output, publication}, trigger) {
  const related = script?.hookOutputs || [];
  const moveControls = new Map();
  const forVersion = reviewId => reviewId ? (state.ws.hookPublications || []).filter(post => post.reviewId === reviewId) : [];
  let current = {output, publication};
  const drawer = h('dialog', {class: 'reel-drawer', 'aria-labelledby': 'drawer-reel-title', onclick: e => {
    if (e.target === drawer && e.clientX < drawer.getBoundingClientRect().left) drawer.close();
  }});
  const title = h('h2', {id: 'drawer-reel-title'});
  const topicUrl = script?.kind === 'studio' && WORK.includes(workStage(script)) ? `#scen/${encodeURIComponent('studio:' + script.id)}` : null;
  const header = h('header', {class: 'drawer-header'}, h('div', {},
    script ? topicUrl ? h('a', {class: 'meta', href: topicUrl, onclick: () => drawer.close()}, script.title)
      : h('span', {class: 'meta'}, script.title) : null, title),
    h('button', {class: 'btn drawer-close', type: 'button', 'aria-label': 'Закрыть карточку', autofocus: true,
      onclick: () => drawer.close()}, '×'));
  const body = h('div', {class: 'drawer-body'});
  drawer.append(header, body);
  drawer.addEventListener('close', () => {
    drawer.remove();
    if (reelDrawer === drawer) reelDrawer = null;
    const originalSlot = trigger?.dataset.publicationId;
    const focus = trigger?.isConnected ? trigger : [...document.querySelectorAll('[data-publication-id]')]
      .find(tile => tile.dataset.publicationId === originalSlot);
    focus?.focus({preventScroll: true});
  });
  function onMoved(saved) {
    replaceHookPublication(saved);
    current.publication = saved;
    const day = saved.moveRequest?.day || saved.day;
    state.cal.month = day.slice(0, 7) + '-01';
    render();
    draw();
    header.querySelector('button').focus({preventScroll: true});
  }
  function moveControl(post) {
    if (!moveControls.has(post)) moveControls.set(post, trialPublicationActions(post, onMoved));
    return moveControls.get(post);
  }
  function draw() {
    const {output: version, publication: post} = current;
    const reviewId = version?.reviewId || post?.reviewId;
    const poster = version?.posterUrl || post?.posterUrl;
    const video = mediaUrl(version?.url) || (reviewId && `/api/workspace/media/output/${encodeURIComponent('renders/' + reviewId)}`);
    title.textContent = version?.hookText || post?.hook || post?.title || script?.title || 'Ролик';
    const dates = forVersion(reviewId).filter(item => item.id !== post?.id);
    if (post) dates.unshift(post);
    const otherVersions = related.filter(item => item !== version && (!reviewId || item.reviewId !== reviewId));
    const videoError = h('p', {class: 'meta', hidden: true}, 'Видео недоступно');
    body.replaceChildren(
      h('section', {class: 'drawer-hero'},
        video ? h('div', {class: 'drawer-player'}, h('video', {controls: true, preload: 'none', playsinline: true, src: video,
          poster: mediaUrl(poster), onerror: () => { videoError.hidden = false; }}), videoError) : null,
        h('div', {class: 'drawer-dates'}, dates.length ? dates.map(item => drawerPublication(item, false, moveControl(item))) :
          h('p', {class: 'meta'}, 'Дата публикации ещё не назначена'))),
      state.analytics?.fetchedAt ? h('p', {class: 'meta drawer-source'}, 'Данные на ' +
        moscowDateTime.format(new Date(state.analytics.fetchedAt)) + ' МСК') : null,
      otherVersions.length ? h('section', {class: 'drawer-siblings'}, h('h3', {}, 'Другие версии'),
        otherVersions.map(item => {
          const itemDates = forVersion(item.reviewId);
          const select = () => {
            current = {output: item, publication: itemDates.find(x => x.status === 'published') || itemDates[0]};
            draw();
            body.scrollTop = 0;
            header.querySelector('button').focus({preventScroll: true});
          };
          return h('article', {class: 'drawer-sibling'},
            h('button', {class: 'drawer-version', type: 'button', onclick: select},
              reelCover(item.posterUrl), h('span', {}, item.hookText || `Версия ${related.indexOf(item) + 1}`), h('span', {'aria-hidden': 'true'}, '›')),
            itemDates.length ? itemDates.map(date => drawerPublication(date, true)) : h('p', {class: 'meta'}, 'Без даты публикации'));
        })) : null);
  }
  reelDrawer = drawer;
  document.body.append(drawer);
  draw();
  drawer.showModal();
  if (!state.analytics?.fetchedAt) {
    const start = state.analytics;
    loadAnalytics().then(() => {
      if (drawer.open && state.analytics !== start) draw();
    });
  }
}

function calScreen() {
  const ws = state.ws;
  const todayIso = new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (!state.cal.month) state.cal.month = todayIso.slice(0, 7) + '-01';
  const first = new Date(state.cal.month + 'T12:00:00');
  const y = first.getFullYear(), m = first.getMonth();
  const shift = d => { state.cal.month = iso(new Date(y, m + d, 1, 12)); render(); };
  const scenarios = studio();
  const byKey = new Map(scenarios.map(s => [s.key, s]));
  const plans = (ws.plans || []).filter(p => p && p.day);
  const planned = new Set(plans.map(p => p.id));
  const hookPublications = ws.hookPublications || [];
  const datedVersions = new Set(hookPublications.map(p => p.reviewId));
  const tray = scenarios.filter(s => s.ws === 'approved' && !planned.has(s.key) &&
    (!s.hookOutputs.length || s.hookOutputs.some(output => !datedVersions.has(output.reviewId))));
  const notice = h('div', {class: 'toast calendar-notice' + (state.cal.notice?.error ? ' err' : ''), role: 'status'},
    state.cal.notice?.message || '');
  let drag = null;
  let activeDrop = null;
  function hideDrop() {
    if (!activeDrop) return;
    activeDrop.node.classList.remove('over');
    if (activeDrop.overlay) activeDrop.overlay.hidden = true;
    activeDrop = null;
  }
  function finishDrag() {
    hideDrop();
    drag?.source.classList.remove('calendar-drag-source');
    drag = null;
    window.removeEventListener('keydown', cancelOnEscape);
  }
  function cancelOnEscape(event) {
    if (event.key === 'Escape') finishDrag();
  }
  function startDrag(event, item) {
    if (!event.dataTransfer || state.cal.movingTrial) { event.preventDefault(); return; }
    finishDrag();
    drag = {...item, source: event.currentTarget, slots: new Map()};
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-whynotzavod-calendar', item.post?.id || item.key);
    event.currentTarget.classList.add('calendar-drag-source');
    window.addEventListener('keydown', cancelOnEscape);
  }
  function showDrop(node, day, overlay) {
    if (activeDrop?.node === node) return;
    hideDrop();
    activeDrop = {node, overlay};
    node.classList.add('over');
    if (!overlay) return;
    overlay.hidden = false;
    overlay.replaceChildren(h('span', {class: 'calendar-drop-message'}, 'Проверяю слоты…'));
    const target = activeDrop;
    const currentDrag = drag;
    if (!currentDrag.slots.has(day)) {
      currentDrag.slots.set(day, readTrialSlots(currentDrag.post, day).catch(error => {
        currentDrag.slots.delete(day);
        throw error;
      }));
    }
    currentDrag.slots.get(day).then(slots => {
      if (activeDrop !== target) return;
      overlay.replaceChildren(...calendarTrialHours.map(time => {
        const slot = slots.find(item => item.time === time);
        const reason = trialSlotReasons[slot?.reason] || '';
        const label = reason ? `${time} МСК · ${reason}` : `${time} МСК`;
        return h('button', {class: 'calendar-drop-slot', type: 'button', tabindex: '-1',
          'data-trial-hour': time, disabled: !slot?.available, 'aria-label': label, title: label},
        time, reason ? h('small', {}, reason) : null);
      }));
    }, () => {
      if (activeDrop === target) overlay.replaceChildren(h('span', {class: 'calendar-drop-message'}, 'Не удалось проверить слоты'));
    });
  }
  async function moveCalendarTrial(post, day, time) {
    state.cal.movingTrial = true;
    state.cal.notice = {message: 'Сохраняю перенос…'};
    notice.textContent = state.cal.notice.message;
    notice.classList.remove('err');
    try {
      const saved = await requestTrialMove(post, day, time);
      replaceHookPublication(saved);
      state.cal.notice = {message: saved.moveRequest
        ? `Перенос на ${dm(day)} в ${time} МСК запрошен` : `Ролик перенесён на ${dm(day)} в ${time} МСК`};
    } catch (error) {
      state.cal.notice = {message: error.message, error: true};
    } finally {
      state.cal.movingTrial = false;
      if (state.screen === 'calendar') {
        const scrollLeft = document.querySelector('.cal')?.scrollLeft || 0;
        render();
        document.querySelector('.cal').scrollLeft = scrollLeft;
      }
    }
  }
  const movePlan = async (key, day) => {
    try { await put(`/api/workspace/plan/${encodeURIComponent(key)}`, {day}); } catch (error) { alert(error.message); }
    await load(true);
  };
  const planTile = (key, title) => {
    const s = byKey.get(key);
    const output = s?.hookOutputs?.[0];
    return h('div', {class: 'tile', title: (title || s?.title || '') + ' · серия'},
      h('div', {class: 'pic plan', draggable: 'true', ondragstart: e => startDrag(e, {key}), ondragend: finishDrag},
        reelCover(output?.posterUrl), h('span', {class: 'tile-letter'}, 'С')),
      h('small', {}, 'серия'));
  };
  const postTile = p => {
    const late = p.status !== 'опубликовано' && p.day < todayIso;
    const title = p.title + ' · ' + p.status + (late ? ' · дата прошла, проверить' : '');
    const script = p.scenarioId ? ws.scenarios.find(s => s.id === p.scenarioId && s.kind === p.scenarioKind) : null;
    return h('button', {class: 'tile publication-tile', type: 'button', title, 'aria-label': title,
      onclick: e => openReelDrawer({script, publication: p}, e.currentTarget)},
      h('span', {class: 'pic ' + (p.status === 'опубликовано' ? 'done' : '') + (late ? ' late' : '')},
        h('span', {class: 'tile-letter'}, (p.targets || []).includes('trial') ? 'T' : 'Л')),
      h('small', {}, calendarPostTime(p) || '—'));
  };
  const trackedPosts = new Set(hookPublications.map(item => item.providerId).filter(Boolean));
  const publicationTile = (p, provisional) => {
    const time = calendarPostTime(provisional ? p.moveRequest : p);
    const label = provisional ? 'Перенос ждёт подтверждения' : publicationLabels[p.status];
    const title = [p.title, p.hook, label, `${time} МСК`, p.publishRequest ? 'Публикация сейчас запрошена' : ''].filter(Boolean).join(' · ');
    const script = byKey.get(p.scenarioKey);
    const output = script?.hookOutputs.find(item => item.reviewId === p.reviewId);
    const draggable = !provisional && canMoveTrial(p);
    return h('button', {class: 'tile publication-tile', type: 'button', title, 'aria-label': title, 'data-publication-id': p.id,
      draggable: draggable ? 'true' : null, ondragstart: draggable ? e => startDrag(e, {post: p}) : null, ondragend: draggable ? finishDrag : null,
      onclick: e => openReelDrawer({script, output, publication: p}, e.currentTarget)},
      h('span', {class: 'pic ' + (provisional ? 'move-pending' : p.status === 'published' ? 'done' : p.status === 'planned' ? 'plan' : '')},
        reelCover(p.posterUrl || output?.posterUrl), h('span', {class: 'tile-letter'}, p.placement === 'trial' ? 'T' : 'Л')),
      h('small', {}, time));
  };
  const dropZone = (node, day) => {
    const overlay = day ? h('div', {class: 'calendar-drop-slots', hidden: true}) : null;
    if (overlay) node.append(overlay);
    function updateDrop(event) {
      if (!drag || drag.post && (!day || day < todayIso)) { hideDrop(); return; }
      showDrop(node, day, drag.post ? overlay : null);
      event.preventDefault();
      const slot = event.target.closest?.('[data-trial-hour]');
      if (event.dataTransfer) event.dataTransfer.dropEffect = !drag.post || (slot && !slot.disabled) ? 'move' : 'none';
    }
    node.addEventListener('dragenter', updateDrop);
    node.addEventListener('dragover', updateDrop);
    node.addEventListener('dragleave', event => {
      if (activeDrop?.node !== node || (event.relatedTarget instanceof Node && node.contains(event.relatedTarget))) return;
      const rect = node.getBoundingClientRect();
      if (!event.relatedTarget && event.clientX >= rect.left && event.clientX < rect.right &&
          event.clientY >= rect.top && event.clientY < rect.bottom) return;
      hideDrop();
    });
    node.addEventListener('drop', event => {
      if (!drag) return;
      event.preventDefault();
      const selected = drag;
      const slot = event.target.closest?.('[data-trial-hour]');
      const available = !!(day && activeDrop?.node === node && slot && !slot.disabled && overlay.contains(slot));
      finishDrag();
      if (selected.key) movePlan(selected.key, day);
      else if (available) moveCalendarTrial(selected.post, day, slot.dataset.trialHour);
    });
    return node;
  };
  const start = (first.getDay() + 6) % 7;
  const daysIn = new Date(y, m + 1, 0).getDate();
  const total = Math.ceil((start + daysIn) / 7) * 7;
  const cells = [];
  for (let i = 0; i < total; i++) {
    const d = new Date(y, m, i - start + 1, 12);
    const inMonth = d.getMonth() === m;
    const day = iso(d);
    const posts = (ws.posts || []).filter(p => p.day === day && !trackedPosts.has(p.id)).sort((a, b) => (a.when || '').localeCompare(b.when || ''));
    const dayPlans = plans.filter(p => p.day === day);
    const dayPublications = hookPublications.flatMap(p => [
      ...(p.day === day ? [{post: p, at: p.at, provisional: false}] : []),
      ...(p.moveRequest?.day === day ? [{post: p, at: p.moveRequest.at, provisional: true}] : []),
    ]).sort((a, b) => a.at.localeCompare(b.at));
    cells.push(dropZone(h('div', {class: 'day' + (inMonth ? '' : ' out'), 'data-calendar-day': day},
      h('span', {class: 'num' + (day === todayIso ? ' today' : '')}, d.getDate()),
      h('div', {class: 'tiles'}, dayPlans.map(p => planTile(p.id, p.title)),
        dayPublications.map(({post, provisional}) => publicationTile(post, provisional)), posts.map(postTile))), day));
  }
  const monthLabel = first.toLocaleDateString('ru', {month: 'long', year: 'numeric'});
  return [
    h('div', {class: 'bar'},
      h('button', {class: 'btn', style: 'width:36px;padding:0', 'aria-label': 'Предыдущий месяц', onclick: () => shift(-1)}, '‹'),
      h('span', {style: 'font-weight:600;font-size:14px;min-width:130px;text-align:center'}, monthLabel[0].toUpperCase() + monthLabel.slice(1)),
      h('button', {class: 'btn', style: 'width:36px;padding:0', 'aria-label': 'Следующий месяц', onclick: () => shift(1)}, '›'),
      h('span', {class: 'meta'}, 'Автоплан Trial · 09:00, 12:00, 15:00 МСК')),
    notice,
    dropZone(h('div', {class: 'tray'}, h('span', {class: 'meta'}, 'Одобрено, без даты:'),
      tray.length ? tray.map(s => planTile(s.key, s.title)) : h('span', {class: 'meta'}, 'нет')), null),
    h('div', {class: 'cal'}, h('div', {class: 'cal-in'},
      h('div', {class: 'wk head7'}, ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map(t => h('div', {}, t))),
      h('div', {class: 'wk'}, cells))),
    h('div', {class: 'legend'},
      h('span', {}, h('i', {style: 'background:#B45309'}), 'серия, можно перетаскивать'),
      h('span', {}, h('i', {style: 'background:#B45309'}), 'версия в плане'),
      h('span', {}, h('i', {style: 'background:#18181B'}), 'опубликован'),
      h('span', {}, h('i', {style: 'background:#A1A1AA'}), 'в очереди'),
      hookPublications.some(p => p.moveRequest) ? h('span', {}, h('i', {class: 'move-pending'}), 'перенос ждёт подтверждения') : null,
      h('span', {}, h('i', {style: 'border:2px solid #DC2626'}), 'дата прошла — проверить'),
      h('span', {}, 'T — Trial, Л — лента')),
  ];
}

/* ---------------- Статистика ---------------- */
function statsScreen() {
  const a = state.analytics;
  if (!a) {
    loadAnalytics().then(() => { if (state.screen === 'stats') render(); });
    return [h('p', {class: 'meta'}, 'Загружаю статистику…')];
  }
  if (!a.reels?.length) return [h('div', {class: 'empty'}, a.failed ? 'Не удалось загрузить статистику.' : 'В эту копию ещё не добавлены данные статистики.')];
  const days = state.stats.days;
  const now = Date.parse(a.fetchedAt || new Date().toISOString());
  const rows = a.reels.filter(r => !days || now - Date.parse(r.publishedAt) <= days * 86400000);
  const sum = key => rows.reduce((t, r) => t + (typeof r.metrics?.[key] === 'number' ? r.metrics[key] : 0), 0);
  const views = sum('views'), reach = sum('reach'), saves = sum('saves'), shares = sum('shares'), comments = sum('comments');
  const skips = rows.map(r => r.metrics?.skipRate).filter(v => typeof v === 'number').sort((x, y) => x - y);
  const medianSkip = skips.length ? skips[Math.floor(skips.length / 2)] : null;
  const kept = medianSkip === null ? null : Math.round(views * (100 - medianSkip) / 100);
  const funnel = [['Просмотры', views], ['Досмотрели первые секунды', kept], ['Сохранили и переслали', saves + shares], ['Комментарии', comments]];
  const weeks = [];
  for (let i = 7; i >= 0; i--) {
    const end = now - i * 7 * 86400000, from = end - 7 * 86400000;
    const v = a.reels.filter(r => { const t = Date.parse(r.publishedAt); return t > from && t <= end; }).reduce((t, r) => t + (r.metrics?.views || 0), 0);
    weeks.push([new Date(end).toLocaleDateString('ru', {day: '2-digit', month: '2-digit'}), v]);
  }
  const maxW = Math.max(1, ...weeks.map(w => w[1]));
  const top = rows.filter(r => typeof r.metrics?.views === 'number').sort((x, y) => y.metrics.views - x.metrics.views).slice(0, 10);
  const base = a.insights?.baseline || {};
  const ins = [];
  if (medianSkip !== null) ins.push({what: `Первые секунды держат ${Math.round(100 - medianSkip)}% зрителей`, why: `медиана пролистываний ${Math.round(medianSkip)}% за период; цель — удерживать 60%+.`,
    next: medianSkip > 40 ? 'менять хук и обложку, тема при этом рабочая.' : 'хуки работают — сохраняем формат первых секунд.'});
  if (base.feed && base.outsideFeed) ins.push({what: 'Trial собирает меньше просмотров, но больше полезных действий',
    why: `вне ленты медиана ${num(base.outsideFeed.medianViews)} просмотров против ${num(base.feed.medianViews)} в ленте; сохранений и репостов на 1000 охвата ${base.outsideFeed.medianSavesAndSharesPer1000Reach?.toFixed(1)} против ${base.feed.medianSavesAndSharesPer1000Reach?.toFixed(1)}.`,
    next: 'победителей из Trial выкладывать в ленту — там они получают охват.'});
  const best = top[0];
  if (best) ins.push({what: 'Лучший рилс периода: ' + (best.caption || '').split('\n')[0].slice(0, 70), why: `${num(best.metrics.views)} просмотров, ${num(best.metrics.saves)} сохранений, ${num(best.metrics.comments)} комментариев.`,
    next: 'разобрать его хук и повторить механику в следующей серии.'});
  return [
    h('div', {class: 'bar'},
      h('select', {class: 'ctl', 'aria-label': 'Период', onchange: e => { state.stats.days = Number(e.target.value); render(); }},
        [[7, 'Последняя неделя'], [30, 'Последний месяц'], [0, 'Весь архив']].map(([v, t]) => h('option', {value: v, selected: v === days}, t))),
      h('span', {class: 'meta'}, `${rows.length} рилсов · @${a.account?.username || a.account || 'instagram'} · данные на ${dm(a.fetchedAt)}`)),
    h('div', {class: 'kpis'}, [['Рилсы', rows.length], ['Просмотры', views], ['Охват', reach], ['Сохранения и репосты', saves + shares], ['Комментарии', comments]]
      .map(([t, v]) => h('div', {class: 'kpi'}, h('span', {class: 'meta'}, t), h('b', {}, num(v))))),
    h('div', {class: 'two'},
      h('section', {class: 'panel'}, h('div', {}, h('h3', {}, 'Воронка'), h('p', {class: 'meta', style: 'margin:4px 0 0'}, 'Полоса — сколько дошло с предыдущего шага')),
        funnel.map(([t, v], i) => {
          const prev = i ? funnel[i - 1][1] : v;
          const pct = !i ? 100 : prev ? Math.round(v / prev * 1000) / 10 : 0;
          return h('div', {class: 'fun'}, h('div', {class: 'l'}, h('span', {}, t), h('span', {}, h('b', {}, num(v)), i ? '  ' + pct + '%' : '')),
            h('div', {class: 'track'}, h('i', {style: `width:${Math.max(2, Math.min(100, pct))}%`})));
        }),
        ),
      h('section', {class: 'panel'}, h('div', {}, h('h3', {}, 'Просмотры по неделям'), h('p', {class: 'meta', style: 'margin:4px 0 0'}, 'Все рилсы, по дате публикации')),
        h('div', {class: 'bars'}, weeks.map(([, v]) => h('div', {}, h('span', {}, v >= 1000 ? (Math.round(v / 100) / 10) + 'K' : v),
          h('i', {class: v === maxW ? 'max' : '', style: `height:${Math.round(v / maxW * 140)}px`})))),
        h('div', {class: 'axis'}, weeks.map(([d]) => h('span', {}, d))))),
    h('section', {class: 'panel'}, h('h3', {}, 'Лучшие рилсы периода'),
      h('div', {class: 'table'}, h('table', {},
        h('thead', {}, h('tr', {}, ['Рилс', 'Дата', 'Где', 'Просмотры', 'Пролистывания', 'Сохранения', 'Репосты', 'Комментарии'].map(t => h('th', {}, t)))),
        h('tbody', {}, top.map(r => h('tr', {},
          h('td', {}, safeUrl(r.url) ? h('a', {href: safeUrl(r.url), target: '_blank', rel: 'noopener'}, (r.caption || 'Без подписи').split('\n')[0].slice(0, 60)) : (r.caption || '').slice(0, 60)),
          h('td', {}, dm(r.publishedAt)), h('td', {}, r.placement === 'feed' ? 'лента' : r.placement === 'outside_feed' ? 'Trial' : '—'),
          h('td', {}, num(r.metrics.views)), h('td', {}, typeof r.metrics.skipRate === 'number' ? Math.round(r.metrics.skipRate) + '%' : '—'),
          h('td', {}, num(r.metrics.saves)), h('td', {}, num(r.metrics.shares)), h('td', {}, num(r.metrics.comments)))))))),
    h('section', {style: 'display:flex;flex-direction:column;gap:12px'}, h('h3', {}, 'Выводы'),
      h('div', {class: 'ins'}, ins.map(i => h('div', {class: 'panel'}, h('b', {}, i.what), h('div', {}, h('span', {class: 'meta'}, 'Почему: '), i.why), h('div', {class: 'next'}, h('b', {}, 'Дальше: '), i.next))))),
  ];
}

function settingsScreen() {
  return [
    h('h2', {}, 'Правила и настройки'),
    ...[['svod', 'Голос автора'], ['style', 'Стиль текста на видео']].map(([key, label]) => {
      const text = h('textarea', {class: 'ctl', rows: 8, maxlength: 20000, disabled: true});
      const submit = h('button', {class: 'btn-p', type: 'submit', disabled: true}, 'Сохранить');
      const feedback = h('span', {class: 'meta', role: 'status'});
      api('/api/style?which=' + key).then(({text: saved}) => {
        text.value = saved;
        text.disabled = false;
        submit.disabled = false;
      }).catch(error => { feedback.textContent = error.message; });
      return h('form', {class: 'panel starter-settings', onsubmit: async event => {
        event.preventDefault();
        submit.disabled = true;
        try {
          await put('/api/style', {which: key, text: text.value});
          feedback.textContent = 'Сохранено.';
        } catch (error) {
          feedback.textContent = error.message;
        } finally {
          submit.disabled = false;
        }
      }}, h('label', {}, label, text), h('div', {class: 'bar'}, submit, feedback));
    }),
  ];
}

/* ---------------- Каркас ---------------- */
const SCREENS = [['idei', 'Банк идей'], ['scen', 'Сценарии'], ['calendar', 'Календарь'], ['stats', 'Статистика']];
function render() {
  const screen = state.screen;
  let content;
  if (screen === 'settings') content = settingsScreen();
  else if (state.error && !state.ws) content = [h('div', {class: 'toast err'}, 'Не удалось загрузить данные: ' + state.error)];
  else if (!state.ws) content = [h('p', {class: 'meta'}, 'Загружаю…')];
  else if (screen === 'scen') content = scenScreen();
  else if (screen === 'calendar') content = calScreen();
  else if (screen === 'stats') content = statsScreen();
  else content = bankScreen();
  const counts = state.ws ? {idei: filterBank(bankItems()).filter(i => !i.decision).length, scen: studio().filter(s => ['review', 'changes'].includes(s.ws)).length} : {};
  const scrollY = window.scrollY;
  $root.replaceChildren(h('div', {class: 'app'},
    h('nav', {class: 'side', 'aria-label': 'Разделы'},
      h('div', {class: 'brand'}, h('i', {}, 'W.'), 'Контент-завод'),
      SCREENS.map(([key, label]) => h('a', {class: 'nav', href: '#' + key, 'aria-current': key === screen ? 'page' : null}, label, h('small', {}, counts[key] || ''))),
      h('div', {class: 'spacer'}),
      h('a', {class: 'nav quiet', href: '#settings'}, 'Правила и настройки')),
    h('main', {}, content)));
  window.scrollTo(0, scrollY);
}

function route() {
  const [key, detail] = location.hash.slice(1).split('/');
  state.screen = SCREENS.some(s => s[0] === key) || key === 'settings' ? key : 'idei';
  if (state.screen !== 'calendar' && reelDrawer?.open) reelDrawer.close();
  if (key === 'scen' && detail) {
    try { state.scen.sel = decodeURIComponent(detail); state.scen.filter = 'all'; }
    catch { state.scen.sel = null; }
  }
  render();
}
window.addEventListener('hashchange', route);
route();
load();
