import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openVpsStorage } from '../worker/vps-storage.mjs';
import { createWorkspace } from '../worker/workspace.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'content-vps-storage-'));
  const mediaDirectory = join(directory, 'media');
  const options = { databasePath: join(directory, 'workspace.sqlite'), mediaDirectory };
  let storage;
  t.after(async () => {
    storage?.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    storage: storage = await openVpsStorage(options),
    mediaDirectory,
    async reopen() {
      storage.close();
      storage = undefined;
      return storage = await openVpsStorage(options);
    },
  };
}

const sha256 = body => createHash('sha256').update(body).digest('hex');
const requestBody = text => new Response(text).body;

test('SQLite persists workspace statements and rolls back a failed batch', async t => {
  const local = await fixture(t);
  const { DB } = local.storage;
  const insert = name => DB.prepare('INSERT INTO workspace_snapshots VALUES (?, ?)').bind(name, '{}');

  assert.equal((await insert('workspace').run()).meta.changes, 1);
  await assert.rejects(async () => DB.batch([insert('references'), insert('workspace')]), /UNIQUE/);
  assert.equal(await DB.prepare('SELECT document FROM workspace_snapshots WHERE name = ?').bind('references').first(), null);

  const batch = await DB.batch([insert('styles'), insert('config')]);
  assert.deepEqual(batch.map(result => result.meta.changes), [1, 1]);
  const reopened = await local.reopen();
  const snapshots = await reopened.DB.prepare('SELECT name FROM workspace_snapshots ORDER BY name').bind().all();
  assert.deepEqual(snapshots.results, [{ name: 'config' }, { name: 'styles' }, { name: 'workspace' }]);
});

test('filesystem bucket persists unique bytes and keeps object metadata per key', async t => {
  const local = await fixture(t);
  const { BUCKET } = local.storage;
  const first = 'previews/one.jpg';
  const second = 'previews/two.jpg';
  const digest = sha256('abcdef');
  assert.equal(await BUCKET.head(first), null);
  assert.equal(await BUCKET.get(first), null);
  await BUCKET.put(first, requestBody('abcdef'), {
    sha256: digest,
    customMetadata: { sha256: digest, source: 'first' },
    httpMetadata: { contentType: 'image/jpeg' },
  });
  await BUCKET.put(second, requestBody('abcdef'), { customMetadata: { source: 'second' } });

  const reopened = await local.reopen();
  const head = await reopened.BUCKET.head(first);
  assert.equal(head.size, 6);
  assert.equal(head.httpEtag, '"' + digest + '"');
  assert.deepEqual(head.customMetadata, { sha256: digest, source: 'first' });
  assert.equal(head.httpMetadata.contentType, 'image/jpeg');
  assert.equal((await reopened.BUCKET.head(second)).customMetadata.source, 'second');
  const part = await reopened.BUCKET.get(first, { range: { offset: 1, length: 3 } });
  assert.equal(await new Response(part.body).text(), 'bcd');
  const files = await readdir(join(local.mediaDirectory, 'blobs'));
  assert.deepEqual(files, [digest]);
  const { mode } = await stat(join(local.mediaDirectory, 'blobs', digest));
  assert.equal(mode & 0o777, 0o600);
});

test('filesystem bucket verifies checksums and atomically creates a conditional object once', async t => {
  const { storage: { BUCKET } } = await fixture(t);
  const key = 'previews/concurrent.jpg';
  await assert.rejects(BUCKET.put(key, requestBody('different'), { sha256: sha256('expected') }), /checksum/i);
  assert.equal(await BUCKET.head(key), null);

  const onlyIf = { etagDoesNotMatch: '*' };
  const attempts = await Promise.all([
    BUCKET.put(key, requestBody('one'), { onlyIf }),
    BUCKET.put(key, requestBody('two'), { onlyIf }),
  ]);
  assert.equal(attempts.filter(Boolean).length, 1);
  const stored = await BUCKET.get(key);
  const body = await new Response(stored.body).text();
  assert.ok(body === 'one' || body === 'two');
  assert.equal(stored.customMetadata.sha256, sha256(body));
  assert.equal(stored.httpEtag, attempts.find(Boolean).httpEtag);
});

test('workspace on VPS storage serves media ranges through its HTTP endpoint', async t => {
  const { storage: { DB, BUCKET } } = await fixture(t);
  const workspace = createWorkspace({ assets: {} });
  const key = 'renders/example/topic/clip.mp4';
  const body = 'abcdef';
  const digest = sha256(body);
  const send = (path, options) => workspace.fetch(new Request('https://workspace.example.test' + path, options), {
    DB, BUCKET, WORKSPACE_IMPORT_KEY: 'test-import',
  });
  const upload = await send('/__import/file/' + encodeURIComponent(key), {
    method: 'PUT',
    body,
    headers: { 'x-workspace-import': 'test-import', 'x-file-sha256': digest, 'content-length': '6' },
  });
  assert.equal(upload.status, 200);
  assert.equal((await upload.json()).sha256, digest);

  const response = await send('/api/workspace/media/output/' + encodeURIComponent(key), {
    headers: { 'oai-authenticated-user-id': 'owner', range: 'bytes=2-4' },
  });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 2-4/6');
  assert.equal(await response.text(), 'cde');
});

test('VPS SQLite keeps queued shared-body targets as an array after a video revision', async t => {
  const { storage } = await fixture(t);
  const workspace = createWorkspace({ assets: {} });
  const env = { ...storage, WORKSPACE_IMPORT_KEY: 'test-import', WORKSPACE_REVISION_KEY: 'test-revisions' };
  const owner = { 'oai-authenticated-user-id': 'owner' };
  const importer = { 'x-workspace-import': env.WORKSPACE_IMPORT_KEY };
  const editor = { 'x-workspace-revision': env.WORKSPACE_REVISION_KEY };
  const call = (path, options) => workspace.fetch(new Request('https://workspace.example.test' + path, options), env);
  async function put(path, headers, body) {
    const result = await call(path, { method: 'PUT', headers, body: JSON.stringify(body) });
    const data = await result.json();
    assert.equal(result.status, 200, JSON.stringify(data));
    return data;
  }
  const media = (content, filename) => ({
    id: sha256(content).slice(0, 24) + '/topic/' + filename,
    content,
  });
  const opening = media('opening', 'opening.mp4');
  const sibling = media('sibling', 'sibling.mp4');
  const updated = media('new opening', 'opening.mp4');
  const objectKey = (version, cover) => cover ? 'covers/' + version.id.replace(/\.mp4$/, '.jpg') : 'renders/' + version.id;
  const output = version => ({ url: '/api/workspace/media/output/' + encodeURIComponent(objectKey(version, false)) });
  async function upload(path, version, headers) {
    for (const cover of [false, true]) {
      const body = cover ? 'poster ' + version.content : version.content;
      const res = await call(path + encodeURIComponent(objectKey(version, cover)), {
        method: 'PUT', body, headers: { ...headers, 'content-length': String(Buffer.byteLength(body)), 'x-file-sha256': sha256(body) },
      });
      assert.equal(res.status, 200, await res.text());
    }
  }
  await upload('/__import/file/', opening, importer);
  await upload('/__import/file/', sibling, importer);
  const scenario = { kind: 'studio', id: 'topic', title: 'Topic', clips: [], hookOutputs: [output(opening), output(sibling)] };
  await put('/__import/snapshot', importer, {
    workspace: { references: [], ideas: [], backlog: [], scenarios: [scenario], plans: [], jobs: [], posts: [] },
    references: { records: [] }, config: {}, styles: {},
  });
  const requestRevision = body => put('/api/workspace/revisions', owner, { scenarioKey: 'studio:topic', ...body });
  const { revision: openingRequest } = await requestRevision({ reviewId: opening.id, comment: 'Shorten the opening.' });
  const { revision: bodyRequest } = await requestRevision({ comment: 'Change the shared body.' });
  const openingPath = '/__import/revisions/' + openingRequest.id;
  const { claimToken } = await put(openingPath, editor, { action: 'claim' });
  await upload(openingPath + '/file/', updated, { ...editor, 'x-revision-claim': claimToken });
  await put(openingPath, editor, { action: 'ready', claimToken, replacements: [
    { reviewId: opening.id, resultReviewId: updated.id, duration: 28 },
  ] });

  const expectedTargets = [updated.id, sibling.id];
  const row = await storage.DB.prepare("SELECT json_type(document, '$.targetReviewIds') AS type FROM workspace_edits WHERE id = ?")
    .bind(bodyRequest.id).first();
  assert.equal(row.type, 'array');
  const response = await call('/api/workspace', { headers: owner });
  assert.equal(response.status, 200);
  const { revisions } = await response.json();
  assert.deepEqual(revisions.find(item => item.id === bodyRequest.id).targetReviewIds, expectedTargets);
  const { revision: claimed, claimToken: bodyToken } = await put('/__import/revisions/' + bodyRequest.id, editor, { action: 'claim' });
  assert.equal(claimed.status, 'in-progress');
  assert.deepEqual(claimed.targetReviewIds, expectedTargets);
  assert.ok(bodyToken);
});
