// Offline copy-only migration. No legacy file is deleted or overwritten.
import { cp, mkdir, readdir, readFile, writeFile, lstat, access, mkdtemp, rm, realpath } from 'node:fs/promises';
import { join, resolve, relative, sep, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { resourceId } from './security.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const exists = path => access(path).then(() => true, () => false);
const inside = (parent, child) => child === parent || child.startsWith(parent + sep);
async function canonicalTarget(path) {
  let parent = resolve(path); const missing = [];
  while (!await exists(parent)) { missing.unshift(basename(parent)); parent = dirname(parent); }
  return join(await realpath(parent), ...missing);
}
export async function inventory(root) {
  const files = Object.create(null);
  async function visit(dir) {
    for (const entry of (await readdir(dir)).sort()) {
      const path = join(dir, entry), stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error('Symlinks are not allowed in a migration snapshot');
      if (stat.isDirectory()) await visit(path);
      else if (stat.isFile()) files[relative(root, path).split(sep).join('/')] = hash(await readFile(path));
      else throw new Error('Unsupported filesystem entry');
    }
  }
  if (await exists(root)) {
    if ((await lstat(root)).isSymbolicLink()) throw new Error('Symlinks are not allowed in a migration snapshot');
    await visit(root);
  }
  return { ...files };
}
const equal = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

export async function planPhotos(dataDir) {
  const storeBytes = await readFile(join(dataDir, 'store.json'));
  const store = JSON.parse(storeBytes), assignments = [], unresolved = [];
  for (const id of (await readdir(join(dataDir, 'photos')).catch(() => [])).sort()) {
    const owners = store.brands.filter(b => (store.data[b.id]?.properties || []).some(p => String(p.id) === id)).map(b => b.id);
    if (resourceId(id) && owners.length === 1 && resourceId(owners[0])) assignments.push({ propertyId: id, brandId: owners[0] });
    else unresolved.push({ propertyId: id, possibleOwners: owners });
  }
  return { version: 1, ownershipVerified: false, storeHash: hash(storeBytes), legacyFiles: await inventory(join(dataDir, 'photos')), assignments, unresolved };
}

export async function verifiedBackup(dataDir, backupDir) {
  dataDir = await realpath(dataDir); backupDir = await canonicalTarget(backupDir);
  if (inside(dataDir, backupDir) || inside(backupDir, dataDir)) throw new Error('Backup and data directories must be separate');
  if (await exists(backupDir)) throw new Error('Backup destination must not exist');
  const files = await inventory(dataDir);
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  await cp(dataDir, join(backupDir, 'snapshot'), { recursive: true, force: false, errorOnExist: true });
  if (!equal(files, await inventory(dataDir)) || !equal(files, await inventory(join(backupDir, 'snapshot')))) throw new Error('Source changed or backup checksum mismatch; stop');
  await writeFile(join(backupDir, 'manifest.json'), JSON.stringify({ version: 1, files }, null, 2), { mode: 0o600 });
  const recoveryRoot = await mkdtemp(join(tmpdir(), 'ruano-recovery-'));
  try { await restoreBackup(backupDir, join(recoveryRoot, 'restored')); }
  finally { await rm(recoveryRoot, { recursive: true, force: true }); }
  return { verified: true, fileCount: Object.keys(files).length };
}

export async function restoreBackup(backupDir, target) {
  backupDir = await realpath(backupDir); target = await canonicalTarget(target);
  if (inside(backupDir, target) || inside(target, backupDir)) throw new Error('Restore and backup directories must be separate');
  if (await exists(target)) throw new Error('Restore destination must not exist; never overwrite live data');
  const { files } = JSON.parse(await readFile(join(backupDir, 'manifest.json'), 'utf8'));
  const snapshot = join(backupDir, 'snapshot');
  if (!equal(files, await inventory(snapshot))) throw new Error('Backup checksum mismatch');
  await mkdir(target, { mode: 0o700 });
  for (const entry of await readdir(snapshot)) {
    await cp(join(snapshot, entry), join(target, entry), { recursive: true, force: false, errorOnExist: true });
  }
  if (!equal(files, await inventory(target))) throw new Error('Restore checksum mismatch');
  return { verified: true, fileCount: Object.keys(files).length };
}

export async function migratePhotos(dataDir, backupDir, plan, { offline = false } = {}) {
  if (!offline) throw new Error('Stop the application and explicitly confirm offline operation');
  if (plan.ownershipVerified !== true) throw new Error('Ownership must be independently verified and the plan explicitly reviewed');
  const current = await planPhotos(dataDir);
  if (plan.version !== 1 || plan.storeHash !== current.storeHash || !equal(plan.legacyFiles, current.legacyFiles)) throw new Error('Plan is stale; review a new plan');
  const store = JSON.parse(await readFile(join(dataDir, 'store.json'), 'utf8')), seen = new Set();
  for (const { brandId, propertyId } of plan.assignments) {
    if (!resourceId(brandId) || !resourceId(propertyId) || seen.has(propertyId)) throw new Error('Invalid or duplicated ownership assignment');
    if (!current.assignments.some(a => a.brandId === brandId && a.propertyId === propertyId)) throw new Error('Ambiguous or unowned legacy directories require manual recovery');
    seen.add(propertyId);
    if (!store.brands.some(b => b.id === brandId) || !(store.data[brandId]?.properties || []).some(p => String(p.id) === propertyId)) throw new Error('Assignment does not refer to a current property');
    if (!(await lstat(join(dataDir, 'photos', propertyId))).isDirectory()) throw new Error('Legacy source is not a directory');
    if (await exists(join(dataDir, 'photos-v2', brandId, propertyId))) throw new Error('Destination exists; never overwrite scoped photographs');
  }
  // Backup AND a checksum-verified restore complete before the first scoped copy.
  const backup = await verifiedBackup(dataDir, backupDir);
  if (!equal(current.legacyFiles, await inventory(join(dataDir, 'photos'))) || current.storeHash !== hash(await readFile(join(dataDir, 'store.json')))) throw new Error('Source changed after backup');
  const copied = [];
  for (const { brandId, propertyId } of plan.assignments) {
    const src = join(dataDir, 'photos', propertyId), dst = join(dataDir, 'photos-v2', brandId, propertyId);
    await mkdir(join(dataDir, 'photos-v2', brandId), { recursive: true });
    await cp(src, dst, { recursive: true, force: false, errorOnExist: true });
    if (!equal(await inventory(src), await inventory(dst))) throw new Error('Scoped copy checksum mismatch; use verified backup to recover');
    copied.push({ brandId, propertyId });
  }
  return { backup, copied, legacyPreserved: true, unresolved: plan.unresolved };
}
