import jwt from 'jsonwebtoken';

import { config } from '../config.js';

export function createAccessToken(user) {
  return jwt.sign(
    {
      role: user.role,
      provider: user.authProvider,
      username: user.username,
    },
    config.jwtSecret,
    {
      expiresIn: config.jwtExpiresIn,
      subject: String(user.id),
    },
  );
}

export function verifyAccessToken(token) {
  return jwt.verify(token, config.jwtSecret);
}
