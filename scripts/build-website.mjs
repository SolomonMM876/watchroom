import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'public');
const destination = path.join(root, 'website');
const transportMeta = '<meta name="watchroom-transport" content="peerjs">';

// Keep this exporter limited to public assets. A symlink could accidentally
// include files outside the website, and GitHub Pages artifacts reject links.
async function checkSource(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Website assets must not be symlinks: ${path.relative(root, entryPath)}`);
    if (entry.isDirectory()) await checkSource(entryPath);
  }
}

await checkSource(source);
try {
  const existing = await lstat(destination);
  if (existing.isSymbolicLink() || !existing.isDirectory()) throw new Error('The generated website path must be a directory, not a file or symlink.');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const staging = await mkdtemp(path.join(root, '.website-build-'));
try {
  await cp(source, staging, {
    recursive: true,
    filter: (entryPath) => path.basename(entryPath) !== '.DS_Store',
  });
  const indexPath = path.join(staging, 'index.html');
  const original = await readFile(indexPath, 'utf8');
  if (!/<head\b[^>]*>/i.test(original)) throw new Error('The public index.html is missing its head element.');
  const withoutTransportMeta = original.replace(/<meta\b[^>]*\bname=["']watchroom-transport["'][^>]*>\s*/gi, '');
  const websiteIndex = withoutTransportMeta.replace(/<head\b[^>]*>/i, (head) => `${head}\n  ${transportMeta}`);
  await writeFile(indexPath, websiteIndex);
  await writeFile(path.join(staging, '.nojekyll'), '');
  await cp(path.join(root, 'WEBSITE.html'), path.join(staging, 'WEBSITE.html'));

  // Rebuild only this generated directory; the extension and downloaded
  // archives are separate artifacts and are never touched by this script.
  await rm(destination, { recursive: true, force: true });
  await mkdir(path.dirname(destination), { recursive: true });
  await rename(staging, destination);
  console.log(`Static website ready at ${destination}`);
  console.log('Deploy the complete website directory through GitHub Pages or another HTTPS static host.');
} finally {
  await rm(staging, { recursive: true, force: true });
}
