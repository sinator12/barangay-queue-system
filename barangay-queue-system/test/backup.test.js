const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { createDatabaseBackup, restoreDatabase, verifyDatabase } = require("../backup");

test("verified backup and guarded restore preserve the original database", (t) => {
  const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "barangay-queue-backup-test-"));
  t.after(() => fs.rmSync(testDirectory, { recursive: true, force: true }));

  const sourcePath = path.join(testDirectory, "live.db");
  const restorePath = path.join(testDirectory, "restore.db");
  const backupDirectory = path.join(testDirectory, "backups");

  const sourceDatabase = new DatabaseSync(sourcePath);
  sourceDatabase.exec("PRAGMA journal_mode = WAL; CREATE TABLE sample (value TEXT NOT NULL); INSERT INTO sample VALUES ('kept');");
  const backupPath = createDatabaseBackup({
    databasePath: sourcePath,
    backupDirectory,
    retentionDays: 30
  });
  sourceDatabase.close();
  assert.equal(verifyDatabase(backupPath), true);

  const oldRestoreDatabase = new DatabaseSync(restorePath);
  oldRestoreDatabase.exec("CREATE TABLE sample (value TEXT NOT NULL); INSERT INTO sample VALUES ('old');");
  oldRestoreDatabase.close();

  const result = restoreDatabase({
    sourcePath: backupPath,
    databasePath: restorePath,
    backupDirectory
  });
  assert.equal(verifyDatabase(restorePath), true);
  assert.ok(result.safetyBackupPath);

  const restoredDatabase = new DatabaseSync(restorePath);
  assert.deepEqual(restoredDatabase.prepare("SELECT value FROM sample").all().map((row) => row.value), ["kept"]);
  restoredDatabase.close();

  const liveDatabase = new DatabaseSync(sourcePath);
  assert.deepEqual(liveDatabase.prepare("SELECT value FROM sample").all().map((row) => row.value), ["kept"]);
  liveDatabase.close();
});

test("restore rejects a corrupt backup without changing the target", (t) => {
  const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "barangay-queue-bad-restore-test-"));
  t.after(() => fs.rmSync(testDirectory, { recursive: true, force: true }));

  const corruptPath = path.join(testDirectory, "corrupt.db");
  const targetPath = path.join(testDirectory, "live.db");
  fs.writeFileSync(corruptPath, "not sqlite");
  const database = new DatabaseSync(targetPath);
  database.exec("CREATE TABLE sample (value TEXT NOT NULL); INSERT INTO sample VALUES ('untouched');");
  database.close();

  assert.throws(() => restoreDatabase({ sourcePath: corruptPath, databasePath: targetPath }), /integrity_check/);
  const target = new DatabaseSync(targetPath);
  assert.deepEqual(target.prepare("SELECT value FROM sample").all().map((row) => row.value), ["untouched"]);
  target.close();
});
