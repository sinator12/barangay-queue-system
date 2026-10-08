const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { createOtpAuthUri, createRecoveryCodes, createTotpSecret, hashRecoveryCode, verifyTotp } = require("./mfa");
const { getBackupSettings, listBackups, verifyDatabase } = require("./backup");

const ROOT_DIRECTORY = __dirname;
const DATA_DIRECTORY = path.resolve(process.env.QUEUE_DATA_DIR || path.join(ROOT_DIRECTORY, "data"));
const DATABASE_PATH = path.join(DATA_DIRECTORY, "barangay-queue.db");
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3000);
const APP_ORIGIN = process.env.APP_ORIGIN || `http://${HOST}:${PORT}`;
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || APP_ORIGIN)
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
);
const SESSION_DURATION_SECONDS = 8 * 60 * 60;
const PASSWORD_MINIMUM_LENGTH = 12;
const VALID_STATUSES = ["Waiting", "Serving", "Completed"];
const SERVICES = {
  A: "Barangay Clearance",
  B: "Certificate of Indigency",
  C: "Business Permit",
  D: "Resident Certification",
  E: "Other Documents"
};
const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
const PUBLIC_FILES = new Set([
  "index.html",
  "style.css",
  "script.js",
  "queue.js",
  "login.html",
  "login.css",
  "login.js",
  "setup.html",
  "setup.js",
  "admin.html",
  "admin.css",
  "admin.js"
  ,"display.html"
  ,"display.css"
  ,"display.js"
]);

fs.mkdirSync(DATA_DIRECTORY, { recursive: true });
const database = new DatabaseSync(DATABASE_PATH);
database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function initializeDatabase() {
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'staff')),
      created_at TEXT NOT NULL,
      last_login_at TEXT,
      mfa_secret TEXT,
      mfa_enabled INTEGER NOT NULL DEFAULT 0 CHECK (mfa_enabled IN (0, 1))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS queue_counters (
      prefix TEXT PRIMARY KEY,
      last_number INTEGER NOT NULL CHECK (last_number >= 0)
    );

    CREATE TABLE IF NOT EXISTS queue_items (
      id INTEGER PRIMARY KEY,
      number TEXT NOT NULL UNIQUE,
      service TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('Waiting', 'Serving', 'Completed')),
      created_at TEXT NOT NULL,
      served_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS one_serving_queue
    ON queue_items(status) WHERE status = 'Serving';

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY,
      actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      queue_item_id INTEGER REFERENCES queue_items(id) ON DELETE SET NULL,
      details TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS login_failures (
      username_key TEXT NOT NULL,
      client_key TEXT NOT NULL,
      failed_attempts INTEGER NOT NULL,
      window_started_at TEXT NOT NULL,
      locked_until TEXT,
      PRIMARY KEY (username_key, client_key)
    );

    CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (user_id, code_hash)
    );
  `);

  const userColumns = new Set(database.prepare("PRAGMA table_info(users)").all().map((column) => column.name));

  if (!userColumns.has("mfa_secret")) {
    database.exec("ALTER TABLE users ADD COLUMN mfa_secret TEXT");
  }

  if (!userColumns.has("mfa_enabled")) {
    database.exec("ALTER TABLE users ADD COLUMN mfa_enabled INTEGER NOT NULL DEFAULT 0 CHECK (mfa_enabled IN (0, 1))");
  }

  database.prepare(`
    DELETE FROM sessions
    WHERE user_id IN (SELECT id FROM users WHERE role = 'admin' AND mfa_enabled = 0)
  `).run();
}

function now() {
  return new Date().toISOString();
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024
  });

  return `scrypt$32768$8$1$${salt}$${hash.toString("hex")}`;
}

function verifyPassword(password, storedValue) {
  const [algorithm, N, r, p, salt, expectedHash] = storedValue.split("$");

  if (algorithm !== "scrypt" || !salt || !expectedHash) {
    return false;
  }

  const expectedBuffer = Buffer.from(expectedHash, "hex");
  const actualBuffer = crypto.scryptSync(password, salt, 64, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: 64 * 1024 * 1024
  });

  return expectedBuffer.length === actualBuffer.length && crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function validateUsername(username) {
  if (typeof username !== "string" || !/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
    throw new HttpError(400, "Username must contain 3–32 letters, numbers, dots, underscores, or hyphens.");
  }
}

function validatePassword(password) {
  if (typeof password !== "string" || password.length < PASSWORD_MINIMUM_LENGTH || password.length > 128) {
    throw new HttpError(400, `Password must be ${PASSWORD_MINIMUM_LENGTH}–128 characters long.`);
  }
}

function createUser(username, password, role) {
  validateUsername(username);
  validatePassword(password);

  if (!["admin", "staff"].includes(role)) {
    throw new HttpError(400, "Role must be admin or staff.");
  }

  try {
    const result = database.prepare(
      "INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)"
    ).run(username, hashPassword(password), role, now());

    return database.prepare("SELECT id, username, role, created_at AS createdAt FROM users WHERE id = ?").get(result.lastInsertRowid);
  } catch (error) {
    if (String(error.message).includes("UNIQUE constraint failed")) {
      throw new HttpError(409, "That username is already in use.");
    }

    throw error;
  }
}

function hasAdministrator() {
  return database.prepare("SELECT COUNT(*) AS total FROM users WHERE role = 'admin'").get().total > 0;
}

function createInitialAdminIfConfigured() {
  if (hasAdministrator()) {
    return;
  }

  const username = process.env.INITIAL_ADMIN_USERNAME;
  const password = process.env.INITIAL_ADMIN_PASSWORD;

  if (username && password) {
    createUser(username, password, "admin");
    console.log(`Initial administrator account created for ${username}.`);
  }
}

function createFirstAdministrator(username, password) {
  try {
    database.exec("BEGIN IMMEDIATE");

    if (hasAdministrator()) {
      throw new HttpError(409, "An administrator account has already been created. Please sign in.");
    }

    const user = createUser(username, password, "admin");
    addAuditLog(user.id, "initial_admin_created", null, `Created initial administrator account ${user.username}`);
    database.exec("COMMIT");
    return user;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function mapQueueItem(row) {
  return {
    id: row.id,
    number: row.number,
    service: row.service,
    status: row.status,
    createdAt: row.created_at,
    servedAt: row.served_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at
  };
}

function getQueueItems() {
  const rows = database.prepare(`
    SELECT id, number, service, status, created_at, served_at, completed_at, updated_at
    FROM queue_items
    ORDER BY
      CASE status WHEN 'Serving' THEN 0 WHEN 'Waiting' THEN 1 ELSE 2 END,
      created_at ASC
  `).all();

  return rows.map(mapQueueItem);
}

function getQueueStats() {
  const row = database.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'Waiting' THEN 1 ELSE 0 END) AS waiting,
      SUM(CASE WHEN status = 'Completed' THEN 1 ELSE 0 END) AS completed,
      MAX(CASE WHEN status = 'Serving' THEN number ELSE NULL END) AS serving
    FROM queue_items
  `).get();

  return {
    total: row.total || 0,
    waiting: row.waiting || 0,
    completed: row.completed || 0,
    serving: row.serving || null
  };
}

function addAuditLog(actorUserId, action, queueItemId, details) {
  database.prepare(
    "INSERT INTO audit_logs (actor_user_id, action, queue_item_id, details, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(actorUserId || null, action, queueItemId || null, details || null, now());
}

function kickUser(userId, actorUser) {
  if (userId === actorUser.id) {
    throw new HttpError(400, "You cannot sign yourself out from this screen. Use Sign Out instead.");
  }

  const targetUser = database.prepare("SELECT id, username, role FROM users WHERE id = ?").get(userId);

  if (!targetUser) {
    throw new HttpError(404, "User account not found.");
  }

  database.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  addAuditLog(actorUser.id, "user_kicked", null, `Signed out ${targetUser.role} account ${targetUser.username}`);
  return targetUser;
}

function removeStaffAccount(userId, actorUser) {
  if (userId === actorUser.id) {
    throw new HttpError(400, "You cannot remove your own account.");
  }

  const targetUser = database.prepare("SELECT id, username, role FROM users WHERE id = ?").get(userId);

  if (!targetUser) {
    throw new HttpError(404, "User account not found.");
  }

  if (targetUser.role !== "staff") {
    throw new HttpError(400, "Only staff accounts can be removed from this screen.");
  }

  database.prepare("DELETE FROM users WHERE id = ?").run(userId);
  addAuditLog(actorUser.id, "staff_account_removed", null, `Removed staff account ${targetUser.username}`);
  return targetUser;
}

function clearCompletedHistory(actorUser) {
  try {
    database.exec("BEGIN IMMEDIATE");
    const completedCount = database.prepare("SELECT COUNT(*) AS total FROM queue_items WHERE status = 'Completed'").get().total;
    database.prepare("DELETE FROM queue_items WHERE status = 'Completed'").run();
    addAuditLog(actorUser.id, "completed_history_cleared", null, `Removed ${completedCount} completed queue record(s); audit logs retained.`);
    database.exec("COMMIT");
    return completedCount;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function createQueueItem(serviceCode) {
  const service = SERVICES[serviceCode];

  if (!service) {
    throw new HttpError(400, "Choose a valid barangay service.");
  }

  try {
    database.exec("BEGIN IMMEDIATE");
    const counter = database.prepare("SELECT last_number FROM queue_counters WHERE prefix = ?").get(serviceCode);
    const nextNumber = (counter?.last_number || 0) + 1;
    const createdAt = now();

    if (counter) {
      database.prepare("UPDATE queue_counters SET last_number = ? WHERE prefix = ?").run(nextNumber, serviceCode);
    } else {
      database.prepare("INSERT INTO queue_counters (prefix, last_number) VALUES (?, ?)").run(serviceCode, nextNumber);
    }

    const result = database.prepare(`
      INSERT INTO queue_items (number, service, status, created_at, updated_at)
      VALUES (?, ?, 'Waiting', ?, ?)
    `).run(`${serviceCode}-${String(nextNumber).padStart(3, "0")}`, service, createdAt, createdAt);
    const activeQueueCount = database.prepare(`
      SELECT COUNT(*) AS total
      FROM queue_items
      WHERE id != ? AND status IN ('Waiting', 'Serving')
    `).get(result.lastInsertRowid).total;
    const automaticallyCalled = activeQueueCount === 0;

    if (automaticallyCalled) {
      database.prepare(`
        UPDATE queue_items
        SET status = 'Serving', served_at = ?, updated_at = ?
        WHERE id = ?
      `).run(createdAt, createdAt, result.lastInsertRowid);
      addAuditLog(null, "queue_auto_called", result.lastInsertRowid, `Automatically called ${serviceCode}-${String(nextNumber).padStart(3, "0")}`);
    }

    const queueItem = database.prepare(`
      SELECT id, number, service, status, created_at, served_at, completed_at, updated_at
      FROM queue_items WHERE id = ?
    `).get(result.lastInsertRowid);
    addAuditLog(null, "queue_created", queueItem.id, `Public kiosk created ${queueItem.number}`);
    database.exec("COMMIT");

    return { queueItem: mapQueueItem(queueItem), automaticallyCalled };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function getPublicQueue() {
  const servingQueue = database.prepare(`
    SELECT number, service FROM queue_items WHERE status = 'Serving' LIMIT 1
  `).get();
  const nextQueues = database.prepare(`
    SELECT number, service
    FROM queue_items
    WHERE status = 'Waiting'
    ORDER BY created_at ASC
    LIMIT 5
  `).all();

  return {
    serving: servingQueue || null,
    next: nextQueues
  };
}

function callNextQueue(actorUserId) {
  try {
    database.exec("BEGIN IMMEDIATE");
    const nextQueue = database.prepare(`
      SELECT id, number, service, status, created_at, served_at, completed_at, updated_at
      FROM queue_items WHERE status = 'Waiting' ORDER BY created_at ASC LIMIT 1
    `).get();

    if (!nextQueue) {
      database.exec("COMMIT");
      return null;
    }

    const currentQueue = database.prepare("SELECT id, number FROM queue_items WHERE status = 'Serving'").get();
    const changedAt = now();

    if (currentQueue) {
      database.prepare(`
        UPDATE queue_items
        SET status = 'Completed', completed_at = ?, updated_at = ?
        WHERE id = ?
      `).run(changedAt, changedAt, currentQueue.id);
      addAuditLog(actorUserId, "queue_completed", currentQueue.id, `Completed while calling ${nextQueue.number}`);
    }

    database.prepare(`
      UPDATE queue_items
      SET status = 'Serving', served_at = ?, updated_at = ?
      WHERE id = ?
    `).run(changedAt, changedAt, nextQueue.id);
    addAuditLog(actorUserId, "queue_called", nextQueue.id, `Called ${nextQueue.number}`);
    const calledQueue = database.prepare(`
      SELECT id, number, service, status, created_at, served_at, completed_at, updated_at
      FROM queue_items WHERE id = ?
    `).get(nextQueue.id);
    database.exec("COMMIT");

    return mapQueueItem(calledQueue);
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function updateQueueStatus(queueId, newStatus, actorUserId) {
  if (!VALID_STATUSES.includes(newStatus)) {
    throw new HttpError(400, "Choose a valid queue status.");
  }

  try {
    database.exec("BEGIN IMMEDIATE");
    const selectedQueue = database.prepare("SELECT id, number FROM queue_items WHERE id = ?").get(queueId);

    if (!selectedQueue) {
      throw new HttpError(404, "Queue ticket not found.");
    }

    const changedAt = now();

    if (newStatus === "Serving") {
      const currentQueue = database.prepare("SELECT id, number FROM queue_items WHERE status = 'Serving' AND id != ?").get(queueId);

      if (currentQueue) {
        database.prepare(`
          UPDATE queue_items
          SET status = 'Completed', completed_at = ?, updated_at = ?
          WHERE id = ?
        `).run(changedAt, changedAt, currentQueue.id);
        addAuditLog(actorUserId, "queue_completed", currentQueue.id, `Completed while serving ${selectedQueue.number}`);
      }

      database.prepare(`
        UPDATE queue_items
        SET status = 'Serving', served_at = ?, completed_at = NULL, updated_at = ?
        WHERE id = ?
      `).run(changedAt, changedAt, queueId);
    } else if (newStatus === "Completed") {
      database.prepare(`
        UPDATE queue_items
        SET status = 'Completed', completed_at = ?, updated_at = ?
        WHERE id = ?
      `).run(changedAt, changedAt, queueId);
    } else {
      database.prepare(`
        UPDATE queue_items
        SET status = 'Waiting', served_at = NULL, completed_at = NULL, updated_at = ?
        WHERE id = ?
      `).run(changedAt, queueId);
    }

    addAuditLog(actorUserId, "queue_status_updated", queueId, `${selectedQueue.number} set to ${newStatus}`);
    const updatedQueue = database.prepare(`
      SELECT id, number, service, status, created_at, served_at, completed_at, updated_at
      FROM queue_items WHERE id = ?
    `).get(queueId);
    database.exec("COMMIT");

    return mapQueueItem(updatedQueue);
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function getCookie(req, name) {
  const cookies = req.headers.cookie || "";
  const cookie = cookies.split(";").map((entry) => entry.trim()).find((entry) => entry.startsWith(`${name}=`));
  return cookie ? decodeURIComponent(cookie.slice(name.length + 1)) : null;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function getAuthenticatedUser(req) {
  const token = getCookie(req, "barangay_session");

  if (!token) {
    return null;
  }

  database.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now());
  return database.prepare(`
    SELECT users.id, users.username, users.role
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `).get(hashToken(token), now()) || null;
}

function requireUser(req, allowedRoles) {
  const user = getAuthenticatedUser(req);

  if (!user) {
    throw new HttpError(401, "Please sign in to continue.");
  }

  if (allowedRoles && !allowedRoles.includes(user.role)) {
    throw new HttpError(403, "You do not have permission for this action.");
  }

  return user;
}

function setSessionCookie(res, token) {
  const secureFlag = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `barangay_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DURATION_SECONDS}${secureFlag}`
  );
}

function clearSessionCookie(res) {
  const secureFlag = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `barangay_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureFlag}`);
}

function assertSameOrigin(req) {
  const origin = req.headers.origin;

  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    throw new HttpError(403, "Invalid request origin.");
  }
}

function getLoginKeys(req, username) {
  return {
    username: String(username || "").trim().slice(0, 128).toLowerCase(),
    client: req.socket.remoteAddress || "unknown"
  };
}

function loginIsThrottled(req, username) {
  const keys = getLoginKeys(req, username);
  const currentTime = now();
  const cutoff = new Date(Date.now() - LOGIN_FAILURE_WINDOW_MS).toISOString();
  const record = database.prepare(`
    SELECT failed_attempts AS failedAttempts, window_started_at AS windowStartedAt, locked_until AS lockedUntil
    FROM login_failures WHERE username_key = ? AND client_key = ?
  `).get(keys.username, keys.client);

  database.prepare(`
    DELETE FROM login_failures
    WHERE window_started_at <= ? AND (locked_until IS NULL OR locked_until <= ?)
  `).run(cutoff, currentTime);

  if (!record) {
    return false;
  }

  if (record.lockedUntil && record.lockedUntil > currentTime) {
    return true;
  }

  if (record.windowStartedAt <= cutoff) {
    database.prepare("DELETE FROM login_failures WHERE username_key = ? AND client_key = ?").run(keys.username, keys.client);
    return false;
  }

  return record.failedAttempts >= LOGIN_FAILURE_LIMIT;
}

function registerFailedLogin(req, username) {
  const keys = getLoginKeys(req, username);
  const currentTime = now();
  const cutoff = new Date(Date.now() - LOGIN_FAILURE_WINDOW_MS).toISOString();
  const record = database.prepare(`
    SELECT failed_attempts AS failedAttempts, window_started_at AS windowStartedAt
    FROM login_failures WHERE username_key = ? AND client_key = ?
  `).get(keys.username, keys.client);
  const isExpired = !record || record.windowStartedAt <= cutoff;
  const failedAttempts = isExpired ? 1 : record.failedAttempts + 1;
  const windowStartedAt = isExpired ? currentTime : record.windowStartedAt;
  const lockedUntil = failedAttempts >= LOGIN_FAILURE_LIMIT
    ? new Date(Date.now() + LOGIN_LOCKOUT_MS).toISOString()
    : null;

  database.prepare(`
    INSERT INTO login_failures (username_key, client_key, failed_attempts, window_started_at, locked_until)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(username_key, client_key) DO UPDATE SET
      failed_attempts = excluded.failed_attempts,
      window_started_at = excluded.window_started_at,
      locked_until = excluded.locked_until
  `).run(keys.username, keys.client, failedAttempts, windowStartedAt, lockedUntil);

  return Boolean(lockedUntil);
}

function clearFailedLogins(req, username) {
  const keys = getLoginKeys(req, username);
  database.prepare("DELETE FROM login_failures WHERE username_key = ? AND client_key = ?").run(keys.username, keys.client);
}

function isLocalAddress(address) {
  const normalized = String(address || "").toLowerCase().replace(/^::ffff:/, "");
  return normalized === "127.0.0.1" || normalized === "::1";
}

function verifyRecoveryCode(userId, submittedCode) {
  const normalizedCode = typeof submittedCode === "string" ? submittedCode.toUpperCase().replace(/[\s-]/g, "") : "";

  if (!/^[A-Z2-7]{16}$/.test(normalizedCode)) {
    return false;
  }

  const submittedHash = hashRecoveryCode(normalizedCode);
  const saved = database.prepare(`
    SELECT id, code_hash AS codeHash
    FROM mfa_recovery_codes WHERE user_id = ? AND code_hash = ?
  `).get(userId, submittedHash);

  if (!saved) {
    return false;
  }

  const expected = Buffer.from(saved.codeHash, "hex");
  const actual = Buffer.from(submittedHash, "hex");

  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return false;
  }

  database.prepare("DELETE FROM mfa_recovery_codes WHERE id = ?").run(saved.id);
  return true;
}

function createUserSession(user, res) {
  const token = crypto.randomBytes(32).toString("base64url");
  const createdAt = now();
  const expiresAt = new Date(Date.now() + SESSION_DURATION_SECONDS * 1000).toISOString();
  database.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)").run(
    hashToken(token), user.id, expiresAt, createdAt
  );
  database.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(createdAt, user.id);
  addAuditLog(user.id, "user_logged_in", null, "Successful sign-in");
  setSessionCookie(res, token);
  return { id: user.id, username: user.username, role: user.role };
}

function getBackupStatus() {
  const settings = getBackupSettings();
  const backups = listBackups(settings.directory);
  const latest = backups[0];

  return {
    directory: settings.directory,
    retentionDays: settings.retentionDays,
    backupCount: backups.length,
    latest: latest ? {
      name: latest.name,
      createdAt: new Date(latest.modifiedAt).toISOString(),
      valid: verifyDatabase(latest.path)
    } : null
  };
}

function runOnDemandBackup() {
  if (backupProcess && !backupProcess.killed) {
    throw new HttpError(409, "A database backup is already running. Try again when it finishes.");
  }

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT_DIRECTORY, "backup.js"), "--now"], {
      cwd: ROOT_DIRECTORY,
      env: process.env,
      stdio: "ignore",
      windowsHide: true
    });
    backupProcess = child;
    child.once("error", (error) => {
      if (backupProcess === child) backupProcess = null;
      reject(new Error(`Could not start a database backup: ${error.message}`));
    });
    child.once("exit", (code) => {
      if (backupProcess === child) backupProcess = null;
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`The database backup failed with exit code ${code ?? "unknown"}. Check the server log.`));
      }
    });
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let requestBody = "";

    req.on("data", (chunk) => {
      requestBody += chunk;

      if (requestBody.length > 64 * 1024) {
        reject(new HttpError(413, "Request is too large."));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!requestBody) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(requestBody));
      } catch {
        reject(new HttpError(400, "Request body must be valid JSON."));
      }
    });

    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin"
  });
  res.end(JSON.stringify(payload));
}

function sendError(res, error) {
  const statusCode = error instanceof HttpError ? error.statusCode : 500;
  const message = error instanceof HttpError ? error.message : "An unexpected server error occurred.";

  if (statusCode >= 500) {
    console.error(error);
  }

  sendJson(res, statusCode, { error: message });
}

async function handleApiRequest(req, res, pathname) {
  if (req.method !== "GET") {
    assertSameOrigin(req);
  }

  if (pathname === "/api/setup/status" && req.method === "GET") {
    sendJson(res, 200, { setupRequired: !hasAdministrator() });
    return;
  }

  if (pathname === "/api/health" && req.method === "GET") {
    database.prepare("SELECT 1").get();
    sendJson(res, 200, { status: "ok", timestamp: now() });
    return;
  }

  if (pathname === "/api/setup/initial-admin" && req.method === "POST") {
    if (!isLocalAddress(req.socket.remoteAddress)) {
      throw new HttpError(403, "Create the first Administrator from the queue server computer.");
    }

    const body = await readJson(req);
    const user = createFirstAdministrator(body.username?.trim(), body.password);
    sendJson(res, 201, { user });
    return;
  }

  if (pathname === "/api/auth/me" && req.method === "GET") {
    const user = requireUser(req);
    sendJson(res, 200, { user });
    return;
  }

  if (pathname === "/api/auth/login" && req.method === "POST") {
    const body = await readJson(req);
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";

    if (!hasAdministrator()) {
      throw new HttpError(409, "Setup is required before staff can sign in.");
    }

    if (loginIsThrottled(req, username)) {
      throw new HttpError(429, "Too many sign-in attempts. Try again in 15 minutes.");
    }

    const user = database.prepare(`
      SELECT id, username, password_hash, role, mfa_secret AS mfaSecret, mfa_enabled AS mfaEnabled
      FROM users WHERE username = ?
    `).get(username);

    if (!user || !verifyPassword(password, user.password_hash)) {
      registerFailedLogin(req, username);
      const throttled = loginIsThrottled(req, username);
      throw new HttpError(throttled ? 429 : 401, throttled
        ? "Too many sign-in attempts. Try again in 15 minutes."
        : "Invalid username or password.");
    }

    if (user.role === "admin" && !user.mfaEnabled) {
      if (!isLocalAddress(req.socket.remoteAddress)) {
        throw new HttpError(403, "Administrator two-step sign-in must first be set up from the queue server computer.");
      }

      const secret = user.mfaSecret || createTotpSecret();

      if (!user.mfaSecret) {
        database.prepare("UPDATE users SET mfa_secret = ? WHERE id = ?").run(secret, user.id);
      }

      sendJson(res, 428, {
        error: "Set up an authenticator app to finish Administrator sign-in.",
        mfaSetupRequired: true,
        mfaSecret: secret,
        otpAuthUri: createOtpAuthUri(user.username, secret)
      });
      return;
    }

    if (user.role === "admin") {
      const code = typeof body.mfaCode === "string" ? body.mfaCode.trim() : "";

      if (!code) {
        sendJson(res, 428, { error: "Enter your authenticator code or a one-time recovery code.", mfaRequired: true });
        return;
      }

      const validTotp = verifyTotp(user.mfaSecret, code);
      const validRecoveryCode = !validTotp && verifyRecoveryCode(user.id, code);

      if (!validTotp && !validRecoveryCode) {
        registerFailedLogin(req, username);
        const throttled = loginIsThrottled(req, username);
        throw new HttpError(throttled ? 429 : 401, throttled
          ? "Too many sign-in attempts. Try again in 15 minutes."
          : "Invalid username, password, or authenticator code.");
      }

      if (validRecoveryCode) {
        addAuditLog(user.id, "mfa_recovery_code_used", null, "A one-time Administrator recovery code was used.");
      }
    }

    clearFailedLogins(req, username);
    sendJson(res, 200, { user: createUserSession(user, res) });
    return;
  }

  if (pathname === "/api/auth/mfa/enroll" && req.method === "POST") {
    if (!isLocalAddress(req.socket.remoteAddress)) {
      throw new HttpError(403, "Set up Administrator two-step sign-in from the queue server computer.");
    }

    const body = await readJson(req);
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const code = typeof body.code === "string" ? body.code.trim() : "";

    if (loginIsThrottled(req, username)) {
      throw new HttpError(429, "Too many sign-in attempts. Try again in 15 minutes.");
    }

    const user = database.prepare(`
      SELECT id, username, password_hash, role, mfa_secret AS mfaSecret, mfa_enabled AS mfaEnabled
      FROM users WHERE username = ?
    `).get(username);

    if (!user || user.role !== "admin" || !verifyPassword(password, user.password_hash)) {
      registerFailedLogin(req, username);
      const throttled = loginIsThrottled(req, username);
      throw new HttpError(throttled ? 429 : 401, throttled
        ? "Too many sign-in attempts. Try again in 15 minutes."
        : "Invalid Administrator credentials.");
    }

    if (user.mfaEnabled || !user.mfaSecret) {
      throw new HttpError(409, "Administrator two-step sign-in is already set up or needs to be restarted. Sign in again.");
    }

    if (!verifyTotp(user.mfaSecret, code)) {
      registerFailedLogin(req, username);
      const throttled = loginIsThrottled(req, username);
      throw new HttpError(throttled ? 429 : 401, throttled
        ? "Too many sign-in attempts. Try again in 15 minutes."
        : "That authenticator code is not valid. Check the device clock and try again.");
    }

    const recoveryCodes = createRecoveryCodes();

    try {
      database.exec("BEGIN IMMEDIATE");
      database.prepare("UPDATE users SET mfa_enabled = 1 WHERE id = ? AND mfa_enabled = 0").run(user.id);
      const insertCode = database.prepare(
        "INSERT INTO mfa_recovery_codes (user_id, code_hash, created_at) VALUES (?, ?, ?)"
      );

      for (const recoveryCode of recoveryCodes) {
        insertCode.run(user.id, hashRecoveryCode(recoveryCode), now());
      }

      addAuditLog(user.id, "admin_mfa_enabled", null, "Administrator enabled authenticator-based two-step sign-in.");
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }

    clearFailedLogins(req, username);
    sendJson(res, 200, {
      user: createUserSession(user, res),
      recoveryCodes
    });
    return;
  }

  if (pathname === "/api/auth/logout" && req.method === "POST") {
    const token = getCookie(req, "barangay_session");

    if (token) {
      database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
    }

    clearSessionCookie(res);
    sendJson(res, 200, { success: true });
    return;
  }

  if (pathname === "/api/queues" && req.method === "GET") {
    requireUser(req, ["admin", "staff"]);
    sendJson(res, 200, { items: getQueueItems(), stats: getQueueStats() });
    return;
  }

  if (pathname === "/api/queues" && req.method === "POST") {
    const body = await readJson(req);
    const result = createQueueItem(body.serviceCode);
    sendJson(res, 201, result);
    return;
  }

  if (pathname === "/api/public/queue" && req.method === "GET") {
    sendJson(res, 200, getPublicQueue());
    return;
  }

  if (pathname === "/api/queues/call-next" && req.method === "POST") {
    const user = requireUser(req, ["admin", "staff"]);
    const queueItem = callNextQueue(user.id);
    sendJson(res, 200, { queueItem });
    return;
  }

  const statusRoute = pathname.match(/^\/api\/queues\/(\d+)\/status$/);

  if (statusRoute && req.method === "PATCH") {
    const user = requireUser(req, ["admin", "staff"]);
    const body = await readJson(req);
    const queueItem = updateQueueStatus(Number(statusRoute[1]), body.status, user.id);
    sendJson(res, 200, { queueItem });
    return;
  }

  if (pathname === "/api/reports" && req.method === "GET") {
    requireUser(req, ["admin"]);
    const queueItems = getQueueItems();
    const serviceBreakdown = queueItems.reduce((counts, queueItem) => {
      counts[queueItem.service] = (counts[queueItem.service] || 0) + 1;
      return counts;
    }, {});
    sendJson(res, 200, { stats: getQueueStats(), serviceBreakdown });
    return;
  }

  if (pathname === "/api/backups" && req.method === "GET") {
    requireUser(req, ["admin"]);
    sendJson(res, 200, getBackupStatus());
    return;
  }

  if (pathname === "/api/backups/run" && req.method === "POST") {
    requireUser(req, ["admin"]);
    await runOnDemandBackup();
    sendJson(res, 200, { ...getBackupStatus(), created: true });
    return;
  }

  if (pathname === "/api/users" && req.method === "GET") {
    requireUser(req, ["admin"]);
    const users = database.prepare(`
      SELECT id, username, role, created_at AS createdAt, last_login_at AS lastLoginAt
      FROM users ORDER BY username ASC
    `).all();
    sendJson(res, 200, { users });
    return;
  }

  if (pathname === "/api/users" && req.method === "POST") {
    const admin = requireUser(req, ["admin"]);
    const body = await readJson(req);
    const user = createUser(body.username?.trim(), body.password, body.role);
    addAuditLog(admin.id, "user_created", null, `Created ${user.role} account ${user.username}`);
    sendJson(res, 201, { user });
    return;
  }

  const kickUserRoute = pathname.match(/^\/api\/users\/(\d+)\/kick$/);

  if (kickUserRoute && req.method === "POST") {
    const admin = requireUser(req, ["admin"]);
    const user = kickUser(Number(kickUserRoute[1]), admin);
    sendJson(res, 200, { user });
    return;
  }

  const removeUserRoute = pathname.match(/^\/api\/users\/(\d+)$/);

  if (removeUserRoute && req.method === "DELETE") {
    const admin = requireUser(req, ["admin"]);
    const user = removeStaffAccount(Number(removeUserRoute[1]), admin);
    sendJson(res, 200, { user });
    return;
  }

  if (pathname === "/api/history/completed" && req.method === "DELETE") {
    const admin = requireUser(req, ["admin"]);
    const removedCount = clearCompletedHistory(admin);
    sendJson(res, 200, { removedCount });
    return;
  }

  throw new HttpError(404, "API endpoint not found.");
}

function getContentType(filePath) {
  const contentTypes = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml"
  };

  return contentTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function serveStaticFile(req, res, pathname) {
  const requestedFile = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));

  if (!PUBLIC_FILES.has(requestedFile)) {
    throw new HttpError(404, "Page not found.");
  }

  const filePath = path.resolve(ROOT_DIRECTORY, requestedFile);

  if (!filePath.startsWith(`${ROOT_DIRECTORY}${path.sep}`) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    throw new HttpError(404, "Page not found.");
  }

  res.writeHead(200, {
    "Content-Type": getContentType(filePath),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
    "Referrer-Policy": "same-origin"
  });
  fs.createReadStream(filePath).pipe(res);
}

initializeDatabase();
createInitialAdminIfConfigured();

let backupProcess = null;
let isShuttingDown = false;

function runAutomaticBackupCheck() {
  if (process.env.QUEUE_DISABLE_AUTOMATIC_BACKUPS === "1" || (backupProcess && !backupProcess.killed)) {
    return;
  }

  backupProcess = spawn(process.execPath, [path.join(ROOT_DIRECTORY, "backup.js"), "--automatic"], {
    cwd: ROOT_DIRECTORY,
    env: process.env,
    stdio: "inherit",
    windowsHide: true
  });
  backupProcess.once("error", (error) => console.error(`Automatic backup could not start: ${error.message}`));
  backupProcess.once("exit", (code) => {
    if (code && !isShuttingDown) console.error(`Automatic backup check failed with exit code ${code}.`);
    backupProcess = null;
  });
}

runAutomaticBackupCheck();
const backupCheckTimer = setInterval(runAutomaticBackupCheck, 60 * 60 * 1000);
backupCheckTimer.unref();

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, APP_ORIGIN);

    if (requestUrl.pathname.startsWith("/api/")) {
      await handleApiRequest(req, res, requestUrl.pathname);
    } else {
      serveStaticFile(req, res, requestUrl.pathname);
    }
  } catch (error) {
    sendError(res, error);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Barangay Queue System is running at ${APP_ORIGIN}`);
});

function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  clearInterval(backupCheckTimer);

  if (backupProcess && !backupProcess.killed) {
    backupProcess.kill();
  }

  server.close(() => {
    database.close();
    process.exit(0);
  });
  server.closeAllConnections?.();
  setTimeout(() => {
    database.close();
    process.exit(1);
  }, 5000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
