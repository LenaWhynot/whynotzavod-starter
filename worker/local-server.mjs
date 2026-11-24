import {createServer} from 'node:http';
import {join, resolve} from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import workspace from '../dist/server/index.js';
import {openVpsStorage} from './vps-storage.mjs';

const port = Number(process.env.CONTENT_FACTORY_PORT ?? '4329');
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('CONTENT_FACTORY_PORT must be between 1 and 65535.');
}

const host = '127.0.0.1';
const authority = host + ':' + port;
const origin = 'http://' + authority;
const directory = resolve(process.env.CONTENT_FACTORY_DATA || 'data');
const storage = await openVpsStorage({
  databasePath: join(directory, 'workspace.sqlite'),
  mediaDirectory: join(directory, 'media'),
});

const server = createServer(async (incoming, outgoing) => {
  try {
    const target = new URL(incoming.url, origin);
    if (incoming.headers.host !== authority || target.origin !== origin ||
        (incoming.headers.origin && incoming.headers.origin !== origin) ||
        incoming.headers['sec-fetch-site'] === 'cross-site') {
      outgoing.writeHead(403, {'cache-control': 'no-store'}).end();
      return;
    }
    const headers = new Headers(Object.entries(incoming.headers));
    headers.set('oai-authenticated-user-id', 'local-owner');
    const options = {method: incoming.method, headers};
    if (incoming.method !== 'GET' && incoming.method !== 'HEAD') {
      options.body = Readable.toWeb(incoming);
      options.duplex = 'half';
    }
    const result = await workspace.fetch(new Request(target, options), storage);
    outgoing.writeHead(result.status, Object.fromEntries(result.headers));
    if (result.body) await pipeline(Readable.fromWeb(result.body), outgoing);
    else outgoing.end();
  } catch (error) {
    console.error('Workspace request failed:', error.name);
    if (outgoing.headersSent) outgoing.destroy();
    else outgoing.writeHead(500).end();
  }
});

server.listen(port, host, () => console.log('Контент-завод открыт: ' + origin));
function stop() {
  server.close(() => storage.close());
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
