import { mkdir, readFile, writeFile } from 'node:fs/promises';
const at = (path) => new URL(path, import.meta.url);
const read = path => readFile(at(path), 'utf8');
const paths = {
  '/': ['v4.html', 'text/html; charset=utf-8'],
  '/v4.js': ['v4.js', 'text/javascript; charset=utf-8'],
  '/v4.css': ['v4.css', 'text/css; charset=utf-8'],
};
const assets = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([url, [file, mime]]) => [
  url, [mime, await read(`../public/${file}`)],
])));
await mkdir(at('../dist/server'), {recursive:true});
const workspace = await read('../worker/workspace.mjs');
await writeFile(at('../dist/server/index.js'), [
  await read('../worker/workspace-links.mjs'),
  // Embed the shared graph logic in the same single-module Worker artifact.
  workspace.replace(/^import [^\n]+ from '\.\/workspace-links\.mjs';\n/m, ''),
  `const assets = ${JSON.stringify(assets)};`,
  'export default createWorkspace({assets});',
].join('\n'));
