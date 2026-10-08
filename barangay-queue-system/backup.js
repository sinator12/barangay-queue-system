const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");
const { DatabaseSync } = require("node:sqlite");

const ROOT = __dirname;
const DATA_DIRECTORY = path.resolve(process.env.QUEUE_DATA_DIR || path.join(ROOT, "data"));
const DATABASE_PATH = path.join(DATA_DIRECTORY, "barangay-queue.db");
const AUTOMATIC_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

function getBackupSettings() {
  let settings = {};

  try {
    settings = JSON.parse(fs.readFileSync(path.join(ROOT, "backup-settings.json"), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new Error(`Could not read backup-settings.json: ${error.message}`);
    }
  }

  const directory = process.env.QUEUE_BACKUP_DIR || settings.directory || path.join("data", "backups");
  const retentionDays = Number(process.env.QUEUE_BACKUP_RETENTION_DAYS || settings.retentionDays || 30);

  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
    throw new Error("Backup retentionDays must be an integer between 1 and 3650.");
  }

  return {
    directory: path.resolve(ROOT, directory),
    retentionDays
  };
}

function quoteSqlString(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

function verifyDatabase(filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return false;
  }

  let checkDatabase;

  try {
    checkDatabase = new DatabaseSync(filePath);
    const result = checkDatabase.prepare("PRAGMA integrity_check").all();
    return result.length > 0 && result.every((row) => Object.values(row)[0] === "ok");
  } catch {
    return false;
  } finally {
    if (checkDatabase) checkDatabase.close();
  }
}

function listBackups(directory, prefix = "barangay-queue") {
  if (!fs.existsSync(directory)) {
    return [];
  }

  return fs.readdirSync(directory)
    .filter((name) => name.startsWith(`${prefix}-`) && name.endsWith(".db"))
    .map((name) => ({
      name,
      path: path.join(directory, name),
      modifiedAt: fs.statSync(path.join(directory, name)).mtimeMs
    }))
    .sort((left, right) => right.modifiedAt - left.modifiedAt);
}

function rotateBackups(directory, retentionDays, prefix = "barangay-queue") {
  const backupFiles = listBackups(directory, prefix);
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  for (const oldBackup of backupFiles) {
    if (oldBackup.modifiedAt < cutoff && oldBackup.path !== backupFiles[0]?.path) {
      fs.unlinkSync(oldBackup.path);
    }
  }
}

function createDatabaseBackup({
  databasePath = DATABASE_PATH,
  backupDirectory = getBackupSettings().directory,
  retentionDays = getBackupSettings().retentionDays,
  prefix = "barangay-queue"
} = {}) {
  if (!fs.existsSync(databasePath)) {
    throw new Error(`The database was not found: ${databasePath}`);
  }

  fs.mkdirSync(backupDirectory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDirectory, `${prefix}-${stamp}.db`);
  const sourceDatabase = new DatabaseSync(databasePath);

  try {
    sourceDatabase.exec("PRAGMA busy_timeout = 10000;");
    sourceDatabase.exec(`VACUUM INTO ${quoteSqlString(backupPath)}`);
  } finally {
    sourceDatabase.close();
  }

  if (!verifyDatabase(backupPath)) {
    fs.unlinkSync(backupPath);
    throw new Error("The new database backup did not pass SQLite integrity_check; it was removed.");
  }

  rotateBackups(backupDirectory, retentionDays, prefix);
  return backupPath;
}

function checkServerStopped(port = Number(process.env.PORT || 3000)) {
  return new Promise((resolve, reject) => {
    const probe = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;

    probe.setTimeout(1000);
    probe.once("connect", () => {
      settled = true;
      probe.destroy();
      reject(new Error(`A server is listening on port ${port}. Stop the queue server before restoring a backup.`));
    });
    probe.once("timeout", () => {
      if (settled) return;
      settled = true;
      probe.destroy();
      reject(new Error(`Could not confirm that port ${port} is free. Stop the queue server before restoring a backup.`));
    });
    probe.once("error", (error) => {
      if (settled) return;
      settled = true;
      if (error.code === "ECONNREFUSED") {
        resolve();
      } else {
        reject(new Error(`Could not confirm that the queue server is stopped: ${error.message}`));
      }
    });
  });
}

function createStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function restoreDatabase({ sourcePath, databasePath = DATABASE_PATH, backupDirectory = getBackupSettings().directory } = {}) {
  const source = path.resolve(sourcePath || "");
  const target = path.resolve(databasePath);

  if (!sourcePath || source === target || !fs.existsSync(source)) {
    throw new Error("Choose an existing backup file that is different from the live database.");
  }

  if (!verifyDatabase(source)) {
    throw new Error("The selected backup failed SQLite integrity_check. The live database was not changed.");
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.mkdirSync(backupDirectory, { recursive: true });
  const stamp = createStamp();
  const stagePath = `${target}.restore-${stamp}.tmp`;
  let staged = false;
  let previousPath = null;
  const sidecars = [`${target}-wal`, `${target}-shm`];
  const movedSidecars = [];

  try {
    fs.copyFileSync(source, stagePath, fs.constants.COPYFILE_EXCL);
    staged = true;

    if (!verifyDatabase(stagePath)) {
      throw new Error("The restore copy failed SQLite integrity_check. The live database was not changed.");
    }

    if (fs.existsSync(target)) {
      createDatabaseBackup({
        databasePath: target,
        backupDirectory,
        retentionDays: Number.MAX_SAFE_INTEGER,
        prefix: "pre-restore"
      });

      previousPath = `${target}.before-restore-${stamp}`;
      fs.renameSync(target, previousPath);

      for (const sidecar of sidecars) {
        if (fs.existsSync(sidecar)) {
          const preservedSidecar = `${previousPath}${sidecar.slice(target.length)}`;
          fs.renameSync(sidecar, preservedSidecar);
          movedSidecars.push({ original: sidecar, preserved: preservedSidecar });
        }
      }
    }

    fs.renameSync(stagePath, target);
    staged = false;
    previousPath = previousPath || null;
    return { restoredPath: target, safetyBackupPath: listBackups(backupDirectory, "pre-restore")[0]?.path || null };
  } catch (error) {
    if (previousPath && fs.existsSync(previousPath) && !fs.existsSync(target)) {
      fs.renameSync(previousPath, target);

      for (const sidecar of movedSidecars) {
        if (fs.existsSync(sidecar.preserved)) {
          fs.renameSync(sidecar.preserved, sidecar.original);
        }
      }
    }

    if (staged && fs.existsSync(stagePath)) {
      fs.unlinkSync(stagePath);
    }

    throw error;
  }
}

function runAutomaticBackup() {
  const settings = getBackupSettings();
  const latestBackup = listBackups(settings.directory)[0];

  if (latestBackup
    && Date.now() - latestBackup.modifiedAt < AUTOMATIC_BACKUP_INTERVAL_MS
    && verifyDatabase(latestBackup.path)) {
    return null;
  }

  return createDatabaseBackup({
    databasePath: DATABASE_PATH,
    backupDirectory: settings.directory,
    retentionDays: settings.retentionDays
  });
}

async function runRestoreCli(sourceArgument) {
  if (!stdin.isTTY) {
    throw new Error("Restore requires an interactive terminal so it can ask for confirmation.");
  }

  const settings = getBackupSettings();
  const requestedPath = path.resolve(settings.directory, sourceArgument || "");
  const expectedDirectory = path.resolve(settings.directory);

  if (path.dirname(requestedPath) !== expectedDirectory || !requestedPath.toLowerCase().endsWith(".db")) {
    throw new Error(`Choose a .db file directly inside the configured backup folder: ${expectedDirectory}`);
  }

  await checkServerStopped();
  const prompt = readline.createInterface({ input: stdin, output: stdout });

  try {
    console.log(`This will replace the live queue database with: ${requestedPath}`);
    console.log("A verified safety backup of the current database will be created first.");
    const answer = await prompt.question('Type RESTORE to continue: ');

    if (answer !== "RESTORE") {
      console.log("Restore cancelled. The live database was not changed.");
      return;
    }
  } finally {
    prompt.close();
  }

  const result = restoreDatabase({
    sourcePath: requestedPath,
    databasePath: DATABASE_PATH,
    backupDirectory: settings.directory
  });
  console.log(`Database restored. Safety backup: ${result.safetyBackupPath || "not needed"}`);
  console.log("Restart the queue server to use the restored records.");
}

async function main() {
  const [operation, argument] = process.argv.slice(2);

  if (operation === "--automatic") {
    const result = runAutomaticBackup();
    if (result) console.log(`Verified automatic database backup created: ${result}`);
    return;
  }

  if (operation === "--restore") {
    await runRestoreCli(argument);
    return;
  }

  if (operation !== "--now") {
    throw new Error("Use --now to make a backup now, --automatic for the server's scheduled check, or --restore <backup-file>. ");
  }

  const settings = getBackupSettings();
  const result = createDatabaseBackup({
    databasePath: DATABASE_PATH,
    backupDirectory: settings.directory,
    retentionDays: settings.retentionDays
  });
  console.log(`Verified database backup created: ${result}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  createDatabaseBackup,
  getBackupSettings,
  listBackups,
  restoreDatabase,
  runAutomaticBackup,
  verifyDatabase
};
