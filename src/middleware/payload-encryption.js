import crypto from 'node:crypto';
import { config } from '../config.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

// /api/* ostidagi JSON javob va so'rov tanalarini AES-256-GCM bilan qadoqlaydi.
// Network sekmesida ko'rinadigan xom bayt oqimi endi shifrlangan bo'ladi:
// {"__enc":1,"iv":"...","data":"...","tag":"..."}
// Bu qatlam yo'lda (TLS ustiga) qo'shimcha berkitish qatlami hisoblanadi;
// asosiy himoya baribir TLS orqali ta'minlanadi.

function getKey() {
  const key = Buffer.from(config.payloadEncryptionKey, 'hex');
  if (key.length !== 32) {
    throw new Error('PAYLOAD_ENCRYPTION_KEY 64 ta hex belgidan (32 bayt) iborat bo\'lishi kerak');
  }
  return key;
}

function encryptJson(payload) {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload ?? null), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    __enc: 1,
    iv: iv.toString('base64'),
    data: encrypted.toString('base64'),
    tag: tag.toString('base64'),
  };
}

function decryptEnvelope(envelope) {
  const key = getKey();
  const iv = Buffer.from(envelope.iv, 'base64');
  const data = Buffer.from(envelope.data, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

function isEncryptedEnvelope(body) {
  return (
    body &&
    typeof body === 'object' &&
    body.__enc === 1 &&
    typeof body.iv === 'string' &&
    typeof body.data === 'string' &&
    typeof body.tag === 'string'
  );
}

// Ochiq (skanerlanmagan) qoldiriladigan yo'llar: SSE oqimi, health-check.
// req.originalUrl ishlatiladi — bu middleware /api ostiga mount qilinganidan
// keyin req.path prefiksisiz (masalan "/health") kelib, taqqoslashni buzadi.
function isExcludedPath(originalUrl) {
  const path = originalUrl.split('?')[0];
  return path === '/api/health' || path.startsWith('/api/events');
}

export function payloadEncryption(req, res, next) {
  if (!config.payloadEncryptionEnabled || isExcludedPath(req.originalUrl)) {
    return next();
  }

  const originalJson = res.json.bind(res);
  res.json = (body) => originalJson(encryptJson(body));

  if (isEncryptedEnvelope(req.body)) {
    try {
      req.body = decryptEnvelope(req.body);
    } catch (error) {
      return res.status(400).json({ ok: false, message: "Payload deshifrlashda xatolik" });
    }
  }

  next();
}
