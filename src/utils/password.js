import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const PASSWORD_KEY_LENGTH = 64;

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, PASSWORD_KEY_LENGTH).toString('hex');
  return { hash, salt };
}

export function verifyPassword(password, passwordHash, passwordSalt) {
  if (!passwordHash || !passwordSalt) {
    return false;
  }

  const expectedBuffer = Buffer.from(passwordHash, 'hex');
  const actualBuffer = scryptSync(password, passwordSalt, expectedBuffer.length || PASSWORD_KEY_LENGTH);

  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, actualBuffer);
}
