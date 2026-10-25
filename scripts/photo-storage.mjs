import { readFile } from 'node:fs/promises';
import { planPhotos, migratePhotos, restoreBackup, verifiedBackup } from '../lib/photo-migration.mjs';

const [command, data, backup, planFile, confirmation] = process.argv.slice(2);
try {
  if (command === 'plan' && data) console.log(JSON.stringify(await planPhotos(data), null, 2));
  else if(command==='backup'&&data&&backup&&planFile==='--offline-confirmed'){
    console.log(JSON.stringify(await verifiedBackup(data,backup),null,2));
  }
  else if (command === 'apply' && data && backup && planFile && confirmation === '--offline-confirmed') {
    const plan = JSON.parse(await readFile(planFile, 'utf8'));
    console.log(JSON.stringify(await migratePhotos(data, backup, plan, { offline: true }), null, 2));
  } else if (command === 'restore' && data && backup) {
    console.log(JSON.stringify(await restoreBackup(data, backup), null, 2));
  } else throw new Error('Usage: backup DATA_DIR NEW_BACKUP_DIR --offline-confirmed | plan DATA_DIR | apply DATA_DIR NEW_BACKUP_DIR REVIEWED_PLAN.json --offline-confirmed | restore BACKUP_DIR NEW_RESTORE_DIR');
} catch (err) { console.error(err.message); process.exitCode = 1; }
