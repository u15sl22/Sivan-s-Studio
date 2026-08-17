#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const CHECKPOINT_VERSION = 1;
const MAX_SOURCE_BYTES = 88 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = new Set([".pdf", ".png"]);
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

function optionValue(name) {
  const prefix = `${name}=`;
  const inline = process.argv.find((argument) => argument.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasOption(name) {
  return process.argv.includes(name) || process.argv.some((argument) => argument.startsWith(`${name}=`));
}

function showHelp() {
  console.log(`Usage:
  node scripts/upload_library.mjs --directory /path/to/books [options]
  node scripts/upload_library.mjs --status [options]

Options:
  --url URL                 Forwarded application URL (default: http://127.0.0.1:8766)
  --directory PATH          Directory containing PDF/PNG files; subdirectories are scanned
  --username USERNAME       Teacher username (default: sivan.teacher)
  --checkpoint PATH         Local resume file (default: <directory>/.sivan-upload-state.json)
  --dry-run                 Validate and list files without connecting or uploading
  --status                  Show current server-side processing counts
  --allow-existing          Allow adding files when the server library is not empty
  --strip-number-prefix     Remove prefixes such as "001-" from generated titles
  --help                    Show this help

The teacher password is read from a hidden prompt. For non-interactive use only,
set SIVAN_UPLOAD_PASSWORD in the process environment.`);
}

function normalizeBaseUrl(value) {
  const url = new URL(value);
  if (!new Set(["http:", "https:"]).has(url.protocol)) throw new Error("Upload URL must use http or https.");
  return url.toString().replace(/\/$/, "");
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

async function collectReadingFiles(rootDirectory) {
  const files = [];

  async function walk(currentDirectory) {
    const entries = await readdir(currentDirectory, { withFileTypes: true });
    entries.sort((left, right) => collator.compare(left.name, right.name));
    for (const entry of entries) {
      const absolutePath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) await walk(absolutePath);
      else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        const metadata = await stat(absolutePath);
        files.push({
          absolutePath,
          relativePath: path.relative(rootDirectory, absolutePath).split(path.sep).join("/"),
          size: metadata.size,
          mtimeMs: Math.trunc(metadata.mtimeMs)
        });
      }
    }
  }

  await walk(rootDirectory);
  files.sort((left, right) => collator.compare(left.relativePath, right.relativePath));
  return files;
}

function titleForFile(file, stripNumberPrefix) {
  let title = path.basename(file.relativePath, path.extname(file.relativePath)).trim();
  if (stripNumberPrefix) title = title.replace(/^\s*\d+\s*[-_.、)]\s*/, "").trim();
  return title || path.basename(file.relativePath);
}

function validateSource(file, buffer) {
  if (!buffer.length) throw new Error(`${file.relativePath} is empty.`);
  if (buffer.length > MAX_SOURCE_BYTES) {
    throw new Error(`${file.relativePath} is ${formatBytes(buffer.length)}; the safe API limit is ${formatBytes(MAX_SOURCE_BYTES)}.`);
  }
  const extension = path.extname(file.relativePath).toLowerCase();
  const validPdf = buffer.length >= 5 && buffer.subarray(0, 5).toString("ascii") === "%PDF-";
  const validPng = buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if ((extension === ".pdf" && !validPdf) || (extension === ".png" && !validPng)) {
    throw new Error(`${file.relativePath} does not match its file extension.`);
  }
}

function importKeyFor(file, buffer) {
  const digest = createHash("sha256")
    .update(file.relativePath.normalize("NFC"))
    .update("\0")
    .update(buffer)
    .digest("hex");
  return `bulk-v1:${digest}`;
}

async function loadCheckpoint(checkpointPath, directory) {
  if (!existsSync(checkpointPath)) {
    return { version: CHECKPOINT_VERSION, directory, createdAt: new Date().toISOString(), files: {} };
  }
  const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
  if (checkpoint.version !== CHECKPOINT_VERSION) throw new Error(`Unsupported checkpoint version in ${checkpointPath}.`);
  if (path.resolve(checkpoint.directory) !== directory) throw new Error(`Checkpoint belongs to another directory: ${checkpoint.directory}`);
  if (!checkpoint.files || typeof checkpoint.files !== "object") throw new Error(`Invalid checkpoint: ${checkpointPath}`);
  return checkpoint;
}

async function saveCheckpoint(checkpointPath, checkpoint) {
  const temporaryPath = `${checkpointPath}.tmp`;
  checkpoint.updatedAt = new Date().toISOString();
  await writeFile(temporaryPath, `${JSON.stringify(checkpoint, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, checkpointPath);
}

async function readPassword() {
  if (process.env.SIVAN_UPLOAD_PASSWORD) return process.env.SIVAN_UPLOAD_PASSWORD;
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error("A TTY is required for the password prompt, or set SIVAN_UPLOAD_PASSWORD.");
  }
  return await new Promise((resolve, reject) => {
    let password = "";
    const finish = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      resolve(password);
    };
    const cancel = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      reject(new Error("Cancelled."));
    };
    const onData = (chunk) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u0003") return cancel();
        if (character === "\u007f" || character === "\b") password = password.slice(0, -1);
        else password += character;
      }
    };
    process.stdout.write("Teacher password: ");
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

class TeacherClient {
  constructor(baseUrl, username, password) {
    this.baseUrl = baseUrl;
    this.username = username;
    this.password = password;
    this.cookie = "";
  }

  async login() {
    const response = await fetch(`${this.baseUrl}/api/auth/teacher/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: this.username, password: this.password }),
      signal: AbortSignal.timeout(30_000)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(response.status, body.error || `Login failed with HTTP ${response.status}.`);
    const setCookie = response.headers.getSetCookie?.()[0] || response.headers.get("set-cookie") || "";
    const match = /(?:^|,\s*)(sivan_access=[^;]+)/.exec(setCookie);
    if (!match) throw new Error("Login succeeded but the session cookie was missing.");
    this.cookie = match[1];
  }

  async request(pathname, options = {}, allowRelogin = true) {
    if (!this.cookie) await this.login();
    const response = await fetch(`${this.baseUrl}${pathname}`, {
      ...options,
      headers: { ...options.headers, Cookie: this.cookie },
      signal: options.signal || AbortSignal.timeout(5 * 60_000)
    });
    if (response.status === 401 && allowRelogin) {
      await this.login();
      return await this.request(pathname, options, false);
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(response.status, body.error || `HTTP ${response.status}`);
    return body;
  }

  async libraryStatus() {
    return await this.request("/api/teacher/library/status");
  }

  async upload(payload) {
    return await this.request("/api/teacher/pdfs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  }
}

function printServerStatus(status) {
  console.table({ total: status.total || 0, processing: status.processing || 0, ready: status.ready || 0, failed: status.failed || 0 });
}

async function uploadWithRetry(client, payload, fileLabel) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await client.upload(payload);
    } catch (error) {
      lastError = error;
      const retryable = !(error instanceof ApiError) || error.status === 429 || error.status >= 500;
      if (!retryable || attempt === 3) break;
      const delay = attempt * 2000;
      console.warn(`${fileLabel}: upload attempt ${attempt} failed; retrying in ${delay / 1000}s (${error.message})`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

async function main() {
  if (hasOption("--help")) {
    showHelp();
    return;
  }

  const baseUrl = normalizeBaseUrl(optionValue("--url") || "http://127.0.0.1:8766");
  const username = optionValue("--username") || process.env.SIVAN_UPLOAD_USERNAME || "sivan.teacher";
  const statusOnly = hasOption("--status");
  const dryRun = hasOption("--dry-run");
  const directoryOption = optionValue("--directory");

  if (!statusOnly && !directoryOption) {
    showHelp();
    throw new Error("--directory is required for an upload.");
  }

  let directory;
  let files = [];
  let checkpointPath;
  let checkpoint;

  if (!statusOnly) {
    directory = path.resolve(directoryOption);
    const directoryMetadata = await stat(directory).catch(() => null);
    if (!directoryMetadata?.isDirectory()) throw new Error(`Book directory not found: ${directory}`);
    files = await collectReadingFiles(directory);
    if (!files.length) throw new Error(`No PDF or PNG files found under ${directory}.`);
    const tooLarge = files.filter((file) => file.size > MAX_SOURCE_BYTES);
    if (tooLarge.length) throw new Error(`${tooLarge.length} file(s) exceed the safe ${formatBytes(MAX_SOURCE_BYTES)} source limit.`);
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    console.log(`Found ${files.length} reading file(s), ${formatBytes(totalBytes)} total.`);
    files.forEach((file, index) => console.log(`${String(index + 1).padStart(3, " ")}  Booklist ${Math.floor(index / 10) + 1}  ${file.relativePath}  ${formatBytes(file.size)}`));

    if (dryRun) {
      console.log("Dry run complete. No server connection was made and no checkpoint was changed.");
      return;
    }

    checkpointPath = path.resolve(optionValue("--checkpoint") || path.join(directory, ".sivan-upload-state.json"));
    checkpoint = await loadCheckpoint(checkpointPath, directory);
  }

  const password = await readPassword();
  const client = new TeacherClient(baseUrl, username, password);
  await client.login();
  const initialStatus = await client.libraryStatus();
  console.log(`Connected to ${baseUrl} as ${username}.`);
  printServerStatus(initialStatus);

  if (statusOnly) return;

  const completedEntries = Object.values(checkpoint.files).filter((entry) => entry.status === "accepted").length;
  const serverArticleCount = Number(initialStatus.total || 0);
  const checkpointInitialized = Number.isInteger(checkpoint.initialServerArticleCount);
  if (serverArticleCount < completedEntries) {
    throw new Error("The server contains fewer books than this checkpoint. The library may have been reset; move the old checkpoint aside before starting a new import.");
  }
  if (serverArticleCount && completedEntries === 0 && !checkpointInitialized && !hasOption("--allow-existing")) {
    throw new Error("The server library is not empty and this checkpoint has no completed uploads. Reset it first, resume with the correct checkpoint, or pass --allow-existing intentionally.");
  }
  if (!checkpointInitialized) {
    checkpoint.initialServerArticleCount = serverArticleCount;
    checkpoint.serverUrl = baseUrl;
    await saveCheckpoint(checkpointPath, checkpoint);
  } else if (checkpoint.serverUrl && checkpoint.serverUrl !== baseUrl) {
    throw new Error(`Checkpoint was initialized for ${checkpoint.serverUrl}, not ${baseUrl}.`);
  }

  let accepted = 0;
  let skipped = 0;
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const previous = checkpoint.files[file.relativePath];
    if (previous?.status === "accepted" && previous.size === file.size && previous.mtimeMs === file.mtimeMs) {
      skipped += 1;
      console.log(`[${index + 1}/${files.length}] skip ${file.relativePath}`);
      continue;
    }

    console.log(`[${index + 1}/${files.length}] reading ${file.relativePath}`);
    const buffer = await readFile(file.absolutePath);
    validateSource(file, buffer);
    const extension = path.extname(file.relativePath).toLowerCase();
    const mimeType = extension === ".png" ? "image/png" : "application/pdf";
    const importKey = importKeyFor(file, buffer);
    const payload = {
      filename: path.basename(file.relativePath),
      title: titleForFile(file, hasOption("--strip-number-prefix")),
      importKey,
      dataUrl: `data:${mimeType};base64,${buffer.toString("base64")}`
    };
    const result = await uploadWithRetry(client, payload, file.relativePath);
    checkpoint.files[file.relativePath] = {
      status: "accepted",
      size: file.size,
      mtimeMs: file.mtimeMs,
      importKey,
      articleId: result.id,
      booklistNumber: result.booklistNumber,
      duplicate: Boolean(result.duplicate),
      acceptedAt: new Date().toISOString()
    };
    await saveCheckpoint(checkpointPath, checkpoint);
    accepted += 1;
    console.log(`[${index + 1}/${files.length}] ${result.duplicate ? "already accepted" : "accepted"} ${file.relativePath} -> Booklist ${result.booklistNumber}`);
  }

  console.log(`Upload pass complete: ${accepted} accepted/confirmed, ${skipped} skipped from checkpoint.`);
  console.log(`Checkpoint: ${checkpointPath}`);
  printServerStatus(await client.libraryStatus());
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
