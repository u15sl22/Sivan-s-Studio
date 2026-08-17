#!/usr/bin/env node

import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const CONFIRMATION = "RESET_LIBRARY_AND_HISTORY";
const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function optionValue(name) {
  const prefix = `${name}=`;
  const inline = process.argv.find((argument) => argument.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const dataDir = path.resolve(optionValue("--data-dir") || path.join(PROJECT_ROOT, "data"));
const databasePath = path.join(dataDir, "sivan-studio.db");
const dryRun = process.argv.includes("--dry-run");
const confirmation = optionValue("--confirm");

if (!existsSync(databasePath)) {
  console.error(`Database not found: ${databasePath}`);
  process.exit(1);
}

const db = new DatabaseSync(databasePath);
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 2000");

const counts = {
  articles: db.prepare("SELECT COUNT(*) AS count FROM articles").get().count,
  pages: db.prepare("SELECT COUNT(*) AS count FROM article_pages").get().count,
  assignments: db.prepare("SELECT COUNT(*) AS count FROM article_assignments").get().count,
  submissions: db.prepare("SELECT COUNT(*) AS count FROM submissions").get().count,
  attempts: db.prepare("SELECT COUNT(*) AS count FROM sentence_attempts").get().count,
  attendanceDays: db.prepare("SELECT COUNT(*) AS count FROM attendance_daily").get().count
};

console.table(counts);

if (dryRun) {
  console.log("Dry run only. No database rows or files were removed.");
  db.close();
  process.exit(0);
}

if (confirmation !== CONFIRMATION) {
  console.error("Refusing to reset the library without the exact confirmation phrase.");
  console.error(`Run again with --confirm=${CONFIRMATION} after stopping the app and backing up data/.`);
  db.close();
  process.exit(2);
}

try {
  db.exec("BEGIN IMMEDIATE");
  db.exec("DELETE FROM attendance_daily");
  db.exec("DELETE FROM sentence_attempts");
  db.exec("DELETE FROM submissions");
  db.exec("DELETE FROM article_assignments");
  db.exec("DELETE FROM article_pages");
  db.exec("DELETE FROM articles");
  db.exec("COMMIT");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
} catch (error) {
  try {
    db.exec("ROLLBACK");
  } catch {
    // The transaction may already have rolled back.
  }
  db.close();
  throw error;
}

db.close();

for (const directory of [path.join(dataDir, "pdfs"), path.join(dataDir, "recordings")]) {
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
}

console.log("Library reset complete. Teacher, class, and student accounts were preserved.");
console.log("Book records, reading history, attendance, page files, and recordings were removed.");
