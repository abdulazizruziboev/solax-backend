import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { getDb } from '../db.js';

const BACKUP_DIR = path.resolve(process.cwd(), 'backups');
const MAX_BACKUPS = 30;

function ensureBackupDir() {
  if (!existsSync(BACKUP_DIR)) {
    mkdirSync(BACKUP_DIR, { recursive: true });
  }
}

function getDbPath() {
  const dbPath = config.databasePath;
  if (path.isAbsolute(dbPath)) return dbPath;
  return path.resolve(process.cwd(), dbPath);
}

export async function createBackup() {
  ensureBackupDir();
  const dbPath = getDbPath();

  if (!existsSync(dbPath)) {
    console.error('[backup] DB fayl topilmadi:', dbPath);
    return null;
  }

  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupFileName = `solax-backup-${timestamp}.sqlite`;
  const backupPath = path.join(BACKUP_DIR, backupFileName);

  try {
    // better-sqlite3'ning ichki backup API'si — platformadan mustaqil, WAL bilan
    // ham xavfsiz ishlaydi (tashqi cp/sqlite3 CLI'ga bog'liq emas).
    await getDb().backup(backupPath);

    const stat = statSync(backupPath);
    console.log(`[backup] Yaratildi: ${backupFileName} (${(stat.size / 1024).toFixed(1)} KB)`);

    cleanOldBackups();
    return backupPath;
  } catch (error) {
    console.error('[backup] Xato:', error.message);
    return null;
  }
}

function cleanOldBackups() {
  try {
    const files = readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith('solax-backup-') && f.endsWith('.sqlite'))
      .map((f) => ({
        name: f,
        path: path.join(BACKUP_DIR, f),
        time: statSync(path.join(BACKUP_DIR, f)).mtime.getTime(),
      }))
      .sort((a, b) => b.time - a.time);

    if (files.length > MAX_BACKUPS) {
      for (const file of files.slice(MAX_BACKUPS)) {
        unlinkSync(file.path);
        console.log(`[backup] O'chirildi: ${file.name}`);
      }
    }
  } catch (error) {
    console.error('[backup] Tozalash xatosi:', error.message);
  }
}

export function getBackupStatus() {
  ensureBackupDir();
  const files = readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith('solax-backup-') && f.endsWith('.sqlite'))
    .map((f) => ({
      name: f,
      size: statSync(path.join(BACKUP_DIR, f)).size,
      createdAt: statSync(path.join(BACKUP_DIR, f)).mtime.toISOString(),
    }))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  return {
    backupDir: BACKUP_DIR,
    totalBackups: files.length,
    maxBackups: MAX_BACKUPS,
    latest: files[0] || null,
    dbPath: getDbPath(),
  };
}

// Schedule — har 6 soatda backup
let backupTimer = null;
let startupBackupTimer = null;

export function startBackupScheduler() {
  if (backupTimer) return;

  // Birinchi backup — 5 daqiqadan so'ng
  startupBackupTimer = setTimeout(() => {
    createBackup().catch((error) => console.error('[backup] Boshlang\'ich backup xatosi:', error.message));
  }, 5 * 60 * 1000);
  startupBackupTimer.unref?.();

  // Keyin har 6 soatda
  backupTimer = setInterval(() => {
    createBackup().catch((error) => console.error('[backup] Rejalashtirilgan backup xatosi:', error.message));
  }, 6 * 60 * 60 * 1000);

  backupTimer.unref?.();
  console.log('[backup] Scheduler ishga tushdi (har 6 soatda)');
}

export function stopBackupScheduler() {
  if (backupTimer) {
    clearInterval(backupTimer);
    backupTimer = null;
  }

  if (startupBackupTimer) {
    clearTimeout(startupBackupTimer);
    startupBackupTimer = null;
  }
}
