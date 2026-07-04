import { randomBytes } from 'node:crypto';

import { getDb } from '../db.js';
import { config } from '../config.js';
import { LEGACY_PERMISSION_ALIASES, USER_PERMISSIONS, USER_ROLES, USER_STATUSES } from '../constants.js';
import { AppError } from '../middleware/errors.js';
import { hashPassword, verifyPassword } from '../utils/password.js';
import { getDeviceTotals } from './device-service.js';

function normaliseUsername(username) {
  return String(username || '')
    .trim()
    .toLowerCase();
}

function normaliseDisplayName(displayName, fallbackValue) {
  const value = String(displayName || '').trim();
  return value || fallbackValue || null;
}

function assertRole(role) {
  if (!USER_ROLES.includes(role)) {
    throw new AppError(400, `Role noto'g'ri. Ruxsat etilgan qiymatlar: ${USER_ROLES.join(', ')}`);
  }
}

function resolveTelegramRole(telegramId, fallbackRole = 'user') {
  if (config.superAdminTelegramIds.includes(String(telegramId))) {
    return 'super_admin';
  }

  return fallbackRole;
}

function normaliseUserSummary(summary) {
  return {
    totalUsers: summary?.totalUsers ?? 0,
    totalSuperAdmins: summary?.totalSuperAdmins ?? 0,
    totalAdmins: summary?.totalAdmins ?? 0,
    totalRegularUsers: summary?.totalRegularUsers ?? 0,
    telegramOnlyUsers: summary?.telegramOnlyUsers ?? 0,
    localOnlyUsers: summary?.localOnlyUsers ?? 0,
    hybridUsers: summary?.hybridUsers ?? 0,
  };
}

function parsePermissions(value) {
  if (Array.isArray(value)) {
    return value;
  }

  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalisePermissions(permissions, { strict = true } = {}) {
  const normalisedPermissions = new Set();

  for (const permission of Array.isArray(permissions) ? permissions : []) {
    const cleanPermission = String(permission || '').trim();
    const aliasPermissions = LEGACY_PERMISSION_ALIASES[cleanPermission];

    if (aliasPermissions) {
      for (const aliasPermission of aliasPermissions) {
        normalisedPermissions.add(aliasPermission);
      }
      continue;
    }

    if (USER_PERMISSIONS.includes(cleanPermission)) {
      normalisedPermissions.add(cleanPermission);
      continue;
    }

    if (strict && cleanPermission) {
      throw new AppError(
        400,
        `Permission noto'g'ri. Ruxsat etilgan qiymatlar: ${USER_PERMISSIONS.join(', ')}`,
      );
    }
  }

  return USER_PERMISSIONS.filter((permission) => normalisedPermissions.has(permission));
}

export function serializeUser(user) {
  if (!user) {
    return null;
  }

  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    telegramId: user.telegramId,
    telegramUsername: user.telegramUsername,
    telegramPhotoUrl: user.telegramPhotoUrl,
    authProvider: user.authProvider,
    role: user.role,
    status: user.status,
    createdBy: user.createdBy,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt,
    lastTelegramAuthAt: user.lastTelegramAuthAt,
    permissions: normalisePermissions(parsePermissions(user.permissions), { strict: false }),
  };
}

function getUserByIdWithSecrets(userId) {
  return getDb().prepare('SELECT * FROM app_users WHERE id = ?').get(userId);
}

export function getUserById(userId) {
  return serializeUser(getUserByIdWithSecrets(userId));
}

export function getUserByUsername(username) {
  const user = getDb()
    .prepare('SELECT * FROM app_users WHERE username = ?')
    .get(normaliseUsername(username));
  return serializeUser(user);
}

export function getUserForLogin(username) {
  return getDb()
    .prepare('SELECT * FROM app_users WHERE username = ?')
    .get(normaliseUsername(username));
}

// Foydalanuvchi mavjud bo'lmaganda ham scrypt hisoblash bir xil vaqt olishi
// uchun (aks holda javob vaqtidan username mavjudligini bilib olish mumkin).
const DUMMY_PASSWORD_HASH = hashPassword(randomBytes(32).toString('hex'));

export function authenticateLocalUser(username, password) {
  const user = getUserForLogin(username);
  const passwordMatches = verifyPassword(
    password,
    user?.passwordHash ?? DUMMY_PASSWORD_HASH.hash,
    user?.passwordSalt ?? DUMMY_PASSWORD_HASH.salt,
  );

  if (!user || user.status !== 'active' || !passwordMatches) {
    throw new AppError(401, 'Login yoki parol xato');
  }

  getDb()
    .prepare('UPDATE app_users SET lastLoginAt = CURRENT_TIMESTAMP, updatedAt = CURRENT_TIMESTAMP WHERE id = ?')
    .run(user.id);

  return serializeUser(getUserByIdWithSecrets(user.id));
}

export function listUsers({ role, search }) {
  const db = getDb();
  const filters = [];
  const params = [];

  if (role) {
    assertRole(role);
    filters.push('role = ?');
    params.push(role);
  }

  if (search) {
    const wildcard = `%${String(search).trim()}%`;
    filters.push(`
      (
        COALESCE(username, '') LIKE ?
        OR COALESCE(displayName, '') LIKE ?
        OR COALESCE(telegramUsername, '') LIKE ?
      )
    `);
    params.push(wildcard, wildcard, wildcard);
  }

  const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
  const users = db.prepare(`
    SELECT
      id,
      username,
      displayName,
      telegramId,
      telegramUsername,
      telegramPhotoUrl,
      authProvider,
      role,
      status,
      createdBy,
      createdAt,
      updatedAt,
      lastLoginAt,
      lastTelegramAuthAt,
      permissions
    FROM app_users
    ${whereClause}
    ORDER BY
      CASE role
        WHEN 'super_admin' THEN 1
        WHEN 'admin' THEN 2
        ELSE 3
      END,
      COALESCE(displayName, username, telegramUsername) ASC,
      id ASC
  `).all(...params);

  const summarySql = `
    SELECT
      COUNT(*) AS totalUsers,
      COALESCE(SUM(CASE WHEN role = 'super_admin' THEN 1 ELSE 0 END), 0) AS totalSuperAdmins,
      COALESCE(SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END), 0) AS totalAdmins,
      COALESCE(SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END), 0) AS totalRegularUsers,
      COALESCE(SUM(CASE WHEN authProvider = 'telegram' THEN 1 ELSE 0 END), 0) AS telegramOnlyUsers,
      COALESCE(SUM(CASE WHEN authProvider = 'local' THEN 1 ELSE 0 END), 0) AS localOnlyUsers,
      COALESCE(SUM(CASE WHEN authProvider = 'hybrid' THEN 1 ELSE 0 END), 0) AS hybridUsers
    FROM app_users
  `;
  const summary = db.prepare(`${summarySql} ${whereClause}`).get(...params);
  const globalSummary = db.prepare(summarySql).get();

  return {
    summary: normaliseUserSummary(summary),
    globalSummary: normaliseUserSummary(globalSummary),
    users: users.map(serializeUser),
  };
}

export function getUserStatusSummary() {
  const summary = getDb().prepare(`
    SELECT
      COUNT(*) AS totalUsers,
      COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) AS activeUsers,
      COALESCE(SUM(CASE WHEN status = 'disabled' THEN 1 ELSE 0 END), 0) AS blockedUsers,
      COALESCE(SUM(CASE WHEN authProvider = 'telegram' THEN 1 ELSE 0 END), 0) AS telegramUsers,
      COALESCE(SUM(CASE WHEN authProvider = 'local' THEN 1 ELSE 0 END), 0) AS localUsers,
      COALESCE(SUM(CASE WHEN authProvider = 'hybrid' THEN 1 ELSE 0 END), 0) AS hybridUsers
    FROM app_users
    WHERE role = 'user'
  `).get();

  return {
    totalUsers: summary.totalUsers ?? 0,
    activeUsers: summary.activeUsers ?? 0,
    blockedUsers: summary.blockedUsers ?? 0,
    telegramUsers: summary.telegramUsers ?? 0,
    localUsers: summary.localUsers ?? 0,
    hybridUsers: summary.hybridUsers ?? 0,
  };
}

export function getAdminStatusSummary() {
  const summary = getDb().prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END), 0) AS totalAdmins,
      COALESCE(SUM(CASE WHEN role = 'admin' AND status = 'active' THEN 1 ELSE 0 END), 0) AS activeAdmins,
      COALESCE(SUM(CASE WHEN role = 'admin' AND status = 'disabled' THEN 1 ELSE 0 END), 0) AS blockedAdmins,
      COALESCE(SUM(CASE WHEN role = 'super_admin' THEN 1 ELSE 0 END), 0) AS superAdmins,
      COALESCE(SUM(CASE WHEN role = 'super_admin' AND status = 'active' THEN 1 ELSE 0 END), 0) AS activeSuperAdmins,
      COALESCE(SUM(CASE WHEN role = 'super_admin' AND status = 'disabled' THEN 1 ELSE 0 END), 0) AS blockedSuperAdmins,
      COALESCE(COUNT(*), 0) AS totalPrivilegedUsers
    FROM app_users
    WHERE role IN ('super_admin', 'admin')
  `).get();

  return {
    totalAdmins: summary.totalAdmins ?? 0,
    activeAdmins: summary.activeAdmins ?? 0,
    blockedAdmins: summary.blockedAdmins ?? 0,
    superAdmins: summary.superAdmins ?? 0,
    activeSuperAdmins: summary.activeSuperAdmins ?? 0,
    blockedSuperAdmins: summary.blockedSuperAdmins ?? 0,
    adminOnly: summary.totalAdmins ?? 0,
    admins: summary.totalPrivilegedUsers ?? 0,
    totalPrivilegedUsers: summary.totalPrivilegedUsers ?? 0,
  };
}

function validateLocalCredentials({ username, password }) {
  const cleanUsername = normaliseUsername(username);

  if (!/^[a-z0-9._-]{3,32}$/.test(cleanUsername)) {
    throw new AppError(
      400,
      "Username 3-32 ta belgidan iborat bo'lishi va faqat a-z, 0-9, nuqta, pastki chiziq yoki tire ishlatishi kerak",
    );
  }

  if (typeof password !== 'string' || password.length < 8) {
    throw new AppError(400, "Parol kamida 8 ta belgidan iborat bo'lishi kerak");
  }

  return cleanUsername;
}

export function createLocalUser({ username, password, displayName, role, createdBy }) {
  const cleanUsername = validateLocalCredentials({ username, password });
  assertRole(role);

  const existingUser = getDb().prepare('SELECT id FROM app_users WHERE username = ?').get(cleanUsername);
  if (existingUser) {
    throw new AppError(409, 'Bu username allaqachon mavjud');
  }

  const { hash, salt } = hashPassword(password);
  const cleanDisplayName = normaliseDisplayName(displayName, cleanUsername);

  const result = getDb().prepare(`
    INSERT INTO app_users (
      username,
      displayName,
      authProvider,
      passwordHash,
      passwordSalt,
      role,
      status,
      createdBy,
      createdAt,
      updatedAt
    )
    VALUES (?, ?, 'local', ?, ?, ?, 'active', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(cleanUsername, cleanDisplayName, hash, salt, role, createdBy ?? null);

  return getUserById(result.lastInsertRowid);
}

export function upsertTelegramUser(telegramUser) {
  const db = getDb();
  const telegramId = String(telegramUser.id);
  const displayName = [telegramUser.first_name, telegramUser.last_name].filter(Boolean).join(' ').trim();
  const telegramUsername = telegramUser.username ? String(telegramUser.username).trim() : null;
  const telegramPhotoUrl = telegramUser.photo_url ? String(telegramUser.photo_url).trim() : null;

  const existingUser = db.prepare('SELECT * FROM app_users WHERE telegramId = ?').get(telegramId);

  if (existingUser) {
    const authProvider =
      existingUser.authProvider === 'local' || existingUser.authProvider === 'hybrid'
        ? 'hybrid'
        : 'telegram';
    const nextRole = resolveTelegramRole(telegramId, existingUser.role || 'user');

    db.prepare(`
      UPDATE app_users
      SET
        displayName = ?,
        telegramUsername = ?,
        telegramPhotoUrl = ?,
        authProvider = ?,
        role = ?,
        lastLoginAt = CURRENT_TIMESTAMP,
        lastTelegramAuthAt = CURRENT_TIMESTAMP,
        updatedAt = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      normaliseDisplayName(displayName, telegramUsername || existingUser.username || `tg_${telegramId}`),
      telegramUsername,
      telegramPhotoUrl,
      authProvider,
      nextRole,
      existingUser.id,
    );

    return getUserById(existingUser.id);
  }

  const createdUser = db.prepare(`
    INSERT INTO app_users (
      username,
      displayName,
      telegramId,
      telegramUsername,
      telegramPhotoUrl,
      authProvider,
      role,
      status,
      createdAt,
      updatedAt,
      lastLoginAt,
      lastTelegramAuthAt
    )
    VALUES (?, ?, ?, ?, ?, 'telegram', 'user', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(
    null,
    normaliseDisplayName(displayName, telegramUsername || `tg_${telegramId}`),
    telegramId,
    telegramUsername,
    telegramPhotoUrl,
  );

  const role = resolveTelegramRole(telegramId, 'user');

  if (role !== 'user') {
    db.prepare(`
      UPDATE app_users
      SET role = ?, updatedAt = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(role, createdUser.lastInsertRowid);
  }

  return getUserById(createdUser.lastInsertRowid);
}

export function updateUserRole({ targetUserId, newRole, changedByUserId, changedByRole }) {
  const db = getDb();
  assertRole(newRole);

  const targetUser = getUserByIdWithSecrets(targetUserId);
  if (!targetUser) {
    throw new AppError(404, 'Foydalanuvchi topilmadi');
  }

  if (changedByRole !== 'super_admin' && (targetUser.role === 'super_admin' || newRole === 'super_admin')) {
    throw new AppError(403, "Super admin rolini boshqarish huquqi yo'q");
  }

  if (targetUser.status !== 'active') {
    throw new AppError(400, "Faol bo'lmagan foydalanuvchining rolini o'zgartirib bo'lmaydi");
  }

  if (targetUser.id === changedByUserId && targetUser.role === 'super_admin' && newRole !== 'super_admin') {
    const superAdminCount = db
      .prepare("SELECT COUNT(*) AS count FROM app_users WHERE role = 'super_admin' AND status = 'active'")
      .get().count;

    if (superAdminCount <= 1) {
      throw new AppError(400, "Yagona super admin o'z rolini pasaytira olmaydi");
    }
  }

  if (targetUser.role === newRole) {
    return serializeUser(targetUser);
  }

  db.prepare(`
    UPDATE app_users
    SET role = ?, permissions = ?, updatedAt = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(newRole, newRole === 'admin' ? targetUser.permissions : '[]', targetUser.id);

  db.prepare(`
    INSERT INTO role_change_logs (userId, previousRole, nextRole, changedBy)
    VALUES (?, ?, ?, ?)
  `).run(targetUser.id, targetUser.role, newRole, changedByUserId);

  return getUserById(targetUser.id);
}

export function updateUserStatus({ targetUserId, newStatus, changedByUserId, changedByRole, canManageAdmins = false }) {
  const db = getDb();
  if (!USER_STATUSES.includes(newStatus)) {
    throw new AppError(400, `Status noto'g'ri. Ruxsat etilgan qiymatlar: ${USER_STATUSES.join(', ')}`);
  }

  const targetUser = getUserByIdWithSecrets(targetUserId);
  if (!targetUser) {
    throw new AppError(404, 'Foydalanuvchi topilmadi');
  }

  if (targetUser.id === changedByUserId) {
    throw new AppError(400, "O'z statusingizni o'zgartira olmaysiz");
  }

  if (targetUser.role === 'super_admin') {
    throw new AppError(400, "Super adminni bloklab bo'lmaydi");
  }

  if (targetUser.role === 'admin' && changedByRole !== 'super_admin' && !canManageAdmins) {
    throw new AppError(403, "Admin statusini o'zgartirish huquqi yo'q");
  }

  if (targetUser.status === newStatus) {
    return serializeUser(targetUser);
  }

  db.prepare(`
    UPDATE app_users
    SET status = ?, updatedAt = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(newStatus, targetUser.id);

  return getUserById(targetUser.id);
}

export function updateUserPermissions({ targetUserId, permissions, changedByUserId }) {
  const db = getDb();
  const targetUser = getUserByIdWithSecrets(targetUserId);
  if (!targetUser) {
    throw new AppError(404, 'Foydalanuvchi topilmadi');
  }

  if (targetUser.role === 'super_admin') {
    throw new AppError(400, "Super admin huquqlarini o'zgartirib bo'lmaydi");
  }

  if (targetUser.role !== 'admin') {
    throw new AppError(400, 'Permission faqat admin foydalanuvchilar uchun beriladi');
  }

  const permissionsString = JSON.stringify(normalisePermissions(permissions));

  db.prepare(`
    UPDATE app_users
    SET permissions = ?, updatedAt = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(permissionsString, targetUser.id);

  return getUserById(targetUser.id);
}

function parseTelegramIds(value) {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.map((item) => String(item ?? '').trim()).filter(Boolean);
  } catch (_error) {
    return [];
  }
}

function removeTelegramIdFromDevices(db, telegramId) {
  const cleanTelegramId = String(telegramId || '').trim();
  if (!cleanTelegramId) {
    return 0;
  }

  const rows = db
    .prepare(
      `
        SELECT registrationNo, telegramIds
        FROM devices
        WHERE COALESCE(telegramIds, '') LIKE ?
      `,
    )
    .all(`%${cleanTelegramId}%`);
  const updateDeviceTelegramIds = db.prepare('UPDATE devices SET telegramIds = ? WHERE registrationNo = ?');
  let updated = 0;

  for (const row of rows) {
    const telegramIds = parseTelegramIds(row.telegramIds);
    if (!telegramIds.includes(cleanTelegramId)) {
      continue;
    }

    updateDeviceTelegramIds.run(
      JSON.stringify(telegramIds.filter((item) => item !== cleanTelegramId)),
      row.registrationNo,
    );
    updated += 1;
  }

  return updated;
}

export function deleteUser({ targetUserId, deletedByUserId, deletedByRole, canManageAdmins = false }) {
  const db = getDb();
  const targetUser = getUserByIdWithSecrets(targetUserId);

  if (!targetUser) {
    throw new AppError(404, 'Foydalanuvchi topilmadi');
  }

  if (targetUser.id === deletedByUserId) {
    throw new AppError(400, "O'zingizni o'chira olmaysiz");
  }

  if (targetUser.role === 'super_admin') {
    throw new AppError(400, "Super adminni o'chirib bo'lmaydi");
  }

  if (targetUser.role === 'admin' && deletedByRole !== 'super_admin' && !canManageAdmins) {
    throw new AppError(403, "Adminni o'chirish huquqi yo'q");
  }

  const deletedUser = serializeUser(targetUser);
  let unlinkedDevices = 0;

  db.exec('BEGIN');

  try {
    unlinkedDevices = removeTelegramIdFromDevices(db, targetUser.telegramId);
    db.prepare('UPDATE app_users SET createdBy = NULL WHERE createdBy = ?').run(targetUser.id);
    db.prepare('DELETE FROM role_change_logs WHERE userId = ? OR changedBy = ?').run(targetUser.id, targetUser.id);
    db.prepare('DELETE FROM app_users WHERE id = ?').run(targetUser.id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return {
    deletedUser,
    deletedUserId: targetUser.id,
    unlinkedDevices,
  };
}

export function ensureUserCanCreateRole(currentUserRole, targetRole) {
  if (currentUserRole === 'admin' && targetRole !== 'user') {
    throw new AppError(403, 'Admin faqat oddiy user yarata oladi');
  }

  if (currentUserRole !== 'super_admin' && targetRole === 'super_admin') {
    throw new AppError(403, "Super admin yaratish huquqi yo'q");
  }
}

export function getHealthSnapshot() {
  const db = getDb();

  const usersSummary = db.prepare(`
    SELECT
      COALESCE(COUNT(*), 0) AS totalUsers,
      COALESCE(SUM(CASE WHEN role = 'super_admin' THEN 1 ELSE 0 END), 0) AS superAdmins,
      COALESCE(SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END), 0) AS adminOnly,
      COALESCE(SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END), 0) AS users,
      COALESCE(SUM(CASE WHEN role IN ('super_admin', 'admin') THEN 1 ELSE 0 END), 0) AS totalPrivilegedUsers
    FROM app_users
  `).get();

  const alertsSummary = db.prepare(`
    SELECT
      COALESCE(COUNT(*), 0) AS totalAlerts,
      COALESCE(SUM(CASE WHEN isRead = 0 THEN 1 ELSE 0 END), 0) AS unreadAlerts
    FROM alerts
  `).get();

  return {
    users: {
      totalUsers: usersSummary.totalUsers ?? 0,
      superAdmins: usersSummary.superAdmins ?? 0,
      adminOnly: usersSummary.adminOnly ?? 0,
      admins: usersSummary.totalPrivilegedUsers ?? 0,
      totalPrivilegedUsers: usersSummary.totalPrivilegedUsers ?? 0,
      users: usersSummary.users ?? 0,
    },
    devices: getDeviceTotals(),
    alerts: alertsSummary,
  };
}

export function assertActiveUser(user) {
  if (!user) {
    throw new AppError(401, 'Sessiya topilmadi');
  }

  if (!USER_STATUSES.includes(user.status) || user.status !== 'active') {
    throw new AppError(403, 'Foydalanuvchi bloklangan');
  }

  return user;
}
