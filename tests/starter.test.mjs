import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createWorkspace} from '../worker/workspace.mjs';
import {openVpsStorage} from '../worker/vps-storage.mjs';

test('a new workspace supports an independent scenario, video review, and calendar plan', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'content-starter-test-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const options = {databasePath: join(dir, 'workspace.sqlite'), mediaDirectory: join(dir, 'media')};
  const worker = createWorkspace({assets: {}});
  let storage = await openVpsStorage(options);
  try {
    const call = (path, method = 'GET', body, headers = {}) => worker.fetch(
      new Request('http://127.0.0.1:4329' + path, {
        method, body,
        headers: {'oai-authenticated-user-id': 'local-owner', ...headers},
      }), storage);
    const json = (path, method, input) => call(path, method, JSON.stringify(input));
    assert.deepEqual((await (await call('/api/workspace')).json()).scenarios, []);

    const created = await json('/api/workspace/scenario', 'POST', {
      title: 'Тестовый сценарий', body: 'Один бытовой пример.', hooks: ['Первый кадр'],
    });
    assert.equal(created.status, 201);
    const {scenario} = await created.json();
    assert.equal(scenario.hooks[0].text, 'Первый кадр');
    const key = 'studio:' + scenario.id;
    const route = '/api/workspace/scenario/' + encodeURIComponent(scenario.id);
    assert.equal((await json(route, 'PUT', {title: ''})).status, 400);

    const bytes = Buffer.from('00000018667479706d703432000000006d703432', 'hex');
    const upload = () => call(route + '/video', 'PUT', bytes, {
      'content-length': String(bytes.length), 'content-type': 'video/mp4', 'x-hook-id': 'h1',
      'x-file-sha256': createHash('sha256').update(bytes).digest('hex'),
    });
    const saved = await upload();
    assert.equal(saved.status, 201);
    const {output} = await saved.json();
    assert.equal(output.hookText, 'Первый кадр');
    assert.equal((await upload()).status, 201);
    const response = await call(output.url, 'GET', undefined, {range: 'bytes=0-7'});
    assert.equal(response.status, 206);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(0, 8));

    const {scenarios: unreviewed} = await (await call('/api/workspace')).json();
    assert.equal(unreviewed[0].hookOutputs.length, 1);
    const reviewId = unreviewed[0].hookOutputs[0].reviewId;
    assert.equal((await json('/api/workspace/media-review', 'PUT', {reviewId, status: 'approved'})).status, 200);
    assert.equal((await json(route, 'PUT', {title: 'Сценарий с уточнением', body: 'Уточнённый пример.', hooks: ['Первый кадр']})).status, 200);
    assert.equal((await json('/api/workspace/plan/' + encodeURIComponent(key), 'PUT', {day: '2030-01-03'})).status, 200);

    storage.close();
    storage = await openVpsStorage(options);
    const {scenarios, plans} = await (await call('/api/workspace')).json();
    assert.equal(scenarios[0].title, 'Сценарий с уточнением');
    assert.equal(scenarios[0].hookOutputs[0].reviewStatus, 'approved');
    assert.equal(plans[0].day, '2030-01-03');
  } finally {
    storage.close();
  }
});
