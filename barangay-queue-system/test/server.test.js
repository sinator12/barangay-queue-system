const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const net = require("node:net");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { DatabaseSync } = require("node:sqlite");
const test = require("node:test");
const assert = require("node:assert/strict");

const ROOT = path.resolve(__dirname, "..");
const SERVER_PATH = path.join(ROOT, "server.js");
const ADMIN_USERNAME = "testadmin";
const ADMIN_PASSWORD = "AdminPassphrase-2026!";
const STAFF_USERNAME = "teststaff";
const STAFF_PASSWORD = "StaffPassphrase-2026!";

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function decodeBase32(value) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let accumulator = 0;
  let bits = 0;
  const bytes = [];

  for (const character of value) {
    accumulator = (accumulator << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >> bits) & 255);
      accumulator &= (1 << bits) - 1;
    }
  }

  return Buffer.from(bytes);
}

function authenticatorCode(secret, timestamp = Date.now()) {
  const counter = BigInt(Math.floor(timestamp / 30_000));
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(counter);
  const digest = crypto.createHmac("sha1", decodeBase32(secret)).update(counterBytes).digest();
  const offset = digest[digest.length - 1] & 15;
  const code = (((digest[offset] & 127) << 24)
    | ((digest[offset + 1] & 255) << 16)
    | ((digest[offset + 2] & 255) << 8)
    | (digest[offset + 3] & 255)) % 1_000_000;
  return String(code).padStart(6, "0");
}

async function startServer(port, dataDirectory, backupDirectory, stderrState) {
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      APP_ORIGIN: origin,
      ALLOWED_ORIGINS: origin,
      QUEUE_DATA_DIR: dataDirectory,
      QUEUE_BACKUP_DIR: backupDirectory,
      QUEUE_DISABLE_AUTOMATIC_BACKUPS: "1"
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  child.stderr.on("data", (chunk) => { stderrState.value += chunk.toString(); });

  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Test server exited early: ${stderrState.value}`);
    }
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) return { child, origin };
    } catch {
      // The child can take a short moment to bind its test port.
    }
    await delay(100);
  }

  child.kill();
  throw new Error(`Test server did not become healthy: ${stderrState.value}`);
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), delay(5000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function request(origin, route, { method = "GET", body, cookie } = {}) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(`${origin}${route}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  const payload = await response.json();
  const setCookie = response.headers.get("set-cookie");
  return {
    response,
    payload,
    cookie: setCookie ? setCookie.split(";")[0] : null,
    setCookie
  };
}

test("admin MFA, staff permissions, ticket flow, and login throttling survive a restart", async (t) => {
  const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "barangay-queue-server-test-"));
  const dataDirectory = path.join(testDirectory, "data");
  const backupDirectory = path.join(testDirectory, "backups");
  fs.mkdirSync(dataDirectory);
  const port = await reservePort();
  const stderrState = { value: "" };
  let server = await startServer(port, dataDirectory, backupDirectory, stderrState);
  t.after(async () => {
    await stopServer(server?.child);
    fs.rmSync(testDirectory, { recursive: true, force: true });
  });

  const setup = await request(server.origin, "/api/setup/initial-admin", {
    method: "POST",
    body: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD }
  });
  assert.equal(setup.response.status, 201);

  const firstAdminLogin = await request(server.origin, "/api/auth/login", {
    method: "POST",
    body: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD }
  });
  assert.equal(firstAdminLogin.response.status, 428);
  assert.equal(firstAdminLogin.payload.mfaSetupRequired, true);

  const enrollment = await request(server.origin, "/api/auth/mfa/enroll", {
    method: "POST",
    body: {
      username: ADMIN_USERNAME,
      password: ADMIN_PASSWORD,
      code: authenticatorCode(firstAdminLogin.payload.mfaSecret)
    }
  });
  assert.equal(enrollment.response.status, 200, JSON.stringify(enrollment.payload));
  assert.match(enrollment.setCookie, /HttpOnly/i);
  assert.match(enrollment.setCookie, /SameSite=Strict/i);
  assert.equal(enrollment.payload.recoveryCodes.length, 10);
  const adminCookie = enrollment.cookie;

  const addStaff = await request(server.origin, "/api/users", {
    method: "POST",
    cookie: adminCookie,
    body: { username: STAFF_USERNAME, password: STAFF_PASSWORD, role: "staff" }
  });
  assert.equal(addStaff.response.status, 201);

  const noMfaCode = await request(server.origin, "/api/auth/login", {
    method: "POST",
    body: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD }
  });
  assert.equal(noMfaCode.response.status, 428);
  assert.equal(noMfaCode.payload.mfaRequired, true);

  const firstTicket = await request(server.origin, "/api/queues", { method: "POST", body: { serviceCode: "A" } });
  const secondTicket = await request(server.origin, "/api/queues", { method: "POST", body: { serviceCode: "A" } });
  assert.equal(firstTicket.payload.queueItem.number, "A-001");
  assert.equal(firstTicket.payload.queueItem.status, "Serving");
  assert.equal(secondTicket.payload.queueItem.number, "A-002");
  assert.equal(secondTicket.payload.queueItem.status, "Waiting");

  const simultaneousTickets = await Promise.all(Array.from({ length: 5 }, () => request(server.origin, "/api/queues", {
    method: "POST",
    body: { serviceCode: "B" }
  })));
  const simultaneousNumbers = simultaneousTickets.map((ticket) => ticket.payload.queueItem.number).sort();
  assert.deepEqual(simultaneousNumbers, ["B-001", "B-002", "B-003", "B-004", "B-005"]);

  const staffLogin = await request(server.origin, "/api/auth/login", {
    method: "POST",
    body: { username: STAFF_USERNAME, password: STAFF_PASSWORD }
  });
  assert.equal(staffLogin.response.status, 200);
  const forbiddenReports = await request(server.origin, "/api/reports", { cookie: staffLogin.cookie });
  assert.equal(forbiddenReports.response.status, 403);
  const forbiddenBackup = await request(server.origin, "/api/backups/run", {
    method: "POST",
    cookie: staffLogin.cookie
  });
  assert.equal(forbiddenBackup.response.status, 403);

  const callNext = await request(server.origin, "/api/queues/call-next", {
    method: "POST",
    cookie: staffLogin.cookie
  });
  assert.equal(callNext.response.status, 200);
  assert.equal(callNext.payload.queueItem.number, "A-002");
  const queues = await request(server.origin, "/api/queues", { cookie: staffLogin.cookie });
  assert.deepEqual(queues.payload.items.filter((item) => item.number.startsWith("A-")).map((item) => [item.number, item.status]), [
    ["A-002", "Serving"],
    ["A-001", "Completed"]
  ]);

  const manualBackup = await request(server.origin, "/api/backups/run", {
    method: "POST",
    cookie: adminCookie
  });
  assert.equal(manualBackup.response.status, 200, JSON.stringify(manualBackup.payload));
  assert.equal(manualBackup.payload.latest.valid, true);
  assert.equal(manualBackup.payload.backupCount, 1);

  const recoveryCode = enrollment.payload.recoveryCodes[0];
  const recoveryLogin = await request(server.origin, "/api/auth/login", {
    method: "POST",
    body: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD, mfaCode: recoveryCode }
  });
  assert.equal(recoveryLogin.response.status, 200);
  await request(server.origin, "/api/auth/logout", { method: "POST", cookie: recoveryLogin.cookie });
  const reusedRecoveryCode = await request(server.origin, "/api/auth/login", {
    method: "POST",
    body: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD, mfaCode: recoveryCode }
  });
  assert.equal(reusedRecoveryCode.response.status, 401);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const failedLogin = await request(server.origin, "/api/auth/login", {
      method: "POST",
      body: { username: STAFF_USERNAME, password: "wrong password" }
    });
    assert.equal(failedLogin.response.status, attempt === 4 ? 429 : 401);
  }

  await stopServer(server.child);
  server = await startServer(port, dataDirectory, backupDirectory, stderrState);
  const lockedAfterRestart = await request(server.origin, "/api/auth/login", {
    method: "POST",
    body: { username: STAFF_USERNAME, password: STAFF_PASSWORD }
  });
  assert.equal(lockedAfterRestart.response.status, 429);
});

test("legacy databases migrate safely and revoke pre-MFA Administrator sessions", async (t) => {
  const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "barangay-queue-migration-test-"));
  const dataDirectory = path.join(testDirectory, "data");
  const backupDirectory = path.join(testDirectory, "backups");
  fs.mkdirSync(dataDirectory);
  const databasePath = path.join(dataDirectory, "barangay-queue.db");
  const legacyDatabase = new DatabaseSync(databasePath);
  legacyDatabase.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'staff')),
      created_at TEXT NOT NULL,
      last_login_at TEXT
    );
    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  const salt = crypto.randomBytes(16).toString("hex");
  const passwordHash = crypto.scryptSync(ADMIN_PASSWORD, salt, 64, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024
  });
  const createdAt = new Date().toISOString();
  legacyDatabase.prepare(`
    INSERT INTO users (id, username, password_hash, role, created_at)
    VALUES (1, ?, ?, 'admin', ?)
  `).run(ADMIN_USERNAME, `scrypt$32768$8$1$${salt}$${passwordHash.toString("hex")}`, createdAt);

  const legacyToken = "pre-mfa-session-token";
  const legacyTokenHash = crypto.createHash("sha256").update(legacyToken).digest("hex");
  legacyDatabase.prepare(`
    INSERT INTO sessions (token_hash, user_id, expires_at, created_at)
    VALUES (?, 1, ?, ?)
  `).run(legacyTokenHash, new Date(Date.now() + 60 * 60 * 1000).toISOString(), createdAt);
  legacyDatabase.close();

  const port = await reservePort();
  const stderrState = { value: "" };
  const server = await startServer(port, dataDirectory, backupDirectory, stderrState);
  t.after(async () => {
    await stopServer(server.child);
    fs.rmSync(testDirectory, { recursive: true, force: true });
  });

  const oldSession = await request(server.origin, "/api/auth/me", {
    cookie: `barangay_session=${legacyToken}`
  });
  assert.equal(oldSession.response.status, 401);

  const adminLogin = await request(server.origin, "/api/auth/login", {
    method: "POST",
    body: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD }
  });
  assert.equal(adminLogin.response.status, 428);
  assert.equal(adminLogin.payload.mfaSetupRequired, true);
});
