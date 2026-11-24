import { createHash } from 'node:crypto';
import { closeSync, createReadStream, createWriteStream, fsyncSync, linkSync, openSync } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const digestPattern = /^[a-f0-9]{64}$/;

function transaction(database, execute) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = execute();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function initializeDatabase(database, schema) {
  database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
  transaction(database, () => {
    const tables = database.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name IN ('workspace_snapshots', 'workspace_edits')
    `).all();
    if (tables.length === 0) database.exec(schema);
    else if (tables.length !== 2) throw new Error('Incomplete workspace database schema');
    database.exec(`
      CREATE TABLE IF NOT EXISTS vps_media_objects (
        key TEXT PRIMARY KEY NOT NULL,
        digest TEXT NOT NULL,
        size INTEGER NOT NULL,
        custom_metadata TEXT NOT NULL,
        http_metadata TEXT NOT NULL
      );
    `);
  });
}

function createD1Binding(database) {
  const boundWrites = new WeakMap();
  return {
    prepare(sql) {
      const statement = database.prepare(sql);
      return {
        bind(...parameters) {
          const bound = {
            async first() {
              const row = statement.get(...parameters);
              return row ? { ...row } : null;
            },
            async all() {
              return { results: statement.all(...parameters).map(row => ({ ...row })), success: true };
            },
            async run() {
              return execute();
            },
          };
          function execute() {
            const { changes } = statement.run(...parameters);
            return { meta: { changes }, success: true };
          }
          boundWrites.set(bound, execute);
          return bound;
        },
      };
    },
    async batch(statements) {
      return transaction(database, () => statements.map(statement => boundWrites.get(statement)()));
    },
  };
}

function describeObject(row) {
  return {
    size: row.size,
    etag: row.digest,
    httpEtag: '"' + row.digest + '"',
    customMetadata: JSON.parse(row.custom_metadata),
    httpMetadata: JSON.parse(row.http_metadata),
  };
}

async function writeStagedBlob(destination, body) {
  const hash = createHash('sha256');
  let size = 0;
  const measure = new Transform({
    transform(chunk, encoding, callback) {
      size += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  const source = body instanceof ReadableStream ? Readable.fromWeb(body) : Readable.from([body]);
  await pipeline(source, measure, createWriteStream(destination, { flags: 'wx', mode: 0o600, flush: true }));
  return { digest: hash.digest('hex'), size };
}

function publishBlob(staged, directory, digest) {
  try {
    linkSync(staged, join(directory, digest));
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const directoryDescriptor = openSync(directory, 'r');
  try {
    fsyncSync(directoryDescriptor);
  } finally {
    closeSync(directoryDescriptor);
  }
}

function createBucket(database, mediaDirectory, blobsDirectory) {
  const lookup = database.prepare('SELECT * FROM vps_media_objects WHERE key = ?');
  const upsert = database.prepare(`
    INSERT INTO vps_media_objects (key, digest, size, custom_metadata, http_metadata) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (key) DO UPDATE SET digest = excluded.digest, size = excluded.size,
      custom_metadata = excluded.custom_metadata, http_metadata = excluded.http_metadata
  `);

  return {
    async head(key) {
      const row = lookup.get(key);
      return row ? describeObject(row) : null;
    },
    async get(key, { range } = {}) {
      const row = lookup.get(key);
      if (!row) return null;
      if (!digestPattern.test(row.digest)) throw new Error('Invalid stored media digest');
      let bounds;
      if (range) {
        const { offset, length } = range;
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length)
          || length < 1 || length > row.size - offset) {
          throw new RangeError('Invalid media byte range');
        }
        bounds = { start: offset, end: offset + length - 1 };
      }
      const body = Readable.toWeb(createReadStream(join(blobsDirectory, row.digest), bounds));
      return { ...describeObject(row), body };
    },
    async put(key, body, options = {}) {
      const createOnly = options.onlyIf?.etagDoesNotMatch === '*';
      if (options.onlyIf && (!createOnly || Object.keys(options.onlyIf).length !== 1)) {
        throw new TypeError('Unsupported media write condition');
      }
      if (createOnly && lookup.get(key)) return null;

      const stagingDirectory = await mkdtemp(join(mediaDirectory, '.upload-'));
      try {
        const staged = join(stagingDirectory, 'blob');
        const { digest, size } = await writeStagedBlob(staged, body);
        const suppliedHashes = [options.sha256, options.customMetadata?.sha256];
        if (suppliedHashes.some(value => value !== undefined && value !== digest)) {
          throw Object.assign(new Error('Media checksum does not match the uploaded bytes'), { status: 400 });
        }
        const row = {
          digest,
          size,
          custom_metadata: JSON.stringify({ ...options.customMetadata, sha256: digest }),
          http_metadata: JSON.stringify(options.httpMetadata ?? {}),
        };
        return transaction(database, () => {
          if (createOnly && lookup.get(key)) return null;
          publishBlob(staged, blobsDirectory, digest);
          upsert.run(key, row.digest, row.size, row.custom_metadata, row.http_metadata);
          return describeObject(row);
        });
      } finally {
        await rm(stagingDirectory, { recursive: true, force: true });
      }
    },
  };
}

export async function openVpsStorage({ databasePath, mediaDirectory }) {
  const schema = await readFile(new URL('../drizzle/0000_workspace.sql', import.meta.url), 'utf8');
  const databaseFile = resolve(databasePath);
  const mediaRoot = resolve(mediaDirectory);
  const blobsDirectory = join(mediaRoot, 'blobs');
  await mkdir(dirname(databaseFile), { recursive: true, mode: 0o700 });
  await mkdir(blobsDirectory, { recursive: true, mode: 0o700 });
  const file = await open(databaseFile, 'a', 0o600);
  await file.close();
  const database = new DatabaseSync(databaseFile);
  try {
    initializeDatabase(database, schema);
    return {
      DB: createD1Binding(database),
      BUCKET: createBucket(database, mediaRoot, blobsDirectory),
      close: () => database.close(),
    };
  } catch (error) {
    database.close();
    throw error;
  }
}
