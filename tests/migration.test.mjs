import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, photo } from './helpers.mjs';
import { inventory, planPhotos, migratePhotos, restoreBackup, verifiedBackup } from '../lib/photo-migration.mjs';

async function legacy(f) {
  await mkdir(join(f.dir, 'photos', '101'), { recursive: true });
  await writeFile(join(f.dir, 'photos', '101', 'ffffffffffffffffffffffff.jpg'), photo);
  await writeFile(join(f.dir, 'photos', '101', 'index.json'), JSON.stringify({ photos: [{ id: 'ffffffffffffffffffffffff' }] }));
}
test('migration copies only reviewed assignments after a verified backup and recovery', async () => {
  const f = await fixture({ start: false }), backup = f.dir + '-backup', restored = f.dir + '-restored';
  try {
    await legacy(f); const before = await inventory(f.dir); const plan = { ...await planPhotos(f.dir), ownershipVerified: true };
    assert.deepEqual(plan.assignments, [{ propertyId: '101', brandId: 'a' }]);
    await assert.rejects(migratePhotos(f.dir, backup, {...plan, ownershipVerified:false}, {offline:true}),/Ownership/);
    const result = await migratePhotos(f.dir, backup, plan, { offline: true });
    assert.equal(result.backup.verified, true); assert.equal(result.legacyPreserved, true);
    assert.deepEqual(await inventory(join(f.dir, 'photos', '101')), await inventory(join(f.dir, 'photos-v2', 'a', '101')));
    await restoreBackup(backup, restored); assert.deepEqual(await inventory(restored), before);
    await assert.rejects(restoreBackup(backup, join(backup, 'restore')), /separate/);
    await f.launch();
    const a=await f.login(),b=await f.login('testb');
    assert.equal((await f.request('/api/photos/101/ffffffffffffffffffffffff?brand=a',a)).status,200);
    assert.equal((await f.request('/api/photos/101/ffffffffffffffffffffffff?brand=a',b)).status,403);
    await f.stop();
    await assert.rejects(restoreBackup(backup, f.dir), /must not exist/);
    await assert.rejects(migratePhotos(f.dir, backup + '-other', plan, { offline: true }), /Destination exists/);
    await writeFile(join(backup, 'snapshot', 'photos', '101', 'ffffffffffffffffffffffff.jpg'), 'tampered');
    await assert.rejects(restoreBackup(backup, restored + '-bad'), /checksum/);
  } finally { await f.close(); await rm(backup, { recursive: true, force: true }); await rm(restored, { recursive: true, force: true }); }
});
test('migration requires offline confirmation and rejects stale plans before touching photos', async () => {
  const f = await fixture({ start: false });
  try {
    await legacy(f); const plan = { ...await planPhotos(f.dir), ownershipVerified: true }, before = await inventory(join(f.dir, 'photos'));
    await assert.rejects(migratePhotos(f.dir, f.dir + '-backup', plan), /offline/);
    await writeFile(join(f.dir, 'photos', '101', 'new.jpg'), photo);
    await assert.rejects(migratePhotos(f.dir, f.dir + '-backup', plan, { offline: true }), /stale/);
    assert.deepEqual((await inventory(join(f.dir, 'photos')))['101/ffffffffffffffffffffffff.jpg'], before['101/ffffffffffffffffffffffff.jpg']);
  } finally { await f.close(); }
});
test('legacy collisions and orphans are unresolved, never guessed or copied', async () => {
  const f = await fixture({ start: false }), backup = f.dir + '-backup';
  try {
    await legacy(f); const store = JSON.parse(await readFile(join(f.dir, 'store.json')));
    store.data.b.properties.push({ id: 101 }); await writeFile(join(f.dir, 'store.json'), JSON.stringify(store));
    await mkdir(join(f.dir, 'photos', '999')); await writeFile(join(f.dir, 'photos', '999', 'ffffffffffffffffffffffff.jpg'), photo);
    const before = await inventory(join(f.dir, 'photos')), plan = { ...await planPhotos(f.dir), ownershipVerified: true };
    assert.equal(plan.assignments.length, 0); assert.equal(plan.unresolved.length, 2);
    await assert.rejects(migratePhotos(f.dir, backup, {...plan,assignments:[{brandId:'a',propertyId:'101'}]}, {offline:true}),/Ambiguous/);
    const result = await migratePhotos(f.dir, backup, plan, { offline: true });
    assert.equal(result.copied.length, 0); assert.deepEqual(await inventory(join(f.dir, 'photos')), before);
    assert.deepEqual(await inventory(join(f.dir, 'photos-v2')), {});
  } finally { await f.close(); await rm(backup, { recursive: true, force: true }); }
});
test('migration refuses symlinks instead of following external files', async () => {
  const f = await fixture({ start: false });
  const alias = f.dir + '-alias';
  try {
    await legacy(f);
    await assert.rejects(verifiedBackup(f.dir, join(f.dir, 'backup')), /separate/);
    await symlink(f.dir, alias);
    await assert.rejects(verifiedBackup(f.dir, join(alias, 'backup')), /separate/);
    await symlink(join(f.dir, 'store.json'), join(f.dir, 'photos', '101', 'link'));
    await assert.rejects(planPhotos(f.dir), /Symlinks/);
  } finally { await rm(alias, { force: true }); await f.close(); }
});
