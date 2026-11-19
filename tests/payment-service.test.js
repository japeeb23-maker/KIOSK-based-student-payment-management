const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { createDatabase: createSqliteDatabase } = require("../src/server/database");
const { migrateSqlite } = require("../scripts/migrate-credit-ledger");
const {
  PaymentService,
  applyCashDeviceEvent,
  cashAcceptance,
  calculateCashChange,
  expireCashTransactions,
  processPayMongoWebhook,
  verifyPayMongoSignature
} = require("../src/server/payment-service");

const schema = fs.readFileSync(path.join(__dirname, "..", "db", "payments.sql"), "utf8");

function createDatabase({ channel = "CASH", status = "CASH_ACCEPTING", amountDueMinor = 10000, paymentSchema = schema } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE app_state (
    state_key TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  db.exec(paymentSchema);
  const state = {
    students: [{ id: "S-TEST-1", studentNo: "TEST-001", name: "Test Student", course: "BS IT", year: "1st Year", email: "student@example.test" }],
    assessments: [{ id: "A-TEST-1", studentId: "S-TEST-1", term: "Test Term", items: [{ label: "Tuition", amount: 100 }] }],
    payments: [],
    notes: []
  };
  db.prepare("INSERT INTO app_state(state_key, payload, updated_at) VALUES ('paypoint', ?, ?)")
    .run(JSON.stringify(state), new Date().toISOString());
  const transactionId = "TX-test-payment-0001";
  db.prepare(`INSERT INTO transactions
    (id, student_id, assessment_id, channel, payment_method, status, amount_due_minor,
     idempotency_key, created_at, updated_at, expires_at, provider_payment_intent_id)
    VALUES (?, 'S-TEST-1', 'A-TEST-1', ?, ?, ?, ?, 'test-idempotency', ?, ?, ?, ?)`).run(
    transactionId,
    channel,
    channel === "CASH" ? "CASH" : "QRPH",
    status,
    amountDueMinor,
    new Date().toISOString(),
    new Date().toISOString(),
    new Date(Date.now() + 60000).toISOString(),
    channel === "PAYMONGO" ? "pi_test_1" : null
  );
  db.prepare("INSERT INTO transaction_items(transaction_id, label, amount_minor) VALUES (?, 'Tuition', ?)")
    .run(transactionId, amountDueMinor);
  return { db, transactionId };
}

function signedWebhook(payload, secret = "test-webhook-secret") {
  const rawBody = Buffer.from(JSON.stringify(payload));
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto.createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest("hex");
  return { rawBody, signatureHeader: `t=${timestamp},te=${signature}` };
}

test("cash settlement creates one payment and one immutable official receipt", async () => {
  const { db, transactionId } = createDatabase();
  const event = {
    eventId: "cash-event-exact-0001",
    transactionId,
    type: "CASH_INSERTED",
    amountMinor: 10000
  };

  const first = await applyCashDeviceEvent(db, "acceptor-01", event);
  const duplicate = await applyCashDeviceEvent(db, "acceptor-01", event);

  assert.equal(first.status, "PAID");
  assert.equal(first.receipt.orNumber, "FBC-" + new Date().getUTCFullYear() + "-00000001");
  const receiptBytes = Buffer.from(first.receipt.escposBase64, "base64");
  assert.ok(receiptBytes.includes(Buffer.from([0x1b, 0x40])));
  assert.ok(receiptBytes.includes(Buffer.from([0x1b, 0x61, 0x01])));
  assert.ok(receiptBytes.includes(Buffer.from([0x1d, 0x56, 0x00])));
  assert.equal(duplicate.status, "PAID");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM official_receipts").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM app_state").get().count, 1);
  const state = JSON.parse(db.prepare("SELECT payload FROM app_state WHERE state_key = 'paypoint'").get().payload);
  assert.equal(state.payments.length, 1);
  db.close();
});

test("receipt text cannot inject printer control commands", async () => {
  const { db, transactionId } = createDatabase();
  const state = JSON.parse(db.prepare("SELECT payload FROM app_state WHERE state_key = 'paypoint'").get().payload);
  state.assessments[0].items[0].label = "Tuition\x1b\x40\nExtra";
  db.prepare("UPDATE app_state SET payload = ? WHERE state_key = 'paypoint'").run(JSON.stringify(state));
  const result = await applyCashDeviceEvent(db, "acceptor-01", {
    eventId: "cash-print-sanitize-001", transactionId, type: "CASH_INSERTED", amountMinor: 10000
  });
  const bytes = Buffer.from(result.receipt.escposBase64, "base64");
  assert.ok(bytes.includes(Buffer.from("Tuition?@?Extra")));
  assert.equal(bytes.indexOf(Buffer.from([0x1b, 0x40]), 1), -1);
  db.close();
});

test("cash change shortage credits the undisposed change and itemizes it on the receipt", async () => {
  const { db, transactionId } = createDatabase();

  const inserted = await applyCashDeviceEvent(db, "acceptor-01", {
    eventId: "cash-event-overpay-001",
    transactionId,
    type: "CASH_INSERTED",
    amountMinor: 12000
  });
  assert.equal(inserted.status, "CHANGE_PENDING");
  assert.equal(inserted.changeDueMinor, 2000);

  const settled = await applyCashDeviceEvent(db, "acceptor-01", {
    eventId: "cash-event-change-shortage-01",
    transactionId,
    type: "INSUFFICIENT_CHANGE",
    amountMinor: 500
  });
  assert.equal(settled.status, "PAID");
  assert.equal(settled.changeDispensedMinor, 500);
  assert.equal(settled.changeCreditedMinor, 1500);
  assert.equal(db.prepare("SELECT amount_minor FROM student_credit_ledger").get().amount_minor, 1500);
  db.close();
});

test("cash acceptance allows a larger bill and handles change", async () => {
  const { db, transactionId } = createDatabase({ amountDueMinor: 1250 });
  const acceptance = await cashAcceptance(db, transactionId);
  assert.ok(acceptance.allowedDenominationsMinor.includes(2000));
  const inserted = await applyCashDeviceEvent(db, "acceptor-01", {
    eventId: "cash-small-due-001", transactionId, type: "CASH_INSERTED", amountMinor: 2000
  });
  assert.equal(inserted.status, "CHANGE_PENDING");
  assert.equal(inserted.changeDueMinor, 750);
  const settled = await applyCashDeviceEvent(db, "acceptor-01", {
    eventId: "cash-small-change-001", transactionId, type: "INSUFFICIENT_CHANGE", amountMinor: 0
  });
  assert.equal(settled.status, "PAID");
  assert.equal(settled.changeCreditedMinor, 750);
  db.close();
});

test("late bills after expiry are credited once per event without double counting earlier cash", async () => {
  const { db, transactionId } = createDatabase();
  await applyCashDeviceEvent(db, "acceptor-01", {
    eventId: "cash-before-expiry-001", transactionId, type: "CASH_INSERTED", amountMinor: 2000
  });
  db.prepare("UPDATE transactions SET expires_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 1000).toISOString(), transactionId);
  const firstLate = { eventId: "cash-after-expiry-001", transactionId, type: "CASH_INSERTED", amountMinor: 2000 };
  assert.equal((await applyCashDeviceEvent(db, "acceptor-01", firstLate)).status, "EXPIRED");
  await applyCashDeviceEvent(db, "acceptor-01", firstLate);
  await applyCashDeviceEvent(db, "acceptor-01", {
    eventId: "cash-after-expiry-002", transactionId, type: "CASH_INSERTED", amountMinor: 5000
  });
  await expireCashTransactions(db);
  const credits = db.prepare("SELECT amount_minor FROM student_credit_ledger ORDER BY amount_minor").all();
  assert.deepEqual(credits.map(row => row.amount_minor), [2000, 2000, 5000]);
  db.close();
});

test("confirmed payment exceeding the remaining balance is credited and receipted", async () => {
  const { db, transactionId } = createDatabase({ channel: "PAYMONGO", status: "PENDING" });
  const state = JSON.parse(db.prepare("SELECT payload FROM app_state WHERE state_key = 'paypoint'").get().payload);
  state.payments.push({ assessmentId: "A-TEST-1", studentId: "S-TEST-1", amount: 75 });
  db.prepare("UPDATE app_state SET payload = ? WHERE state_key = 'paypoint'").run(JSON.stringify(state));
  const signed = signedWebhook({ data: { id: "evt_overpayment_001", attributes: {
    type: "payment.paid",
    data: { id: "pay_overpayment_001", attributes: { payment_intent_id: "pi_test_1", amount: 10000, currency: "PHP" } }
  } } });
  await processPayMongoWebhook(db, signed.rawBody, signed.signatureHeader, "test-webhook-secret");
  const updated = JSON.parse(db.prepare("SELECT payload FROM app_state WHERE state_key = 'paypoint'").get().payload);
  assert.equal(updated.payments[1].amount, 25);
  assert.equal(db.prepare("SELECT amount_minor FROM student_credit_ledger WHERE transaction_id = ?").get(transactionId).amount_minor, 7500);
  const receipt = db.prepare("SELECT fee_breakdown_json FROM official_receipts WHERE transaction_id = ?").get(transactionId);
  assert.deepEqual(JSON.parse(receipt.fee_breakdown_json), [
    { label: "Tuition", amountMinor: 2500 },
    { label: "Overpayment credited to account", amountMinor: 7500 }
  ]);
  db.close();
});

test("a confirmed payment for an already paid assessment is entirely credited", async () => {
  const { db, transactionId } = createDatabase({ channel: "PAYMONGO", status: "PENDING" });
  const state = JSON.parse(db.prepare("SELECT payload FROM app_state WHERE state_key = 'paypoint'").get().payload);
  state.payments.push({ assessmentId: "A-TEST-1", studentId: "S-TEST-1", amount: 100 });
  db.prepare("UPDATE app_state SET payload = ? WHERE state_key = 'paypoint'").run(JSON.stringify(state));
  const signed = signedWebhook({ data: { id: "evt_fully_credited_001", attributes: {
    type: "payment.paid",
    data: { id: "pay_fully_credited_001", attributes: { payment_intent_id: "pi_test_1", amount: 10000, currency: "PHP" } }
  } } });
  await processPayMongoWebhook(db, signed.rawBody, signed.signatureHeader, "test-webhook-secret");
  const updated = JSON.parse(db.prepare("SELECT payload FROM app_state WHERE state_key = 'paypoint'").get().payload);
  assert.equal(updated.payments.length, 1);
  assert.equal(db.prepare("SELECT amount_minor FROM student_credit_ledger WHERE transaction_id = ?").get(transactionId).amount_minor, 10000);
  assert.equal(db.prepare("SELECT status FROM transactions WHERE id = ?").get(transactionId).status, "PAID");
  db.close();
});

test("PayMongo webhook verifies signature, amount and idempotent settlement", async () => {
  const { db } = createDatabase({ channel: "PAYMONGO", status: "PENDING" });
  const payload = {
    data: {
      id: "evt_test_paid_001",
      attributes: {
        type: "payment.paid",
        data: {
          id: "pay_test_001",
          attributes: { payment_intent_id: "pi_test_1", amount: 10000, currency: "PHP" }
        }
      }
    }
  };
  const signed = signedWebhook(payload);
  assert.equal(verifyPayMongoSignature(signed.rawBody, signed.signatureHeader, "test-webhook-secret"), true);
  const result = await processPayMongoWebhook(db, signed.rawBody, signed.signatureHeader, "test-webhook-secret");
  const duplicate = await processPayMongoWebhook(db, signed.rawBody, signed.signatureHeader, "test-webhook-secret");

  assert.equal(result.processed, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM official_receipts").get().count, 1);
  assert.equal(JSON.parse(db.prepare("SELECT payload FROM app_state WHERE state_key = 'paypoint'").get().payload).payments.length, 1);
  db.close();
});

test("free demo gateway settles immediately and creates an official receipt", async () => {
  const { db } = createDatabase({ channel: "PAYMONGO", status: "PENDING" });
  const service = new PaymentService(db, {});

  const result = await service.startDigital({ subjectId: "S-TEST-1" }, {
    assessmentId: "A-TEST-1",
    amount: 100,
    method: "FREE_GATEWAY"
  }, "free-demo-idempotency");

  assert.equal(result.status, "PAID");
  assert.equal(result.paymentMethod, "FREE_GATEWAY");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM official_receipts").get().count, 1);
  assert.equal(JSON.parse(db.prepare("SELECT payload FROM app_state WHERE state_key = 'paypoint'").get().payload).payments.length, 1);
  db.close();
});

test("free demo gateway is unavailable in production", async () => {
  const { db } = createDatabase({ channel: "PAYMONGO", status: "PENDING" });
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const service = new PaymentService(db, {});
    await assert.rejects(
      service.startDigital({ subjectId: "S-TEST-1" }, {
        assessmentId: "A-TEST-1",
        amount: 100,
        method: "FREE_GATEWAY"
      }, "free-demo-production-idempotency"),
      { statusCode: 403 }
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM transactions").get().count, 1);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    db.close();
  }
});

test("signed webhook with a mismatched amount cannot mark a transaction paid", async () => {
  const { db } = createDatabase({ channel: "PAYMONGO", status: "PENDING" });
  const payload = {
    data: {
      id: "evt_test_wrong_amount",
      attributes: {
        type: "payment.paid",
        data: {
          id: "pay_test_002",
          attributes: { payment_intent_id: "pi_test_1", amount: 9999, currency: "PHP" }
        }
      }
    }
  };
  const signed = signedWebhook(payload);

  await assert.rejects(
    processPayMongoWebhook(db, signed.rawBody, signed.signatureHeader, "test-webhook-secret"),
    { statusCode: 409 }
  );
  assert.equal(db.prepare("SELECT status FROM transactions").get().status, "PENDING");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM official_receipts").get().count, 0);
  db.close();
});

test("cash change calculation uses exact integer centavos", () => {
  assert.equal(calculateCashChange(1250, 2000), 750);
  assert.equal(calculateCashChange(1250, 1000), 0);
  assert.throws(() => calculateCashChange(1.25, 200), TypeError);
});

test("credit ledger migration preserves entries and immutable triggers", () => {
  const legacySchema = schema.replace(
    /description TEXT NOT NULL,\r?\n  created_at TEXT NOT NULL\r?\n\);/,
    "description TEXT NOT NULL,\n  created_at TEXT NOT NULL,\n  UNIQUE (transaction_id, credit_type)\n);"
  );
  assert.notEqual(legacySchema, schema);
  const { db, transactionId } = createDatabase({ paymentSchema: legacySchema });
  const insert = db.prepare("INSERT INTO student_credit_ledger VALUES (?, 'S-TEST-1', ?, 'CASH_CANCELLED', 2000, 'test', '2026-01-01')");
  insert.run("credit-1", transactionId);
  assert.equal(migrateSqlite(db), true);
  assert.equal(migrateSqlite(db), false);
  db.prepare("INSERT INTO student_credit_ledger VALUES (?, 'S-TEST-1', ?, 'CASH_CANCELLED', 2000, 'test', '2026-01-01')")
    .run("credit-2", transactionId);
  assert.equal(db.prepare("SELECT count(*) AS count FROM student_credit_ledger").get().count, 2);
  assert.throws(() => db.prepare("DELETE FROM student_credit_ledger").run(), /immutable/i);
  assert.throws(() => db.prepare("UPDATE student_credit_ledger SET amount_minor = 3000").run(), /immutable/i);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'student_credit_student'").get());
  db.close();
});

test("SQLite adapter keeps outside queries out of an async transaction", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fbc-paypoint-test-"));
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousNodeEnv = process.env.NODE_ENV;
  delete process.env.DATABASE_URL;
  process.env.NODE_ENV = "test";
  const db = createSqliteDatabase({ databasePath: path.join(directory, "test.sqlite") });
  try {
    await db.exec("CREATE TABLE counter(value INTEGER NOT NULL); INSERT INTO counter VALUES (0)");
    const transaction = db.transaction(async transactionDb => {
      await transactionDb.prepare("UPDATE counter SET value = 1").run();
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal((await transactionDb.prepare("SELECT value FROM counter").get()).value, 1);
    });
    const outsideRead = db.prepare("SELECT value FROM counter").get();
    await transaction;
    assert.equal((await outsideRead).value, 1);
  } finally {
    await db.close();
    fs.rmSync(directory, { recursive: true, force: true });
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});
