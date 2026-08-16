import http from "node:http";
import { readFile, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(ROOT, "data");
const RECORDING_DIR = path.join(DATA_DIR, "recordings");
const PDF_DIR = path.join(DATA_DIR, "pdfs");
await mkdir(RECORDING_DIR, { recursive: true });
await mkdir(PDF_DIR, { recursive: true });

const execFileAsync = promisify(execFile);
const bundledPython = process.env.USERPROFILE
  ? path.join(process.env.USERPROFILE, ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe")
  : "";
const PYTHON = process.env.SIVAN_PYTHON || (bundledPython && existsSync(bundledPython) ? bundledPython : "python");

const PORT = Number(process.env.SIVAN_PORT || 8766);
const TOKEN_TTL_SECONDS = 30 * 60;
const STUDENT_SCORE_FLOOR = 7.5;
const BUSINESS_TIME_ZONE = "Asia/Shanghai";
const PDF_TIMEOUT_SECONDS = Math.max(60, Number(process.env.SIVAN_PDF_TIMEOUT_SECONDS) || 900);
const TOKEN_SECRET = process.env.SIVAN_TOKEN_SECRET || randomBytes(32).toString("hex");
const TEACHER_USERNAME = String(process.env.SIVAN_TEACHER_USERNAME || "sivan.teacher").trim().toLowerCase();
const TEACHER_PASSWORD = process.env.SIVAN_TEACHER_PASSWORD || "";
const db = new DatabaseSync(path.join(DATA_DIR, "sivan-studio.db"));
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA journal_mode = WAL");

function hashSecret(value, salt = randomBytes(16).toString("hex")) {
  const digest = scryptSync(value, salt, 64).toString("hex");
  return `${salt}:${digest}`;
}

function verifySecret(value, stored) {
  const [salt, expectedHex] = String(stored).split(":");
  if (!salt || !expectedHex) return false;
  const actual = scryptSync(value, salt, 64);
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function id(prefix) {
  return `${prefix}_${randomBytes(10).toString("hex")}`;
}

function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS classes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS teachers (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      token_version INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS students (
      id TEXT PRIMARY KEY,
      class_id TEXT NOT NULL REFERENCES classes(id),
      display_name TEXT NOT NULL,
      normalized_name TEXT NOT NULL UNIQUE,
      code_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      token_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS articles (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      source_filename TEXT,
      source_pdf_path TEXT,
      page_count INTEGER NOT NULL DEFAULT 0,
      booklist_number INTEGER NOT NULL DEFAULT 1,
      processing_status TEXT NOT NULL DEFAULT 'ready',
      processing_error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS article_pages (
      id TEXT PRIMARY KEY,
      article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
      page_order INTEGER NOT NULL,
      image_data_url TEXT NOT NULL DEFAULT '',
      image_path TEXT,
      text TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS article_assignments (
      article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
      class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      PRIMARY KEY (article_id, class_id)
    );
    CREATE TABLE IF NOT EXISTS submissions (
      id TEXT PRIMARY KEY,
      student_id TEXT NOT NULL REFERENCES students(id),
      article_id TEXT NOT NULL REFERENCES articles(id),
      score REAL NOT NULL,
      wrong_words INTEGER NOT NULL,
      total_words INTEGER NOT NULL,
      submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS sentence_attempts (
      id TEXT PRIMARY KEY,
      submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
      sentence_order INTEGER NOT NULL,
      expected_text TEXT NOT NULL,
      heard_text TEXT NOT NULL,
      recording_path TEXT,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      wrong_words INTEGER NOT NULL,
      total_words INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS attendance_daily (
      student_id TEXT NOT NULL REFERENCES students(id),
      read_date TEXT NOT NULL,
      submission_id TEXT NOT NULL REFERENCES submissions(id),
      PRIMARY KEY (student_id, read_date)
    );
    CREATE INDEX IF NOT EXISTS idx_submissions_student_date ON submissions(student_id, submitted_at DESC);
    CREATE INDEX IF NOT EXISTS idx_attendance_student_date ON attendance_daily(student_id, read_date);
  `);

  const attemptColumns = db.prepare("PRAGMA table_info(sentence_attempts)").all();
  if (!attemptColumns.some((column) => column.name === "duration_ms")) {
    db.exec("ALTER TABLE sentence_attempts ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0");
  }
  const classColumns = db.prepare("PRAGMA table_info(classes)").all();
  if (!classColumns.some((column) => column.name === "status")) db.exec("ALTER TABLE classes ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
  const articleColumns = db.prepare("PRAGMA table_info(articles)").all();
  if (!articleColumns.some((column) => column.name === "source_filename")) db.exec("ALTER TABLE articles ADD COLUMN source_filename TEXT");
  if (!articleColumns.some((column) => column.name === "source_pdf_path")) db.exec("ALTER TABLE articles ADD COLUMN source_pdf_path TEXT");
  if (!articleColumns.some((column) => column.name === "page_count")) db.exec("ALTER TABLE articles ADD COLUMN page_count INTEGER NOT NULL DEFAULT 0");
  if (!articleColumns.some((column) => column.name === "processing_status")) db.exec("ALTER TABLE articles ADD COLUMN processing_status TEXT NOT NULL DEFAULT 'ready'");
  if (!articleColumns.some((column) => column.name === "processing_error")) db.exec("ALTER TABLE articles ADD COLUMN processing_error TEXT NOT NULL DEFAULT ''");
  if (!articleColumns.some((column) => column.name === "booklist_number")) {
    db.exec("ALTER TABLE articles ADD COLUMN booklist_number INTEGER NOT NULL DEFAULT 1");
    const existingArticles = db.prepare("SELECT id FROM articles ORDER BY created_at, id").all();
    const assignBooklist = db.prepare("UPDATE articles SET booklist_number = ? WHERE id = ?");
    existingArticles.forEach((article, index) => assignBooklist.run(Math.floor(index / 10) + 1, article.id));
  }
  db.exec("DROP INDEX IF EXISTS idx_articles_booklist_created_at");
  db.exec("CREATE INDEX IF NOT EXISTS idx_articles_booklist_created_desc ON articles(booklist_number, created_at DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_articles_processing_status ON articles(processing_status) WHERE processing_status = 'processing'");
  db.exec("PRAGMA optimize");
  const pageColumns = db.prepare("PRAGMA table_info(article_pages)").all();
  if (!pageColumns.some((column) => column.name === "image_path")) db.exec("ALTER TABLE article_pages ADD COLUMN image_path TEXT");

  const classCount = db.prepare("SELECT COUNT(*) AS count FROM classes").get().count;
  if (!classCount) {
    db.prepare("INSERT INTO classes (id, name) VALUES (?, ?)").run("blue", "Blue Class");
    db.prepare("INSERT INTO classes (id, name) VALUES (?, ?)").run("green", "Green Class");
  }

  const teacherCount = db.prepare("SELECT COUNT(*) AS count FROM teachers").get().count;
  if (!teacherCount) {
    if (TEACHER_PASSWORD.length < 12) throw new Error("SIVAN_TEACHER_PASSWORD must be set to at least 12 characters for first startup.");
    db.prepare("INSERT INTO teachers (id, username, password_hash, display_name) VALUES (?, ?, ?, ?)")
      .run("teacher_sivan", TEACHER_USERNAME, hashSecret(TEACHER_PASSWORD), "Sivan");
  }
}

initDatabase();

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function signToken(payload) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify({ ...payload, iat: now, exp: now + TOKEN_TTL_SECONDS }));
  const signature = createHmac("sha256", TOKEN_SECRET).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${signature}`;
}

function verifyToken(token) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const expected = createHmac("sha256", TOKEN_SECRET).update(`${parts[0]}.${parts[1]}`).digest();
  const actual = Buffer.from(parts[2], "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    const table = payload.role === "teacher" ? "teachers" : "students";
    const actor = db.prepare(`SELECT status, token_version FROM ${table} WHERE id = ?`).get(payload.sub);
    if (!actor || actor.status !== "active" || actor.token_version !== payload.ver) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || "").split(";").filter(Boolean).map((part) => {
    const index = part.indexOf("=");
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1))];
  }));
}

function session(req) {
  return verifyToken(parseCookies(req).sivan_access);
}

function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `sivan_access=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${TOKEN_TTL_SECONDS}${secure}`);
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function bodyJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 120 * 1024 * 1024) throw new Error("PAYLOAD_TOO_LARGE");
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function cleanWords(text) {
  return String(text || "").toLowerCase().replace(/[^a-z'\s-]/g, " ").split(/\s+/).filter(Boolean);
}

function splitSentences(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  return normalized ? (normalized.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [normalized]).map((item) => item.trim()) : [];
}

function businessDate(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(value);
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function nextBooklistNumber() {
  const available = db.prepare(`
    SELECT booklist_number AS booklistNumber
    FROM articles
    GROUP BY booklist_number
    HAVING COUNT(*) < 10
    ORDER BY booklist_number
    LIMIT 1
  `).get();
  if (available) return Number(available.booklistNumber);
  return Number(db.prepare("SELECT COALESCE(MAX(booklist_number), 0) + 1 AS booklistNumber FROM articles").get().booklistNumber);
}

function studentDisplayScore(score) {
  return Math.max(STUDENT_SCORE_FLOOR, Number(score || 0));
}

function alignWords(expectedText, heardText) {
  const expected = cleanWords(expectedText);
  const heard = cleanWords(heardText);
  const rows = expected.length + 1;
  const cols = heard.length + 1;
  const dp = Array.from({ length: rows }, () => Array(cols).fill(0));
  for (let i = 0; i < rows; i += 1) dp[i][0] = i;
  for (let j = 0; j < cols; j += 1) dp[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (expected[i - 1] === heard[j - 1] ? 0 : 1));
    }
  }
  let i = expected.length;
  let j = heard.length;
  const reviewed = [];
  let wrong = 0;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + (expected[i - 1] === heard[j - 1] ? 0 : 1)) {
      const isCorrect = expected[i - 1] === heard[j - 1];
      if (!isCorrect) wrong += 1;
      reviewed.unshift({ word: expected[i - 1], heard: heard[j - 1], isCorrect });
      i -= 1;
      j -= 1;
    } else if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
      wrong += 1;
      reviewed.unshift({ word: expected[i - 1], heard: "", isCorrect: false });
      i -= 1;
    } else {
      wrong += 1;
      j -= 1;
    }
  }
  return { expected, heard, reviewed, wrong, total: expected.length };
}

function requireRole(req, res, role) {
  const auth = session(req);
  if (!auth) {
    json(res, 401, { error: "Session expired or invalid." });
    return null;
  }
  if (auth.role !== role) {
    json(res, 403, { error: "Forbidden." });
    return null;
  }
  return auth;
}

function articleForStudent(articleId, studentId) {
  return db.prepare(`
    SELECT a.id, a.title
    FROM articles a
    JOIN article_assignments aa ON aa.article_id = a.id
    JOIN students s ON s.class_id = aa.class_id
    WHERE a.id = ? AND s.id = ? AND s.status = 'active' AND a.processing_status = 'ready'
  `).get(articleId, studentId);
}

function articlePages(articleId) {
  return db.prepare("SELECT id, page_order AS pageOrder, image_data_url AS imageDataUrl, image_path AS imagePath, text FROM article_pages WHERE article_id = ? ORDER BY page_order").all(articleId)
    .map((page) => ({ ...page, imageUrl: page.imagePath ? `/api/article-pages/${page.id}/image` : "" }));
}

const pdfQueue = [];
const queuedPdfIds = new Set();
let pdfWorkerRunning = false;
let activePdfArticleId = null;

function enqueuePdfProcessing(articleId) {
  if (queuedPdfIds.has(articleId)) return;
  queuedPdfIds.add(articleId);
  pdfQueue.push(articleId);
  setImmediate(runPdfQueue);
}

async function readCompletedPdfPages(manifestPath, bookDir) {
  if (!existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const pages = Array.isArray(manifest.pages) ? manifest.pages : [];
    if (!pages.length || Number(manifest.pageCount) !== pages.length) return null;
    const pageIndexes = new Set();
    for (const page of pages) {
      const pageIndex = Number(page.index);
      if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndexes.has(pageIndex)) return null;
      pageIndexes.add(pageIndex);
      if (typeof page.image !== "string" || !page.image) return null;
      const imagePath = path.resolve(bookDir, page.image);
      if (!imagePath.startsWith(bookDir + path.sep) || !existsSync(imagePath)) return null;
    }
    return pages;
  } catch {
    return null;
  }
}

async function processStoredPdf(articleId) {
  const article = db.prepare("SELECT source_pdf_path AS sourcePdfPath, processing_status AS processingStatus FROM articles WHERE id = ?").get(articleId);
  if (!article || article.processingStatus !== "processing" || !article.sourcePdfPath) return;
  const bookDir = path.join(PDF_DIR, articleId);
  const sourcePath = path.resolve(DATA_DIR, article.sourcePdfPath);
  if (!sourcePath.startsWith(bookDir + path.sep) || !existsSync(sourcePath)) throw new Error("Stored PDF is missing.");
  const manifestPath = path.join(bookDir, "manifest.json");
  const temporaryManifestPath = path.join(bookDir, "manifest.json.tmp");
  let pages = await readCompletedPdfPages(manifestPath, bookDir);
  let processError = null;

  if (!pages) {
    await rm(manifestPath, { force: true });
    await rm(temporaryManifestPath, { force: true });
    console.log(`PDF processing started for ${articleId}.`);
    try {
      await execFileAsync(PYTHON, [path.join(ROOT, "scripts", "process_pdf.py"), sourcePath, bookDir], {
        timeout: PDF_TIMEOUT_SECONDS * 1000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env,
          PYTHONPATH: path.join(ROOT, ".python-packages"),
          PYTHONNOUSERSITE: "1"
        }
      });
    } catch (error) {
      processError = error;
    }
    pages = await readCompletedPdfPages(manifestPath, bookDir);
  }

  if (!pages) {
    if (processError) throw processError;
    throw new Error("PDF processing did not produce a complete manifest.");
  }
  if (processError) {
    console.warn(`PDF process exited abnormally after producing complete results for ${articleId}; recovered ${pages.length} page(s).`);
  }
  if (!db.prepare("SELECT 1 FROM articles WHERE id = ?").get(articleId)) {
    await rm(bookDir, { recursive: true, force: true });
    return;
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM article_pages WHERE article_id = ?").run(articleId);
    const insertPage = db.prepare("INSERT INTO article_pages (id, article_id, page_order, image_data_url, image_path, text) VALUES (?, ?, ?, ?, ?, ?)");
    for (const page of pages) {
      const relativeImage = path.relative(DATA_DIR, path.join(bookDir, page.image)).replaceAll("\\", "/");
      insertPage.run(id("page"), articleId, Number(page.index), "", relativeImage, String(page.text || "").trim());
    }
    db.prepare("UPDATE articles SET page_count = ?, processing_status = 'ready', processing_error = '' WHERE id = ?").run(pages.length, articleId);
    db.exec("COMMIT");
    console.log(`PDF processing completed for ${articleId}: ${pages.length} page(s).`);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

async function runPdfQueue() {
  if (pdfWorkerRunning) return;
  pdfWorkerRunning = true;
  try {
    while (pdfQueue.length) {
      const articleId = pdfQueue.shift();
      queuedPdfIds.delete(articleId);
      activePdfArticleId = articleId;
      try {
        await processStoredPdf(articleId);
      } catch (error) {
        const message = error?.code === "ETIMEDOUT" || error?.killed
          ? `PDF/OCR processing exceeded ${PDF_TIMEOUT_SECONDS} seconds without producing complete results.`
          : String(error?.message || "PDF/OCR processing failed.").slice(0, 500);
        db.prepare("UPDATE articles SET processing_status = 'failed', processing_error = ? WHERE id = ?").run(message, articleId);
        if (!db.prepare("SELECT 1 FROM articles WHERE id = ?").get(articleId)) {
          await rm(path.join(PDF_DIR, articleId), { recursive: true, force: true });
        }
        console.error(`PDF processing failed for ${articleId}:`, error);
      } finally {
        activePdfArticleId = null;
      }
    }
  } finally {
    pdfWorkerRunning = false;
    if (pdfQueue.length) setImmediate(runPdfQueue);
  }
}

async function saveRecording(dataUrl, attemptId) {
  if (!dataUrl) return null;
  const match = /^data:audio\/[^;]+;base64,(.+)$/.exec(dataUrl);
  if (!match) return null;
  const filename = `${attemptId}.webm`;
  await writeFile(path.join(RECORDING_DIR, filename), Buffer.from(match[1], "base64"));
  return filename;
}

async function api(req, res, url) {
  if (req.method === "POST" && url.pathname === "/api/auth/student/login") {
    const input = await bodyJson(req);
    const normalized = String(input.name || "").trim().toLowerCase();
    const student = db.prepare(`SELECT s.*, c.name AS class_name FROM students s JOIN classes c ON c.id = s.class_id WHERE s.normalized_name = ? AND s.status = 'active' AND c.status = 'active'`).get(normalized);
    if (!student || !verifySecret(String(input.code || ""), student.code_hash)) return json(res, 401, { error: "姓名或 code 不正确。" });
    setSessionCookie(res, signToken({ sub: student.id, role: "student", ver: student.token_version }));
    return json(res, 200, { user: { id: student.id, name: student.display_name, className: student.class_name }, expiresIn: TOKEN_TTL_SECONDS });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/teacher/login") {
    const input = await bodyJson(req);
    const teacher = db.prepare("SELECT * FROM teachers WHERE username = ? AND status = 'active'").get(String(input.username || "").trim().toLowerCase());
    if (!teacher || !verifySecret(String(input.password || ""), teacher.password_hash)) return json(res, 401, { error: "教师账号或密码不正确。" });
    setSessionCookie(res, signToken({ sub: teacher.id, role: "teacher", ver: teacher.token_version }));
    return json(res, 200, { user: { id: teacher.id, name: teacher.display_name, role: "teacher" }, expiresIn: TOKEN_TTL_SECONDS });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    res.setHeader("Set-Cookie", "sivan_access=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
    return json(res, 200, { ok: true });
  }

  if (req.method === "GET" && url.pathname === "/api/student/home") {
    const auth = requireRole(req, res, "student");
    if (!auth) return;
    const student = db.prepare(`SELECT s.id, s.display_name AS name, c.name AS className FROM students s JOIN classes c ON c.id = s.class_id WHERE s.id = ?`).get(auth.sub);
    const readDays = db.prepare("SELECT read_date AS readDate FROM attendance_daily WHERE student_id = ? ORDER BY read_date").all(auth.sub).map((row) => row.readDate);
    const latest = db.prepare("SELECT score FROM submissions WHERE student_id = ? ORDER BY submitted_at DESC LIMIT 1").get(auth.sub);
    const today = businessDate();
    const todayResult = db.prepare(`SELECT s.score, s.wrong_words AS wrong, s.total_words AS total, a.title AS articleTitle FROM attendance_daily ad JOIN submissions s ON s.id = ad.submission_id JOIN articles a ON a.id = s.article_id WHERE ad.student_id = ? AND ad.read_date = ?`).get(auth.sub, today);
    const studentTodayResult = todayResult ? { ...todayResult, score: studentDisplayScore(todayResult.score) } : null;
    const articles = db.prepare(`SELECT a.id, a.title, COUNT(ap.id) AS pageCount FROM articles a JOIN article_assignments aa ON aa.article_id = a.id JOIN students s ON s.class_id = aa.class_id LEFT JOIN article_pages ap ON ap.article_id = a.id WHERE s.id = ? AND a.processing_status = 'ready' GROUP BY a.id ORDER BY a.created_at DESC`).all(auth.sub);
    return json(res, 200, { student: { ...student, readDays, latestScore: latest ? studentDisplayScore(latest.score) : "--" }, today: { completed: Boolean(studentTodayResult), ...(studentTodayResult || {}) }, articles });
  }

  if (req.method === "GET" && url.pathname === "/api/student/today-recordings") {
    const auth = requireRole(req, res, "student");
    if (!auth) return;
    const today = businessDate();
    const submission = db.prepare(`SELECT s.id, s.score, s.wrong_words AS wrong, s.total_words AS total, a.title AS articleTitle FROM attendance_daily ad JOIN submissions s ON s.id = ad.submission_id JOIN articles a ON a.id = s.article_id WHERE ad.student_id = ? AND ad.read_date = ?`).get(auth.sub, today);
    if (!submission) return json(res, 404, { error: "Today’s reading has not been completed." });
    const attempts = db.prepare("SELECT id, sentence_order AS sentenceOrder, expected_text AS sentence, duration_ms AS durationMs, recording_path AS recordingPath FROM sentence_attempts WHERE submission_id = ? ORDER BY sentence_order").all(submission.id)
      .filter((attempt) => attempt.recordingPath)
      .map((attempt) => ({ id: attempt.id, sentenceOrder: attempt.sentenceOrder, sentence: attempt.sentence, durationMs: attempt.durationMs, audioUrl: `/api/student/recordings/${attempt.id}` }));
    return json(res, 200, { ...submission, score: studentDisplayScore(submission.score), attempts });
  }

  const studentRecordingMatch = /^\/api\/student\/recordings\/([^/]+)$/.exec(url.pathname);
  if (req.method === "GET" && studentRecordingMatch) {
    const auth = requireRole(req, res, "student");
    if (!auth) return;
    const attempt = db.prepare(`SELECT sa.recording_path AS recordingPath FROM sentence_attempts sa JOIN submissions s ON s.id = sa.submission_id WHERE sa.id = ? AND s.student_id = ?`).get(studentRecordingMatch[1], auth.sub);
    if (!attempt?.recordingPath) return json(res, 404, { error: "Recording not found." });
    const absolute = path.resolve(RECORDING_DIR, attempt.recordingPath);
    if (!absolute.startsWith(RECORDING_DIR) || !existsSync(absolute)) return json(res, 404, { error: "Recording not found." });
    const file = await readFile(absolute);
    res.writeHead(200, { "Content-Type": "audio/webm", "Content-Length": file.length, "Cache-Control": "private, no-store" });
    return res.end(file);
  }

  const studentArticleMatch = /^\/api\/student\/articles\/([^/]+)$/.exec(url.pathname);
  if (req.method === "GET" && studentArticleMatch) {
    const auth = requireRole(req, res, "student");
    if (!auth) return;
    const article = articleForStudent(studentArticleMatch[1], auth.sub);
    if (!article) return json(res, 404, { error: "Article not found." });
    const pages = articlePages(article.id).map((page) => ({ ...page, sentences: splitSentences(page.text) }));
    return json(res, 200, { ...article, pages });
  }

  const pageImageMatch = /^\/api\/article-pages\/([^/]+)\/image$/.exec(url.pathname);
  if (req.method === "GET" && pageImageMatch) {
    const auth = session(req);
    if (!auth) return json(res, 401, { error: "Session expired or invalid." });
    const page = db.prepare("SELECT id, article_id AS articleId, image_path AS imagePath FROM article_pages WHERE id = ?").get(pageImageMatch[1]);
    if (!page?.imagePath) return json(res, 404, { error: "Page image not found." });
    if (auth.role === "student" && !articleForStudent(page.articleId, auth.sub)) return json(res, 404, { error: "Page image not found." });
    const absolute = path.resolve(DATA_DIR, page.imagePath);
    if (!absolute.startsWith(PDF_DIR) || !existsSync(absolute)) return json(res, 404, { error: "Page image not found." });
    const image = await readFile(absolute);
    res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": image.length, "Cache-Control": "private, max-age=300" });
    return res.end(image);
  }

  if (req.method === "POST" && url.pathname === "/api/student/submissions") {
    const auth = requireRole(req, res, "student");
    if (!auth) return;
    const input = await bodyJson(req);
    const article = articleForStudent(String(input.articleId || ""), auth.sub);
    if (!article) return json(res, 404, { error: "Article not found." });
    const expectedSentences = articlePages(article.id).flatMap((page) => splitSentences(page.text));
    const attemptsAreValid = Array.isArray(input.attempts)
      && input.attempts.length === expectedSentences.length
      && input.attempts.every((attempt) => /^data:audio\//.test(String(attempt?.audioDataUrl || "")) && Number(attempt?.durationSeconds) > 0 && Number(attempt?.durationSeconds) <= 60);
    if (!expectedSentences.length || !attemptsAreValid) {
      return json(res, 400, { error: "每句话都需要完成录音后才能提交。" });
    }
    const results = expectedSentences.map((sentence, index) => alignWords(sentence, input.attempts[index]?.heardText || ""));
    const total = results.reduce((sum, item) => sum + item.total, 0);
    const wrong = results.reduce((sum, item) => sum + item.wrong, 0);
    const score = total ? Math.max(0, Math.round((1 - Math.min(wrong / total, 1)) * 100) / 10) : 0;
    const submissionId = id("submission");
    db.prepare("INSERT INTO submissions (id, student_id, article_id, score, wrong_words, total_words) VALUES (?, ?, ?, ?, ?, ?)").run(submissionId, auth.sub, article.id, score, wrong, total);
    for (let index = 0; index < results.length; index += 1) {
      const attemptId = id("attempt");
      const recordingPath = await saveRecording(input.attempts[index]?.audioDataUrl, attemptId);
      db.prepare("INSERT INTO sentence_attempts (id, submission_id, sentence_order, expected_text, heard_text, recording_path, duration_ms, wrong_words, total_words) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(attemptId, submissionId, index, expectedSentences[index], String(input.attempts[index]?.heardText || ""), recordingPath, Math.round(Number(input.attempts[index].durationSeconds) * 1000), results[index].wrong, results[index].total);
    }
    const today = businessDate();
    db.prepare("INSERT INTO attendance_daily (student_id, read_date, submission_id) VALUES (?, ?, ?) ON CONFLICT(student_id, read_date) DO UPDATE SET submission_id = excluded.submission_id").run(auth.sub, today, submissionId);
    return json(res, 201, { submissionId, score: studentDisplayScore(score), wrong, total, attempts: results.map((result, index) => ({ sentence: expectedSentences[index], result })) });
  }

  if (req.method === "GET" && url.pathname === "/api/teacher/dashboard") {
    const auth = requireRole(req, res, "teacher");
    if (!auth) return;
    const today = businessDate();
    const classes = db.prepare("SELECT id, name FROM classes WHERE status = 'active' ORDER BY name").all().map((classItem) => {
      const students = db.prepare("SELECT id, display_name AS name FROM students WHERE class_id = ? AND status = 'active' ORDER BY display_name").all(classItem.id).map((student) => {
        const readDays = db.prepare("SELECT read_date AS readDate FROM attendance_daily WHERE student_id = ? ORDER BY read_date").all(student.id).map((row) => row.readDate);
        const submissions = db.prepare(`SELECT s.id, s.score, s.wrong_words AS wrong, s.total_words AS total, s.submitted_at AS submittedAt, a.title AS articleTitle FROM submissions s JOIN articles a ON a.id = s.article_id WHERE s.student_id = ? ORDER BY s.submitted_at DESC LIMIT 8`).all(student.id).map((submission) => ({
          ...submission,
          attempts: db.prepare("SELECT id, sentence_order AS sentenceOrder, expected_text AS sentence, heard_text AS heardText, wrong_words AS wrong, total_words AS total, recording_path AS recordingPath FROM sentence_attempts WHERE submission_id = ? ORDER BY sentence_order").all(submission.id).map((attempt) => ({ ...attempt, audioUrl: attempt.recordingPath ? `/api/teacher/recordings/${attempt.id}` : "" }))
        }));
        const todaySubmission = db.prepare(`SELECT s.score, s.wrong_words AS wrong, s.total_words AS total, a.title AS articleTitle FROM attendance_daily ad JOIN submissions s ON s.id = ad.submission_id JOIN articles a ON a.id = s.article_id WHERE ad.student_id = ? AND ad.read_date = ?`).get(student.id, today);
        return { ...student, className: classItem.name, readDays, latestScore: submissions[0]?.score ?? "--", today: { completed: Boolean(todaySubmission), ...(todaySubmission || {}) }, submissions };
      });
      return { ...classItem, students };
    });
    const articles = db.prepare("SELECT id, title, booklist_number AS booklistNumber, processing_status AS processingStatus, processing_error AS processingError FROM articles ORDER BY booklist_number, created_at DESC").all().map((article) => ({
      ...article,
      assignedClasses: db.prepare("SELECT c.id, c.name FROM article_assignments aa JOIN classes c ON c.id = aa.class_id WHERE aa.article_id = ? AND c.status = 'active'").all(article.id),
      pages: articlePages(article.id)
    }));
    return json(res, 200, { date: today, classes, articles });
  }

  if (req.method === "POST" && url.pathname === "/api/teacher/classes") {
    const auth = requireRole(req, res, "teacher");
    if (!auth) return;
    const input = await bodyJson(req);
    const name = String(input.name || "").trim();
    if (!name || name.length > 80) return json(res, 400, { error: "班级名称不能为空且不能超过80个字符。" });
    const existing = db.prepare("SELECT id, status FROM classes WHERE LOWER(name) = LOWER(?)").get(name);
    if (existing?.status === "active") return json(res, 409, { error: "该班级名称已存在。" });
    if (existing) {
      db.prepare("UPDATE classes SET name = ?, status = 'active' WHERE id = ?").run(name, existing.id);
      return json(res, 200, { id: existing.id, name, restored: true });
    }
    const classId = id("class");
    db.prepare("INSERT INTO classes (id, name, status) VALUES (?, ?, 'active')").run(classId, name);
    return json(res, 201, { id: classId, name });
  }

  const classMatch = /^\/api\/teacher\/classes\/([^/]+)$/.exec(url.pathname);
  if (req.method === "PATCH" && classMatch) {
    const auth = requireRole(req, res, "teacher");
    if (!auth) return;
    const input = await bodyJson(req);
    const name = String(input.name || "").trim();
    if (!name || name.length > 80) return json(res, 400, { error: "班级名称不能为空且不能超过80个字符。" });
    const current = db.prepare("SELECT id FROM classes WHERE id = ? AND status = 'active'").get(classMatch[1]);
    if (!current) return json(res, 404, { error: "班级不存在。" });
    const duplicate = db.prepare("SELECT id FROM classes WHERE id <> ? AND LOWER(name) = LOWER(?)").get(classMatch[1], name);
    if (duplicate) return json(res, 409, { error: "该班级名称已存在。" });
    db.prepare("UPDATE classes SET name = ? WHERE id = ?").run(name, classMatch[1]);
    return json(res, 200, { id: classMatch[1], name });
  }

  if (req.method === "DELETE" && classMatch) {
    const auth = requireRole(req, res, "teacher");
    if (!auth) return;
    const current = db.prepare("SELECT id FROM classes WHERE id = ? AND status = 'active'").get(classMatch[1]);
    if (!current) return json(res, 404, { error: "班级不存在。" });
    const activeStudents = db.prepare("SELECT COUNT(*) AS count FROM students WHERE class_id = ? AND status = 'active'").get(classMatch[1]).count;
    if (activeStudents) return json(res, 409, { error: "请先转移或删除该班级中的在读学生，再删除班级。" });
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("DELETE FROM article_assignments WHERE class_id = ?").run(classMatch[1]);
      db.prepare("UPDATE classes SET status = 'deleted' WHERE id = ?").run(classMatch[1]);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/teacher/students") {
    const auth = requireRole(req, res, "teacher");
    if (!auth) return;
    const input = await bodyJson(req);
    const name = String(input.name || "").trim();
    const normalized = name.toLowerCase();
    if (!name || String(input.code || "").length < 8 || !input.classId) return json(res, 400, { error: "姓名、班级和至少8位 code 都是必填项。" });
    const targetClass = db.prepare("SELECT id FROM classes WHERE id = ? AND status = 'active'").get(String(input.classId));
    if (!targetClass) return json(res, 400, { error: "请选择有效班级。" });
    const existing = db.prepare("SELECT id FROM students WHERE normalized_name = ?").get(normalized);
    if (existing) {
      db.prepare("UPDATE students SET display_name = ?, class_id = ?, code_hash = ?, status = 'active', token_version = token_version + 1 WHERE id = ?").run(name, input.classId, hashSecret(String(input.code)), existing.id);
    } else {
      db.prepare("INSERT INTO students (id, class_id, display_name, normalized_name, code_hash) VALUES (?, ?, ?, ?, ?)").run(id("student"), input.classId, name, normalized, hashSecret(String(input.code)));
    }
    return json(res, 200, { ok: true });
  }

  const deleteStudentMatch = /^\/api\/teacher\/students\/([^/]+)$/.exec(url.pathname);
  if (req.method === "DELETE" && deleteStudentMatch) {
    const auth = requireRole(req, res, "teacher");
    if (!auth) return;
    db.prepare("UPDATE students SET status = 'deleted', token_version = token_version + 1 WHERE id = ?").run(deleteStudentMatch[1]);
    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/teacher/articles") {
    const auth = requireRole(req, res, "teacher");
    if (!auth) return;
    const input = await bodyJson(req);
    if (!String(input.title || "").trim() || !Array.isArray(input.pages) || !input.pages.length) return json(res, 400, { error: "文章标题和页面不能为空。" });
    const articleId = id("article");
    const booklistNumber = nextBooklistNumber();
    db.prepare("INSERT INTO articles (id, title, booklist_number) VALUES (?, ?, ?)").run(articleId, String(input.title).trim(), booklistNumber);
    input.pages.forEach((page, index) => db.prepare("INSERT INTO article_pages (id, article_id, page_order, image_data_url, text) VALUES (?, ?, ?, ?, ?)").run(id("page"), articleId, index, String(page.imageDataUrl || ""), String(page.text || "").trim()));
    return json(res, 201, { id: articleId, booklistNumber });
  }

  if (req.method === "POST" && url.pathname === "/api/teacher/pdfs") {
    const auth = requireRole(req, res, "teacher");
    if (!auth) return;
    const input = await bodyJson(req);
    const filename = path.basename(String(input.filename || "book.pdf"));
    const title = String(input.title || filename.replace(/\.(?:pdf|png)$/i, "")).trim();
    const dataUrl = String(input.dataUrl || "");
    const pdfMatch = /^data:application\/pdf;base64,(.+)$/i.exec(dataUrl);
    const pngMatch = /^data:image\/png;base64,(.+)$/i.exec(dataUrl);
    const match = pdfMatch || pngMatch;
    if (!title || !match) return json(res, 400, { error: "请选择有效的 PDF 或 PNG 文件。" });
    const sourceBuffer = Buffer.from(match[1], "base64");
    const isPdf = Boolean(pdfMatch);
    const validPdf = sourceBuffer.length >= 5 && sourceBuffer.subarray(0, 5).toString("ascii") === "%PDF-";
    const validPng = sourceBuffer.length >= 8 && sourceBuffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if ((isPdf && !validPdf) || (!isPdf && !validPng)) return json(res, 400, { error: "文件内容与 PDF / PNG 格式不匹配。" });
    const articleId = id("article");
    const bookDir = path.join(PDF_DIR, articleId);
    const sourcePath = path.join(bookDir, isPdf ? "source.pdf" : "source.png");
    await mkdir(bookDir, { recursive: true });
    await writeFile(sourcePath, sourceBuffer);
    const relativeSource = path.relative(DATA_DIR, sourcePath).replaceAll("\\", "/");
    const booklistNumber = nextBooklistNumber();
    try {
      db.prepare("INSERT INTO articles (id, title, source_filename, source_pdf_path, page_count, booklist_number, processing_status, processing_error) VALUES (?, ?, ?, ?, 0, ?, 'processing', '')")
        .run(articleId, title, filename, relativeSource, booklistNumber);
    } catch (error) {
      await rm(bookDir, { recursive: true, force: true });
      throw error;
    }
    enqueuePdfProcessing(articleId);
    return json(res, 202, { id: articleId, title, status: "processing", booklistNumber });
  }

  const reprocessArticleMatch = /^\/api\/teacher\/articles\/([^/]+)\/reprocess$/.exec(url.pathname);
  if (req.method === "POST" && reprocessArticleMatch) {
    const auth = requireRole(req, res, "teacher");
    if (!auth) return;
    const article = db.prepare("SELECT source_pdf_path AS sourcePdfPath FROM articles WHERE id = ?").get(reprocessArticleMatch[1]);
    if (!article?.sourcePdfPath || !existsSync(path.resolve(DATA_DIR, article.sourcePdfPath))) return json(res, 404, { error: "原始 PDF 文件不存在。" });
    db.prepare("UPDATE articles SET processing_status = 'processing', processing_error = '', page_count = 0 WHERE id = ?").run(reprocessArticleMatch[1]);
    enqueuePdfProcessing(reprocessArticleMatch[1]);
    return json(res, 202, { id: reprocessArticleMatch[1], status: "processing" });
  }

  const assignmentMatch = /^\/api\/teacher\/articles\/([^/]+)\/assignments$/.exec(url.pathname);
  if (req.method === "PUT" && assignmentMatch) {
    const auth = requireRole(req, res, "teacher");
    if (!auth) return;
    const article = db.prepare("SELECT processing_status AS processingStatus FROM articles WHERE id = ?").get(assignmentMatch[1]);
    if (!article || article.processingStatus !== "ready") return json(res, 409, { error: "PDF/OCR 处理完成后才能分配班级。" });
    const input = await bodyJson(req);
    const classIds = [...new Set((Array.isArray(input.classIds) ? input.classIds : []).map(String))];
    if (classIds.some((classId) => !db.prepare("SELECT 1 FROM classes WHERE id = ? AND status = 'active'").get(classId))) {
      return json(res, 400, { error: "分配列表包含无效班级。" });
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("DELETE FROM article_assignments WHERE article_id = ?").run(assignmentMatch[1]);
      for (const classId of classIds) db.prepare("INSERT INTO article_assignments (article_id, class_id) VALUES (?, ?)").run(assignmentMatch[1], classId);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return json(res, 200, { ok: true });
  }

  const pageMatch = /^\/api\/teacher\/pages\/([^/]+)$/.exec(url.pathname);
  if (req.method === "PATCH" && pageMatch) {
    const auth = requireRole(req, res, "teacher");
    if (!auth) return;
    const input = await bodyJson(req);
    db.prepare("UPDATE article_pages SET text = ? WHERE id = ?").run(String(input.text || ""), pageMatch[1]);
    return json(res, 200, { ok: true });
  }

  const deleteArticleMatch = /^\/api\/teacher\/articles\/([^/]+)$/.exec(url.pathname);
  if (req.method === "DELETE" && deleteArticleMatch) {
    const auth = requireRole(req, res, "teacher");
    if (!auth) return;
    const articleId = deleteArticleMatch[1];
    db.prepare("DELETE FROM articles WHERE id = ?").run(articleId);
    if (activePdfArticleId !== articleId) {
      await rm(path.join(PDF_DIR, articleId), { recursive: true, force: true });
    }
    return json(res, 200, { ok: true });
  }

  const recordingMatch = /^\/api\/teacher\/recordings\/([^/]+)$/.exec(url.pathname);
  if (req.method === "GET" && recordingMatch) {
    const auth = requireRole(req, res, "teacher");
    if (!auth) return;
    const attempt = db.prepare("SELECT recording_path FROM sentence_attempts WHERE id = ?").get(recordingMatch[1]);
    if (!attempt?.recording_path) return json(res, 404, { error: "Recording not found." });
    const file = await readFile(path.join(RECORDING_DIR, attempt.recording_path));
    res.writeHead(200, { "Content-Type": "audio/webm", "Content-Length": file.length, "Cache-Control": "private, no-store" });
    return res.end(file);
  }

  return json(res, 404, { error: "API route not found." });
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".md": "text/markdown; charset=utf-8" };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const resolved = path.resolve(ROOT, requested);
    if (!resolved.startsWith(ROOT) || !existsSync(resolved)) return json(res, 404, { error: "Not found." });
    const file = await readFile(resolved);
    res.writeHead(200, { "Content-Type": MIME[path.extname(resolved)] || "application/octet-stream" });
    res.end(file);
  } catch (error) {
    console.error(error);
    json(res, error.message === "PAYLOAD_TOO_LARGE" ? 413 : 500, { error: "服务器处理请求失败。" });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Sivan's Studio running at http://127.0.0.1:${PORT}`);
  console.log("Teacher account loaded from the database.");
  const pending = db.prepare("SELECT id FROM articles WHERE processing_status = 'processing' ORDER BY created_at").all();
  pending.forEach((article) => enqueuePdfProcessing(article.id));
  if (pending.length) console.log(`Resumed ${pending.length} pending PDF/OCR job(s).`);
});
