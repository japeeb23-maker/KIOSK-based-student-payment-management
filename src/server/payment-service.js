const crypto = require("node:crypto");

const PAYMONGO_API = "https://api.paymongo.com/v1";
const CASH_SESSION_TTL_MS = 5 * 60 * 1000;
const CASH_BILL_DENOMINATIONS_MINOR = [2000, 5000, 10000, 20000, 50000, 100000];

class PaymentError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = "PaymentError";
    this.statusCode = statusCode;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function amountToMinor(value) {
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || !/^\d+(?:\.\d{1,2})?$/.test(String(value))) return null;
  const [whole, fraction = ""] = String(value).split(".");
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
}

function moneyLabel(minor) {
  return `PHP ${(minor / 100).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function calculateCashChange(amountDueMinor, amountTenderedMinor) {
  if (!Number.isSafeInteger(amountDueMinor) || amountDueMinor <= 0 ||
      !Number.isSafeInteger(amountTenderedMinor) || amountTenderedMinor < 0) {
    throw new TypeError("Cash amounts must be non-negative integer centavos.");
  }
  return Math.max(0, amountTenderedMinor - amountDueMinor);
}

function verifyPayMongoSignature(rawBody, signatureHeader, secret, now = Date.now(), toleranceSeconds = 300) {
  if (!Buffer.isBuffer(rawBody) || !signatureHeader || !secret) return false;
  const parts = Object.fromEntries(signatureHeader.split(",").map(part => {
    const separator = part.indexOf("=");
    return separator > 0 ? [part.slice(0, separator).trim(), part.slice(separator + 1).trim()] : ["", ""];
  }).filter(([key, value]) => key && value));
  const timestamp = Number(parts.t);
  if (!Number.isSafeInteger(timestamp) || Math.abs(Math.floor(now / 1000) - timestamp) > toleranceSeconds) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest();
  const signatures = [parts.te, parts.li].filter(Boolean);
  return signatures.some(value => {
    if (!/^[\da-f]{64}$/i.test(value)) return false;
    const candidate = Buffer.from(value, "hex");
    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
  });
}

function verifyCashDeviceSignature(rawBody, deviceId, timestampHeader, signatureHeader, secret, now = Date.now(), toleranceSeconds = 60) {
  if (!Buffer.isBuffer(rawBody) || !deviceId || !timestampHeader || !signatureHeader || !secret) return false;
  const timestamp = Number(timestampHeader);
  if (!Number.isSafeInteger(timestamp) || Math.abs(Math.floor(now / 1000) - timestamp) > toleranceSeconds) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.${deviceId}.`).update(rawBody).digest();
  const signature = signatureHeader.replace(/^sha256=/i, "");
  if (!/^[\da-f]{64}$/i.test(signature)) return false;
  const actual = Buffer.from(signature, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

async function withImmediateTransaction(db, callback) {
  if (typeof db.transaction === "function") return db.transaction(callback);
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = await callback(db);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function parseJson(value, fallback = null) {
  if (!value) return fallback;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); }
  catch { return fallback; }
}

function assessmentBreakdown(state, assessment, amountDueMinor) {
  const remaining = assessment.items.map(item => ({
    label: item.label,
    amountMinor: Math.round(Number(item.amount) * 100)
  }));
  let previouslyPaid = Math.round(state.payments
    .filter(payment => payment.assessmentId === assessment.id)
    .reduce((sum, payment) => sum + Number(payment.amount), 0) * 100);
  for (const item of remaining) {
    const applied = Math.min(item.amountMinor, previouslyPaid);
    item.amountMinor -= applied;
    previouslyPaid -= applied;
  }
  let amountLeft = amountDueMinor;
  const items = [];
  for (const item of remaining) {
    if (amountLeft <= 0) break;
    const allocated = Math.min(item.amountMinor, amountLeft);
    if (allocated > 0) items.push({ label: item.label, amountMinor: allocated });
    amountLeft -= allocated;
  }
  if (amountLeft !== 0) throw new PaymentError(409, "Assessment balance changed; refresh the account and try again.");
  return items;
}

function createEscPosPayload(receipt) {
  const printable = value => String(value).replace(/[^\x20-\x7e]/g, "?");
  const lines = [
    "\x1b\x40",
    "\x1b\x61\x01",
    "\x1b\x45\x01",
    "FELLOWSHIP BAPTIST COLLEGE",
    "OFFICIAL PAYMENT RECEIPT",
    "\x1b\x45\x00",
    `OR: ${printable(receipt.orNumber)}`,
    `Date: ${printable(receipt.issuedAt)}`,
    `Student: ${printable(receipt.studentId)}`,
    `Assessment: ${printable(receipt.assessmentId)}`,
    "--------------------------------",
    "\x1b\x61\x00",
    ...receipt.items.map(item => `${printable(item.label)}  ${moneyLabel(item.amountMinor)}`),
    "--------------------------------",
    `AMOUNT DUE:       ${moneyLabel(receipt.amountDueMinor)}`,
    `TENDERED:         ${moneyLabel(receipt.amountTenderedMinor)}`,
    `CHANGE DISPENSED: ${moneyLabel(receipt.changeDispensedMinor)}`,
    `CHANGE CREDITED:  ${moneyLabel(receipt.changeCreditedMinor)}`,
    `METHOD: ${printable(receipt.paymentMethod)}`,
    "",
    "Thank you.",
    "\n\n",
    "\x1d\x56\x00"
  ];
  return Buffer.from(lines.join("\n"), "ascii");
}

async function addReceiptJobs(db, transaction, student) {
  const timestamp = nowIso();
  const channels = [
    { channel: "EMAIL", recipient: typeof student.email === "string" ? student.email.trim() : "" },
    { channel: "SMS", recipient: typeof student.phone === "string" ? student.phone.trim() : "" }
  ];
  const insert = db.prepare(`INSERT OR IGNORE INTO receipt_delivery_jobs
    (id, transaction_id, channel, recipient, status, attempts, next_attempt_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`);
  for (const { channel, recipient } of channels) {
    await insert.run(
      crypto.randomUUID(),
      transaction.id,
      channel,
      recipient || null,
      recipient ? "PENDING" : "BLOCKED",
      timestamp,
      timestamp,
      timestamp
    );
  }
}

async function issueOfficialReceipt(db, transaction, student, paymentMethod) {
  const existing = await db.prepare("SELECT * FROM official_receipts WHERE transaction_id = ?").get(transaction.id);
  if (existing) return existing;

  const sequenceQuery = db.type === "postgres"
    ? "SELECT next_number FROM payment_sequence WHERE id = 1 FOR UPDATE"
    : "SELECT next_number FROM payment_sequence WHERE id = 1";
  const sequence = await db.prepare(sequenceQuery).get();
  if (!sequence) throw new Error("Official receipt sequence is not initialized.");
  const orNumber = `FBC-${new Date().getUTCFullYear()}-${String(sequence.next_number).padStart(8, "0")}`;
  await db.prepare("UPDATE payment_sequence SET next_number = next_number + 1 WHERE id = 1").run();

  const items = (await db.prepare("SELECT label, amount_minor FROM transaction_items WHERE transaction_id = ? ORDER BY id")
    .all(transaction.id))
    .map(item => ({ label: item.label, amountMinor: item.amount_minor }));
  const issuedAt = nowIso();
  const receiptData = {
    orNumber,
    issuedAt,
    studentId: transaction.student_id,
    assessmentId: transaction.assessment_id,
    paymentMethod,
    amountDueMinor: transaction.amount_due_minor,
    amountTenderedMinor: transaction.amount_tendered_minor || transaction.amount_due_minor,
    changeDispensedMinor: transaction.change_dispensed_minor,
    changeCreditedMinor: transaction.change_credited_minor,
    items
  };
  const payload = createEscPosPayload(receiptData);
  await db.prepare(`INSERT INTO official_receipts
    (transaction_id, or_number, student_id, assessment_id, currency, amount_due_minor,
     amount_tendered_minor, change_dispensed_minor, change_credited_minor,
     payment_method, fee_breakdown_json, escpos_payload, issued_at)
    VALUES (?, ?, ?, ?, 'PHP', ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    transaction.id,
    orNumber,
    transaction.student_id,
    transaction.assessment_id,
    receiptData.amountDueMinor,
    receiptData.amountTenderedMinor,
    receiptData.changeDispensedMinor,
    receiptData.changeCreditedMinor,
    paymentMethod,
    JSON.stringify(items),
    payload,
    issuedAt
  );
  await addReceiptJobs(db, transaction, student);
  return db.prepare("SELECT * FROM official_receipts WHERE transaction_id = ?").get(transaction.id);
}

async function settleTransaction(db, transactionId, paymentMethod) {
  const transactionSql = db.type === "postgres"
    ? "SELECT * FROM transactions WHERE id = ? FOR UPDATE"
    : "SELECT * FROM transactions WHERE id = ?";
  const transaction = await db.prepare(transactionSql).get(transactionId);
  if (!transaction || transaction.status === "PAID") return transaction;
  if (!["PENDING", "CASH_ACCEPTING", "CHANGE_PENDING"].includes(transaction.status)) return transaction;

  const stateSql = db.type === "postgres"
    ? "SELECT payload FROM app_state WHERE state_key = 'paypoint' FOR UPDATE"
    : "SELECT payload FROM app_state WHERE state_key = 'paypoint'";
  const stateRow = await db.prepare(stateSql).get();
  if (!stateRow) throw new Error("Paypoint data is unavailable; payment settlement was not applied.");
  const state = parseJson(stateRow.payload);
  const student = state.students.find(record => record.id === transaction.student_id);
  const assessment = state.assessments.find(record => record.id === transaction.assessment_id && record.studentId === transaction.student_id);
  if (!student || !assessment) throw new PaymentError(409, "The student assessment no longer exists.");

  const paid = Math.round(state.payments
    .filter(payment => payment.assessmentId === assessment.id)
    .reduce((sum, payment) => sum + Number(payment.amount), 0) * 100);
  const total = Math.round(assessment.items.reduce((sum, item) => sum + Number(item.amount), 0) * 100);
  const appliedMinor = Math.min(transaction.amount_due_minor, Math.max(0, total - paid));
  const excessMinor = transaction.amount_due_minor - appliedMinor;
  const receiptItems = appliedMinor ? assessmentBreakdown(state, assessment, appliedMinor) : [];
  if (excessMinor) receiptItems.push({ label: "Overpayment credited to account", amountMinor: excessMinor });
  await db.prepare("DELETE FROM transaction_items WHERE transaction_id = ?").run(transaction.id);
  const insertItem = db.prepare("INSERT INTO transaction_items(transaction_id, label, amount_minor) VALUES (?, ?, ?)");
  for (const item of receiptItems) await insertItem.run(transaction.id, item.label, item.amountMinor);

  const timestamp = nowIso();
  const paymentId = `FP-${transaction.id}`;
  const methodLabel = paymentMethod === "CASH" ? "Cash acceptor" :
    paymentMethod === "FREE_GATEWAY" ? "Free demo gateway" :
    paymentMethod === "QRPH" ? "PayMongo QR Ph" :
    paymentMethod === "GCASH" ? "PayMongo GCash" : "PayMongo Maya";
  const payment = {
    id: paymentId,
    studentId: transaction.student_id,
    assessmentId: transaction.assessment_id,
    amount: appliedMinor / 100,
    method: methodLabel,
    date: timestamp.slice(0, 10),
    reference: transaction.provider_payment_intent_id || transaction.id
  };
  if (appliedMinor) state.payments.push(payment);
  if (excessMinor) {
    await addStudentCredit(db, transaction, "OVERPAYMENT_CREDIT", excessMinor,
      "Confirmed payment exceeding the assessment balance credited to the student's account.");
  }
  await db.prepare("UPDATE app_state SET payload = ?, updated_at = ? WHERE state_key = 'paypoint'")
    .run(JSON.stringify(state), timestamp);

  await db.prepare("UPDATE transactions SET status = 'PAID', updated_at = ? WHERE id = ?").run(timestamp, transaction.id);
  const settled = await db.prepare("SELECT * FROM transactions WHERE id = ?").get(transaction.id);
  await issueOfficialReceipt(db, settled, student, methodLabel);
  return settled;
}

async function addStudentCredit(db, transaction, creditType, amountMinor, description) {
  if (amountMinor <= 0) return;
  await db.prepare(`INSERT INTO student_credit_ledger
    (id, student_id, transaction_id, credit_type, amount_minor, description, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    crypto.randomUUID(),
    transaction.student_id,
    transaction.id,
    creditType,
    amountMinor,
    description,
    nowIso()
  );
}

async function readTransactionView(db, transaction, includeReceipt = true) {
  const receipt = includeReceipt && transaction.status === "PAID"
    ? await db.prepare("SELECT * FROM official_receipts WHERE transaction_id = ?").get(transaction.id)
    : null;
  return {
    transactionId: transaction.id,
    assessmentId: transaction.assessment_id,
    status: transaction.status,
    channel: transaction.channel,
    paymentMethod: transaction.provider_payment_method_id === "FREE_GATEWAY"
      ? "FREE_GATEWAY"
      : transaction.payment_method,
    currency: transaction.currency,
    amountDueMinor: transaction.amount_due_minor,
    amountTenderedMinor: transaction.amount_tendered_minor,
    changeDueMinor: transaction.change_due_minor,
    changeDispensedMinor: transaction.change_dispensed_minor,
    changeCreditedMinor: transaction.change_credited_minor,
    expiresAt: transaction.expires_at,
    checkout: parseJson(transaction.provider_checkout_json),
    receipt: receipt ? {
      orNumber: receipt.or_number,
      issuedAt: receipt.issued_at,
      feeBreakdown: parseJson(receipt.fee_breakdown_json, []),
      escposBase64: Buffer.from(receipt.escpos_payload).toString("base64")
    } : null
  };
}

class PayMongoStrategy {
  constructor(configuration = process.env) {
    this.secretKey = configuration.PAYMONGO_SECRET_KEY || "";
    this.apiBase = (configuration.PAYMONGO_API_BASE || PAYMONGO_API).replace(/\/+$/, "");
    this.publicBaseUrl = configuration.FBC_PUBLIC_BASE_URL || "";
  }

  assertConfigured() {
    if (!this.secretKey) throw new PaymentError(503, "Digital payments are not configured on this server.");
  }

  async request(path, body, idempotencyKey) {
    this.assertConfigured();
    let response;
    try {
      response = await fetch(`${this.apiBase}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.secretKey}:`).toString("base64")}`,
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(12000)
      });
    } catch (error) {
      throw new PaymentError(502, `Payment provider could not be reached: ${error.message}`);
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const code = payload?.errors?.[0]?.code;
      throw new PaymentError(502, `Payment provider rejected the request${code ? ` (${code})` : ""}.`);
    }
    if (!payload || !payload.data || typeof payload.data.id !== "string") {
      throw new PaymentError(502, "Payment provider returned an invalid response.");
    }
    return payload.data;
  }

  async create(transaction, student, onIntentCreated) {
    const method = transaction.payment_method === "MAYA" ? "paymaya" : transaction.payment_method.toLowerCase();
    const suffix = transaction.id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48);
    const intent = await this.request("/payment_intents", {
      data: {
        attributes: {
          amount: transaction.amount_due_minor,
          currency: "PHP",
          payment_method_allowed: [method],
          description: `FBC assessment ${transaction.assessment_id}`,
          metadata: {
            transaction_id: transaction.id,
            student_id: transaction.student_id,
            assessment_id: transaction.assessment_id
          }
        }
      }
    }, `fbc-${suffix}-intent`);
    const clientKey = intent.attributes?.client_key;
    if (typeof clientKey !== "string" || !clientKey) {
      throw new PaymentError(502, "Payment provider did not return a payment-intent client key.");
    }
    await onIntentCreated(intent.id);

    const studentName = String(student.name || "").slice(0, 255);
    const email = typeof student.email === "string" ? student.email.slice(0, 255) : undefined;
    const paymentMethod = await this.request("/payment_methods", {
      data: {
        attributes: {
          type: method,
          ...(method === "qrph" ? {} : {
            billing: {
              name: studentName,
              ...(email ? { email } : {})
            }
          })
        }
      }
    }, `fbc-${suffix}-method`);
    const attached = await this.request(`/payment_intents/${encodeURIComponent(intent.id)}/attach`, {
      data: {
        attributes: {
          payment_method: paymentMethod.id,
          client_key: clientKey,
          ...(this.publicBaseUrl ? { return_url: new URL("/kiosk.html", this.publicBaseUrl).href } : {})
        }
      }
    }, `fbc-${suffix}-attach`);
    const nextAction = attached.attributes?.next_action || {};
    const checkout = {
      redirectUrl: nextAction.redirect?.url || null,
      qrImageUrl: nextAction.code?.image_url || null,
      expiresAt: attached.attributes?.expires_at || null
    };
    if (!checkout.redirectUrl && !checkout.qrImageUrl) {
      throw new PaymentError(502, "Payment provider did not return a wallet redirect or QR code.");
    }
    return { paymentIntentId: intent.id, paymentMethodId: paymentMethod.id, checkout };
  }
}

class CashAcceptorStrategy {
  constructor(db) {
    this.db = db;
  }

  create(studentId, assessmentId, idempotencyKey, amountDueMinor, items, database = this.db) {
    return createTransaction(database, {
      studentId,
      assessmentId,
      channel: "CASH",
      paymentMethod: "CASH",
      status: "CASH_ACCEPTING",
      idempotencyKey,
      amountDueMinor,
      items
    });
  }
}

async function createTransaction(db, input) {
  const id = `TX-${crypto.randomUUID()}`;
  const timestamp = nowIso();
  const ttl = input.channel === "CASH" ? CASH_SESSION_TTL_MS : 30 * 60 * 1000;
  const expiresAt = new Date(Date.now() + ttl).toISOString();
  await db.prepare(`INSERT INTO transactions
    (id, student_id, assessment_id, channel, payment_method, status, amount_due_minor,
     idempotency_key, created_at, updated_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id,
    input.studentId,
    input.assessmentId,
    input.channel,
    input.paymentMethod,
    input.status,
    input.amountDueMinor,
    input.idempotencyKey,
    timestamp,
    timestamp,
    expiresAt
  );
  const insertItem = db.prepare("INSERT INTO transaction_items(transaction_id, label, amount_minor) VALUES (?, ?, ?)");
  for (const item of input.items) await insertItem.run(id, item.label, item.amountMinor);
  return db.prepare("SELECT * FROM transactions WHERE id = ?").get(id);
}

async function readPaypointState(db, lock = false) {
  const sql = lock && db.type === "postgres"
    ? "SELECT payload FROM app_state WHERE state_key = 'paypoint' FOR UPDATE"
    : "SELECT payload FROM app_state WHERE state_key = 'paypoint'";
  const row = await db.prepare(sql).get();
  if (!row) throw new Error("Paypoint data is unavailable.");
  return parseJson(row.payload);
}

async function validateCreateInput(db, studentId, body, idempotencyKey, state) {
  if (!idempotencyKey || idempotencyKey.length > 128) {
    throw new PaymentError(400, "Provide an Idempotency-Key header no longer than 128 characters.");
  }
  if (!body || typeof body.assessmentId !== "string") throw new PaymentError(400, "Choose an assessment.");
  const amountDueMinor = amountToMinor(body.amount);
  if (!amountDueMinor) throw new PaymentError(400, "Enter a valid payment amount in PHP.");
  if (!state) state = await readPaypointState(db);
  const assessment = state.assessments.find(item => item.id === body.assessmentId && item.studentId === studentId);
  if (!assessment) throw new PaymentError(404, "Assessment does not belong to the signed-in student.");
  const total = Math.round(assessment.items.reduce((sum, item) => sum + Number(item.amount), 0) * 100);
  const paid = Math.round(state.payments.filter(payment => payment.assessmentId === assessment.id)
    .reduce((sum, payment) => sum + Number(payment.amount), 0) * 100);
  const balance = Math.max(0, total - paid);
  if (amountDueMinor > balance) throw new PaymentError(409, "Payment exceeds the current assessment balance.");
  const student = state.students.find(record => record.id === studentId);
  return { amountDueMinor, items: assessmentBreakdown(state, assessment, amountDueMinor), student };
}

async function existingByIdempotency(db, studentId, key) {
  return db.prepare("SELECT * FROM transactions WHERE student_id = ? AND idempotency_key = ?").get(studentId, key);
}

async function createDigitalPayment(db, provider, session, body, idempotencyKey) {
  const method = String(body?.method || "").toUpperCase();
  if (!["QRPH", "GCASH", "MAYA", "FREE_GATEWAY"].includes(method)) throw new PaymentError(400, "Choose QR Ph, GCash, Maya, or the free demo gateway.");
  if (method === "FREE_GATEWAY" && process.env.NODE_ENV === "production") {
    throw new PaymentError(403, "The free demo gateway is only available outside production.");
  }
  const storedMethod = method === "FREE_GATEWAY" ? "QRPH" : method;
  if (!idempotencyKey || idempotencyKey.length > 128) {
    throw new PaymentError(400, "Provide an Idempotency-Key header no longer than 128 characters.");
  }
  let student;
  let transaction = await withImmediateTransaction(db, async transactionDb => {
    const state = await readPaypointState(transactionDb, true);
    const existing = await existingByIdempotency(transactionDb, session.subjectId, idempotencyKey);
    if (existing) {
      if (existing.channel !== "PAYMONGO" || existing.payment_method !== storedMethod ||
          existing.assessment_id !== body.assessmentId ||
          existing.amount_due_minor !== amountToMinor(body.amount)) {
        throw new PaymentError(409, "Idempotency key was already used for a different payment request.");
      }
      if (method === "FREE_GATEWAY" && existing.provider_payment_method_id !== "FREE_GATEWAY") {
        throw new PaymentError(409, "Idempotency key was already used for a different payment request.");
      }
      student = state.students.find(record => record.id === existing.student_id);
      return existing;
    }
    const validated = await validateCreateInput(transactionDb, session.subjectId, body, idempotencyKey, state);
    student = validated.student;
    return createTransaction(transactionDb, {
      studentId: session.subjectId,
      assessmentId: body.assessmentId,
      channel: "PAYMONGO",
      paymentMethod: storedMethod,
      status: "INITIALIZING",
      idempotencyKey,
      amountDueMinor: validated.amountDueMinor,
      items: validated.items
    });
  });
  if (transaction.status !== "INITIALIZING" && transaction.provider_checkout_json) {
    return readTransactionView(db, transaction);
  }
  if (!student) throw new PaymentError(404, "Student account was not found.");

  if (method === "FREE_GATEWAY") {
    return withImmediateTransaction(db, async transactionDb => {
      const freeCheckout = {
        gateway: "free-demo",
        qrImageUrl: null,
        redirectUrl: "https://demo.fbc.edu.ph/free-gateway",
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString()
      };
      await transactionDb.prepare(`UPDATE transactions SET provider_payment_intent_id = ?, provider_payment_method_id = ?,
        provider_checkout_json = ?, status = 'PENDING', updated_at = ? WHERE id = ?`).run(
        `FREE-${transaction.id}`,
        "FREE_GATEWAY",
        JSON.stringify(freeCheckout),
        nowIso(),
        transaction.id
      );
      const settled = await settleTransaction(transactionDb, transaction.id, "FREE_GATEWAY");
      return readTransactionView(transactionDb, settled);
    });
  }

  provider.assertConfigured();
  const providerResult = await provider.create(transaction, student, async paymentIntentId => {
    await withImmediateTransaction(db, async transactionDb => {
      await transactionDb.prepare(`UPDATE transactions SET provider_payment_intent_id = ?,
        status = CASE WHEN status = 'INITIALIZING' THEN 'PENDING' ELSE status END,
        updated_at = ? WHERE id = ?`).run(paymentIntentId, nowIso(), transaction.id);
    });
  });
  transaction = await withImmediateTransaction(db, async transactionDb => {
    await transactionDb.prepare(`UPDATE transactions SET provider_payment_intent_id = ?, provider_payment_method_id = ?,
      provider_checkout_json = ?, status = CASE WHEN status = 'INITIALIZING' THEN 'PENDING' ELSE status END,
      updated_at = ? WHERE id = ?`).run(
      providerResult.paymentIntentId,
      providerResult.paymentMethodId,
      JSON.stringify(providerResult.checkout),
      nowIso(),
      transaction.id
    );
    return transactionDb.prepare("SELECT * FROM transactions WHERE id = ?").get(transaction.id);
  });
  return readTransactionView(db, transaction);
}

async function createCashPayment(db, session, body, idempotencyKey, strategy = new CashAcceptorStrategy(db)) {
  if (!idempotencyKey || idempotencyKey.length > 128) {
    throw new PaymentError(400, "Provide an Idempotency-Key header no longer than 128 characters.");
  }
  let transaction = await withImmediateTransaction(db, async transactionDb => {
    const state = await readPaypointState(transactionDb, true);
    const existing = await existingByIdempotency(transactionDb, session.subjectId, idempotencyKey);
    if (existing) {
      if (existing.channel !== "CASH" || existing.assessment_id !== body.assessmentId ||
          existing.amount_due_minor !== amountToMinor(body.amount)) {
        throw new PaymentError(409, "Idempotency key was already used for a different payment request.");
      }
      return existing;
    }
    const validated = await validateCreateInput(transactionDb, session.subjectId, body, idempotencyKey, state);
    return strategy.create(
      session.subjectId,
      body.assessmentId,
      idempotencyKey,
      validated.amountDueMinor,
      validated.items,
      transactionDb
    );
  });
  if (transaction.status === "CASH_ACCEPTING" && Date.parse(transaction.expires_at) <= Date.now()) {
    await expireCashTransactions(db);
    transaction = await db.prepare("SELECT * FROM transactions WHERE id = ?").get(transaction.id);
  }
  return {
    ...await readTransactionView(db, transaction, false),
    ...(transaction.status === "CASH_ACCEPTING" ? { acceptance: await cashAcceptance(db, transaction.id) } : {})
  };
}

async function cashAcceptance(db, transactionId) {
  const transaction = await db.prepare("SELECT * FROM transactions WHERE id = ?").get(transactionId);
  if (!transaction || transaction.channel !== "CASH" || transaction.status !== "CASH_ACCEPTING") {
    throw new PaymentError(409, "This cash transaction is not accepting bills.");
  }
  const remainingMinor = Math.max(0, transaction.amount_due_minor - transaction.amount_tendered_minor);
  return {
    remainingMinor,
    allowedDenominationsMinor: remainingMinor > 0 ? CASH_BILL_DENOMINATIONS_MINOR : [],
    expiresAt: transaction.expires_at
  };
}

async function cashCreditPartial(db, transaction, creditType, reason) {
  if (transaction.amount_tendered_minor <= 0) return;
  await addStudentCredit(db, transaction, creditType, transaction.amount_tendered_minor, reason);
}

async function applyCashDeviceEvent(db, deviceId, event) {
  if (!event || typeof event.eventId !== "string" || event.eventId.length < 8 || event.eventId.length > 128 ||
      typeof event.transactionId !== "string" ||
      !["CASH_INSERTED", "CASH_CANCELLED", "CHANGE_DISPENSED", "INSUFFICIENT_CHANGE"].includes(event.type)) {
    throw new PaymentError(400, "Cash device event is incomplete or invalid.");
  }
  const amountMinor = event.amountMinor === undefined ? 0 : event.amountMinor;
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) throw new PaymentError(400, "Cash event amount must be integer centavos.");
  if (event.type === "CASH_INSERTED" && amountMinor <= 0) throw new PaymentError(400, "Inserted cash must be greater than zero.");
  const occurredAt = typeof event.occurredAt === "string" && Number.isFinite(Date.parse(event.occurredAt))
    ? new Date(event.occurredAt).toISOString()
    : nowIso();

  return withImmediateTransaction(db, async transactionDb => {
    const duplicate = await transactionDb.prepare("SELECT * FROM cash_ledger_events WHERE event_id = ?").get(event.eventId);
    if (duplicate) {
      if (duplicate.transaction_id !== event.transactionId || duplicate.event_type !== event.type || duplicate.amount_minor !== amountMinor) {
        throw new PaymentError(409, "Cash device event ID was reused with different event data.");
      }
      const current = await transactionDb.prepare("SELECT * FROM transactions WHERE id = ?").get(event.transactionId);
      return readTransactionView(transactionDb, current);
    }
    const transactionSql = transactionDb.type === "postgres"
      ? "SELECT * FROM transactions WHERE id = ? FOR UPDATE"
      : "SELECT * FROM transactions WHERE id = ?";
    let transaction = await transactionDb.prepare(transactionSql).get(event.transactionId);
    if (!transaction || transaction.channel !== "CASH") throw new PaymentError(404, "Cash transaction was not found.");
    await transactionDb.prepare(`INSERT INTO cash_ledger_events
      (event_id, transaction_id, device_id, event_type, amount_minor, occurred_at, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      event.eventId, event.transactionId, deviceId, event.type, amountMinor, occurredAt, nowIso()
    );

    if (event.type === "CASH_INSERTED") {
      const nextTendered = transaction.amount_tendered_minor + amountMinor;
      if (transaction.status === "PAID") {
        await addStudentCredit(transactionDb, transaction, "OVERPAYMENT_CREDIT", amountMinor, "Late cash insertion credited to the student's next fee balance.");
        return readTransactionView(transactionDb, transaction);
      }
      if (transaction.status === "CASH_ACCEPTING" && Date.parse(transaction.expires_at) <= Date.now()) {
        await transactionDb.prepare("UPDATE transactions SET status = 'EXPIRED', updated_at = ? WHERE id = ?")
          .run(nowIso(), transaction.id);
        await cashCreditPartial(transactionDb, transaction, "CASH_CANCELLED", "Timed-out partial cash payment credited to the student's account.");
        transaction = await transactionDb.prepare("SELECT * FROM transactions WHERE id = ?").get(transaction.id);
      }
      if (["EXPIRED", "CANCELLED"].includes(transaction.status)) {
        await transactionDb.prepare("UPDATE transactions SET amount_tendered_minor = ?, updated_at = ? WHERE id = ?")
          .run(nextTendered, nowIso(), transaction.id);
        transaction = await transactionDb.prepare("SELECT * FROM transactions WHERE id = ?").get(transaction.id);
        await addStudentCredit(transactionDb, transaction, "CASH_CANCELLED", amountMinor, "Late cash insertion credited to the student's account.");
        return readTransactionView(transactionDb, transaction);
      }
      if (transaction.status === "CHANGE_PENDING") {
        const changeDue = transaction.change_due_minor + amountMinor;
        await transactionDb.prepare(`UPDATE transactions SET amount_tendered_minor = ?, change_due_minor = ?,
          updated_at = ? WHERE id = ?`).run(nextTendered, changeDue, nowIso(), transaction.id);
        transaction = await transactionDb.prepare("SELECT * FROM transactions WHERE id = ?").get(transaction.id);
        return readTransactionView(transactionDb, transaction);
      }
      if (transaction.status !== "CASH_ACCEPTING") throw new PaymentError(409, "Cash transaction is not accepting bills.");
      const changeDue = calculateCashChange(transaction.amount_due_minor, nextTendered);
      await transactionDb.prepare(`UPDATE transactions SET amount_tendered_minor = ?, change_due_minor = ?,
        status = ?, updated_at = ? WHERE id = ?`).run(
        nextTendered,
        changeDue,
        changeDue ? "CHANGE_PENDING" : "CASH_ACCEPTING",
        nowIso(),
        transaction.id
      );
      transaction = await transactionDb.prepare("SELECT * FROM transactions WHERE id = ?").get(transaction.id);
      if (nextTendered === transaction.amount_due_minor) transaction = await settleTransaction(transactionDb, transaction.id, "CASH");
      return readTransactionView(transactionDb, transaction);
    }

    if (event.type === "CASH_CANCELLED") {
      if (transaction.status === "CASH_ACCEPTING") {
        await transactionDb.prepare("UPDATE transactions SET status = 'CANCELLED', updated_at = ? WHERE id = ?").run(nowIso(), transaction.id);
        transaction = await transactionDb.prepare("SELECT * FROM transactions WHERE id = ?").get(transaction.id);
        await cashCreditPartial(transactionDb, transaction, "CASH_CANCELLED", "Uncompleted cash payment returned as account credit.");
      }
      return readTransactionView(transactionDb, transaction);
    }

    if (transaction.status !== "CHANGE_PENDING") throw new PaymentError(409, "Cash transaction is not awaiting change handling.");
    if (event.type === "CHANGE_DISPENSED") {
      if (amountMinor !== transaction.change_due_minor) throw new PaymentError(409, "Dispenser amount does not match the calculated change.");
      await transactionDb.prepare("UPDATE transactions SET change_dispensed_minor = ?, updated_at = ? WHERE id = ?")
        .run(amountMinor, nowIso(), transaction.id);
    } else {
      if (amountMinor > transaction.change_due_minor) throw new PaymentError(409, "Reported shortage exceeds the calculated change.");
      const creditedMinor = transaction.change_due_minor - amountMinor;
      await transactionDb.prepare(`UPDATE transactions SET change_dispensed_minor = ?, change_credited_minor = ?,
        updated_at = ? WHERE id = ?`).run(amountMinor, creditedMinor, nowIso(), transaction.id);
      transaction = await transactionDb.prepare("SELECT * FROM transactions WHERE id = ?").get(transaction.id);
      await addStudentCredit(transactionDb, transaction, "CHANGE_SHORTAGE", creditedMinor, "Cash change shortage credited to the student's next fee balance.");
    }
    transaction = await settleTransaction(transactionDb, transaction.id, "CASH");
    return readTransactionView(transactionDb, transaction);
  });
}

function cancelStudentCashTransaction(db, session, transactionId) {
  return withImmediateTransaction(db, async transactionDb => {
    const sql = transactionDb.type === "postgres"
      ? "SELECT * FROM transactions WHERE id = ? AND student_id = ? FOR UPDATE"
      : "SELECT * FROM transactions WHERE id = ? AND student_id = ?";
    const transaction = await transactionDb.prepare(sql)
      .get(transactionId, session.subjectId);
    if (!transaction || transaction.channel !== "CASH") throw new PaymentError(404, "Cash transaction was not found.");
    if (transaction.status === "CASH_ACCEPTING") {
      await transactionDb.prepare(`INSERT INTO cash_ledger_events
        (event_id, transaction_id, device_id, event_type, amount_minor, occurred_at, received_at)
        VALUES (?, ?, 'student-portal', 'CASH_CANCELLED', 0, ?, ?)`).run(
        `portal-${crypto.randomUUID()}`, transaction.id, nowIso(), nowIso()
      );
      await transactionDb.prepare("UPDATE transactions SET status = 'CANCELLED', updated_at = ? WHERE id = ?").run(nowIso(), transaction.id);
      const cancelled = await transactionDb.prepare("SELECT * FROM transactions WHERE id = ?").get(transaction.id);
      await cashCreditPartial(transactionDb, cancelled, "CASH_CANCELLED", "Uncompleted cash payment returned as account credit.");
      return readTransactionView(transactionDb, cancelled);
    }
    return readTransactionView(transactionDb, transaction);
  });
}

async function expireCashTransactions(db) {
  const expiredIds = (await db.prepare("SELECT id FROM transactions WHERE channel = 'CASH' AND status = 'CASH_ACCEPTING' AND expires_at <= ?")
    .all(nowIso())).map(row => row.id);
  for (const id of expiredIds) {
    await withImmediateTransaction(db, async transactionDb => {
      const sql = transactionDb.type === "postgres"
        ? "SELECT * FROM transactions WHERE id = ? FOR UPDATE"
        : "SELECT * FROM transactions WHERE id = ?";
      const transaction = await transactionDb.prepare(sql).get(id);
      if (!transaction || transaction.status !== "CASH_ACCEPTING" || transaction.expires_at > nowIso()) return;
      await transactionDb.prepare(`INSERT INTO cash_ledger_events
        (event_id, transaction_id, device_id, event_type, amount_minor, occurred_at, received_at)
        VALUES (?, ?, 'system-timeout', 'CASH_CANCELLED', 0, ?, ?)`).run(
        `timeout-${crypto.randomUUID()}`, transaction.id, nowIso(), nowIso()
      );
      await transactionDb.prepare("UPDATE transactions SET status = 'EXPIRED', updated_at = ? WHERE id = ?").run(nowIso(), id);
      const expired = await transactionDb.prepare("SELECT * FROM transactions WHERE id = ?").get(id);
      await cashCreditPartial(transactionDb, expired, "CASH_CANCELLED", "Timed-out partial cash payment credited to the student's account.");
    });
  }
}

function webhookEnvelope(payload) {
  const event = payload?.data;
  const attributes = event?.attributes;
  return {
    id: event?.id,
    type: attributes?.type,
    resource: attributes?.data || attributes?.resource || null
  };
}

async function processPayMongoWebhook(db, rawBody, signatureHeader, secret) {
  if (!secret) throw new PaymentError(503, "Payment webhooks are not configured on this server.");
  if (!verifyPayMongoSignature(rawBody, signatureHeader, secret)) {
    throw new PaymentError(401, "Webhook signature is invalid or expired.");
  }
  let payload;
  try { payload = JSON.parse(rawBody.toString("utf8")); }
  catch { throw new PaymentError(400, "Webhook body must be valid JSON."); }
  const event = webhookEnvelope(payload);
  if (typeof event.id !== "string" || typeof event.type !== "string") {
    throw new PaymentError(400, "Webhook event is missing its ID or type.");
  }
  const payloadHash = crypto.createHash("sha256").update(rawBody).digest("hex");

  return withImmediateTransaction(db, async transactionDb => {
    const inserted = await transactionDb.prepare(`INSERT OR IGNORE INTO paymongo_webhook_events
      (event_id, event_type, payload_sha256, received_at) VALUES (?, ?, ?, ?)`)
      .run(event.id, event.type, payloadHash, nowIso());
    if (!inserted.changes) return { received: true, duplicate: true };
    if (!["payment.paid", "payment.failed"].includes(event.type)) return { received: true, processed: false };

    const attributes = event.resource?.attributes || {};
    const intentId = attributes.payment_intent_id ||
      attributes.payment_intent?.id ||
      attributes.payment_intent?.data?.id ||
      event.resource?.id;
    if (typeof intentId !== "string") return { received: true, processed: false };
    const transactionSql = transactionDb.type === "postgres"
      ? "SELECT * FROM transactions WHERE provider_payment_intent_id = ? FOR UPDATE"
      : "SELECT * FROM transactions WHERE provider_payment_intent_id = ?";
    const transaction = await transactionDb.prepare(transactionSql).get(intentId);
    if (!transaction) return { received: true, processed: false };
    if (transaction.status === "PAID") return { received: true, processed: true, alreadyPaid: true };
    if (transaction.status !== "PENDING") return { received: true, processed: false };

    if (event.type === "payment.failed") {
      await transactionDb.prepare("UPDATE transactions SET status = 'FAILED', updated_at = ? WHERE id = ?").run(nowIso(), transaction.id);
      return { received: true, processed: true, failed: true };
    }

    const paidAmount = Number(attributes.amount);
    const currency = String(attributes.currency || "").toUpperCase();
    if (!Number.isSafeInteger(paidAmount) || paidAmount !== transaction.amount_due_minor || currency !== "PHP") {
      throw new PaymentError(409, "Signed payment event amount or currency does not match the pending transaction.");
    }
    await settleTransaction(transactionDb, transaction.id, transaction.payment_method);
    return { received: true, processed: true };
  });
}

function claimReceiptJob(db) {
  return withImmediateTransaction(db, async transactionDb => {
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await transactionDb.prepare(`UPDATE receipt_delivery_jobs SET status = 'PENDING', updated_at = ?
      WHERE status = 'SENDING' AND updated_at < ?`).run(nowIso(), stale);
    const job = await transactionDb.prepare(`SELECT * FROM receipt_delivery_jobs
      WHERE status = 'PENDING' AND next_attempt_at <= ? AND recipient IS NOT NULL
      ORDER BY created_at LIMIT 1`).get(nowIso());
    if (!job) return null;
    const claimed = await transactionDb.prepare(`UPDATE receipt_delivery_jobs SET status = 'SENDING',
      attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'PENDING'`)
      .run(nowIso(), job.id);
    return claimed.changes ? { ...job, attempts: job.attempts + 1 } : null;
  });
}

async function deliverReceiptJob(db, job, configuration = process.env) {
  const receipt = await db.prepare(`SELECT r.*, t.payment_method, t.amount_due_minor, t.amount_tendered_minor,
    t.change_dispensed_minor, t.change_credited_minor FROM official_receipts r
    JOIN transactions t ON t.id = r.transaction_id WHERE r.transaction_id = ?`).get(job.transaction_id);
  if (!receipt) throw new Error("Official receipt is unavailable.");
  const breakdown = parseJson(receipt.fee_breakdown_json, []);
  const bodyText = [
    `Official receipt ${receipt.or_number}`,
    `Student: ${receipt.student_id}`,
    `Assessment: ${receipt.assessment_id}`,
    `Amount paid: ${moneyLabel(receipt.amount_due_minor)}`,
    ...breakdown.map(item => `${item.label}: ${moneyLabel(item.amountMinor)}`),
    `Tendered: ${moneyLabel(receipt.amount_tendered_minor)}`,
    `Change dispensed: ${moneyLabel(receipt.change_dispensed_minor)}`,
    `Change credited: ${moneyLabel(receipt.change_credited_minor)}`
  ].join("\n");
  if (job.channel === "EMAIL") {
    if (!configuration.SENDGRID_API_KEY || !configuration.RECEIPT_FROM_EMAIL) {
      throw new Error("Email delivery is not configured.");
    }
    const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${configuration.SENDGRID_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: job.recipient }] }],
        from: { email: configuration.RECEIPT_FROM_EMAIL },
        subject: `FBC official receipt ${receipt.or_number}`,
        content: [{ type: "text/plain", value: bodyText }]
      }),
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`Email provider returned HTTP ${response.status}.`);
    return;
  }
  if (!configuration.TWILIO_ACCOUNT_SID || !configuration.TWILIO_AUTH_TOKEN || !configuration.TWILIO_FROM_NUMBER) {
    throw new Error("SMS delivery is not configured.");
  }
  const form = new URLSearchParams({ To: job.recipient, From: configuration.TWILIO_FROM_NUMBER, Body: bodyText });
  const authorization = Buffer.from(`${configuration.TWILIO_ACCOUNT_SID}:${configuration.TWILIO_AUTH_TOKEN}`).toString("base64");
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(configuration.TWILIO_ACCOUNT_SID)}/Messages.json`, {
    method: "POST",
    headers: { Authorization: `Basic ${authorization}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`SMS provider returned HTTP ${response.status}.`);
}

async function processReceiptJobs(db, configuration = process.env) {
  const job = await claimReceiptJob(db);
  if (!job) return false;
  let errorMessage = "";
  try { await deliverReceiptJob(db, job, configuration); }
  catch (error) { errorMessage = error.message; }
  const complete = !errorMessage;
  const terminal = !complete && job.attempts >= 8;
  const delaySeconds = Math.min(3600, 5 * 2 ** Math.min(job.attempts, 9));
  await db.prepare(`UPDATE receipt_delivery_jobs SET status = ?, last_error = ?,
    next_attempt_at = ?, updated_at = ? WHERE id = ? AND status = 'SENDING'`).run(
    complete ? "SENT" : terminal ? "FAILED" : "PENDING",
    errorMessage || null,
    new Date(Date.now() + delaySeconds * 1000).toISOString(),
    nowIso(),
    job.id
  );
  return true;
}

function startReceiptDeliveryWorker(db, configuration = process.env) {
  let running = false;
  let inFlight = Promise.resolve();
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    inFlight = (async () => {
      try { await processReceiptJobs(db, configuration); }
      catch (error) { console.error("Receipt delivery worker failed.", error); }
      finally { running = false; }
    })();
    await inFlight;
  }, 1000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await inFlight;
  };
}

class PaymentController {
  constructor(db, configuration = process.env) {
    this.service = new PaymentService(db, configuration);
  }

  createDigital(session, body, idempotencyKey) {
    return this.service.startDigital(session, body, idempotencyKey);
  }

  createCash(session, body, idempotencyKey) {
    return this.service.startCash(session, body, idempotencyKey);
  }

  status(session, transactionId) {
    return this.service.readStatus(session, transactionId);
  }

  cancelCash(session, transactionId) {
    return this.service.cancelCash(session, transactionId);
  }

  confirmCashDeviceEvent(deviceId, event) {
    return this.service.confirmCashEvent(deviceId, event);
  }

  cashDeviceAcceptance(transactionId) {
    return this.service.cashAcceptance(transactionId);
  }

  paymongoWebhook(rawBody, signatureHeader) {
    return this.service.confirmPayMongoWebhook(rawBody, signatureHeader);
  }
}

class PaymentService {
  constructor(db, configuration = process.env) {
    this.db = db;
    this.configuration = configuration;
    this.strategies = {
      PAYMONGO: new PayMongoStrategy(configuration),
      CASH: new CashAcceptorStrategy(db)
    };
  }

  startDigital(session, body, idempotencyKey) {
    return createDigitalPayment(this.db, this.strategies.PAYMONGO, session, body, idempotencyKey);
  }

  startCash(session, body, idempotencyKey) {
    return createCashPayment(this.db, session, body, idempotencyKey, this.strategies.CASH);
  }

  async readStatus(session, transactionId) {
    await expireCashTransactions(this.db);
    const transaction = await this.db.prepare("SELECT * FROM transactions WHERE id = ? AND student_id = ?")
      .get(transactionId, session.subjectId);
    if (!transaction) throw new PaymentError(404, "Payment transaction was not found.");
    return readTransactionView(this.db, transaction);
  }

  cancelCash(session, transactionId) {
    return cancelStudentCashTransaction(this.db, session, transactionId);
  }

  confirmCashEvent(deviceId, event) {
    return applyCashDeviceEvent(this.db, deviceId, event);
  }

  cashAcceptance(transactionId) {
    return cashAcceptance(this.db, transactionId);
  }

  confirmPayMongoWebhook(rawBody, signatureHeader) {
    return processPayMongoWebhook(
      this.db,
      rawBody,
      signatureHeader,
      this.configuration.PAYMONGO_WEBHOOK_SECRET || ""
    );
  }
}

module.exports = {
  PaymentError,
  PaymentService,
  PaymentController,
  PayMongoStrategy,
  CashAcceptorStrategy,
  amountToMinor,
  calculateCashChange,
  verifyPayMongoSignature,
  verifyCashDeviceSignature,
  withImmediateTransaction,
  createDigitalPayment,
  createCashPayment,
  cashAcceptance,
  applyCashDeviceEvent,
  cancelStudentCashTransaction,
  readTransactionView,
  processPayMongoWebhook,
  expireCashTransactions,
  processReceiptJobs,
  startReceiptDeliveryWorker
};
