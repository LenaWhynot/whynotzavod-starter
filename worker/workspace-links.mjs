const sourceKinds = new Set(['reference', 'idea', 'backlog']);
const scenarioKinds = new Set(['studio', 'scenario', 'reference', 'idea']);
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 240
  && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
const linkError = (status, message) => Object.assign(new Error(message), {status});

export const workspaceLinkKey = link => JSON.stringify([link.sourceKind, link.sourceId, link.scenarioKind, link.scenarioId]);

export function checkWorkspaceLinkSource(source) {
  if (!sourceKinds.has(source?.sourceKind) || !validId(source?.sourceId)) {
    throw linkError(400, 'Укажи тип и карточку источника.');
  }
}

function sourceList(catalog, kind) {
  if (kind === 'reference') return catalog.references;
  if (kind === 'idea') return catalog.ideas;
  return catalog.backlog;
}

function validRelation(link) {
  return link && sourceKinds.has(link.sourceKind) && validId(link.sourceId)
    && scenarioKinds.has(link.scenarioKind) && validId(link.scenarioId);
}

function endpointsExist(catalog, link) {
  return sourceList(catalog, link.sourceKind).some(item => item.id === link.sourceId)
    && catalog.scenarios.some(script => script.id === link.scenarioId && script.kind === link.scenarioKind);
}

function relationOnly({sourceKind, sourceId, scenarioKind, scenarioId}) {
  return {sourceKind, sourceId, scenarioKind, scenarioId};
}

export function readWorkspaceLinkEdit(catalog, input) {
  checkWorkspaceLinkSource(input);
  if (!scenarioKinds.has(input.scenarioKind) || !validId(input.scenarioId) || typeof input.linked !== 'boolean') {
    throw linkError(400, 'Укажи карточку рилса и действие со связью.');
  }
  if (!sourceList(catalog, input.sourceKind).some(item => item.id === input.sourceId)) {
    throw linkError(404, 'Карточка источника не найдена.');
  }
  if (!catalog.scenarios.some(script => script.kind === input.scenarioKind && script.id === input.scenarioId)) {
    throw linkError(404, 'Карточка рилса не найдена.');
  }
  return {...relationOnly(input), linked: input.linked};
}

function urlKey(value) {
  if (typeof value !== 'string' || !value) return '';
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    if (['instagram.com', 'www.instagram.com', 'm.instagram.com'].includes(url.hostname) && !url.port) {
      const media = /^\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname);
      if (media) return `instagram:${media[1]}`;
    }
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_/i.test(key) || ['fbclid', 'gclid'].includes(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.href;
  } catch {
    return '';
  }
}

function actualSourceUrls(script) {
  return [script.referenceSource, ...(script.references || []).map(item => typeof item === 'string' ? item : item?.url),
    ...(script.variants || []).flatMap(actualSourceUrls)];
}

export function workspaceLinks(catalog, saved = [], imported = []) {
  const links = new Map();
  const add = link => {
    if (validRelation(link) && endpointsExist(catalog, link)) links.set(workspaceLinkKey(link), relationOnly(link));
  };
  const connect = (sourceKind, sourceId, script) => add({sourceKind, sourceId, scenarioKind: script.kind, scenarioId: script.id});
  const refsByUrl = new Map();
  for (const ref of catalog.references) {
    const key = urlKey(ref.original?.sourceUrl);
    if (key) refsByUrl.set(key, [...(refsByUrl.get(key) || []), ref.id]);
  }
  const ideas = new Map(catalog.ideas.map(idea => [idea.id, idea]));
  const ownReels = new Map();
  for (const script of catalog.scenarios) {
    if (script.kind === 'reference') connect('reference', script.refId, script);
    if (script.kind === 'idea') {
      connect('idea', script.id, script);
      ownReels.set(script.id, script);
    }
    if (script.sourceIdeaId) connect('idea', script.sourceIdeaId, script);
    const urls = [...actualSourceUrls(script), ideas.get(script.kind === 'idea' ? script.id : null)?.source];
    for (const value of urls) {
      for (const id of refsByUrl.get(urlKey(value)) || []) connect('reference', id, script);
    }
  }
  // The backlog Markdown sits beside the individual idea files. Only its direct links to
  // those exact files are evidence of a connection.
  for (const item of catalog.backlog) {
    for (const [, id] of (item.body || '').matchAll(/\]\((?:\.\/|01-content\/ideas\/)?([A-Za-z0-9_-]+)\.md(?:#[^\s)]+)?\)/g)) {
      const script = ownReels.get(id);
      if (script) connect('backlog', item.id, script);
    }
  }
  for (const link of imported) add(link);
  for (const edit of saved) {
    if (!validRelation(edit)) continue;
    if (edit.linked === false) links.delete(workspaceLinkKey(edit));
    if (edit.linked === true) add(edit);
  }
  return [...links.values()];
}
