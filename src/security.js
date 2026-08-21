'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function validateUsername(value) {
  const username = normalizeUsername(value);
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) {
    return { error: 'O usuário deve ter de 3 a 40 caracteres: letras, números, ponto, hífen ou sublinhado.' };
  }
  return { value: username };
}

function validatePassword(value, username) {
  const password = typeof value === 'string' ? value : '';
  if (password.length < 12) return { error: 'A senha deve ter pelo menos 12 caracteres.' };
  if (password.length > 128) return { error: 'A senha deve ter no máximo 128 caracteres.' };
  if (username && password.toLowerCase().includes(normalizeUsername(username))) {
    return { error: 'A senha não deve conter o nome de usuário.' };
  }
  return { value: password };
}

async function derive(password, salt, options) {
  return scrypt(password, salt, KEY_LENGTH, {
    N: options.N,
    r: options.r,
    p: options.p,
    maxmem: SCRYPT_MAXMEM
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const result = await derive(password, salt, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt, result.toString('base64url')].join('$');
}

async function verifyPassword(password, encoded) {
  try {
    const [algorithm, n, r, p, salt, expected] = String(encoded || '').split('$');
    if (algorithm !== 'scrypt' || !salt || !expected) return false;
    const result = await derive(String(password || ''), salt, {
      N: Number(n), r: Number(r), p: Number(p)
    });
    const expectedBuffer = Buffer.from(expected, 'base64url');
    return result.length === expectedBuffer.length && crypto.timingSafeEqual(result, expectedBuffer);
  } catch (_) {
    return false;
  }
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function parseCookies(header) {
  const cookies = {};
  String(header || '').split(';').forEach(part => {
    const separator = part.indexOf('=');
    if (separator < 1) return;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try { cookies[key] = decodeURIComponent(value); } catch (_) { cookies[key] = value; }
  });
  return cookies;
}

function safeEqualText(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isLoopback(req) {
  return isLoopbackAddress((req.socket && req.socket.remoteAddress) || req.ip);
}

function normalizedAddress(value) {
  const address = String(value || '').toLowerCase().split('%')[0];
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}

function isLoopbackAddress(value) {
  const address = normalizedAddress(value);
  return address === '127.0.0.1' || address === '::1';
}

function isPrivateAddress(value) {
  const address = normalizedAddress(value);
  if (isLoopbackAddress(address)) return true;
  if (address.startsWith('10.') || address.startsWith('192.168.')) return true;
  const match = /^172\.(\d{1,3})\./.exec(address);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
  // Unique local e link-local IPv6; úteis em redes corporativas sem IPv4.
  return address.startsWith('fc') || address.startsWith('fd') || address.startsWith('fe80:');
}

function isPrivateNetwork(req) {
  return isPrivateAddress((req.socket && req.socket.remoteAddress) || req.ip);
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    active: user.active !== false,
    created_at: user.created_at,
    updated_at: user.updated_at || null,
    last_login_at: user.last_login_at || null,
    password_changed_at: user.password_changed_at || null
  };
}

module.exports = {
  hashPassword,
  isLoopback,
  isLoopbackAddress,
  isPrivateAddress,
  isPrivateNetwork,
  normalizeUsername,
  parseCookies,
  publicUser,
  randomToken,
  safeEqualText,
  tokenHash,
  validatePassword,
  validateUsername,
  verifyPassword
};
