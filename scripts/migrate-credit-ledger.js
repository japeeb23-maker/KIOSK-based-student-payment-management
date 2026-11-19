const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { Pool } = require("pg");

function migrateSqlite(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'student_credit_ledger'").get();
    if (!table) throw new Error("The student credit ledger table does not exist.");
    const constraint = /,\s*UNIQUE\s*\(\s*transaction_id\s*,\s*credit_type\s*\)/i;
    if (!constraint.test(table.sql)) {
      db.exec("COMMIT");
      return false;
    }
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'student_credit_ledger_migrating'").get()) {
      throw new Error("A ledger migration table already exists; inspect it before retrying.");
    }
    const createTable = table.sql
      .replace(/^CREATE\s+TABLE\s+student_credit_ledger\b/i, "CREATE TABLE student_credit_ledger_migrating")
      .replace(constraint, "");
    if (createTable === table.sql || !createTable.startsWith("CREATE TABLE student_credit_ledger_migrating")) {
      throw new Error("The ledger schema is not recognized; migration stopped.");
    }
    const objects = db.prepare(`SELECT sql FROM sqlite_master
      WHERE tbl_name = 'student_credit_ledger' AND type IN ('index', 'trigger') AND sql IS NOT NULL`).all();
    const columns = db.prepare("PRAGMA table_info(student_credit_ledger)").all()
      .map(column => `"${column.name.replace(/"/g, '""')}"`).join(", ");
    db.exec(createTable);
    db.exec(`INSERT INTO student_credit_ledger_migrating (${columns}) SELECT ${columns} FROM student_credit_ledger`);
    db.exec("DROP TABLE student_credit_ledger");
    db.exec("ALTER TABLE student_credit_ledger_migrating RENAME TO student_credit_ledger");
    for (const object of objects) db.exec(object.sql);
    db.exec("COMMIT");
    return true;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

async function migratePostgres(connectionString) {
  const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: true }, connectionTimeoutMillis: 10000 });
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query("LOCK TABLE student_credit_ledger IN ACCESS EXCLUSIVE MODE");
    const { rows } = await client.query(`SELECT conname FROM pg_constraint
      WHERE conrelid = 'student_credit_ledger'::regclass AND contype = 'u'
      AND pg_get_constraintdef(oid) = 'UNIQUE (transaction_id, credit_type)'`);
    for (const row of rows) {
      const name = `"${row.conname.replace(/"/g, '""')}"`;
      await client.query(`ALTER TABLE student_credit_ledger DROP CONSTRAINT ${name}`);
    }
    await client.query("COMMIT");
    return rows.length > 0;
  } catch (error) {
    if (client) {
      try { await client.query("ROLLBACK"); }
      catch (rollbackError) { error.rollbackError = rollbackError; }
    }
    throw error;
  } finally {
    if (client) client.release();
    await pool.end();
  }
}

async function main() {
  if (!process.argv.includes("--confirm-migration")) {
    throw new Error("Stop the server, back up the database, then pass --confirm-migration.");
  }
  let changed;
  if (process.env.DATABASE_URL) {
    changed = await migratePostgres(process.env.DATABASE_URL);
  } else {
    if (process.env.NODE_ENV === "production") throw new Error("DATABASE_URL is required in production.");
    const databasePath = path.resolve(process.env.SQLITE_DATABASE_PATH || path.join(__dirname, "..", "data", "fbc-paypoint.sqlite"));
    if (!fs.existsSync(databasePath)) throw new Error("The SQLite database does not exist.");
    const db = new DatabaseSync(databasePath, { open: true });
    try { changed = migrateSqlite(db); }
    finally { db.close(); }
  }
  console.log(changed ? "Student credit ledger migrated." : "Student credit ledger is already migrated.");
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Credit ledger migration failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { migrateSqlite };
