import { checkWorkspaceLinkSource, readWorkspaceLinkEdit, workspaceLinkKey, workspaceLinks } from './workspace-links.mjs';

const security = {
  'cache-control': 'private, no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'",
};
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: {...security, 'content-type':'application/json; charset=utf-8'},
});
const fail = (status, message) => Object.assign(new Error(message), {status});
const parse = value => JSON.parse(value);
const string = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const statement = (db, sql, ...params) => db.prepare(sql).bind(...params);
const readOne = (db, sql, ...params) => statement(db, sql, ...params).first();
const readAll = async (db, sql, ...params) => (await statement(db, sql, ...params).all()).results;
const snapshotNames = ['workspace','references','config','styles'];
const fallbackWorkspace = {references:[], ideas:[], backlog:[], scenarios:[], jobs:[], posts:[], plans:[]};
const stageTypes = new Set(['adaptation_draft','needs_facts','ready_to_record']);
const referenceSelections = new Set(['shortlisted','review']);
const reviewStatuses = new Set(['approved','changes-requested','montage-review']);
const workStages = new Set(['shoot','montage','review','changes','approved','test','winner','flop']);
const bankDecisions = new Set(['take','skip']);
const bankKey = /^(reference|idea|backlog|scenario):[a-z0-9_.-]{1,160}$/i;
const openRevisionStatuses = new Set(['queued','in-progress','needs-input']);
const revisionKind = 'montage-revision';
const hookPublicationKind = 'hook-publication';
const automaticTrialHours = ['09:00','12:00','15:00'];
const manualTrialHours = Array.from({length:24},(_,hour)=>`${String(hour).padStart(2,'0')}:00`);
const trialDailyLimit = 3;
const moscowTime = timestamp => new Date(Date.parse(timestamp)+3*3600000).toISOString();
const revisionLeaseMs = 60 * 60 * 1000;
const staleRevisionNote = 'Состав версий изменился. Уточни правку на актуальном видео.';
const missingBodyNote = 'Не нашла монтажную секцию для этой версии. Нужен рабочий проект или исходный файл этого ролика.';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const renderPrefix = 'renders/';
const outputPrefix = '/api/workspace/media/output/';
const posterPrefix = '/api/workspace/media/poster/';
const renderRevision = /^[a-f0-9]{24}\//;
const videoKey = /^renders\/[a-z0-9][-a-z0-9]{0,80}\/(?:[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}\/)*[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}\.mp4$/;
const coverKey = /^covers\/[a-z0-9][-a-z0-9]{0,80}\/(?:[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}\/)*[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}\.jpg$/;
const imageKey = /^previews\/[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}\.jpg$/;
const allowedKey = value => value.length <= 260 && (videoKey.test(value) || coverKey.test(value) || imageKey.test(value));

function originAllowed(request, env) {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  return origin === new URL(request.url).origin || origin === env.WORKSPACE_ORIGIN;
}

async function secretEqual(expected, provided) {
  if (!expected || !provided || provided.length > 512) return false;
  const encoder = new TextEncoder();
  const hash = async x => new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(x)));
  const [a,b] = await Promise.all([hash(expected),hash(provided)]);
  return a.reduce((different, bit, i) => different | (bit ^ b[i]), 0) === 0;
}

async function bodyJson(request, max) {
  const declared = Number(request.headers.get('content-length'));
  if (declared > max) throw fail(413, 'Запрос слишком большой.');
  const decoder = new TextDecoder();
  let bytes = 0, body = '';
  for await (const chunk of request.body || []) {
    bytes += chunk.byteLength;
    if (bytes > max) throw fail(413, 'Запрос слишком большой.');
    body += decoder.decode(chunk, {stream:true});
  }
  try {
    const value = parse(body + decoder.decode());
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {}
  throw fail(400, 'Ожидается JSON с данными.');
}

async function snapshot(db, name, fallback) {
  const row = await readOne(db, 'SELECT document FROM workspace_snapshots WHERE name = ?', name);
  return row ? parse(row.document) : structuredClone(fallback);
}

async function edits(db, kind) {
  const rows = await readAll(db, 'SELECT id, document FROM workspace_edits WHERE kind = ?', kind);
  return new Map(rows.map(row => [row.id, parse(row.document)]));
}

async function saveEdit(db, kind, id, data) {
  await statement(db, 'INSERT INTO workspace_edits VALUES (?, ?, ?) ON CONFLICT (kind, id) DO UPDATE SET document=excluded.document',
    kind, id, JSON.stringify(data)).run();
}

function renderReviewId(url) {
  try {
    const key = snapshotMediaKey(url,outputPrefix,videoKey,'Некорректный путь к видео.');
    const id = key.slice(renderPrefix.length);
    return renderRevision.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

function withMediaReview(output, reviews, pending) {
  const reviewId = renderReviewId(output.url);
  const status = pending.has(reviewId) ? 'changes-requested' : reviews.get(reviewId);
  return {...output,reviewId,reviewStatus:reviewStatuses.has(status) ? status : undefined};
}

async function saveMediaReview(db, reviewId, status, url) {
  // The snapshot may be replaced while a review request is in progress.
  const result = await statement(db, `
    INSERT INTO workspace_edits (kind, id, document)
    SELECT 'media-review', ?, ?
    WHERE EXISTS (
      SELECT 1 FROM workspace_snapshots AS snapshot,
        json_each(snapshot.document, '$.scenarios') AS scenario,
        json_each(scenario.value, '$.hookOutputs') AS output
      WHERE snapshot.name = 'workspace' AND json_extract(output.value, '$.url') = ?
    )
    AND (? = 'changes-requested' OR NOT EXISTS (
      SELECT 1 FROM workspace_edits AS revision, json_each(revision.document, '$.targetReviewIds') AS target
      WHERE revision.kind = ? AND target.value = ?
        AND json_extract(revision.document, '$.status') IN ('queued', 'in-progress', 'needs-input')
    ))
    ON CONFLICT (kind, id) DO UPDATE SET document = excluded.document
  `,reviewId,JSON.stringify(status),url,status,revisionKind,reviewId).run();
  if (!changedRows(result)) throw fail(409,'Версия изменилась или для неё есть открытая правка.');
}

const changedRows = result => result.meta?.changes ?? result.changes;
const scenarioKeyFor = script => `${script.kind}:${script.id}`;
const revisionPath = reviewId => reviewId.slice(25);
const revisionVideoKey = reviewId => renderPrefix + reviewId;
const revisionCoverKey = reviewId => 'covers/' + reviewId.replace(/\.mp4$/, '.jpg');
const outputUrlFor = reviewId => outputPrefix + encodeURIComponent(revisionVideoKey(reviewId));
const posterUrlFor = reviewId => posterPrefix + encodeURIComponent(revisionCoverKey(reviewId));
const reviewIdValid = id => typeof id === 'string' && renderRevision.test(id)
  && allowedKey(revisionVideoKey(id)) && videoKey.test(revisionVideoKey(id));

function publicRevision({claimToken, replacements, mediaRelease, ...value}) {
  return value;
}

async function revisionRecords(db) {
  return [...(await edits(db,revisionKind)).values()]
    .sort((a,b)=>b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

async function revisionSnapshot(db) {
  const row = await readOne(db,'SELECT document FROM workspace_snapshots WHERE name = ?', 'workspace');
  return {document:row?.document ?? null, data:row ? parse(row.document) : structuredClone(fallbackWorkspace)};
}

function revisionScenario(data,key) {
  return data.scenarios.find(script=>scenarioKeyFor(script)===key);
}

function revisionOutputs(script) {
  return (script?.hookOutputs ?? []).map(output=>renderReviewId(output.url)).filter(Boolean);
}

async function revisionRow(db,id) {
  const row = await readOne(db,'SELECT document FROM workspace_edits WHERE kind = ? AND id = ?',revisionKind,id);
  return row ? {...row,value:parse(row.document)} : null;
}

function checkRevisionComment(comment) {
  if (typeof comment !== 'string' || !comment.trim() || comment.trim().length > 3000) {
    throw fail(400,'Напиши конкретную правку до 3000 символов.');
  }
  return comment.trim();
}

async function requestRevision(db,input) {
  const {scenarioKey,reviewId,clientRequestId} = input;
  const comment = checkRevisionComment(input.comment);
  if (typeof scenarioKey !== 'string' || !scenarioKey.includes(':') || scenarioKey.length > 220
    || (reviewId !== undefined && !reviewIdValid(reviewId))
    || (clientRequestId !== undefined && (typeof clientRequestId !== 'string' || !uuid.test(clientRequestId)))) {
    throw fail(400,'Не удалось определить рилс или версию.');
  }
  const id = clientRequestId ?? crypto.randomUUID();
  const replay = async () => {
    const row = await revisionRow(db,id);
    if (!row) return;
    if (row.value.scenarioKey !== scenarioKey || row.value.reviewId !== reviewId || row.value.comment !== comment) {
      throw fail(409,'Этот комментарий уже сохранён с другим текстом или версией.');
    }
    return publicRevision(row.value);
  };
  const existing = await replay();
  if (existing) return existing;
  const {document,data} = await revisionSnapshot(db);
  const outputs = revisionOutputs(revisionScenario(data,scenarioKey));
  if (!outputs.length || (reviewId && !outputs.includes(reviewId))) {
    throw fail(404,'Видео больше недоступно. Открой актуальный монтаж.');
  }
  const timestamp = new Date().toISOString();
  const value = {id,scenarioKey,scope:reviewId?'video':'body',reviewId,comment,status:'queued',
    createdAt:timestamp,updatedAt:timestamp,targetReviewIds:reviewId?[reviewId]:outputs};
  const result = await statement(db,`
    INSERT INTO workspace_edits (kind,id,document)
    SELECT ?,?,? WHERE EXISTS (
      SELECT 1 FROM workspace_snapshots WHERE name = 'workspace' AND document = ?
    ) ON CONFLICT (kind,id) DO NOTHING
  `,revisionKind,id,JSON.stringify(value),document).run();
  if (changedRows(result)) return publicRevision(value);
  const retry = await replay();
  if (retry) return retry;
  throw fail(409,'Монтаж изменился. Открой актуальное видео и повтори сохранение.');
}

function currentTargetIds(value,data,records) {
  const outputs = revisionOutputs(revisionScenario(data,value.scenarioKey));
  const successors = new Map(records.filter(row=>row.scenarioKey===value.scenarioKey && row.status==='ready')
    .flatMap(row=>row.replacements.map(item=>[item.reviewId,item.resultReviewId])));
  const ids = value.targetReviewIds.map(id=>{
    const seen = new Set();
    while (!outputs.includes(id) && successors.has(id) && !seen.has(id)) {
      seen.add(id);
      id = successors.get(id);
    }
    return id;
  });
  if (!ids.every(id=>outputs.includes(id))) return null;
  if (value.scope === 'body' && (ids.length!==outputs.length || new Set(ids).size!==outputs.length)) return null;
  return ids;
}

async function replaceRevision(db,row,value) {
  const result = await statement(db,`
    UPDATE workspace_edits SET document = ? WHERE kind = ? AND id = ? AND document = ?
  `,JSON.stringify(value),revisionKind,value.id,row.document).run();
  if (!changedRows(result)) throw fail(409,'Статус доработки уже изменился.');
  return json({revision:publicRevision(value)});
}

async function claimRevision(db,row) {
  const value = row.value;
  const now = new Date().toISOString();
  if (value.status!=='queued' && !(value.status==='in-progress' && value.leaseUntil<=now)) {
    throw fail(409,'Доработка уже взята в работу или закрыта.');
  }
  const [{document,data},records] = await Promise.all([revisionSnapshot(db),revisionRecords(db)]);
  const targets = currentTargetIds(value,data,records);
  if (!targets) return replaceRevision(db,row,{
    ...value,status:'needs-input',note:staleRevisionNote,
    updatedAt:now,claimToken:undefined,leaseUntil:undefined,
  });
  const claimToken = crypto.randomUUID();
  const next = {...value,status:'in-progress',targetReviewIds:targets,claimToken,updatedAt:now,
    leaseUntil:new Date(new Date(now).getTime()+revisionLeaseMs).toISOString()};
  const written = await statement(db,`
    UPDATE workspace_edits SET document = ?
    WHERE kind = ? AND id = ? AND document = ?
      AND EXISTS (SELECT 1 FROM workspace_snapshots WHERE name = 'workspace' AND document = ?)
      AND NOT EXISTS (
        SELECT 1 FROM workspace_edits AS other
        WHERE other.kind = ? AND other.id != ? AND json_extract(other.document, '$.scenarioKey') = ?
          AND json_extract(other.document, '$.status') = 'in-progress'
          AND json_extract(other.document, '$.leaseUntil') > ?
      )
  `,JSON.stringify(next),revisionKind,value.id,row.document,document,revisionKind,value.id,value.scenarioKey,now).run();
  if (!changedRows(written)) throw fail(409,'Рилс уже в работе или его версия изменилась.');
  return json({revision:publicRevision(next),claimToken});
}

function hasActiveClaim(row,token) {
  return row.value.status==='in-progress' && row.value.claimToken===token
    && row.value.leaseUntil>new Date().toISOString();
}

function finishReplacements(input,targets) {
  if (!Array.isArray(input) || input.length!==targets.length) throw fail(400,'Передай все версии для этой доработки.');
  const bySource = new Map();
  for (const item of input) {
    const {reviewId,resultReviewId,duration} = item ?? {};
    if (!targets.includes(reviewId) || bySource.has(reviewId) || !reviewIdValid(resultReviewId)
      || revisionPath(reviewId)!==revisionPath(resultReviewId) || reviewId===resultReviewId
      || typeof duration !== 'number' || !Number.isFinite(duration) || duration<=0 || duration>1800) {
      throw fail(400,'Готовый файл не совпадает с версией доработки.');
    }
    bySource.set(reviewId,{reviewId,resultReviewId,duration});
  }
  return targets.map(id=>bySource.get(id));
}

function replaceOutput(output,replacement) {
  return {...output,url:outputUrlFor(replacement.resultReviewId),posterUrl:posterUrlFor(replacement.resultReviewId),
    duration:replacement.duration,status:'montage-review',reviewId:undefined,reviewStatus:undefined};
}

async function verifyReplacementMedia(bucket,replacements) {
  const missing = await Promise.all(replacements.map(async ({resultReviewId})=>{
    const [video,cover] = await Promise.all([
      bucket.head(revisionVideoKey(resultReviewId)),
      bucket.head(revisionCoverKey(resultReviewId)),
    ]);
    return !video?.size || !cover?.size
      || !/^[a-f0-9]{64}$/.test(video.customMetadata?.sha256 ?? '')
      || !video.customMetadata.sha256.startsWith(resultReviewId.slice(0,24))
      || !/^[a-f0-9]{64}$/.test(cover.customMetadata?.sha256 ?? '');
  }));
  if (missing.some(Boolean)) throw fail(409,'Для каждой готовой версии нужен проверенный ролик и его обложка.');
}

function updateRevisionOutputs(data,script,replacements) {
  const bySource = new Map(replacements.map(item=>[item.reviewId,item]));
  return JSON.stringify({...data,scenarios:data.scenarios.map(candidate=>{
    if (candidate!==script) return candidate;
    return {...candidate,hookOutputs:candidate.hookOutputs.map(output=>{
      const replacement=bySource.get(renderReviewId(output.url));
      return replacement ? replaceOutput(output,replacement) : output;
    })};
  })});
}

function rebindQueuedRevisions(db,{id,scenarioKey,replacements},nextDocument) {
  // SQLite can discard the JSON subtype when an aggregate crosses the subquery boundary.
  return statement(db,`
    WITH replacements AS (
      SELECT json_extract(value,'$.reviewId') AS oldId, json_extract(value,'$.resultReviewId') AS newId
      FROM json_each(?)
    )
    UPDATE workspace_edits AS pending
    SET document = json_set(pending.document,'$.targetReviewIds',json((
      SELECT json_group_array(COALESCE(replacements.newId,target.value))
      FROM json_each(pending.document,'$.targetReviewIds') AS target
      LEFT JOIN replacements ON replacements.oldId = target.value
    )))
    WHERE pending.kind = ? AND json_extract(pending.document,'$.scenarioKey') = ?
      AND json_extract(pending.document,'$.status') = 'queued'
      AND EXISTS (SELECT 1 FROM json_each(pending.document,'$.targetReviewIds') AS target
        JOIN replacements ON replacements.oldId = target.value)
      AND EXISTS (SELECT 1 FROM workspace_edits AS finished
        WHERE finished.kind = ? AND finished.id = ? AND finished.document = ?)
  `,JSON.stringify(replacements),revisionKind,scenarioKey,revisionKind,id,nextDocument);
}

async function finishRevision(db,bucket,row,input) {
  const value = row.value;
  const replacements = finishReplacements(input.replacements,value.targetReviewIds);
  if (value.status==='ready' && value.claimToken===input.claimToken
    && JSON.stringify(value.replacements)===JSON.stringify(replacements)) {
    return json({revision:publicRevision(value)});
  }
  if (!hasActiveClaim(row,input.claimToken)) throw fail(409,'Срок взятия в работу закончился или задача уже закрыта.');
  const [{document,data}] = await Promise.all([
    revisionSnapshot(db),
    verifyReplacementMedia(bucket,replacements),
  ]);
  const script = revisionScenario(data,value.scenarioKey);
  const current = revisionOutputs(script);
  if (!value.targetReviewIds.every(id=>current.includes(id))
    || (value.scope==='body' && new Set(value.targetReviewIds).size!==current.length)) {
    throw fail(409,'Версии в карточке изменились. Проверь доработку перед заменой.');
  }
  const updated = updateRevisionOutputs(data,script,replacements);
  const now = new Date().toISOString();
  const next = {...value,status:'ready',updatedAt:now,leaseUntil:undefined,replacements,
    resultReviewIds:replacements.map(item=>item.resultReviewId)};
  if (value.leaseUntil<=now) throw fail(409,'Срок взятия в работу закончился.');
  const nextDocument = JSON.stringify(next);
  const [saved,finished] = await db.batch([
    statement(db,`
      UPDATE workspace_snapshots SET document = ? WHERE name = 'workspace' AND document = ?
        AND EXISTS (SELECT 1 FROM workspace_edits WHERE kind = ? AND id = ? AND document = ?)
    `,updated,document,revisionKind,value.id,row.document),
    statement(db,`
      UPDATE workspace_edits SET document = ? WHERE kind = ? AND id = ? AND document = ?
        AND EXISTS (SELECT 1 FROM workspace_snapshots WHERE name = 'workspace' AND document = ?)
    `,nextDocument,revisionKind,value.id,row.document,updated),
    rebindQueuedRevisions(db,next,nextDocument),
  ]);
  if (!changedRows(saved) || !changedRows(finished)) throw fail(409,'Карточка изменилась во время сохранения. Открой заново.');
  return json({revision:publicRevision(next)});
}

function validateMediaReleaseKey(scenarioKey,id,requiresId) {
  if (typeof scenarioKey!=='string' || !scenarioKey.includes(':') || scenarioKey.length>220
    || ((requiresId || id!==undefined) && (typeof id!=='string' || !uuid.test(id)))) {
    throw fail(400,'Укажи точный ключ рилса и идентификатор выпуска.');
  }
}

async function mediaReleaseState(db,scenarioKey,id) {
  const row = await readOne(db,`
    SELECT snapshot.document, revision.document AS releaseDocument
    FROM workspace_snapshots AS snapshot
    LEFT JOIN workspace_edits AS revision ON revision.kind = ? AND revision.id = ?
    WHERE snapshot.name = 'workspace'
  `,revisionKind,id ?? null);
  const data = row ? parse(row.document) : fallbackWorkspace;
  const script = revisionScenario(data,scenarioKey);
  const release = row?.releaseDocument ? parse(row.releaseDocument) : null;
  if (!script && (release?.scenarioKey!==scenarioKey || release.status!=='ready' || !release.mediaRelease)) {
    throw fail(404,'Рилс не найден.');
  }
  return {document:row.document,data,script,current:revisionOutputs(script),release,releaseDocument:row.releaseDocument};
}

function mediaReleaseReceipt(scenarioKey,{current,release},id) {
  if (id && (release?.scenarioKey!==scenarioKey || release.status!=='ready' || !release.mediaRelease)) {
    throw fail(404,'Выпуск не найден.');
  }
  const resultReviewIds = id ? release.resultReviewIds : undefined;
  return json({scenarioKey,currentReviewIds:current,
    release:id ? {id,resultReviewIds,current:resultReviewIds.every(reviewId=>current.includes(reviewId))} : undefined});
}

function replayMediaRelease(state,{id,scenarioKey,scope,comment,priorTargetReviewIds,replacements}) {
  const {release} = state;
  if (release?.status!=='ready') return;
  if (!release.mediaRelease || release.scenarioKey!==scenarioKey || release.scope!==scope
    || (priorTargetReviewIds===undefined && release.comment!==comment)
    || JSON.stringify(release.mediaRelease.priorTargetReviewIds)!==JSON.stringify(priorTargetReviewIds)
    || JSON.stringify(release.replacements)!==JSON.stringify(finishReplacements(replacements,release.targetReviewIds))) {
    throw fail(409,'Этот идентификатор уже использован для другого выпуска.');
  }
  return mediaReleaseReceipt(scenarioKey,state,id);
}

function canCompleteBlockedRevision(release,{scenarioKey,scope,priorTargetReviewIds},targets,current) {
  if (release?.status!=='needs-input' || release.leaseUntil
    || release.scenarioKey!==scenarioKey || release.scope!==scope
    || JSON.stringify(release.targetReviewIds)!==JSON.stringify(priorTargetReviewIds)
    || (scope==='video' && release.reviewId!==priorTargetReviewIds[0])) return false;
  if (release.note===missingBodyNote) {
    return Boolean(release.claimToken) && JSON.stringify(priorTargetReviewIds)===JSON.stringify(targets);
  }
  return release.note===staleRevisionNote && !release.claimToken
    && priorTargetReviewIds.some(id=>!current.includes(id))
    && JSON.stringify(priorTargetReviewIds.map(revisionPath).sort())===JSON.stringify(targets.map(revisionPath).sort());
}

async function publishMediaRelease(db,bucket,input) {
  const {id,scenarioKey,scope,priorTargetReviewIds} = input;
  validateMediaReleaseKey(scenarioKey,id,true);
  if (!['video','body'].includes(scope) || !Array.isArray(input.replacements) || !input.replacements.length
    || input.replacements.length>150
    || (priorTargetReviewIds!==undefined && (input.comment!==undefined || !Array.isArray(priorTargetReviewIds)
      || priorTargetReviewIds.length>150 || !priorTargetReviewIds.every(reviewIdValid)))) {
    throw fail(400,'Укажи версии и область выпуска.');
  }
  const comment = priorTargetReviewIds===undefined ? checkRevisionComment(input.comment) : undefined;
  const state = await mediaReleaseState(db,scenarioKey,id);
  const replayInput = {...input,comment};
  const replay = replayMediaRelease(state,replayInput);
  if (replay) return replay;
  const {document,data,script,current,release,releaseDocument} = state;
  const sources = input.replacements.map(item=>item?.reviewId);
  const targets = current.filter(reviewId=>sources.includes(reviewId));
  const slots = new Set(targets.map(revisionPath));
  if (targets.length!==sources.length || slots.size!==targets.length
    || current.filter(reviewId=>slots.has(revisionPath(reviewId))).length!==targets.length
    || (scope==='video' ? targets.length!==1 : targets.length!==script.hookOutputs.length)) {
    throw fail(409,'Состав версий в карточке изменился. Проверь актуальные версии.');
  }
  const replacements = finishReplacements(input.replacements,targets);
  const resultReviewIds = replacements.map(item=>item.resultReviewId);
  if (new Set(resultReviewIds).size!==resultReviewIds.length
    || data.scenarios.some(candidate=>revisionOutputs(candidate).some(reviewId=>resultReviewIds.includes(reviewId)))) {
    throw fail(409,'Готовая версия уже использовалась.');
  }
  if ((release || priorTargetReviewIds!==undefined)
    && (priorTargetReviewIds===undefined || !canCompleteBlockedRevision(release,input,targets,current))) {
    throw fail(409,'Эту заявку нельзя закрыть текущим выпуском.');
  }
  await verifyReplacementMedia(bucket,replacements);
  const updated = updateRevisionOutputs(data,script,replacements);
  const now = new Date().toISOString();
  const next = {id,scenarioKey,scope,reviewId:release?.reviewId ?? (scope==='video'?targets[0]:undefined),
    comment:release?.comment ?? comment,status:'ready',createdAt:release?.createdAt ?? now,updatedAt:now,
    targetReviewIds:targets,resultReviewIds,replacements,
    // A unique write token makes the remaining statements conditional on this batch's history write.
    mediaRelease:{priorTargetReviewIds,writeToken:crypto.randomUUID()}};
  const nextDocument = JSON.stringify(next);
  const [recorded,saved] = await db.batch([
    statement(db,`
      INSERT INTO workspace_edits (kind,id,document)
      SELECT ?,?,? WHERE EXISTS (
        SELECT 1 FROM workspace_snapshots WHERE name = 'workspace' AND document = ?
      )
      AND (SELECT document FROM workspace_edits WHERE kind = ? AND id = ?) IS ?
      AND NOT EXISTS (
        SELECT 1 FROM workspace_edits AS active
        WHERE active.kind = ? AND json_extract(active.document,'$.scenarioKey') = ?
          AND json_extract(active.document,'$.status') = 'in-progress'
      )
      AND NOT EXISTS (
        SELECT 1 FROM workspace_edits AS previous, json_each(?) AS result
        WHERE (previous.kind = 'media-review' AND previous.id = result.value)
          OR (previous.kind = ? AND (
            json_extract(previous.document,'$.reviewId') = result.value
            OR EXISTS (SELECT 1 FROM json_each(previous.document,'$.targetReviewIds') WHERE value = result.value)
            OR EXISTS (SELECT 1 FROM json_each(previous.document,'$.resultReviewIds') WHERE value = result.value)
            OR EXISTS (SELECT 1 FROM json_each(previous.document,'$.mediaRelease.priorTargetReviewIds')
              WHERE value = result.value)
          ))
      )
      ON CONFLICT (kind,id) DO UPDATE SET document = excluded.document
    `,revisionKind,id,nextDocument,document,revisionKind,id,releaseDocument,revisionKind,scenarioKey,
    JSON.stringify(resultReviewIds),revisionKind),
    statement(db,`
      UPDATE workspace_snapshots SET document = ? WHERE name = 'workspace' AND document = ?
        AND EXISTS (SELECT 1 FROM workspace_edits WHERE kind = ? AND id = ? AND document = ?)
    `,updated,document,revisionKind,id,nextDocument),
    rebindQueuedRevisions(db,next,nextDocument),
  ]);
  const after = await mediaReleaseState(db,scenarioKey,id);
  if (!changedRows(recorded) || !changedRows(saved)) {
    const retry = replayMediaRelease(after,replayInput);
    if (retry) return retry;
    throw fail(409,'В карточке идёт доработка, версии изменились или готовая версия уже использовалась.');
  }
  return mediaReleaseReceipt(scenarioKey,after,id);
}

async function mediaReleaseRoute(request,env) {
  const {DB:db,BUCKET:bucket} = env;
  if (request.method==='PUT') return publishMediaRelease(db,bucket,await bodyJson(request,100000));
  if (request.method==='GET') {
    const query = new URL(request.url).searchParams;
    const scenarioKey = query.get('scenarioKey');
    const id = query.get('id') ?? undefined;
    validateMediaReleaseKey(scenarioKey,id,false);
    return mediaReleaseReceipt(scenarioKey,await mediaReleaseState(db,scenarioKey,id),id);
  }
  throw fail(404,'Страница не найдена.');
}

function candidateKey(key,targets) {
  const id = videoKey.test(key) ? key.slice(renderPrefix.length)
    : coverKey.test(key) ? key.slice('covers/'.length).replace(/\.jpg$/,'.mp4') : null;
  return reviewIdValid(id) && targets.some(target=>target!==id && revisionPath(target)===revisionPath(id));
}

async function scopedRevisionFile(request,bucket,row,key) {
  if (!hasActiveClaim(row,request.headers.get('x-revision-claim'))) {
    throw fail(409,'Срок взятия в работу закончился или задача уже закрыта.');
  }
  const targets = row.value.targetReviewIds;
  const source = targets.some(id=>key===revisionVideoKey(id) || key===revisionCoverKey(id));
  const candidate = candidateKey(key,targets);
  if (request.method==='GET' || request.method==='HEAD') {
    if (!source && !(candidate && request.method==='HEAD')) throw fail(404,'Файл не относится к этой доработке.');
    const response = await requestMedia(request,bucket,key);
    if (request.method==='HEAD' && response.ok) {
      response.headers.set('x-file-sha256',(await bucket.head(key))?.customMetadata?.sha256 ?? '');
    }
    return response;
  }
  if (request.method!=='PUT' || !candidate || source) throw fail(404,'Файл не относится к этой доработке.');
  const size = Number(request.headers.get('content-length'));
  const sha256 = request.headers.get('x-file-sha256') ?? '';
  const isVideo = videoKey.test(key);
  if (!Number.isSafeInteger(size) || size<1 || size>(isVideo?94_000_000:4_000_000) || !request.body) {
    throw fail(413,'Размер файла не поддерживается.');
  }
  if (!/^[a-f0-9]{64}$/.test(sha256) || (isVideo && !key.startsWith(`renders/${sha256.slice(0,24)}/`))) {
    throw fail(400,'Контрольная сумма файла не совпадает с версией.');
  }
  let stored = await bucket.head(key);
  if (!stored) stored = await bucket.put(key,request.body,{
    sha256,onlyIf:{etagDoesNotMatch:'*'},customMetadata:{sha256},httpMetadata:{contentType:isVideo?'video/mp4':'image/jpeg'},
  }) ?? await bucket.head(key);
  if (stored?.size!==size || stored.customMetadata?.sha256!==sha256) {
    throw fail(409,'Файл этой версии уже сохранён с другим содержимым.');
  }
  return json({file:key,size,sha256});
}

async function revisionServiceRoute(request,env,path) {
  if (!await secretEqual(env.WORKSPACE_REVISION_KEY,request.headers.get('x-workspace-revision'))) {
    throw fail(403,'Доступ закрыт.');
  }
  const db = env.DB;
  if (path==='/__import/revisions' && request.method==='GET') {
    return json({revisions:(await revisionRecords(db)).map(publicRevision)});
  }
  const route = /^\/__import\/revisions\/([^/]+)(?:\/file\/(.*))?$/.exec(path);
  if (!route || !uuid.test(route[1])) throw fail(404,'Доработка не найдена.');
  const row = await revisionRow(db,route[1]);
  if (!row) throw fail(404,'Доработка не найдена.');
  if (route[2] !== undefined) {
    let key;
    try { key = decodeURIComponent(route[2]); } catch { throw fail(404,'Файл не найден.'); }
    if (!allowedKey(key)) throw fail(404,'Файл не найден.');
    return scopedRevisionFile(request,env.BUCKET,row,key);
  }
  if (request.method==='GET') return json({revision:publicRevision(row.value)});
  if (request.method!=='PUT') throw fail(404,'Страница не найдена.');
  const input = await bodyJson(request,20000);
  if (input.action==='claim') return claimRevision(db,row);
  if (input.action==='ready') return finishRevision(db,env.BUCKET,row,input);
  if (input.action==='needs-input') {
    const note = checkRevisionComment(input.note);
    if (row.value.status==='needs-input' && row.value.claimToken===input.claimToken && row.value.note===note) {
      return json({revision:publicRevision(row.value)});
    }
    if (!hasActiveClaim(row,input.claimToken)) throw fail(409,'Срок взятия в работу закончился или задача уже закрыта.');
    return replaceRevision(db,row,{...row.value,status:'needs-input',note,updatedAt:new Date().toISOString(),leaseUntil:undefined});
  }
  throw fail(400,'Неизвестное действие с доработкой.');
}

function withEdits(list, overrides) {
  const merged = new Map(list.map(item => [item.id, item]));
  for (const [id, value] of overrides) {
    if (value === null) merged.delete(id);
    else merged.set(id, value);
  }
  return [...merged.values()];
}

async function referenceData(db) {
  const [base, changed] = await Promise.all([snapshot(db,'references',{records:[]}),edits(db,'reference')]);
  return {...base, records:withEdits(base.records,changed)};
}

function referenceSummary({id,title,category,selection,original,analysis,adaptations}) {
  return {id,title,category,selection,author:original.author,preview:original.previewAvailable,
    summary:analysis.summary,hook:adaptations[0]?.hook || original.layers.spoken.quote,
    active: adaptations.some(item => item.status === 'ready_to_record')};
}

function referenceScenarios(records) {
  return records.flatMap(record => record.adaptations
    .filter(item => item.hook || item.body)
    .map(item => ({
      id: `${record.id}:${item.id}`, kind:'reference', title:item.title || record.title, body:item.body, ending:'',
      source:{title:record.title}, refId:record.id,
      hooks:[{id:'primary',text:item.hook},...item.hookVariants.map((hook,index)=>({id:`variant-${index+1}`,text:hook.text}))].filter(hook=>hook.text),
      references:[],notes:[...item.shotPlan,...item.factGaps],variants:[],
      jobIds:[],postIds:[],hookOutputs:[],clips:[],
      stage:item.status==='ready_to_record'?'ready':'script',
    })));
}

async function workspace(db) {
  const [base, ideaEdits, planEdits, references, linkEdits, reviews, revisions, stageEdits, decisionEdits, scriptNotes, hookPublications] = await Promise.all([
    snapshot(db,'workspace',fallbackWorkspace),edits(db,'idea'),edits(db,'plan'),referenceData(db),edits(db,'link'),edits(db,'media-review'),revisionRecords(db),
    edits(db,'stage'),edits(db,'decision'),edits(db,'script-note'),edits(db,hookPublicationKind),
  ]);
  const ideas = withEdits(base.ideas,ideaEdits).sort((a,b)=>(b.updatedAt || b.date).localeCompare(a.updatedAt || a.date));
  const baseScenarios = new Map(base.scenarios.map(script => [`${script.kind}:${script.id}`,script]));
  const ideaScenarios = ideas.map(idea => ({
    hooks:[],variants:[],jobIds:[],postIds:[],hookOutputs:[],clips:[],stage:'idea',
    ...baseScenarios.get(`idea:${idea.id}`),id:idea.id,kind:'idea',title:idea.title,body:idea.body,source:{title:'Мои идеи',date:idea.date},
  }));
  const adaptations = referenceScenarios(references.records).map(script => {
    const old = baseScenarios.get(`reference:${script.id}`);
    return old ? {...script,jobIds:old.jobIds,postIds:old.postIds,hookOutputs:old.hookOutputs,clips:old.clips,
      stage: old.jobIds.length || old.postIds.length ? old.stage : script.stage} : script;
  });
  const scenarios = [...base.scenarios.filter(script=>!['idea','reference'].includes(script.kind)),...adaptations,...ideaScenarios];
  const links = workspaceLinks({scenarios, ideas, backlog:base.backlog, references:references.records}, linkEdits.values(), base.links);
  const pending = new Set(revisions.filter(row=>openRevisionStatuses.has(row.status)).flatMap(row=>row.targetReviewIds));
  return {...base,ideas,links,plans:withEdits(base.plans,planEdits),references:references.records.map(referenceSummary),
    revisions:revisions.map(publicRevision),
    hookPublications:[...hookPublications.values()].sort((a,b)=>a.at.localeCompare(b.at)),
    decisions:Object.fromEntries(decisionEdits),
    scriptNotes:[...scriptNotes.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)),
    scenarios:scenarios.map(script=>({...script,
      ...(stageEdits.get(`${script.kind}:${script.id}`)?{workStage:stageEdits.get(`${script.kind}:${script.id}`).stage}:{}),
      hookOutputs:script.hookOutputs.map(output=>withMediaReview(output,reviews,pending))}))};
}

function dateIsValid(day) {
  return typeof day === 'string' && /^\d{4}-\d\d-\d\d$/.test(day)
    && new Date(day + 'T00:00:00Z').toJSON()?.slice(0,10) === day;
}

function publicationTarget(data,reviewId) {
  const script = data.scenarios.find(item=>item.kind==='studio' && item.hookOutputs.some(output=>output.reviewId===reviewId));
  if (!script) throw fail(404,'Версия видео больше недоступна. Открой новый монтаж.');
  return {script,output:script.hookOutputs.find(item=>item.reviewId===reviewId)};
}

const trialTime = (day,time) => new Date(`${day}T${time}:00+03:00`).toISOString();

function trialDay(data, day, excludingId) {
  const trials = data.hookPublications.filter(item=>item.placement==='trial');
  const trackedIds = new Set(trials.map(item=>item.providerId).filter(Boolean));
  const legacy = data.posts.filter(item=>item.day===day && item.targets?.includes('trial') &&
    ['запланировано','опубликовано'].includes(item.status) && !trackedIds.has(item.id));
  const existing = trials.filter(item=>item.id!==excludingId && (item.day===day || item.moveRequest?.day===day));
  const occupied = new Set([...existing.flatMap(item=>[item.at,item.moveRequest?.at]),...legacy.map(item=>item.when)]
    .filter(value=>Number.isFinite(Date.parse(value))).map(value=>new Date(value).toISOString()));
  return { occupied, capacity:trialDailyLimit-legacy.length, count:existing.length };
}

function nextTrialSlot(data, now) {
  const firstDay = moscowTime(now).slice(0,10);
  for (let offset=0; offset<366; offset+=1) {
    const day = new Date(Date.parse(firstDay)+offset*86400000).toISOString().slice(0,10);
    const {occupied,capacity,count} = trialDay(data,day);
    if (count>=capacity) continue;
    const at = automaticTrialHours.map(hour=>trialTime(day,hour)).find(value=>value>now && !occupied.has(value));
    if (at) return {at,day,capacity};
  }
  throw fail(409,'Свободных слотов Trial пока нет.');
}

const freeTrialSlot = `NOT EXISTS (
  SELECT 1 FROM workspace_edits WHERE kind=? AND id<>? AND json_extract(document,'$.placement')='trial'
    AND (json_extract(document,'$.at')=? OR json_extract(document,'$.moveRequest.at')=?)
) AND (SELECT COUNT(*) FROM workspace_edits WHERE kind=? AND id<>? AND json_extract(document,'$.placement')='trial'
  AND (json_extract(document,'$.day')=? OR json_extract(document,'$.moveRequest.day')=?)) < ?`;
const trialSlotParams = (id,at,day,capacity) => [hookPublicationKind,id,at,at,hookPublicationKind,id,day,day,capacity];

function publicationDetails(script, output) {
  return {reviewId:output.reviewId,scenarioKey:scenarioKeyFor(script),title:script.title,
    hook:output.hookText || '',posterUrl:output.posterUrl};
}

async function planTrial(db,reviewId) {
  const id = `${reviewId}:trial`;
  for (let attempt=0; attempt<12; attempt+=1) {
    const data = await workspace(db);
    const {script,output} = publicationTarget(data,reviewId);
    const existing = data.hookPublications.find(item=>item.reviewId===reviewId && item.placement==='trial');
    if (existing) return existing;
    if (data.hookPublications.some(item=>item.reviewId===reviewId && item.status!=='planned')) {
      throw fail(409,'У этой версии уже есть публикация или подтверждённая дата.');
    }
    if (output.reviewStatus!=='approved') throw fail(409,'Сначала одобри эту версию.');
    const {at,day,capacity} = nextTrialSlot(data,new Date().toISOString());
    const publication = {id,...publicationDetails(script,output),placement:'trial',status:'planned',at,day};
    const saved = await statement(db,`
      INSERT INTO workspace_edits (kind,id,document)
      SELECT ?,?,?
      WHERE EXISTS (
        SELECT 1 FROM workspace_snapshots AS snapshot,
          json_each(snapshot.document,'$.scenarios') AS scenario,
          json_each(scenario.value,'$.hookOutputs') AS output
        WHERE snapshot.name='workspace' AND json_extract(output.value,'$.url')=?
      ) AND EXISTS (SELECT 1 FROM workspace_edits WHERE kind='media-review' AND id=? AND document='"approved"')
      AND NOT EXISTS (
        SELECT 1 FROM workspace_edits AS revision,json_each(revision.document,'$.targetReviewIds') AS target
        WHERE revision.kind=? AND target.value=?
          AND json_extract(revision.document,'$.status') IN ('queued','in-progress','needs-input')
      ) AND NOT EXISTS (
        SELECT 1 FROM workspace_edits WHERE kind=? AND json_extract(document,'$.reviewId')=?
          AND json_extract(document,'$.status') IN ('scheduled','published')
      ) AND ${freeTrialSlot}
      ON CONFLICT (kind,id) DO NOTHING
    `,hookPublicationKind,id,JSON.stringify(publication),output.url,reviewId,revisionKind,reviewId,
    hookPublicationKind,reviewId,...trialSlotParams(id,at,day,capacity)).run();
    if (changedRows(saved)) return publication;
  }
  throw fail(409,'Календарь обновился. Попробуй ещё раз.');
}

function editableTrial(data, reviewId, now) {
  if (!reviewIdValid(reviewId)) throw fail(400,'Укажи точную версию видео.');
  const publication = data.hookPublications.find(item=>item.id===`${reviewId}:trial`);
  if (!publication) throw fail(404,'Запись Trial не найдена.');
  if (publication.status!=='planned' && !(publication.status==='scheduled' && publication.at>now)) {
    throw fail(409,'Эту публикацию уже нельзя перенести.');
  }
  return publication;
}

async function moveTrial(db, reviewId, {day,time,expectedAt}) {
  if (!dateIsValid(day) || !manualTrialHours.includes(time)) throw fail(400,'Выбери дату и целый час для Trial.');
  const at = trialTime(day,time), now = new Date().toISOString();
  if (at<=now) throw fail(400,'Выбери будущий слот Trial.');
  const data = await workspace(db);
  const before = editableTrial(data,reviewId,now);
  if (before.at!==expectedAt) throw fail(409,'Дата уже изменилась. Открой запись заново.');
  if (before.publishRequest) throw fail(409,'Публикация сейчас уже запрошена.');
  if (at===before.at || before.moveRequest?.at===at) return before;
  if (before.moveRequest) throw fail(409,'Предыдущий перенос ещё ждёт подтверждения.');
  const {occupied,capacity,count} = trialDay(data,day,before.id);
  if (occupied.has(at) || count>=capacity) throw fail(409,'Этот слот уже занят. Выбери другой.');
  const publication = before.status==='planned' ? {...before,at,day,moveResult:undefined}
    : {...before,moveRequest:{id:crypto.randomUUID(),at,day,requestedAt:now},moveResult:undefined};
  const saved = await statement(db,`
    UPDATE workspace_edits SET document=? WHERE kind=? AND id=? AND document=? AND ${freeTrialSlot}
  `,JSON.stringify(publication),hookPublicationKind,before.id,JSON.stringify(before),...trialSlotParams(before.id,at,day,capacity)).run();
  if (!changedRows(saved)) throw fail(409,'Календарь обновился. Проверь свободные слоты.');
  return publication;
}

async function resolveTrialMove(db, reviewId, {requestId,providerId,at,outcome,reason}) {
  if (!uuid.test(requestId || '') || !['confirmed','rejected'].includes(outcome)) throw fail(400,'Укажи результат переноса.');
  const path = `${reviewId}:trial`;
  const row = await readOne(db,'SELECT document FROM workspace_edits WHERE kind=? AND id=?',hookPublicationKind,path);
  const before = row && parse(row.document);
  if (!before || before.providerId!==providerId || before.status!=='scheduled') throw fail(409,'Публикация уже изменилась.');
  if (before.moveResult?.id===requestId && before.moveResult.outcome===outcome) return before;
  if (before.moveRequest?.id!==requestId || before.moveRequest.at!==at) throw fail(409,'Запрос на перенос уже изменился.');
  const moveResult = {id:requestId,outcome,...(outcome==='rejected' ? {reason:string(reason,160)} : {})};
  const publication = {...before,moveRequest:undefined,moveResult,
    ...(outcome==='confirmed' ? {at,day:before.moveRequest.day} : {})};
  const saved = await statement(db,'UPDATE workspace_edits SET document=? WHERE kind=? AND id=? AND document=?',
    JSON.stringify(publication),hookPublicationKind,path,row.document).run();
  if (!changedRows(saved)) throw fail(409,'Запрос на перенос уже изменился.');
  return publication;
}

const publicationTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const publicationTimeValid = at => typeof at==='string' && publicationTimePattern.test(at) &&
  dateIsValid(at.slice(0,10)) && Number.isFinite(Date.parse(at));
const instagramPublicationUrl = /^https:\/\/(www\.)?instagram\.com\/(reel|p)\/[a-zA-Z0-9_-]{1,100}\/?$/;
const publicationProviderIdValid = id => typeof id==='string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id);
const publicationCaptionValid = caption => typeof caption==='string' && caption.length<=5000;

async function requestTrialPublish(db,reviewId,expectedAt) {
  const id = `${reviewId}:trial`;
  const row = await readOne(db,'SELECT document FROM workspace_edits WHERE kind=? AND id=?',hookPublicationKind,id);
  const before = row && parse(row.document);
  if (!before) throw fail(404,'Запись Trial не найдена.');
  if (before.status!=='scheduled' || !before.providerId || before.at!==expectedAt) {
    throw fail(409,'Публикация уже изменилась. Открой запись заново.');
  }
  if (before.moveRequest) throw fail(409,'Перенос ещё ждёт подтверждения.');
  if (before.publishRequest) return before;
  const publishRequest = {id:crypto.randomUUID(),requestedAt:new Date().toISOString()};
  const publication = {...before,publishRequest,publishResult:undefined};
  const saved = await statement(db,'UPDATE workspace_edits SET document=? WHERE kind=? AND id=? AND document=?',
    JSON.stringify(publication),hookPublicationKind,id,row.document).run();
  if (changedRows(saved)) return publication;
  const current = await readOne(db,'SELECT document FROM workspace_edits WHERE kind=? AND id=?',hookPublicationKind,id);
  const retry = current && parse(current.document);
  if (retry?.status==='scheduled' && retry.at===expectedAt && retry.publishRequest) return retry;
  throw fail(409,'Публикация уже изменилась. Открой запись заново.');
}

async function resolveTrialPublish(db,reviewId,{requestId,providerId,outcome,reason,at,url}) {
  if (!uuid.test(requestId || '') || !['confirmed','rejected'].includes(outcome)) throw fail(400,'Укажи результат публикации.');
  if (outcome==='confirmed' && (!publicationTimeValid(at) || Date.parse(at)>Date.now() ||
    typeof url!=='string' || !instagramPublicationUrl.test(url))) {
    throw fail(400,'Укажи фактическое время и ссылку Instagram.');
  }
  const id = `${reviewId}:trial`;
  const row = await readOne(db,'SELECT document FROM workspace_edits WHERE kind=? AND id=?',hookPublicationKind,id);
  const before = row && parse(row.document);
  if (!before || before.providerId!==providerId) throw fail(409,'Публикация уже изменилась.');
  const timestamp = outcome==='confirmed' ? new Date(at).toISOString() : null;
  const permalink = outcome==='confirmed' ? new URL(url).href : null;
  if (before.publishResult?.id===requestId && before.publishResult.outcome===outcome &&
    (outcome==='rejected' || before.at===timestamp && before.url===permalink)) return before;
  if (before.status!=='scheduled' || before.publishRequest?.id!==requestId) throw fail(409,'Запрос уже изменился.');
  const publishResult = {id:requestId,outcome,...(outcome==='rejected' ? {reason:string(reason,160)} : {})};
  const publication = {...before,publishRequest:undefined,publishResult,
    ...(outcome==='confirmed' ? {status:'published',at:timestamp,day:moscowTime(timestamp).slice(0,10),url:permalink} : {})};
  const saved = await statement(db,'UPDATE workspace_edits SET document=? WHERE kind=? AND id=? AND document=?',
    JSON.stringify(publication),hookPublicationKind,id,row.document).run();
  if (!changedRows(saved)) throw fail(409,'Запрос уже изменился.');
  return publication;
}

async function setPublicationCaption(db,{reviewId,placement,providerId,caption}) {
  if (!['trial','feed'].includes(placement) || !publicationProviderIdValid(providerId) || !publicationCaptionValid(caption)) {
    throw fail(400,'Укажи площадку, ID публикации и описание до 5000 символов.');
  }
  const id = `${reviewId}:${placement}`;
  const query = 'SELECT document FROM workspace_edits WHERE kind=? AND id=?';
  const row = await readOne(db,query,hookPublicationKind,id);
  if (!row) throw fail(404,'Публикация не найдена.');
  const matches = publication => publication.id===id && publication.reviewId===reviewId && publication.placement===placement &&
    publication.providerId===providerId && ['scheduled','published'].includes(publication.status);
  const before = parse(row.document);
  if (!matches(before)) throw fail(409,'Публикация уже изменилась.');
  if (before.caption===caption) return before;
  const publication = {...before,caption};
  const saved = await statement(db,'UPDATE workspace_edits SET document=? WHERE kind=? AND id=? AND document=?',
    JSON.stringify(publication),hookPublicationKind,id,row.document).run();
  if (changedRows(saved)) return publication;
  const current = await readOne(db,query,hookPublicationKind,id);
  if (current) {
    const retry = parse(current.document);
    if (matches(retry) && retry.caption===caption) return retry;
  }
  throw fail(409,'Публикация уже изменилась.');
}

async function recordHookPublication(db,input) {
  const {reviewId,status,placement,at,providerId,caption} = input;
  if (!reviewIdValid(reviewId)) throw fail(400,'Укажи точную версию видео.');
  if (input.action==='plan-trial') return planTrial(db,reviewId);
  if (input.action==='move-trial') return moveTrial(db,reviewId,input);
  if (input.action==='resolve-trial-move') return resolveTrialMove(db,reviewId,input);
  if (input.action==='publish-trial-now') return requestTrialPublish(db,reviewId,input.expectedAt);
  if (input.action==='resolve-trial-publish') return resolveTrialPublish(db,reviewId,input);
  if (input.action==='set-publication-caption') return setPublicationCaption(db,input);
  if (!['published','scheduled'].includes(status) || !['trial','feed'].includes(placement)
    || !publicationTimeValid(at) || !publicationProviderIdValid(providerId)) {
    throw fail(400,'Укажи статус, время с часовым поясом и ID публикации.');
  }
  if (caption!==undefined && !publicationCaptionValid(caption)) throw fail(400,'Укажи описание до 5000 символов.');
  let url;
  if (status==='published') {
    const link = typeof input.url==='string' && instagramPublicationUrl.test(input.url);
    if (!link) throw fail(400,'Укажи прямую ссылку на публикацию Instagram.');
    url = new URL(input.url).href;
  }
  const data = await workspace(db);
  const {script,output} = publicationTarget(data,reviewId);
  const id = `${reviewId}:${placement}`;
  const timestamp = new Date(at).toISOString();
  const previous = data.hookPublications.find(item=>item.id===id);
  const samePost = previous?.providerId===providerId;
  if (samePost && previous.status==='published' && status==='published' && previous.at===timestamp && previous.url===url) {
    if (caption!==undefined && caption!==previous.caption) throw fail(409,'Описание опубликованного ролика обновляется отдельно.');
    return previous;
  }
  const unchangedSchedule = status==='scheduled' && previous?.at===timestamp;
  const publishResult = samePost && status==='published'
    ? previous.publishRequest ? {id:previous.publishRequest.id,outcome:'confirmed'} : previous.publishResult
    : unchangedSchedule ? previous.publishResult : undefined;
  const publication = {id,...publicationDetails(script,output),placement,status,at:timestamp,
    day:moscowTime(timestamp).slice(0,10),providerId,url,caption:caption ?? (samePost ? previous.caption : undefined),
    ...(unchangedSchedule ? {moveRequest:previous.moveRequest,moveResult:previous.moveResult,
      publishRequest:previous.publishRequest} : {}),publishResult};
  const document = JSON.stringify(publication);
  const saved = await statement(db,`
    INSERT INTO workspace_edits (kind,id,document)
    SELECT ?,?,?
    WHERE EXISTS (
      SELECT 1 FROM workspace_snapshots AS snapshot,
        json_each(snapshot.document,'$.scenarios') AS scenario,
        json_each(scenario.value,'$.hookOutputs') AS output
      WHERE snapshot.name='workspace' AND json_extract(output.value,'$.url')=?
    ) AND NOT EXISTS (SELECT 1 FROM workspace_edits WHERE kind=? AND id<>?
      AND json_extract(document,'$.providerId')=?)
    ON CONFLICT (kind,id) DO UPDATE SET document=excluded.document
    WHERE workspace_edits.document=excluded.document OR
      (workspace_edits.document=? AND json_extract(workspace_edits.document,'$.status')<>'published' AND
        (json_extract(workspace_edits.document,'$.providerId') IS NULL OR json_extract(workspace_edits.document,'$.providerId')=?))
  `,hookPublicationKind,id,document,output.url,hookPublicationKind,id,providerId,previous ? JSON.stringify(previous) : null,providerId).run();
  if (!changedRows(saved)) throw fail(409,'Версия изменилась или публикация уже привязана.');
  return publication;
}

function editAdaptation(adaptations, value, selection) {
  const id = string(value.id,180);
  if (!/^[a-z0-9_-]+$/i.test(id)) throw fail(400,'Некорректная версия сценария.');
  const old = adaptations.find(item=>item.id===id) || {id,hookVariants:[],shotPlan:[],factGaps:[],title:'',body:'',hook:''};
  const updated = {...old};
  for (const [key,max] of [['title',150],['hook',3000],['body',36000]]) {
    if (key in value) updated[key] = string(value[key],max);
  }
  if (Array.isArray(value.factGaps)) updated.factGaps=value.factGaps.slice(0,25).map(text=>string(text,1000)).filter(Boolean);
  updated.status = stageTypes.has(value.status) ? value.status : 'adaptation_draft';
  updated.accepted = value.accepted === true && updated.status === 'ready_to_record';
  if (updated.accepted && (selection !== 'shortlisted' || !updated.hook || !updated.body || updated.factGaps.length)) {
    throw fail(400,'Для съёмки нужен отобранный источник, хук и текст. Проверь открытые вопросы.');
  }
  if (updated.status === 'ready_to_record' && !updated.accepted) updated.status = 'adaptation_draft';
  const next = adaptations.map(item=>item.id===id?updated:item);
  if (!next.some(item=>item.id===id)) next.push(updated);
  return next;
}

async function requestMedia(request,bucket,key) {
  if (!allowedKey(key)) throw fail(404,'Файл не найден.');
  const metadata = await bucket.head(key);
  if (!metadata) throw fail(404,'Файл не найден.');
  const headers = {...security,'accept-ranges':'bytes','content-type':videoKey.test(key)?'video/mp4':'image/jpeg',
    'content-length':String(metadata.size),etag:metadata.httpEtag};
  if (request.method === 'HEAD') return new Response(null,{headers});
  const range = request.headers.get('range');
  if (!range) {
    const object = await bucket.get(key);
    if (!object) throw fail(404,'Файл не найден.');
    return new Response(object.body,{headers});
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  const suffix = match?.[1] === '' ? Number(match[2]) : null;
  const start = suffix ? Math.max(0,metadata.size-suffix) : Number(match?.[1]);
  const end = suffix || !match?.[2] ? metadata.size - 1 : Math.min(Number(match[2]),metadata.size-1);
  if (!match || (!match[1] && !suffix) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || start >= metadata.size || start > end) {
    return new Response(null,{status:416,headers:{...security,'content-range':`bytes */${metadata.size}`}});
  }
  const length = end-start+1;
  const object = await bucket.get(key,{range:{offset:start,length}});
  if (!object) throw fail(404,'Файл не найден.');
  return new Response(object.body,{status:206, headers:{...headers,'content-length':String(length),'content-range':`bytes ${start}-${end}/${metadata.size}`}});
}

function snapshotMediaKey(url, prefix, keyPattern, message) {
  try {
    if (typeof url === 'string' && url.startsWith(prefix)) {
      const key = decodeURIComponent(url.slice(prefix.length));
      if (keyPattern.test(key) && allowedKey(key)) return key;
    }
  } catch {
    throw fail(400,message);
  }
  throw fail(400,message);
}

async function verifySnapshot(data,bucket) {
  for (const key of snapshotNames) if (!data[key] || typeof data[key]!=='object') throw fail(400,'Неполный снимок.');
  if (!Object.keys(fallbackWorkspace).every(key=>Array.isArray(data.workspace[key])) || !Array.isArray(data.references.records)) throw fail(400,'Некорректный снимок.');
  const media = new Set();
  for (const item of data.workspace.scenarios.flatMap(script=>script.hookOutputs)) {
    const key = snapshotMediaKey(item.url,outputPrefix,videoKey,'Некорректный путь к видео.');
    media.add(key);
    if (item.posterUrl !== undefined) {
      const cover = snapshotMediaKey(item.posterUrl, '/api/workspace/media/poster/', coverKey, 'Некорректный путь к обложке.');
      const expected = key.replace(/^renders\//, 'covers/').replace(/\.mp4$/, '.jpg');
      if (cover !== expected) throw fail(400, 'Обложка должна относиться к этому видео.');
      media.add(cover);
    }
  }
  if (data.workspace.scenarios.some(item=>item.clips.some(clip=>clip.url))) throw fail(400,'Исходники нельзя переносить.');
  for (const record of data.references.records) if (record.original.previewAvailable) media.add(`previews/${record.id}.jpg`);
  if (media.size > 150) throw fail(413,'Слишком много файлов.');
  const checked = await Promise.all([...media].map(key=>bucket.head(key)));
  if (checked.some(result=>!result)) throw fail(409,'Сначала загрузи все файлы из снимка.');
  return media.size;
}

function preserveCompletedRenders(incoming,current,revisions) {
  const lineage = new Map();
  for (const value of revisions) {
    if (value.status!=='ready') continue;
    let paths = lineage.get(value.scenarioKey);
    if (!paths) lineage.set(value.scenarioKey,paths=new Map());
    for (const item of value.replacements) {
      let ancestors = paths.get(item.resultReviewId);
      if (!ancestors) paths.set(item.resultReviewId,ancestors=new Set());
      ancestors.add(item.reviewId);
    }
  }
  if (!lineage.size || !Array.isArray(incoming?.scenarios)) return;
  const currentByScenario = new Map(current.scenarios.map(script=>[scenarioKeyFor(script),script]));
  for (const script of incoming.scenarios) {
    const key = scenarioKeyFor(script);
    const paths = lineage.get(key);
    const live = currentByScenario.get(key);
    if (!paths || !live || !Array.isArray(script.hookOutputs)) continue;
    const currentByPath = new Map(live.hookOutputs.map(output=>{
      const id = renderReviewId(output.url);
      return [id ? revisionPath(id) : null,{id,output}];
    }));
    script.hookOutputs = script.hookOutputs.map(output=>{
      const id = renderReviewId(output.url);
      if (!id) return output;
      const active = currentByPath.get(revisionPath(id));
      if (!active || active.id===id) return output;
      const visited = new Set();
      const remaining = [...(paths.get(active.id) ?? [])];
      while (remaining.length) {
        const previous = remaining.pop();
        if (previous===id) return active.output;
        if (visited.has(previous)) continue;
        visited.add(previous);
        remaining.push(...(paths.get(previous) ?? []));
      }
      return output;
    });
  }
}

async function importSnapshot(db,bucket,data) {
  const before = await revisionSnapshot(db);
  const revisions = await revisionRecords(db);
  preserveCompletedRenders(data.workspace,before.data,revisions);
  const files = await verifySnapshot(data,bucket);
  const updated = JSON.stringify(data.workspace);
  const [saved] = await db.batch([
    statement(db,`
      INSERT INTO workspace_snapshots (name,document)
      SELECT 'workspace',?
      WHERE (SELECT document FROM workspace_snapshots WHERE name='workspace') IS ?
      ON CONFLICT (name) DO UPDATE SET document=excluded.document
    `,updated,before.document),
    ...snapshotNames.filter(key=>key!=='workspace').map(key=>statement(db,`
      INSERT INTO workspace_snapshots (name,document)
      SELECT ?,? WHERE EXISTS (
        SELECT 1 FROM workspace_snapshots WHERE name='workspace' AND document=?
      ) ON CONFLICT (name) DO UPDATE SET document=excluded.document
    `,key,JSON.stringify(data[key]),updated)),
  ]);
  if (!changedRows(saved)) throw fail(409,'Контент изменился во время импорта. Запусти импорт повторно.');
  return json({saved:true,files});
}

const analyticsSnapshotName = 'reel-analytics';
const analyticsImportPath = '/__import/reel-analytics';
const analyticsOwnerPath = '/api/workspace/reel-analytics';
const analyticsMaxBytes = 1_700_000;
const reelCountMetrics = ['views','reach','likes','comments','shares','saves','watchTimeMs'];
const reelRateMetrics = ['skipRate','completionRate'];

function analyticsObject(value) {
  if (value && typeof value==='object' && !Array.isArray(value)) return value;
  throw fail(400,'Некорректные данные статистики.');
}

function analyticsIso(value, optional = false) {
  if (optional && value==null) return null;
  if (typeof value==='string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString()===value) return value;
  throw fail(400,'Некорректная дата статистики.');
}

function analyticsDay(value) {
  analyticsIso(typeof value==='string' ? `${value}T00:00:00.000Z` : value);
  return value;
}

function reelMetric(value, valid) {
  if (value==null) return null;
  if (typeof value==='number' && Number.isFinite(value) && value>=0 && valid(value)) return value;
  throw fail(400,'Некорректная метрика рилза.');
}

function analyticsEnum(value, allowed, fallback) {
  const candidate=value ?? fallback;
  if (allowed.includes(candidate)) return candidate;
  throw fail(400,'Некорректный статус рилза.');
}

function validateAnalyticsReel(input) {
  const reel=analyticsObject(input);
  const {id,url,isAd,caption}=reel;
  if (typeof id!=='string' || !/^\d{6,25}$/.test(id)) throw fail(400,'Некорректный ID рилза.');
  if (url!=null && (typeof url!=='string' || !/^https:\/\/(?:www\.)?instagram\.com\/(?:reel|p)\/[A-Za-z0-9_-]{2,30}\/?$/.test(url))) {
    throw fail(400,'Некорректная ссылка на рилз.');
  }
  if (isAd!=null && typeof isAd!=='boolean') throw fail(400,'Некорректная отметка рекламы.');
  if (caption!=null && (typeof caption!=='string' || caption.length>5000)) throw fail(400,'Некорректная подпись рилза.');
  const source=analyticsObject(reel.metrics);
  const metrics={
    ...Object.fromEntries(reelCountMetrics.map(key=>[key,reelMetric(source[key],Number.isSafeInteger)])),
    ...Object.fromEntries(reelRateMetrics.map(key=>[key,reelMetric(source[key],value=>value<=100)])),
    lastUpdatedAt:analyticsIso(source.lastUpdatedAt,true),
  };
  return {
    id,url:url ?? null,publishedAt:analyticsIso(reel.publishedAt),
    placement:analyticsEnum(reel.placement,['feed','outside_feed','unknown'],'unknown'),
    trialStatus:analyticsEnum(reel.trialStatus,['trial','not_trial','unknown'],'unknown'),
    isAd:isAd ?? null,caption:caption ?? '',durationSeconds:reelMetric(reel.durationSeconds,value=>value>0),
    syncStatus:analyticsEnum(reel.syncStatus,['synced','unavailable','missing'],'missing'),
    metrics,missingMetrics:[...reelCountMetrics,...reelRateMetrics].filter(key=>metrics[key]===null),
  };
}

function validateAnalyticsInsights(input, ids) {
  const value=analyticsObject(input), source=analyticsObject(value.baseline);
  const cohort=input=>{
    if (input==null) return null;
    const row=analyticsObject(input);
    return {
      count:reelMetric(row.count,value=>Number.isSafeInteger(value) && value<=ids.size),
      medianViews:reelMetric(row.medianViews,()=>true),medianReach:reelMetric(row.medianReach,()=>true),
      medianWatchTimeMs:reelMetric(row.medianWatchTimeMs,()=>true),medianSkipRate:reelMetric(row.medianSkipRate,value=>value<=100),
      medianSavesAndSharesPer1000Reach:reelMetric(row.medianSavesAndSharesPer1000Reach,()=>true),
      cumulativeViews:reelMetric(row.cumulativeViews,Number.isSafeInteger),
    };
  };
  const ranking=(rows,metric)=>{
    if (!Array.isArray(rows)) throw fail(400,'Некорректная подборка рилзов.');
    return rows.map(item=>{
      const row=analyticsObject(item);
      if (!ids.has(row.id)) throw fail(400,'В подборке нет такого рилза.');
      return {id:row.id,[metric]:reelMetric(row[metric],()=>true)};
    });
  };
  return {
    baseline:{
      matureAgeDays:reelMetric(source.matureAgeDays,Number.isSafeInteger),floorReach:reelMetric(source.floorReach,Number.isSafeInteger),
      overall:cohort(source.overall),feed:cohort(source.feed),outsideFeed:cohort(source.outsideFeed),
    },
    topViews:ranking(value.topViews,'views'),
    topSavesAndSharesPer1000Reach:ranking(value.topSavesAndSharesPer1000Reach,'value'),
  };
}

function validateReelAnalytics(data) {
  const account=analyticsObject(data.account);
  const coverage=analyticsObject(data.coverage);
  const {username}=account;
  if (data.schemaVersion!==1 || account.platform!=='instagram' || typeof username!=='string' || !/^[a-z0-9_.]{1,30}$/.test(username)) {
    throw fail(400,'Некорректный источник статистики.');
  }
  const {postCount,reelCount}=coverage;
  if (!Array.isArray(data.reels) || reelCount!==data.reels.length || !Number.isSafeInteger(postCount) || postCount<reelCount) {
    throw fail(400,'Неполный снимок статистики.');
  }
  const fetchedAt=analyticsIso(data.fetchedAt);
  const lastSyncAt=analyticsIso(data.lastSyncAt,true);
  const from=analyticsDay(coverage.from), to=analyticsDay(coverage.to);
  const reels=data.reels.map(validateAnalyticsReel);
  const ids=new Set(reels.map(reel=>reel.id));
  if (ids.size!==reelCount) throw fail(400,'В статистике повторяется один рилз.');
  const dates=reels.map(reel=>reel.publishedAt).sort();
  const earliestPublishedAt=dates[0] ?? null, latestPublishedAt=dates.at(-1) ?? null;
  if (from>to || to>fetchedAt.slice(0,10) || (lastSyncAt && lastSyncAt>fetchedAt)
    || analyticsIso(coverage.earliestPublishedAt,true)!==earliestPublishedAt
    || analyticsIso(coverage.latestPublishedAt,true)!==latestPublishedAt
    || (earliestPublishedAt && (earliestPublishedAt.slice(0,10)<from || latestPublishedAt.slice(0,10)>to))) {
    throw fail(400,'Даты архива не совпадают с публикациями.');
  }
  return {
    schemaVersion:1,account:{platform:'instagram',username},fetchedAt,lastSyncAt,
    coverage:{from,to,postCount,reelCount,earliestPublishedAt,latestPublishedAt},reels,
    ...(data.insights==null ? {} : {insights:validateAnalyticsInsights(data.insights,ids)}),
  };
}

async function reelAnalyticsReceipt(document) {
  if (!document) return {analytics:null};
  const {coverage,fetchedAt,lastSyncAt,reels}=parse(document);
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(document));
  return {
    ...coverage,fetchedAt,lastSyncAt,metricsReelCount:reels.filter(reel=>reel.syncStatus==='synced').length,
    sha256:Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join(''),
  };
}

async function getReelAnalyticsDocument(db) {
  return (await readOne(db,'SELECT document FROM workspace_snapshots WHERE name = ?',analyticsSnapshotName))?.document ?? null;
}

async function importReelAnalytics(db,data) {
  const document=JSON.stringify(validateReelAnalytics(data));
  if (new TextEncoder().encode(document).byteLength>analyticsMaxBytes) throw fail(413,'Снимок статистики слишком большой.');
  // Apply only newer, complete snapshots of this account. The check and replacement share one SQL statement.
  const result=await statement(db,`
    INSERT INTO workspace_snapshots (name,document) VALUES (?,?)
    ON CONFLICT (name) DO UPDATE SET document=excluded.document
    WHERE json_extract(excluded.document,'$.fetchedAt') > json_extract(workspace_snapshots.document,'$.fetchedAt')
      AND json_extract(excluded.document,'$.account.username') = json_extract(workspace_snapshots.document,'$.account.username')
      AND json_extract(excluded.document,'$.coverage.from') <= json_extract(workspace_snapshots.document,'$.coverage.from')
      AND json_extract(excluded.document,'$.coverage.to') >= json_extract(workspace_snapshots.document,'$.coverage.to')
      AND coalesce(json_extract(excluded.document,'$.lastSyncAt'),'') >= coalesce(json_extract(workspace_snapshots.document,'$.lastSyncAt'),'')
      AND NOT EXISTS (
        SELECT json_extract(previous.value,'$.id') FROM json_each(workspace_snapshots.document,'$.reels') previous
        EXCEPT
        SELECT json_extract(incoming.value,'$.id') FROM json_each(excluded.document,'$.reels') incoming
      )
  `,analyticsSnapshotName,document).run();
  if (!changedRows(result) && await getReelAnalyticsDocument(db)!==document) {
    throw fail(409,'Снимок статистики старее сохранённого, относится к другому аккаунту или пропускает часть архива.');
  }
  return json(await reelAnalyticsReceipt(document));
}

async function importRoute(request,env,path) {
  if (path==='/__import/revisions' || path.startsWith('/__import/revisions/')) {
    return revisionServiceRoute(request,env,path);
  }
  if (path===analyticsImportPath) {
    if (!await secretEqual(env.WORKSPACE_ANALYTICS_KEY,request.headers.get('x-workspace-analytics'))) throw fail(403,'Доступ закрыт.');
    if (request.method==='GET') return json(await reelAnalyticsReceipt(await getReelAnalyticsDocument(env.DB)));
    if (request.method==='PUT') return importReelAnalytics(env.DB,await bodyJson(request,analyticsMaxBytes));
    throw fail(405,'Недоступный метод запроса.');
  }
  if (!await secretEqual(env.WORKSPACE_IMPORT_KEY,request.headers.get('x-workspace-import'))) throw fail(403,'Доступ закрыт.');
  const db=env.DB;
  if (path==='/__import/media-release') return mediaReleaseRoute(request,env);
  if (request.method==='GET' && path==='/__import/receipt') {
    const data=await workspace(db);
    const query=new URL(request.url).searchParams;
    let sourceLinks;
    if (query.has('sourceKind') || query.has('sourceId')) {
      const source={sourceKind:query.get('sourceKind'),sourceId:query.get('sourceId')};
      checkWorkspaceLinkSource(source);
      sourceLinks=data.links.filter(link=>link.sourceKind===source.sourceKind && link.sourceId===source.sourceId);
    }
    return json({references:data.references.length,ideas:data.ideas.length,scenarios:data.scenarios.length,
      plans:data.plans.length,posts:data.posts.length,outputs:data.scenarios.reduce((n,item)=>n+item.hookOutputs.length,0),
      covers:data.scenarios.reduce((n,item)=>n+item.hookOutputs.filter(output=>output.posterUrl).length,0),
      links:data.links.length,sourceLinks});
  }
  if (request.method==='PUT' && path==='/__import/snapshot') {
    return importSnapshot(db,env.BUCKET,await bodyJson(request,1700000));
  }
  if (request.method==='PUT' && path.startsWith('/__import/file/')) {
    const key=decodeURIComponent(path.slice('/__import/file/'.length));
    if (!allowedKey(key)) throw fail(400,'Недопустимый файл.');
    const size=Number(request.headers.get('content-length'));
    if (!Number.isSafeInteger(size)||size<1||size>94_000_000||!request.body) throw fail(413,'Размер файла не поддерживается.');
    const sha256=request.headers.get('x-file-sha256');
    if (!/^[a-f0-9]{64}$/.test(sha256||'')) throw fail(400,'Нет контрольной суммы файла.');
    const revisioned = videoKey.test(key) && renderRevision.test(key.slice(renderPrefix.length));
    if (revisioned && !key.startsWith(`${renderPrefix}${sha256.slice(0,24)}/`)) throw fail(400,'Версия не соответствует видео.');
    const already=await env.BUCKET.head(key);
    if (already && already.customMetadata?.sha256===sha256 && already.size===size) return json({file:key,size,sha256});
    if (already && revisioned) throw fail(409,'Эта версия видео уже загружена.');
    const stored=await env.BUCKET.put(key,request.body,{sha256,httpMetadata:{contentType:videoKey.test(key)?'video/mp4':'image/jpeg'},customMetadata:{sha256}});
    return json({file:key,size:stored.size,sha256:stored.customMetadata.sha256});
  }
  if (request.method==='HEAD' && path.startsWith('/__import/file/')) {
    const key=decodeURIComponent(path.slice('/__import/file/'.length));
    if (!allowedKey(key)) throw fail(404,'Файл не найден.');
    const file=await env.BUCKET.head(key);
    if (!file) throw fail(404,'Файл не найден.');
    return new Response(null,{headers:{...security,'content-length':String(file.size),'x-file-sha256':file.customMetadata?.sha256||''}});
  }
  throw fail(404,'Страница не найдена.');
}

const starterScenarioId = /^[a-f0-9-]{36}$/;
const starterVideoLimit = 50 * 1024 * 1024;

async function saveStarterScenario(db, current, scenario) {
  const {document, data} = current;
  const scenarios = data.scenarios.some(item => item.kind === 'studio' && item.id === scenario.id)
    ? data.scenarios.map(item => item.kind === 'studio' && item.id === scenario.id ? scenario : item)
    : [...data.scenarios, scenario];
  const result = await statement(db, `
    INSERT INTO workspace_snapshots (name,document)
    SELECT 'workspace',? WHERE (SELECT document FROM workspace_snapshots WHERE name='workspace') IS ?
    ON CONFLICT (name) DO UPDATE SET document=excluded.document
  `, JSON.stringify({...data, scenarios}), document).run();
  if (!changedRows(result)) throw fail(409,'Карточка изменилась. Открой её и повтори действие.');
}

async function editStarterScenario(db, request, id) {
  const current = await revisionSnapshot(db);
  const existing = id ? current.data.scenarios.find(item => item.kind === 'studio' && item.id === id) : null;
  if (id && !existing) throw fail(404,'Сценарий не найден.');
  const input = await bodyJson(request, 48000);
  const title = string(input.title, 160);
  const body = string(input.body, 28000);
  if (!title || !body) throw fail(400,'Введи название и текст сценария.');
  if (!Array.isArray(input.hooks) || input.hooks.length > 10 || input.hooks.some(hook => !string(hook, 400))) {
    throw fail(400,'Укажи до 10 хуков отдельными строками.');
  }
  const hooks = input.hooks.map((hook, index) => ({id: 'h' + (index + 1), text: string(hook, 400)}));
  const scenario = {
    kind: 'studio', id: id ?? crypto.randomUUID(), ending: '', references: [], notes: [],
    variants: [], jobIds: [], postIds: [], hookOutputs: [], clips: [], stage: 'script',
    source: {title: 'Свой сценарий', date: new Date().toISOString().slice(0, 10)},
    ...existing, title, body, hooks,
  };
  await saveStarterScenario(db, current, scenario);
  return json({scenario}, id ? 200 : 201);
}

async function addStarterVideo({DB: db, BUCKET: bucket}, request, id) {
  const current = await revisionSnapshot(db);
  const scenario = current.data.scenarios.find(item => item.kind === 'studio' && item.id === id);
  if (!scenario) throw fail(404,'Сценарий не найден.');
  const size = Number(request.headers.get('content-length'));
  if (!Number.isSafeInteger(size) || size < 1 || size > starterVideoLimit || !request.body) {
    throw fail(413,'Загрузи MP4 размером до 50 МБ.');
  }
  const digest = request.headers.get('x-file-sha256') || '';
  if (request.headers.get('content-type') !== 'video/mp4' || !/^[a-f0-9]{64}$/.test(digest)) {
    throw fail(400,'Ожидается MP4 с контрольной суммой.');
  }
  const hookId = request.headers.get('x-hook-id') || '';
  const hook = scenario.hooks.find(item => item.id === hookId);
  if (hookId && !hook) throw fail(400,'Выбери хук из сценария.');
  const key = `renders/${digest.slice(0,24)}/${id}/${hookId || 'video'}.mp4`;
  const url = outputPrefix + encodeURIComponent(key);
  const existing = scenario.hookOutputs.find(output => output.url === url);
  const object = await bucket.put(key, request.body, {
    sha256: digest, onlyIf: {etagDoesNotMatch:'*'}, httpMetadata: {contentType:'video/mp4'},
  }) ?? await bucket.head(key);
  if (object?.size !== size || object.customMetadata?.sha256 !== digest) throw fail(400,'Проверь размер и контрольную сумму MP4.');
  if (existing) return json({output:existing}, 201);
  const output = {url, hookId, hookText:hook?.text ?? '', label: 'Версия ' + (scenario.hookOutputs.length + 1)};
  await saveStarterScenario(db, current, {...scenario, hookOutputs:[...scenario.hookOutputs, output]});
  return json({output}, 201);
}

async function ownerApi(request,env,path,query) {
  const db=env.DB, method=request.method;
  if (path === '/api/workspace/scenario' && method === 'POST') return editStarterScenario(db, request);
  const starterRoute = /^\/api\/workspace\/scenario\/([^/]+)(\/video)?$/.exec(path);
  if (starterRoute && method === 'PUT' && starterScenarioId.test(starterRoute[1])) {
    return starterRoute[2]
      ? addStarterVideo(env, request, starterRoute[1])
      : editStarterScenario(db, request, starterRoute[1]);
  }

  if (method==='GET' && path===analyticsOwnerPath) return json({analytics:await snapshot(db,analyticsSnapshotName,null)});
  if (method==='GET' && path==='/api/config') return json({...await snapshot(db,'config',{}),hosted:true});
  if (method==='GET' && path==='/api/workspace') return json(await workspace(db));
  if (method==='GET' && path==='/api/references') return json(await referenceData(db));
  if (method==='GET' && path==='/api/ideas') {
    const data=await workspace(db);
    return json({ideas:data.ideas.map(item=>({...item,kind:'моя идея',myText:item.body,state:'идея'}))});
  }
  if (method==='GET' && path==='/api/jobs') return json({jobs:(await workspace(db)).jobs});
  if (method==='GET' && path==='/api/posts') return json({posts:(await workspace(db)).posts});
  if (method==='PUT' && path==='/api/workspace/link') {
    const input=await bodyJson(request,2500);
    const edit=readWorkspaceLinkEdit(await workspace(db),input);
    await saveEdit(db,'link',workspaceLinkKey(edit),edit);
    return json({link:edit});
  }
  if (method==='PUT' && path==='/api/workspace/revisions') {
    return json({revision:await requestRevision(db,await bodyJson(request,18000))});
  }
  if (method==='PUT' && path==='/api/workspace/hook-publication') {
    const publication = await recordHookPublication(db,await bodyJson(request,32000));
    return json({publication});
  }
  if (method==='GET' && path==='/api/workspace/trial-slots') {
    const day = query.get('day'), reviewId = query.get('reviewId');
    if (!dateIsValid(day)) throw fail(400,'Выбери дату.');
    const data = await workspace(db);
    const now = new Date().toISOString();
    const publication = editableTrial(data,reviewId,now);
    if (publication.moveRequest || publication.publishRequest) throw fail(409,'Для этой версии уже есть запрос в работе.');
    const {occupied,capacity,count} = trialDay(data,day,publication.id);
    return json({day,slots:manualTrialHours.map(time=>{
      const at = trialTime(day,time);
      const reason = at===publication.at ? 'current' : at<=now ? 'past' : occupied.has(at) || count>=capacity ? 'occupied' : null;
      return {time,available:!reason,reason};
    })});
  }
  if (method==='PUT' && path==='/api/workspace/media-review') {
    const {reviewId,status}=await bodyJson(request,1500);
    const key=typeof reviewId==='string' ? renderPrefix+reviewId : '';
    if (!renderRevision.test(reviewId || '') || !allowedKey(key) || !videoKey.test(key) || !reviewStatuses.has(status)) {
      throw fail(400,'Некорректное решение по версии видео.');
    }
    const {scenarios}=await workspace(db);
    const output=scenarios.flatMap(script=>script.hookOutputs).find(item=>item.reviewId===reviewId);
    if (!output || !await env.BUCKET.head(key)) throw fail(404,'Версия видео больше недоступна. Открой новый монтаж.');
    await saveMediaReview(db,reviewId,status,output.url);
    return json({reviewId,reviewStatus:status});
  }
  if (path==='/api/style' && ['GET','PUT'].includes(method)) {
    const body=method==='PUT'?await bodyJson(request,80000):{};
    const key=(body.which||query.get('which'))==='svod'?'svod':'style';
    if (method==='GET') {
      const sources=await snapshot(db,'styles',{});
      const changed=await edits(db,'style');
      return json({which:key,text:changed.get(key)??sources[key]??'',file:'Онлайн'});
    }
    const text=string(body.text,60000);
    if (!text) throw fail(400,'Правила не могут быть пустыми.');
    await saveEdit(db,'style',key,text);
    return json({saved:true,file:'Онлайн'});
  }
  const stage=/^\/api\/workspace\/stage\/(.+)$/.exec(path);
  if (stage && method==='PUT') {
    const key=decodeURIComponent(stage[1]);
    if (!(await workspace(db)).scenarios.some(item=>`${item.kind}:${item.id}`===key)) throw fail(404,'Сценарий не найден.');
    const value=(await bodyJson(request,500)).stage;
    if (!workStages.has(value)) throw fail(400,'Некорректный статус сценария.');
    await saveEdit(db,'stage',key,{stage:value,updatedAt:new Date().toISOString()});
    return json({key,stage:value});
  }
  if (path==='/api/workspace/script-note' && method==='PUT') {
    const input=await bodyJson(request,9000);
    const key=typeof input.scenarioKey==='string'?input.scenarioKey:'';
    if (!(await workspace(db)).scenarios.some(item=>`${item.kind}:${item.id}`===key)) throw fail(404,'Сценарий не найден.');
    const regenerate=input.regenerate===true;
    const comment=string(input.comment,4000);
    if (!comment && !regenerate) throw fail(400,'Напиши, что доработать.');
    const timestamp=new Date().toISOString();
    const note={id:crypto.randomUUID(),scenarioKey:key,comment,regenerate,status:'queued',createdAt:timestamp,updatedAt:timestamp};
    await saveEdit(db,'script-note',note.id,note);
    return json({note});
  }
  const decision=/^\/api\/workspace\/decision\/(.+)$/.exec(path);
  if (decision && method==='PUT') {
    const key=decodeURIComponent(decision[1]);
    if (!bankKey.test(key)) throw fail(400,'Некорректная идея.');
    const value=(await bodyJson(request,500)).decision;
    if (value!==null && !bankDecisions.has(value)) throw fail(400,'Некорректное решение по идее.');
    await saveEdit(db,'decision',key,value?{decision:value,updatedAt:new Date().toISOString()}:null);
    return json({key,decision:value});
  }
  const plan=/^\/api\/workspace\/plan\/(.+)$/.exec(path);
  if (plan && method==='PUT') {
    const key=decodeURIComponent(plan[1]);
    const script=(await workspace(db)).scenarios.find(item=>`${item.kind}:${item.id}`===key);
    if (!script) throw fail(404,'Сценарий не найден.');
    const {day}=await bodyJson(request,1000);
    if (day!==null && !dateIsValid(day)) throw fail(400,'Укажи календарную дату.');
    const next=day ? {id:key,scenarioId:script.id,scenarioKind:script.kind,title:script.title,day} : null;
    await saveEdit(db,'plan',key,next);
    return json({plan:next});
  }
  const idea=/^\/api\/ideas(?:\/([^/]+))?$/.exec(path);
  if (idea && ['POST','PATCH'].includes(method)) {
    const {ideas}=await workspace(db);
    const body=await bodyJson(request,90000);
    const id=method==='POST'?string(body.id,140)||`idea-${crypto.randomUUID()}`:decodeURIComponent(idea[1]||'');
    if (!/^[a-z0-9_-]+$/i.test(id)) throw fail(400,'Некорректная идея.');
    const previous=ideas.find(item=>item.id===id);
    if (method==='PATCH' && !previous) throw fail(404,'Идея не найдена.');
    if (method==='POST' && previous) throw fail(409,'Идея уже есть.');
    const title=string(body.title??previous?.title,160);
    if (!title) throw fail(400,'Введи название идеи.');
    const timestamp=new Date().toISOString();
    const next={id,title,body:string(body.myText??previous?.body,40000),date:previous?.date||timestamp.slice(0,10),
      updatedAt:timestamp,source:previous?.source||''};
    await saveEdit(db,'idea',id,next);
    return json({idea:next});
  }
  const reference=/^\/api\/references\/([^/]+)$/.exec(path);
  if (reference && method==='PATCH') {
    const id=decodeURIComponent(reference[1]);
    const before=(await referenceData(db)).records.find(item=>item.id===id);
    if (!before) throw fail(404,'Референс не найден.');
    const changes=await bodyJson(request,90000);
    const selection=changes.selection??before.selection;
    if (!referenceSelections.has(selection)) throw fail(400,'Некорректный статус референса.');
    const next={...before,selection,adaptations:changes.adaptation?editAdaptation(before.adaptations,changes.adaptation,selection):before.adaptations,updatedAt:new Date().toISOString()};
    if (selection==='review') next.adaptations=next.adaptations.map(item=>item.accepted?{...item,accepted:false,status:'adaptation_draft'}:item);
    await saveEdit(db,'reference',id,next);
    return json({record:next});
  }
  if (method==='GET' || method==='HEAD') {
    const media=/^\/api\/workspace\/media\/(output|poster)\/(.+)$/.exec(path);
    if (media) {
      let key;
      try { key=decodeURIComponent(media[2]); }
      catch { throw fail(404,'Файл не найден.'); }
      if (!(media[1]==='poster'?coverKey:videoKey).test(key)) throw fail(404,'Файл не найден.');
      return requestMedia(request,env.BUCKET,key);
    }
    const preview=/^\/api\/references\/([^/]+)\/preview$/.exec(path);
    if (preview) return requestMedia(request,env.BUCKET,`previews/${decodeURIComponent(preview[1])}.jpg`);
  }
  throw fail(404,'Этот маршрут недоступен.');
}

export function createWorkspace({assets}) {
  return {
    async fetch(request,env) {
      const {pathname,searchParams}=new URL(request.url);
      try {
        // The dispatch layer must grant owner-only Site access before these headers can be set.
        if (pathname.startsWith('/__import/')) return await importRoute(request,env,pathname);
        if (!request.headers.get('oai-authenticated-user-id')) throw fail(401,'Доступ закрыт.');
        if (!['GET','HEAD'].includes(request.method)&&!originAllowed(request,env)) throw fail(403,'Неверный адрес запроса.');
        const asset=assets[pathname];
        if (asset && ['GET','HEAD'].includes(request.method)) return new Response(request.method==='HEAD'?null:asset[1],{
          headers:{...security,'content-type':asset[0]},
        });
        return await ownerApi(request,env,pathname,searchParams);
      } catch(error) {
        if (!error.status) console.error('Workspace request failed',error.name);
        return json({error:error.status?error.message:'Не удалось открыть данные.'},error.status||500);
      }
    },
  };
}
