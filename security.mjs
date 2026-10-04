import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);
export const tokenHash = token => createHash('sha256').update(token).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256)
    throw new Error('La contraseña debe tener entre 12 y 256 caracteres');
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64);
  return `scrypt:${salt}:${key.toString('hex')}`;
}
export async function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || password.length > 256) return false;
  const [algorithm, salt, hex] = encoded.split(':');
  if (algorithm !== 'scrypt' || !/^[a-f0-9]{128}$/.test(hex || '')) return false;
  const key = await scrypt(password, salt, 64);
  return timingSafeEqual(key, Buffer.from(hex, 'hex'));
}
export function sessionToken(req) {
  const match = /(?:^|;\s*)rss_session=([A-Za-z0-9_-]{43})(?:;|$)/.exec(req.headers.cookie || '');
  return match?.[1];
}
export function requireSameOrigin(req, origin) {
  if (req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site') {
    const error = new Error('Origen no permitido'); error.status = 403; throw error;
  }
}
export class LoginLimiter {
  constructor(maxAttempts = 10) { this.entries = new Map(); this.maxAttempts = maxAttempts; }
  allow(key, now = Date.now()) {
    for (const [id, value] of this.entries) if (value.until <= now) this.entries.delete(id);
    const entry = this.entries.get(key) || { attempts: 0, until: now + 15 * 60000 };
    if (!this.entries.has(key) && this.entries.size >= 10000) return false;
    entry.attempts++; this.entries.set(key, entry);
    return entry.attempts <= this.maxAttempts;
  }
}
