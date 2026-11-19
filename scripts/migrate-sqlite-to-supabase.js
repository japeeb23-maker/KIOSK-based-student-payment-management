const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { Pool } = require("pg");

const ROOT = path.resolve(__dirname, "..");
const TABLES = [
  ["app_state", ["state_key", "payload", "updated_at"]],
  ["staff_users", ["username", "role", "label", "salt", "password_hash"]],
  ["student_credentials", ["student_id", "salt", "pin_hash", "updated_at"]],
  ["sessions", ["token_hash", "role", "subject_id", "created_at", "expires_at"]],
  ["transactions", [
    "id", "student_id", "assessment_id", "channel", "payment_method", "status", "currency",
    "amount_due_minor", "amount_tendered_minor", "change_due_minor", "change_dispensed_minor",
    "change_credited_minor", "provider_payment_intent_id", "provider_payment_method_id",
    "provider_checkout_json", "idempotency_key", "created_at", "updated_at", "expires_at"
  ]],
  ["transaction_items", ["id", "transaction_id", "label", "amount_minor"]],
  ["cash_ledger_events", ["event_id", "transaction_id", "device_id", "event_type", "amount_minor", "occurred_at", "received_at"]],
  ["student_credit_ledger", ["id", "student_id", "transaction_id", "credit_type", "amount_minor", "description", "created_at"]],
  ["official_receipts", [
    "transaction_id", "or_number", "student_id", "assessment_id", "currency", "amount_due_minor",
    "amount_tendered_minor", "change_dispensed_minor", "change_credited_minor", "payment_method",
    "fee_breakdown_json", "escpos_payload", "issued_at"
  ]],
  ["payment_sequence", ["id", "next_number"]],
  ["paymongo_webhook_events", ["event_id", "event_type", "payload_sha256", "received_at"]],
  ["receipt_delivery_jobs", [
    "id", "transaction_id", "channel", "recipient", "status", "attempts", "next_attempt_at",
    "last_error", "created_at", "updated_at"
  ]]
];

function sourceValue(table, column, value) {
  if (table === "app_state" && column === "payload") {
    return JSON.stringify(typeof value === "string" ? JSON.parse(value) : value);
  }
  if (table === "official_receipts" && column === "escpos_payload" && value != null) {
    return Buffer.from(value);
  }
  return value;
}

async function main() {
  if (!process.argv.includes("--confirm-empty-target")) {
    throw new Error("Add --confirm-empty-target after verifying this Supabase database is the intended empty target.");
  }
  if (!process.env.DATABASE_URL) {
    throw new Error("Set DATABASE_URL in this PowerShell session to the Supabase connection string.");
  }

  const sourcePath = path.resolve(process.env.SQLITE_DATABASE_PATH || path.join(ROOT, "data", "fbc-paypoint.sqlite"));
  if (!fs.existsSync(sourcePath)) throw new Error(`SQLite database not found: ${sourcePath}`);

  const source = new DatabaseSync(sourcePath);
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: true },
    connectionTimeoutMillis: 10000,
    application_name: "fbc-paypoint-migration"
  });
  let sourceTransaction = false;
  let client;

  try {
    source.exec("PRAGMA query_only = ON");
    source.exec("BEGIN");
    sourceTransaction = true;

    client = await pool.connect();
    await client.query("BEGIN");
    await client.query(fs.readFileSync(path.join(ROOT, "supabase", "schema.sql"), "utf8"));
    await client.query(`LOCK TABLE ${TABLES.map(([table]) => table).join(", ")} IN ACCESS EXCLUSIVE MODE`);

    for (const [table] of TABLES) {
      const { rows } = await client.query(`SELECT count(*)::int AS count FROM ${table}`);
      const count = rows[0].count;
      if (table === "payment_sequence" && count === 1) {
        const { rows: sequenceRows } = await client.query("SELECT id, next_number FROM payment_sequence");
        if (sequenceRows[0].id === 1 && sequenceRows[0].next_number === 1) continue;
      }
      if (count !== 0) throw new Error(`Supabase target table "${table}" is not empty; migration stopped without importing data.`);
    }

    const counts = [];
    for (const [table, columns] of TABLES) {
      const rows = source.prepare(`SELECT ${columns.map(column => `"${column}"`).join(", ")} FROM "${table}"`).all();
      if (table === "payment_sequence") {
        await client.query("DELETE FROM payment_sequence WHERE id = 1 AND next_number = 1");
      }
      if (rows.length) {
        const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
        const insert = `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`;
        for (const row of rows) {
          const values = columns.map(column => sourceValue(table, column, row[column]));
          await client.query(insert, values);
        }
      }
      counts.push(`${table}=${rows.length}`);
    }

    await client.query(`
      SELECT setval(
        pg_get_serial_sequence('transaction_items', 'id'),
        COALESCE((SELECT max(id) FROM transaction_items), 1),
        EXISTS (SELECT 1 FROM transaction_items)
      )
    `);
    source.exec("COMMIT");
    sourceTransaction = false;
    await client.query("COMMIT");
    console.log("SQLite data imported successfully. Row counts:", counts.join(", "));
    console.log("Student records and payment details were not printed.");
  } catch (error) {
    if (client) {
      try { await client.query("ROLLBACK"); } catch {}
    }
    if (sourceTransaction) {
      try { source.exec("ROLLBACK"); } catch {}
      sourceTransaction = false;
    }
    throw error;
  } finally {
    if (client) client.release();
    await pool.end();
    source.close();
  }
}

main().catch(error => {
  console.error(`SQLite-to-Supabase migration failed: ${error.message}`);
  process.exitCode = 1;
});
