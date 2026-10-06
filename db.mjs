import pg from 'pg';
import { readFile } from 'node:fs/promises';

export function database(connectionString) {
  return new pg.Pool({ connectionString, max: 5, connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000, statement_timeout: 10000 });
}

export async function migrate(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(74123901)');
    await client.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

// Membership is always checked with the authenticated user, never a client user ID.
export async function withOrganization(pool, userId, organizationId, action) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT role FROM rss_memberships WHERE user_id=$1 AND organization_id=$2',
      [userId, organizationId]);
    if (!rows.length) {
      const error = new Error('Empresa no disponible'); error.status = 404; throw error;
    }
    const result = await action(client, rows[0].role);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK'); throw error;
  } finally { client.release(); }
}
