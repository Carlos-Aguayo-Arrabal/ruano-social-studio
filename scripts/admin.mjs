import { randomUUID } from 'node:crypto';
import { database, migrate } from '../db.mjs';
import { hashPassword } from '../security.mjs';
if (!process.env.DATABASE_URL) throw new Error('Falta DATABASE_URL');
const pool = database(process.env.DATABASE_URL);
try {
  const [command,email,name,role='owner'] = process.argv.slice(2);
  if (command === 'migrate') { await migrate(pool); console.log('Esquema preparado'); }
  else if (command === 'provision' || command === 'assign') {
    if (!email || !name || !['owner','editor','viewer'].includes(role) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new Error('Uso: provision email nombre-empresa [owner|editor|viewer]');
    // Read from stdin, never arguments or printed output. Existing users keep their password.
    const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
    const password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/,'');
    const hash = await hashPassword(password);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const user = await client.query(`INSERT INTO rss_users(id,email,password_hash) VALUES($1,$2,$3)
        ON CONFLICT(email) DO UPDATE SET email=EXCLUDED.email RETURNING id`,[randomUUID(),email.trim().toLowerCase(),hash]);
      const orgId = command === 'assign' ? name : randomUUID();
      if (command === 'provision') {
        await client.query('INSERT INTO rss_organizations(id,name) VALUES($1,$2)',[orgId,name]);
        await client.query('INSERT INTO rss_states(organization_id) VALUES($1)',[orgId]);
      }
      await client.query(`INSERT INTO rss_memberships(user_id,organization_id,role) VALUES($1,$2,$3)
        ON CONFLICT(user_id,organization_id) DO UPDATE SET role=EXCLUDED.role`,[user.rows[0].id,orgId,role]);
      await client.query('COMMIT'); console.log('Usuario y empresa preparados:',orgId);
    } catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  } else throw new Error('Usar migrate, provision o assign');
} finally { await pool.end(); }
