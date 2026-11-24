import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createWorkspace } from '../worker/workspace.mjs';

function sqlite() {
  const db = new DatabaseSync(':memory:');
  return {
    setup: sql=>db.exec(sql),
    prepare: sql=>({
      bind: (...values)=>({
        first: async ()=>db.prepare(sql).get(...values),
        all: async ()=>({results:db.prepare(sql).all(...values)}),
        run: async ()=>db.prepare(sql).run(...values),
      }),
    }),
    batch: statements=>Promise.all(statements.map(item=>item.run())),
  };
}

function mediaStore() {
  const files = new Map();
  const makeMetadata = (object) => object && ({
    size:object.bytes.byteLength,httpEtag:'"fixture-etag"',customMetadata:object.options.customMetadata,
  });
  return {
    head: async key=>makeMetadata(files.get(key)),
    async put(key,stream,options) {
      const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
      const object = {bytes,options};
      files.set(key,object);
      return makeMetadata(object);
    },
    async get(key, options) {
      const item=files.get(key);
      if (!item) return null;
      const bytes=options?.range ? item.bytes.slice(options.range.offset,options.range.offset+options.range.length) : item.bytes;
      return {...makeMetadata(item),body:bytes};
    },
  };
}

test('owner data needs identity, scoped ingest verifies media, planning survives snapshot replacement', async () => {
  const DB=sqlite();
  DB.setup(await readFile(new URL('../drizzle/0000_workspace.sql',import.meta.url),'utf8'));
  const env={DB,BUCKET:mediaStore(),WORKSPACE_IMPORT_KEY:'test-secret'};
  const worker=createWorkspace({assets:{'/':['text/html','owner-interface']}});
  const client=(path, options={})=>worker.fetch(new Request(`https://work.example${path}`,options),env);
  const owner={'oai-authenticated-user-id':'owner'};
  const importer={'x-workspace-import':'test-secret'};
  assert.equal((await client('/')).status,401);
  assert.equal((await client('/api/workspace',{headers:importer})).status,401);
  assert.equal((await client('/__import/receipt',{headers:owner})).status,403);
  assert.equal(await (await client('/',{headers:owner})).text(),'owner-interface');
  const key=encodeURIComponent('renders/release-1/topic/edit.mp4');
  const videoUrl='/api/workspace/media/output/'+key;
  const coverKey=encodeURIComponent('covers/release-1/topic/edit.jpg');
  const posterUrl='/api/workspace/media/poster/'+coverKey;
  const script={id:'one',kind:'studio',title:'Topic',clips:[],hookOutputs:[{url:videoUrl}],
    references:[{url:'https://www.instagram.com/reel/ExactX/'}]};
  const original = {sourceUrl:'https://instagram.com/p/ExactX/',layers:{spoken:{quote:''}}};
  const data={
    workspace:{references:[],ideas:[],backlog:[{id:'later',title:'Next'}],scenarios:[script],plans:[],jobs:[],posts:[]},
    references:{records:[{id:'source-a',title:'Earlier',original,analysis:{},adaptations:[]}]},config:{stages:[]},styles:{},
  };
  const snapshot=()=>client('/__import/snapshot',{method:'PUT',headers:importer,body:JSON.stringify(data)});
  assert.equal((await snapshot()).status,409);
  assert.equal((await client('/__import/file/'+key,{
    method:'PUT',headers:{...importer,'content-length':'8','x-file-sha256':'a'.repeat(64)},body:'12345678',
  })).status,200);
  assert.equal((await snapshot()).status,200);
  script.hookOutputs[0].status='montage-review';
  script.hookOutputs[0].posterUrl=posterUrl.replace('edit.jpg','different.jpg');
  assert.equal((await snapshot()).status,400);
  script.hookOutputs[0].posterUrl=posterUrl;
  assert.equal((await snapshot()).status,409);
  assert.equal((await client('/__import/file/'+coverKey,{
    method:'PUT',headers:{...importer,'content-length':'5','x-file-sha256':'b'.repeat(64)},body:'cover',
  })).status,200);
  assert.equal((await snapshot()).status,200);
  assert.equal((await client(posterUrl)).status,401);
  const poster=await client(posterUrl,{headers:owner});
  assert.equal(poster.status,200);
  assert.equal(poster.headers.get('content-type'),'image/jpeg');
  assert.equal(await poster.text(),'cover');
  assert.equal((await client('/api/workspace/media/output/'+coverKey,{headers:owner})).status,404);
  assert.equal((await client('/api/workspace/media/poster/'+key,{headers:owner})).status,404);
  assert.equal((await client('/api/workspace/media/original/raw.mov',{headers:owner})).status,404);
  assert.equal((await client(videoUrl)).status,401);
  const media=await client(videoUrl,{headers:{...owner,range:'bytes=2-4'}});
  assert.equal(media.status,206);
  assert.equal(media.headers.get('content-range'),'bytes 2-4/8');
  assert.equal(await media.text(),'345');
  const plan=(origin)=>client('/api/workspace/plan/studio%3Aone',{
    method:'PUT',headers:{...owner,origin},body:JSON.stringify({day:'2026-11-30'}),
  });
  assert.equal((await plan('https://attacker.example')).status,403);
  assert.equal((await plan('https://work.example')).status,200);
  assert.equal((await snapshot()).status,200);
  const loaded=await (await client('/api/workspace',{headers:owner})).json();
  assert.equal(loaded.scenarios[0].title,'Topic');
  assert.deepEqual(loaded.scenarios[0].hookOutputs,[{url:videoUrl,posterUrl,status:'montage-review'}]);
  assert.equal(loaded.plans[0].day,'2026-11-30');
  const receipt=await (await client('/__import/receipt',{headers:importer})).json();
  assert.equal(receipt.outputs,1);
  assert.equal(receipt.covers,1);
  assert.equal(receipt.plans,1);
  const auto={sourceKind:'reference',sourceId:'source-a',scenarioKind:'studio',scenarioId:'one'};
  const manual={sourceKind:'backlog',sourceId:'later',scenarioKind:'studio',scenarioId:'one'};
  const link=(relation, linked, headers=owner)=>client('/api/workspace/link',{
    method:'PUT',headers,body:JSON.stringify({...relation,linked}),
  });
  assert.deepEqual(loaded.links,[auto]);
  assert.equal((await link(auto,false,importer)).status,401);
  assert.equal((await link(auto,false,{...owner,origin:'https://attacker.example'})).status,403);
  assert.equal((await link({...manual,sourceId:'missing'},true)).status,404);
  assert.equal((await link(auto,false)).status,200);
  assert.equal((await link(manual,true)).status,200);
  assert.equal((await snapshot()).status,200);
  const reloaded=await (await client('/api/workspace',{headers:owner})).json();
  assert.deepEqual(reloaded.links,[manual]);
  assert.equal(reloaded.plans[0].day,'2026-11-30');
  const filtered=await (await client('/__import/receipt?sourceKind=backlog&sourceId=later',{headers:importer})).json();
  assert.equal(filtered.links,1);
  assert.deepEqual(filtered.sourceLinks,[manual]);
  const put=(path, body, headers=owner)=>client(path,{method:'PUT',headers,body:JSON.stringify(body)});
  assert.equal((await put('/api/workspace/stage/studio%3Aone',{stage:'shoot'},importer)).status,401);
  assert.equal((await put('/api/workspace/stage/studio%3Aone',{stage:'shoot'},{...owner,origin:'https://attacker.example'})).status,403);
  assert.equal((await put('/api/workspace/stage/studio%3Amissing',{stage:'shoot'})).status,404);
  assert.equal((await put('/api/workspace/stage/studio%3Aone',{stage:'publish-now'})).status,400);
  assert.equal((await put('/api/workspace/stage/studio%3Aone',{stage:'approved'})).status,200);
  assert.equal((await put('/api/workspace/decision/reference%3Asource-a',{decision:'skip'})).status,200);
  assert.equal((await put('/api/workspace/decision/reference%3Asource-a',{decision:'delete'})).status,400);
  assert.equal((await put('/api/workspace/decision/..%2Fsecret',{decision:'skip'})).status,400);
  assert.equal((await snapshot()).status,200);
  const staged=await (await client('/api/workspace',{headers:owner})).json();
  assert.equal(staged.scenarios.find(item=>item.id==='one').workStage,'approved');
  assert.equal(staged.decisions['reference:source-a'].decision,'skip');
  assert.equal((await put('/api/workspace/decision/reference%3Asource-a',{decision:null})).status,200);
  assert.equal((await (await client('/api/workspace',{headers:owner})).json()).decisions['reference:source-a'],null);
  assert.equal((await put('/api/workspace/script-note',{scenarioKey:'studio:one',comment:''})).status,400);
  assert.equal((await put('/api/workspace/script-note',{scenarioKey:'studio:nope',comment:'x'})).status,404);
  assert.equal((await put('/api/workspace/script-note',{scenarioKey:'studio:one',comment:'Короче хуки'})).status,200);
  assert.equal((await put('/api/workspace/script-note',{scenarioKey:'studio:one',regenerate:true})).status,200);
  const notes=(await (await client('/api/workspace',{headers:owner})).json()).scriptNotes;
  assert.equal(notes.length,2);
  assert.ok(notes.every(item=>item.status==='queued' && item.scenarioKey==='studio:one'));
});

test('review decisions are owner-only and follow the exact render across imports', async () => {
  const DB = sqlite();
  DB.setup(await readFile(new URL('../drizzle/0000_workspace.sql', import.meta.url), 'utf8'));
  const env = {DB, BUCKET: mediaStore(), WORKSPACE_IMPORT_KEY: 'test-secret'};
  const worker = createWorkspace({assets: {}});
  const call = (path, options = {}) => worker.fetch(new Request(`https://work.example${path}`, options), env);
  const owner = {'oai-authenticated-user-id': 'owner'};
  const importer = {'x-workspace-import': 'test-secret'};
  const first = 'a'.repeat(24) + '/topic/edit.mp4';
  const second = 'b'.repeat(24) + '/topic/other.mp4';
  const replacement = 'c'.repeat(24) + '/topic/edit.mp4';
  const outputUrl = id => '/api/workspace/media/output/' + encodeURIComponent(`renders/${id}`);
  const script = {id: 'one', kind: 'studio', title: 'Topic', clips: [], hookOutputs: [
    {url: outputUrl(first)}, {url: outputUrl(second)},
  ]};
  const data = {workspace: {references: [], ideas: [], backlog: [], scenarios: [script], plans: [], jobs: [], posts: []},
    references: {records: []}, config: {}, styles: {}};
  const importSnapshot = () => call('/__import/snapshot', {method: 'PUT', headers: importer, body: JSON.stringify(data)});
  const readOutputs = async () => (await (await call('/api/workspace', {headers: owner})).json()).scenarios[0].hookOutputs;
  const review = (reviewId, status, headers = owner) => call('/api/workspace/media-review', {
    method: 'PUT', headers, body: JSON.stringify({reviewId, status}),
  });
  for (const id of [first, second, replacement]) {
    const key = encodeURIComponent(`renders/${id}`);
    assert.equal((await call('/__import/file/' + key, {
      method: 'PUT', headers: {...importer, 'content-length': '3', 'x-file-sha256': id[0].repeat(64)}, body: 'cut',
    })).status, 200);
  }
  assert.equal((await importSnapshot()).status, 200);
  assert.deepEqual(await readOutputs(), [first, second].map(reviewId => ({url: outputUrl(reviewId), reviewId})));
  assert.equal((await review(first, 'approved', {})).status, 401);
  assert.equal((await review(first, 'approved', importer)).status, 401);
  assert.equal((await review(first, 'approved', {...owner, origin: 'https://foreign.example'})).status, 403);
  assert.equal((await review(first, 'published')).status, 400);
  assert.equal((await review(first, 'approved', {...owner, origin: 'https://work.example'})).status, 200);
  assert.equal((await review(second, 'approved')).status, 200);
  assert.deepEqual((await readOutputs()).map(output => output.reviewStatus), ['approved', 'approved']);
  assert.equal((await review(first, 'montage-review', {})).status, 401);
  const returned = await review(first, 'montage-review');
  assert.equal(returned.status, 200);
  assert.deepEqual(await returned.json(), {reviewId: first, reviewStatus: 'montage-review'});
  assert.equal((await review(first, 'montage-review')).status, 200);
  assert.equal((await importSnapshot()).status, 200);
  assert.deepEqual((await readOutputs()).map(output => output.reviewStatus), ['montage-review', 'approved']);
  assert.equal((await review(first, 'approved')).status, 200);
  assert.deepEqual((await readOutputs()).map(output => output.reviewStatus), ['approved', 'approved']);
  const changed = await review(first, 'changes-requested');
  assert.equal(changed.status, 200);
  assert.deepEqual(await changed.json(), {reviewId: first, reviewStatus: 'changes-requested'});

  script.hookOutputs[0].reviewStatus = 'approved';
  assert.equal((await importSnapshot()).status, 200);
  assert.deepEqual((await readOutputs()).map(output => output.reviewStatus), ['changes-requested', 'approved']);

  script.hookOutputs[0].url = outputUrl(replacement);
  assert.equal((await importSnapshot()).status, 200);
  assert.equal((await review(first, 'approved')).status, 404);
  assert.deepEqual((await readOutputs()).map(output => [output.reviewId, output.reviewStatus]), [
    [replacement, undefined], [second, 'approved'],
  ]);
});

test('hook calendar plans only approved renders and keeps verified Instagram posts per version', async () => {
  const DB = sqlite();
  DB.setup(await readFile(new URL('../drizzle/0000_workspace.sql',import.meta.url),'utf8'));
  const env = {DB,BUCKET:mediaStore(),WORKSPACE_IMPORT_KEY:'test-secret'};
  const worker = createWorkspace({assets:{}});
  const owner = {'oai-authenticated-user-id':'owner'};
  const importer = {'x-workspace-import':'test-secret'};
  const call = (path, options) => worker.fetch(new Request('https://work.example'+path,options),env);
  const put = (path, body, headers=owner) => call(path,{method:'PUT',headers,body:JSON.stringify(body)});
  const record = (body, headers) => put('/api/workspace/hook-publication',body,headers);
  const ids = ['a','b','c','d','e','f'].map((char,i)=>char.repeat(24)+'/topic/h'+(i+1)+'.mp4');
  const script = {kind:'studio',id:'topic',title:'Topic',clips:[],hookOutputs:ids.map(reviewId=>({
    url:'/api/workspace/media/output/'+encodeURIComponent('renders/'+reviewId),
  }))};
  for (const reviewId of ids) {
    const upload = await call('/__import/file/'+encodeURIComponent('renders/'+reviewId),{
      method:'PUT',headers:{...importer,'content-length':'3','x-file-sha256':reviewId[0].repeat(64)},body:'cut',
    });
    assert.equal(upload.status,200);
  }
  const state = {workspace:{references:[],ideas:[],backlog:[],scenarios:[script],plans:[],jobs:[],posts:[]},
    references:{records:[]},config:{},styles:{}};
  const importSnapshot = () => put('/__import/snapshot',state,importer);
  assert.equal((await importSnapshot()).status,200);
  const plan = reviewId => ({reviewId,action:'plan-trial'});
  assert.equal((await record(plan(ids[0]),{})).status,401);
  assert.equal((await record(plan(ids[0]),{...owner,origin:'https://other.example'})).status,403);
  assert.equal((await record(plan(ids[0]))).status,409);

  const published = {reviewId:ids[0],status:'published',placement:'feed',at:'2026-11-23T00:08:37+03:00',
    url:'https://www.instagram.com/reel/Abc123/',providerId:'post-abc'};
  assert.equal((await record({...published,url:'https://example.com/reel/Abc123/'})).status,400);
  assert.equal((await record({...published,reviewId:'a'.repeat(24)+'/topic/missing.mp4'})).status,404);
  assert.equal((await record(published)).status,200);
  assert.equal((await record(plan(ids[0]))).status,409);
  for (const reviewId of ids.slice(1)) {
    assert.equal((await put('/api/workspace/media-review',{reviewId,status:'approved'})).status,200);
  }

  const planned = await Promise.all(ids.slice(1).map(async reviewId=>{
    const result = await record(plan(reviewId));
    assert.equal(result.status,200);
    return (await result.json()).publication;
  }));
  assert.equal(new Set(planned.map(item=>item.at)).size,5);
  for (const item of planned) {
    assert.equal(item.status,'planned');
    const moscow = new Date(Date.parse(item.at)+3*3600000).toISOString();
    assert.equal(item.day,moscow.slice(0,10));
    assert.ok(['09:00','12:00','15:00'].includes(moscow.slice(11,16)));
    assert.ok(planned.filter(other=>other.day===item.day).length<=3);
  }
  const again = await (await record(plan(ids[1]))).json();
  assert.deepEqual(again.publication,planned[0]);
  const scheduled = {reviewId:ids[1],placement:'trial',status:'scheduled',at:planned[0].at,providerId:'post-trial'};
  assert.equal((await record({...scheduled,caption:' Подпись\nс пробелами 👋 '})).status,200);
  assert.equal((await record({...scheduled,reviewId:ids[2]})).status,409);
  const day = new Date(Date.now()+10*86400000).toISOString().slice(0,10);
  const move = (reviewId, expectedAt, time) => record({reviewId,expectedAt,time,day,action:'move-trial'});
  assert.equal((await move(ids[2],planned[1].at,'10:30')).status,400);
  assert.equal((await move(ids[2],planned[2].at,'09:00')).status,409);
  const moved = await move(ids[2],planned[1].at,'10:00');
  assert.equal(moved.status,200);
  assert.equal((await moved.json()).publication.at,day+'T07:00:00.000Z');
  assert.equal((await move(ids[1],planned[0].at,'10:00')).status,409);
  const requested = await move(ids[1],planned[0].at,'23:00');
  assert.equal(requested.status,200);
  const {publication: pending} = await requested.json();
  assert.equal(pending.at,planned[0].at);
  assert.equal(pending.moveRequest.at,day+'T20:00:00.000Z');
  assert.equal((await record({action:'publish-trial-now',reviewId:ids[1],expectedAt:pending.at})).status,409);
  assert.deepEqual((await (await record(scheduled)).json()).publication.moveRequest,pending.moveRequest);
  const slots = await (await call('/api/workspace/trial-slots?'+new URLSearchParams({day,reviewId:ids[3]}),{headers:owner})).json();
  assert.deepEqual(slots.slots.map(({time})=>time),Array.from({length:24},(_,index)=>`${String(index).padStart(2,'0')}:00`));
  assert.deepEqual(slots.slots.filter(slot=>!slot.available).map(({time})=>time),['10:00','23:00']);
  assert.equal((await move(ids[3],planned[2].at,'23:00')).status,409);
  const competing = await Promise.all([move(ids[3],planned[2].at,'00:00'),move(ids[4],planned[3].at,'00:00')]);
  assert.deepEqual(competing.map(result=>result.status).sort(),[200,409]);
  const midnight = (await competing.find(result=>result.ok).json()).publication;
  assert.equal(midnight.day,day);
  assert.equal(midnight.at,new Date(`${day}T00:00:00+03:00`).toISOString());
  assert.equal((await move(ids[5],planned[4].at,'17:00')).status,409);
  const resolves = {reviewId:ids[1],action:'resolve-trial-move',requestId:pending.moveRequest.id,providerId:pending.providerId,
    at:pending.moveRequest.at,outcome:'confirmed'};
  assert.equal((await record({...resolves,providerId:'different-post'})).status,409);
  assert.equal((await record(resolves)).status,200);
  assert.equal((await record(resolves)).status,200);

  const publishTarget = {reviewId:ids[5],placement:'trial',status:'scheduled',at:day+'T12:00:00.000Z',providerId:'preexisting-trial'};
  assert.equal((await record({action:'publish-trial-now',reviewId:ids[5],expectedAt:planned[4].at})).status,409);
  assert.equal((await record(publishTarget)).status,200);
  const publish = {action:'publish-trial-now',reviewId:ids[5],expectedAt:publishTarget.at};
  assert.equal((await record({...publish,expectedAt:planned[4].at})).status,409);
  const accepted = await record(publish);
  assert.equal(accepted.status,200);
  const {publication: publishPending} = await accepted.json();
  assert.equal(publishPending.status,'scheduled');
  assert.equal(publishPending.providerId,publishTarget.providerId);
  assert.deepEqual((await (await record(publish)).json()).publication.publishRequest,publishPending.publishRequest);
  assert.deepEqual((await (await record(publishTarget)).json()).publication.publishRequest,publishPending.publishRequest);
  const laterDay = new Date(Date.now()+11*86400000).toISOString().slice(0,10);
  assert.equal((await record({action:'move-trial',reviewId:ids[5],expectedAt:publishTarget.at,day:laterDay,time:'09:00'})).status,409);
  const answer = {action:'resolve-trial-publish',reviewId:ids[5],requestId:publishPending.publishRequest.id,providerId:publishTarget.providerId};
  assert.equal((await record({...answer,providerId:'wrong',outcome:'rejected'})).status,409);
  assert.equal((await record({...answer,outcome:'rejected',reason:'Zernio отказал.'})).status,200);
  const {publication: retry} = await (await record(publish)).json();
  assert.notEqual(retry.publishRequest.id,publishPending.publishRequest.id);
  const proof = {...answer,requestId:retry.publishRequest.id,outcome:'confirmed',at:new Date().toISOString(),url:'https://www.instagram.com/reel/Trial123/'};
  assert.equal((await record({...proof,url:'https://example.org/'})).status,400);
  assert.equal((await record(proof)).status,200);
  assert.equal((await record(proof)).status,200);
  assert.equal((await record({...published,reviewId:ids[5],providerId:'other-feed'})).status,200);
  assert.equal((await importSnapshot()).status,200);
  const response = await call('/api/workspace',{headers:owner});
  const read = await response.json();
  const byReview = new Map(read.hookPublications.map(item=>[item.reviewId,item]));
  assert.equal(byReview.get(ids[0]).status,'published');
  assert.equal(byReview.get(ids[0]).day,'2026-11-23');
  assert.equal(byReview.get(ids[1]).status,'scheduled');
  assert.equal(byReview.get(ids[1]).at,day+'T20:00:00.000Z');
  assert.equal(byReview.get(ids[1]).moveRequest,undefined);
  assert.equal(byReview.get(ids[1]).caption,' Подпись\nс пробелами 👋 ');
  assert.equal(byReview.get(ids[2]).status,'planned');
  const pair = read.hookPublications.filter(item=>item.reviewId===ids[5]);
  assert.deepEqual(pair.map(({status,placement})=>[status,placement]),[['published','feed'],['published','trial']]);
  assert.equal(pair[1].providerId,publishTarget.providerId);
  assert.equal(pair[1].publishRequest,undefined);
  assert.deepEqual(read.revisions,[]);
});

test('publication caption writes are private, provider-scoped and preserve the exact publication', async () => {
  const DB = sqlite();
  DB.setup(await readFile(new URL('../drizzle/0000_workspace.sql',import.meta.url),'utf8'));
  const env = {DB,BUCKET:mediaStore(),WORKSPACE_IMPORT_KEY:'test-secret'};
  const owner = {'oai-authenticated-user-id':'owner'};
  const importer = {'x-workspace-import':'test-secret'};
  const worker = createWorkspace({assets:{}});
  const call = (path,options={}) => worker.fetch(new Request(`https://work.example${path}`,options),env);
  const record = (body,headers=owner) => call('/api/workspace/hook-publication',{method:'PUT',headers,body:JSON.stringify(body)});
  const read = async () => (await (await call('/api/workspace',{headers:owner})).json()).hookPublications;
  const reviewId = 'a'.repeat(24)+'/topic/hook.mp4';
  const key = encodeURIComponent('renders/'+reviewId);
  assert.equal((await call('/__import/file/'+key,{method:'PUT',
    headers:{...importer,'content-length':'3','x-file-sha256':'a'.repeat(64)},body:'cut'})).status,200);
  assert.equal((await call('/__import/snapshot',{method:'PUT',headers:importer,body:JSON.stringify({
    workspace:{references:[],ideas:[],backlog:[],plans:[],jobs:[],posts:[],scenarios:[{
      kind:'studio',id:'topic',title:'Topic',clips:[],hookOutputs:[{url:'/api/workspace/media/output/'+key}],
    }]},references:{records:[]},config:{},styles:{},
  })})).status,200);
  const feed = {reviewId,placement:'feed',providerId:'provider-feed',status:'published',at:'2026-11-23T00:08:37+03:00',
    url:'https://www.instagram.com/reel/Abc123/',caption:'Лента'};
  assert.equal((await record(feed)).status,200);
  const trial = {reviewId,placement:'trial',providerId:'provider-trial',status:'scheduled',
    at:new Date(Date.now()+86400000).toISOString(),caption:'Пробная'};
  assert.equal((await record(trial)).status,200);
  const {publication: pending} = await (await record({action:'publish-trial-now',reviewId,expectedAt:trial.at})).json();
  assert.ok(pending.publishRequest);

  const exact = '  Первая строка  \n\nВторая 👋\r\n'+'я'.repeat(2300)+'  ';
  const set = {action:'set-publication-caption',reviewId,placement:'trial',providerId:trial.providerId,caption:exact};
  assert.equal((await record(set,{})).status,401);
  assert.equal((await record(set,{...owner,origin:'https://other.example'})).status,403);
  assert.equal((await record({...set,placement:'feed'})).status,409);
  assert.equal((await record({...set,reviewId:'b'.repeat(24)+'/topic/hook.mp4'})).status,404);
  assert.equal((await record({...set,caption:null})).status,400);
  assert.equal((await record({...set,caption:'x'.repeat(5001)})).status,400);
  const writes = await Promise.all([record(set),record(set)]);
  assert.deepEqual(writes.map(response=>response.status),[200,200]);
  for (const response of writes) assert.deepEqual((await response.json()).publication,{...pending,caption:exact});

  const {caption: _oldTrialCaption,...sameTrial} = trial;
  assert.deepEqual((await (await record(sameTrial)).json()).publication,{...pending,caption:exact});
  const {caption: _oldFeedCaption,...sameFeed} = feed;
  assert.equal((await (await record(sameFeed)).json()).publication.caption,feed.caption);
  const confirmed = await record({action:'resolve-trial-publish',reviewId,providerId:trial.providerId,
    requestId:pending.publishRequest.id,outcome:'confirmed',at:new Date().toISOString(),url:'https://www.instagram.com/reel/Trial123/'});
  assert.equal(confirmed.status,200);
  const {publication: publishedTrial} = await confirmed.json();
  assert.equal(publishedTrial.caption,exact);
  assert.equal((await record({...set,caption:''})).status,200);
  const result = await read();
  assert.deepEqual(result.find(row=>row.placement==='trial'),{...publishedTrial,caption:''});
  assert.equal(result.find(row=>row.placement==='feed').caption,feed.caption);
});

test('revision notes queue exact video and shared-body work through a scoped, verified release', async () => {
  const DB = sqlite();
  DB.setup(await readFile(new URL('../drizzle/0000_workspace.sql',import.meta.url),'utf8'));
  const env = {DB,BUCKET:mediaStore(),WORKSPACE_IMPORT_KEY:'import-secret',WORKSPACE_REVISION_KEY:'revision-secret'};
  const worker = createWorkspace({assets:{}});
  const owner = {'oai-authenticated-user-id':'owner'};
  const importer = {'x-workspace-import':'import-secret'};
  const service = {'x-workspace-revision':'revision-secret'};
  const call = (path,options={}) => worker.fetch(new Request(`https://work.example${path}`,options),env);
  const put = (path,headers,body) => call(path,{method:'PUT',headers,body:JSON.stringify(body)});
  const videoKey = id => `renders/${id}`;
  const coverKey = id => `covers/${id.replace(/\.mp4$/,'.jpg')}`;
  const output = (id, hookId='opening') => ({
    url:'/api/workspace/media/output/'+encodeURIComponent(videoKey(id)),
    posterUrl:'/api/workspace/media/poster/'+encodeURIComponent(coverKey(id)),
    duration:32,status:'montage-review',hookId,
  });
  const original = 'a'.repeat(24)+'/topic/first.mp4';
  const sibling = 'b'.repeat(24)+'/topic/next.mp4';
  const changedOpening = 'c'.repeat(24)+'/topic/first.mp4';
  const changedBody = 'd'.repeat(24)+'/topic/first.mp4';
  const changedSibling = 'e'.repeat(24)+'/topic/next.mp4';
  const independent = 'f'.repeat(24)+'/topic/first.mp4';
  const script = {id:'one',kind:'studio',title:'Topic',clips:[],hookOutputs:[output(original),output(sibling,'other')]};
  const data = {workspace:{references:[],ideas:[],backlog:[],scenarios:[script],plans:[],jobs:[],posts:[]},
    references:{records:[]},config:{},styles:{}};
  const snapshot = () => put('/__import/snapshot',importer,data);
  const workspace = async () => (await call('/api/workspace',{headers:owner})).json();
  const request = (body,headers=owner) => put('/api/workspace/revisions',headers,{scenarioKey:'studio:one',...body});
  const approve = reviewId => put('/api/workspace/media-review',owner,{reviewId,status:'approved'});
  const servicePath = id => `/__import/revisions/${id}`;
  const step = (id,body) => put(servicePath(id),service,body);
  const upload = (path,key,headers,sha=key.split('/')[1][0].repeat(64)) => call(path+encodeURIComponent(key),{
    method:'PUT',headers:{...headers,'content-length':'3','x-file-sha256':sha},body:'cut',
  });
  for (const id of [original,sibling,independent]) {
    for (const key of [videoKey(id),coverKey(id)]) {
      assert.equal((await upload('/__import/file/',key,importer)).status,200);
    }
  }
  assert.equal((await snapshot()).status,200);
  assert.equal((await approve(sibling)).status,200);
  assert.equal((await request({reviewId:original,comment:'Make the first pause shorter'},service)).status,401);
  assert.equal((await request({reviewId:original,comment:'Make the first pause shorter'},
    {...owner,origin:'https://foreign.example'})).status,403);
  assert.equal((await request({reviewId:original,comment:' '})).status,400);
  assert.equal((await request({reviewId:original,comment:'Edit',scenarioKey:'studio:other'})).status,404);
  const note = {reviewId:original,comment:'Убрать паузу в первом хуке',clientRequestId:crypto.randomUUID()};
  const created = await request(note);
  assert.equal(created.status,200);
  const {revision:first} = await created.json();
  assert.deepEqual({scope:first.scope,reviewIds:first.targetReviewIds,status:first.status},
    {scope:'video',reviewIds:[original],status:'queued'});
  assert.deepEqual(await (await request(note)).json(),{revision:first});
  assert.equal((await request({...note,comment:'Иной комментарий'})).status,409);
  assert.deepEqual((await workspace()).scenarios[0].hookOutputs.map(row=>row.reviewStatus),['changes-requested','approved']);
  const body = (await (await request({comment:'Убрать повтор слова в общем теле'})).json()).revision;
  assert.deepEqual(body.targetReviewIds,[original,sibling]);
  assert.equal(body.scope,'body');
  assert.equal((await approve(sibling)).status,409);
  assert.equal((await put('/api/workspace/media-review',owner,{reviewId:sibling,status:'montage-review'})).status,409);
  assert.deepEqual((await workspace()).scenarios[0].hookOutputs.map(row=>row.reviewStatus),['changes-requested','changes-requested']);
  assert.equal((await call('/__import/revisions',{headers:owner})).status,403);
  assert.equal((await call('/__import/revisions',{headers:importer})).status,403);
  assert.equal((await call('/__import/receipt',{headers:service})).status,403);

  const claim = await step(first.id,{action:'claim'});
  assert.equal(claim.status,200);
  const {claimToken,revision:active} = await claim.json();
  assert.equal(active.status,'in-progress');
  assert.ok(active.leaseUntil>active.updatedAt);
  assert.ok(claimToken);
  assert.equal(active.claimToken,undefined);
  assert.equal((await step(body.id,{action:'claim'})).status,409);
  assert.equal((await step(first.id,{action:'claim'})).status,409);
  const firstFiles = servicePath(first.id)+'/file/';
  const claimHeaders = {...service,'x-revision-claim':claimToken};
  assert.equal((await call(firstFiles+encodeURIComponent(videoKey(original)),{headers:claimHeaders})).status,200);
  assert.equal((await call(firstFiles+encodeURIComponent(videoKey(sibling)),{headers:claimHeaders})).status,404);
  assert.equal((await upload(firstFiles,videoKey(original),claimHeaders)).status,404);
  assert.equal((await upload(firstFiles,videoKey(changedOpening),service)).status,409);
  assert.equal((await upload(firstFiles,videoKey(changedSibling),claimHeaders)).status,404);
  assert.equal((await upload(firstFiles,videoKey(changedOpening),claimHeaders,'9'.repeat(64))).status,400);
  assert.equal((await upload(firstFiles,videoKey(changedOpening),claimHeaders)).status,200);
  const downloaded = await call(firstFiles+encodeURIComponent(videoKey(changedOpening)),{method:'HEAD',headers:claimHeaders});
  assert.equal(downloaded.headers.get('x-file-sha256'),'c'.repeat(64));
  const openingComplete = {action:'ready',claimToken,replacements:[
    {reviewId:original,resultReviewId:changedOpening,duration:31.4},
  ]};
  assert.equal((await step(first.id,openingComplete)).status,409);
  assert.equal((await upload(firstFiles,coverKey(changedOpening),claimHeaders)).status,200);
  const ready = await step(first.id,openingComplete);
  assert.equal(ready.status,200);
  const openingResult = (await ready.json()).revision;
  assert.equal(openingResult.status,'ready');
  assert.deepEqual(openingResult.resultReviewIds,[changedOpening]);
  assert.deepEqual(await (await step(first.id,openingComplete)).json(),{revision:openingResult});
  let reread = await workspace();
  assert.deepEqual(reread.scenarios[0].hookOutputs.map(row=>[row.reviewId,row.reviewStatus,row.duration]),[
    [changedOpening,'changes-requested',31.4],[sibling,'changes-requested',32],
  ]);
  assert.deepEqual(reread.revisions.find(row=>row.id===body.id).targetReviewIds,[changedOpening,sibling]);
  assert.equal((await approve(changedOpening)).status,409);

  const bodyClaim = await step(body.id,{action:'claim'});
  assert.equal(bodyClaim.status,200);
  const {claimToken:bodyToken} = await bodyClaim.json();
  const bodyFiles = servicePath(body.id)+'/file/';
  const bodyHeaders = {...service,'x-revision-claim':bodyToken};
  for (const id of [changedBody,changedSibling]) {
    assert.equal((await upload(bodyFiles,videoKey(id),bodyHeaders)).status,200);
    assert.equal((await upload(bodyFiles,coverKey(id),bodyHeaders)).status,200);
  }
  const firstBodyOutput = {reviewId:changedOpening,resultReviewId:changedBody,duration:31};
  assert.equal((await step(body.id,{action:'ready',claimToken:bodyToken,replacements:[firstBodyOutput]})).status,400);
  assert.equal((await step(body.id,{action:'ready',claimToken:bodyToken,replacements:[
    firstBodyOutput,{reviewId:sibling,resultReviewId:changedSibling,duration:31.6},
  ]})).status,200);
  assert.equal((await snapshot()).status,200);
  reread = await workspace();
  assert.deepEqual(reread.scenarios[0].hookOutputs.map(row=>[row.reviewId,row.reviewStatus,row.hookId]),[
    [changedBody,undefined,'opening'],[changedSibling,undefined,'other'],
  ]);
  assert.equal(reread.revisions.find(row=>row.id===body.id).comment,'Убрать повтор слова в общем теле');
  const releasedCover = await call(output(changedBody).posterUrl,{headers:owner});
  assert.equal(releasedCover.status,200);
  assert.equal(await releasedCover.text(),'cut');
  const held = (await (await request({reviewId:changedBody,comment:'Поменять слово'})).json()).revision;
  const heldClaim = (await (await step(held.id,{action:'claim'})).json()).claimToken;
  assert.equal((await step(held.id,{action:'needs-input',claimToken:'bad',note:'Какое слово?'})).status,409);
  const needsInput = await step(held.id,{action:'needs-input',claimToken:heldClaim,note:'Какое слово?'});
  assert.equal(needsInput.status,200);
  assert.equal((await needsInput.json()).revision.status,'needs-input');
  assert.equal((await approve(changedBody)).status,409);
  assert.equal((await approve(changedSibling)).status,200);
  const waiting = (await (await request({reviewId:changedSibling,comment:'Поменять слово'})).json()).revision;
  const oldClaim = (await (await step(waiting.id,{action:'claim'})).json()).claimToken;
  await DB.prepare("UPDATE workspace_edits SET document=json_set(document,'$.leaseUntil','2000-01-01T00:00:00.000Z') WHERE id=?")
    .bind(waiting.id).run();
  const recoveredClaim = await step(waiting.id,{action:'claim'});
  assert.equal(recoveredClaim.status,200);
  assert.notEqual((await recoveredClaim.json()).claimToken,oldClaim);
  assert.equal((await step(waiting.id,{action:'needs-input',claimToken:oldClaim,note:'Какое слово?'})).status,409);

  script.hookOutputs[0] = output(independent);
  assert.equal((await snapshot()).status,200);
  reread = await workspace();
  assert.deepEqual(reread.scenarios[0].hookOutputs.map(row=>row.reviewId),[independent,changedSibling]);
  assert.equal(reread.revisions.length,4);
});

function reelAnalyticsFixture({count = 142, fetchedAt = '2026-11-22T19:00:00.000Z'} = {}) {
  const reels = Array.from({length:count}, (_, offset) => {
    const publishedAt = new Date(Date.UTC(2026, 0, offset + 4)).toISOString();
    return {
      id:String(18300000000000000n + BigInt(offset)),url:`https://www.instagram.com/reel/Fixture_${offset}/`,publishedAt,
      placement:offset ? 'feed' : 'outside_feed',trialStatus:'unknown',isAd:false,caption:`Рилз ${offset}`,durationSeconds:null,
      syncStatus:offset ? 'synced' : 'unavailable',metrics:{views:offset ? 0 : null,reach:offset || null,watchTimeMs:null,skipRate:null},
    };
  });
  return {
    schemaVersion:1,account:{platform:'instagram',username:'example_creator'},fetchedAt,lastSyncAt:'2026-11-22T18:00:00.000Z',
    coverage:{from:'2010-10-06',to:'2026-11-22',postCount:reels.length+22,reelCount:reels.length,
      earliestPublishedAt:reels[0]?.publishedAt ?? null,latestPublishedAt:reels.at(-1)?.publishedAt ?? null},
    reels,
  };
}

async function analyticsClient() {
  const DB=sqlite();
  DB.setup(await readFile(new URL('../drizzle/0000_workspace.sql',import.meta.url),'utf8'));
  const env={DB,BUCKET:mediaStore(),WORKSPACE_IMPORT_KEY:'test-media-secret',WORKSPACE_ANALYTICS_KEY:'test-analytics-secret'};
  const worker=createWorkspace({assets:{}});
  const request=(path,options={})=>worker.fetch(new Request(`https://work.example${path}`,options),env);
  const owner={'oai-authenticated-user-id':'owner'};
  const mediaImporter={'x-workspace-import':'test-media-secret'};
  const importer={'x-workspace-analytics':'test-analytics-secret'};
  const get=(headers = owner)=>request('/api/workspace/reel-analytics',{headers});
  const check=(headers = importer)=>request('/__import/reel-analytics',{headers});
  const put=(value,headers = importer)=>request('/__import/reel-analytics',{method:'PUT',headers,body:JSON.stringify(value)});
  return {request,owner,importer,mediaImporter,get,check,put};
}

test('Reel analytics protects private metrics and preserves the archive through normal workspace imports', async () => {
  const {request,owner,importer,mediaImporter,get,check,put}=await analyticsClient();
  assert.equal((await get({})).status,401);
  assert.equal((await get(importer)).status,401);
  assert.equal((await check(owner)).status,403);
  assert.equal((await check(mediaImporter)).status,403);
  assert.equal((await request('/__import/receipt',{headers:importer})).status,403);
  assert.deepEqual(await (await get()).json(),{analytics:null});
  assert.deepEqual(await (await check()).json(),{analytics:null});
  const data=reelAnalyticsFixture();
  data.insights={
    baseline:{matureAgeDays:7,floorReach:100,overall:{count:1,medianViews:0}},
    topViews:[{id:data.reels[1].id,views:0}],topSavesAndSharesPer1000Reach:[],
  };
  data.secret='never store';
  data.reels[1].downloadUrl='never store';
  assert.equal((await put(data,owner)).status,403);
  const imported=await put(data);
  assert.equal(imported.status,200);
  const receipt=await imported.json();
  assert.equal(receipt.reelCount,142);
  assert.match(receipt.sha256,/^[a-f0-9]{64}$/);
  assert.deepEqual(await (await check()).json(),receipt);
  const read=await get();
  assert.equal(read.headers.get('cache-control'),'private, no-store');
  const {analytics}=await read.json();
  assert.equal(analytics.reels.length,142);
  assert.equal(analytics.reels[0].metrics.views,null);
  assert.equal(analytics.reels[1].metrics.views,0);
  assert.equal(analytics.insights.baseline.overall.medianViews,0);
  assert.deepEqual(analytics.insights.topViews,[{id:data.reels[1].id,views:0}]);
  assert.equal(analytics.secret,undefined);
  assert.equal(analytics.reels[1].downloadUrl,undefined);
  const bytes=new TextEncoder().encode(JSON.stringify(analytics));
  const hash=await crypto.subtle.digest('SHA-256',bytes);
  assert.equal(receipt.sha256,Buffer.from(hash).toString('hex'));

  const emptyWorkspace={references:[],ideas:[],backlog:[],scenarios:[],jobs:[],posts:[],plans:[]};
  const mainImport=await request('/__import/snapshot',{method:'PUT',headers:mediaImporter,body:JSON.stringify({
    workspace:emptyWorkspace,references:{records:[]},config:{},styles:{},
  })});
  assert.equal(mainImport.status,200);
  assert.deepEqual(await (await check()).json(),receipt);
});

test('Reel analytics validates input and serializes archive refreshes without losing historical rows', async () => {
  const {get,check,put}=await analyticsClient();
  const data=reelAnalyticsFixture({count:2});
  const duplicate=structuredClone(data);
  duplicate.reels[1].id=duplicate.reels[0].id;
  assert.equal((await put(duplicate)).status,400);
  const invalidMetric=structuredClone(data);
  invalidMetric.reels[0].metrics.skipRate=200;
  assert.equal((await put(invalidMetric)).status,400);
  const invalidUrl=structuredClone(data);
  invalidUrl.reels[0].url='https://instagram.com.attacker.example/reel/test/';
  assert.equal((await put(invalidUrl)).status,400);
  const invalidCount=structuredClone(data);
  invalidCount.coverage.reelCount++;
  assert.equal((await put(invalidCount)).status,400);
  const saved=await (await put(data)).json();
  assert.deepEqual(await (await put(data)).json(),saved);
  const modifiedAtSameTime=structuredClone(data);
  modifiedAtSameTime.reels[0].metrics.views=10;
  assert.equal((await put(modifiedAtSameTime)).status,409);
  const old=reelAnalyticsFixture({count:2,fetchedAt:'2026-11-22T18:30:00.000Z'});
  assert.equal((await put(old)).status,409);
  const incomplete=reelAnalyticsFixture({count:2,fetchedAt:'2026-11-22T20:30:00.000Z'});
  incomplete.reels[1].id='18300000000000033';
  assert.equal((await put(incomplete)).status,409);
  const shortened=reelAnalyticsFixture({count:1,fetchedAt:'2026-11-22T20:30:00.000Z'});
  assert.equal((await put(shortened)).status,409);
  assert.deepEqual(await (await check()).json(),saved);
  const newest=reelAnalyticsFixture({count:3,fetchedAt:'2026-11-22T21:15:00.000Z'});
  const intermediate=reelAnalyticsFixture({count:3,fetchedAt:'2026-11-22T21:00:00.000Z'});
  const [winner]=await Promise.all([put(newest),put(intermediate)]);
  assert.equal(winner.status,200);
  assert.equal((await (await get()).json()).analytics.fetchedAt,newest.fetchedAt);
});

test('media release swaps verified versions and keeps exact queued comment targets', async () => {
  const DB = sqlite();
  DB.setup(await readFile(new URL('../drizzle/0000_workspace.sql',import.meta.url),'utf8'));
  const env = {DB,BUCKET:mediaStore(),WORKSPACE_IMPORT_KEY:'import-secret',WORKSPACE_REVISION_KEY:'revision-secret'};
  const worker = createWorkspace({assets:{}});
  const owner = {'oai-authenticated-user-id':'owner'};
  const importer = {'x-workspace-import':'import-secret'};
  const service = {'x-workspace-revision':'revision-secret'};
  const call = (path,options={}) => worker.fetch(new Request('https://work.example'+path,options),env);
  const put = (path,headers,body) => call(path,{method:'PUT',headers,body:JSON.stringify(body)});
  const scenarioKey = 'studio:one';
  const releasePath = '/__import/media-release';
  const receipt = (key,id) => call(releasePath+'?'+new URLSearchParams({scenarioKey:key,...(id && {id})}),{headers:importer});
  const reviewId = (hash,slot) => hash.repeat(24)+'/topic/'+slot+'.mp4';
  const [old,sibling,next,final,siblingFinal,obsolete] = [
    ['a','first'],['b','other'],['c','first'],['d','first'],['e','other'],['f','first'],
  ].map(values=>reviewId(...values));
  const mediaKey = (id,cover) => cover ? 'covers/'+id.replace(/\.mp4$/,'.jpg') : 'renders/'+id;
  const output = (id,hookId) => ({hookId,duration:32,url:'/api/workspace/media/output/'+encodeURIComponent(mediaKey(id,false))});
  const upload = async (id,cover) => {
    const response = await call('/__import/file/'+encodeURIComponent(mediaKey(id,cover)),{
      method:'PUT',headers:{...importer,'content-length':'3','x-file-sha256':id[0].repeat(64)},body:'cut',
    });
    assert.equal(response.status,200);
  };
  const data = {
    workspace:{references:[],ideas:[],backlog:[],scenarios:[
      {id:'one',kind:'studio',title:'One',clips:[],hookOutputs:[output(obsolete,'opening'),output(sibling,'other')]},
      {id:'two',kind:'studio',title:'Two',clips:[],hookOutputs:[]},
    ],plans:[],jobs:[],posts:[]},
    config:{retained:true},references:{records:[]},styles:{retained:true},
  };
  const importSnapshot = () => put('/__import/snapshot',importer,data);
  const notes = async () => (await (await call('/__import/revisions',{headers:service})).json()).revisions;
  const createNote = async (comment,reviewId) => {
    const response = await put('/api/workspace/revisions',owner,{scenarioKey,reviewId,comment});
    assert.equal(response.status,200);
    return (await response.json()).revision;
  };
  const claim = id => put('/__import/revisions/'+id,service,{action:'claim'});
  const release = input => put(releasePath,importer,input);
  for (const id of [old,sibling,next,final,siblingFinal,obsolete]) await upload(id,false);
  for (const id of [final,siblingFinal]) await upload(id,true);
  assert.equal((await importSnapshot()).status,200);
  const staleNote = await createNote('Увеличить хук',obsolete);
  data.workspace.scenarios[0].hookOutputs[0] = output(old,'opening');
  assert.equal((await importSnapshot()).status,200);
  assert.equal((await claim(staleNote.id)).status,200);
  assert.equal((await notes()).find(row=>row.id===staleNote.id).status,'needs-input');

  const queuedVideo = await createNote('Оставить заявку на первый хук',old);
  const queuedBody = await createNote('Оставить заявку на общее тело');
  const unrelated = await createNote('Оставить заявку на соседний хук',sibling);
  const initial = {scenarioKey,currentReviewIds:[old,sibling]};
  assert.equal((await call(releasePath+'?scenarioKey='+scenarioKey,{headers:owner})).status,403);
  assert.equal((await call(releasePath+'?scenarioKey='+scenarioKey,{headers:service})).status,403);
  assert.equal((await call(releasePath,{headers:importer})).status,400);
  assert.deepEqual(await (await receipt(scenarioKey)).json(),initial);
  const pending = {
    id:staleNote.id,scenarioKey,scope:'video',priorTargetReviewIds:[obsolete],
    replacements:[{reviewId:old,resultReviewId:next,duration:31.5}],
  };
  assert.equal((await release(pending)).status,409);
  await upload(next,true);
  assert.equal((await release({...pending,priorTargetReviewIds:[old]})).status,409);
  assert.equal((await release({...pending,scope:'body'})).status,409);
  const originalBatch = DB.batch;
  DB.batch = async statements => {
    DB.batch = originalBatch;
    assert.equal((await claim(unrelated.id)).status,200);
    return originalBatch(statements);
  };
  assert.equal((await release(pending)).status,409);
  assert.deepEqual(await (await receipt(scenarioKey)).json(),initial);
  assert.equal((await notes()).find(row=>row.id===staleNote.id).status,'needs-input');
  assert.equal((await notes()).find(row=>row.id===unrelated.id).status,'in-progress');
  await DB.prepare("UPDATE workspace_edits SET document=? WHERE id=?").bind(JSON.stringify(unrelated),unrelated.id).run();
  const published = await release(pending);
  assert.equal(published.status,200);
  const publishedReceipt = {
    scenarioKey,currentReviewIds:[next,sibling],release:{id:pending.id,resultReviewIds:[next],current:true},
  };
  assert.deepEqual(await published.json(),publishedReceipt);
  assert.deepEqual(await (await receipt(scenarioKey,pending.id)).json(),publishedReceipt);
  assert.deepEqual(await (await release(pending)).json(),publishedReceipt);
  assert.equal((await receipt('studio:two',pending.id)).status,404);
  assert.equal((await release({...pending,replacements:[{...pending.replacements[0],duration:32}]})).status,409);
  const records = await notes();
  const byId = id => records.find(row=>row.id===id);
  assert.deepEqual(byId(queuedVideo.id),{...queuedVideo,targetReviewIds:[next]});
  assert.deepEqual(byId(queuedBody.id),{...queuedBody,targetReviewIds:[next,sibling]});
  assert.deepEqual(byId(unrelated.id),unrelated);
  assert.deepEqual(byId(staleNote.id),{
    ...staleNote,status:'ready',updatedAt:byId(staleNote.id).updatedAt,targetReviewIds:[old],resultReviewIds:[next],
  });
  assert.equal(records.length,4);

  const body = {id:crypto.randomUUID(),scenarioKey,scope:'body',comment:'Белые субтитры',replacements:[
    {reviewId:next,resultReviewId:final,duration:31.5},{reviewId:sibling,resultReviewId:siblingFinal,duration:32},
  ]};
  assert.equal((await release({...body,replacements:body.replacements.slice(0,1)})).status,409);
  assert.equal((await release({...body,replacements:[{...body.replacements[0],reviewId:old},body.replacements[1]]})).status,409);
  assert.equal((await release({...body,replacements:[{...body.replacements[0],resultReviewId:old},body.replacements[1]]})).status,409);
  assert.equal((await release(body)).status,200);
  assert.deepEqual(await (await release({...body,replacements:[...body.replacements].reverse()})).json(),{
    scenarioKey,currentReviewIds:[final,siblingFinal],
    release:{id:body.id,resultReviewIds:[final,siblingFinal],current:true},
  });
  assert.deepEqual(await (await receipt(scenarioKey,pending.id)).json(),{
    scenarioKey,currentReviewIds:[final,siblingFinal],release:{...publishedReceipt.release,current:false},
  });
  assert.equal((await importSnapshot()).status,200);
  const reread = await (await call('/api/workspace',{headers:owner})).json();
  assert.deepEqual(reread.scenarios[0].hookOutputs.map(({reviewId,hookId,duration,reviewStatus})=>[reviewId,hookId,duration,reviewStatus]),[
    [final,'opening',31.5,'changes-requested'],[siblingFinal,'other',32,'changes-requested'],
  ]);
  assert.deepEqual(reread.scenarios[1].hookOutputs,[]);
  assert.deepEqual(reread.revisions.find(row=>row.id===queuedBody.id).targetReviewIds,[final,siblingFinal]);
  assert.equal((await call(reread.scenarios[0].hookOutputs[0].posterUrl,{headers:owner})).status,200);

  const manual = await createNote('Поднять читаемость первого хука',final);
  const {claimToken} = await (await claim(manual.id)).json();
  const missingBodyNote = 'Не нашла монтажную секцию для этой версии. Нужен рабочий проект или исходный файл этого ролика.';
  assert.equal((await put('/__import/revisions/'+manual.id,service,{
    action:'needs-input',claimToken,note:missingBodyNote,
  })).status,200);
  const manualResult = reviewId('9','first');
  for (const cover of [false,true]) await upload(manualResult,cover);
  const completeManual = {id:manual.id,scenarioKey,scope:'video',priorTargetReviewIds:[final],replacements:[
    {reviewId:final,resultReviewId:manualResult,duration:31.5},
  ]};
  assert.equal((await release({...completeManual,priorTargetReviewIds:[next]})).status,409);
  assert.equal((await release(completeManual)).status,200);
  assert.deepEqual((await notes()).find(row=>row.id===manual.id),{
    ...manual,status:'ready',updatedAt:(await notes()).find(row=>row.id===manual.id).updatedAt,resultReviewIds:[manualResult],
  });
});
