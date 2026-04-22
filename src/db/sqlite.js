import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { DB_PATH } from '../config/settings.js';
import { runMigrations } from './migrations.js';

let db = null;

/**
 * Get (or create) singleton DB connection.
 * Enables WAL mode and runs migrations on first connect.
 */
export function getDb() {
  if (db) return db;

  // Ensure data directory exists
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  runMigrations(db);

  return db;
}

/**
 * Close DB connection cleanly.
 */
export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}
