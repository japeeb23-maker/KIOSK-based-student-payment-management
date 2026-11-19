const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createDatabase } = require("../src/server/database");

async function main() {
  const username = String(process.env.FBC_STAFF_USERNAME || "").trim().toUpperCase();
  const role = String(process.env.FBC_STAFF_ROLE || "").trim();
  const label = String(process.env.FBC_STAFF_LABEL || "").trim();
  const password = process.env.FBC_STAFF_PASSWORD || "";
  if (!/^[A-Z0-9_-]{3,64}$/.test(username) || !["cashier", "vp", "registrar"].includes(role) ||
      !label || label.length > 100 || password.length < 12 || password.length > 1024) {
    throw new Error("Set a valid FBC_STAFF_USERNAME, FBC_STAFF_ROLE, FBC_STAFF_LABEL, and password of at least 12 characters.");
  }
  const databasePath = path.resolve(process.env.SQLITE_DATABASE_PATH || path.join(__dirname, "..", "data", "fbc-paypoint.sqlite"));
  if (!process.env.DATABASE_URL && !fs.existsSync(databasePath)) throw new Error("The SQLite database does not exist. Initialize the server first.");
  const db = createDatabase({ databasePath });
  try {
    const salt = crypto.randomBytes(16);
    const hash = await new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (error, key) => error ? reject(error) : resolve(key)));
    await db.transaction(async transactionDb => {
      const current = await transactionDb.prepare("SELECT username FROM staff_users WHERE username = ?").get(username);
      if (current && !process.argv.includes("--replace")) throw new Error("This user already exists. Pass --replace to change the account and revoke its sessions.");
      if (current) {
        await transactionDb.prepare("UPDATE staff_users SET role = ?, label = ?, salt = ?, password_hash = ? WHERE username = ?")
          .run(role, label, salt.toString("hex"), hash.toString("hex"), username);
        await transactionDb.prepare("DELETE FROM sessions WHERE subject_id = ? AND role <> 'student'").run(username);
      } else {
        await transactionDb.prepare("INSERT INTO staff_users(username, role, label, salt, password_hash) VALUES (?, ?, ?, ?, ?)")
          .run(username, role, label, salt.toString("hex"), hash.toString("hex"));
      }
    });
    console.log("Staff account saved.");
  } finally {
    await db.close();
  }
}

main().catch(error => {
  console.error(`Staff account update failed: ${error.message}`);
  process.exitCode = 1;
});
