const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createDatabase } = require("./database");
const payments = require("./payment-service");

const ROOT = path.resolve(__dirname, "..", "..");
const SESSION_TTL_MS = 30 * 60 * 1000;
const PAYPOINT_KEY = "paypoint";
const SCHOOL_KEY = "school";
const N8N_PAYMENT_URL = "https://japheth30.app.n8n.cloud/webhook/fbc-kiosk-payment-request";
const STUDENT_LOGIN_ERROR = "Student number was not found.";
const FILES = new Map([
  ["/", ["kiosk.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/kiosk.html", ["kiosk.html", "text/html; charset=utf-8"]],
  ["/scholastech.html", ["scholastech.html", "text/html; charset=utf-8"]],
  ["/api.js", ["api.js", "text/javascript; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/kiosk.js", ["kiosk.js", "text/javascript; charset=utf-8"]],
  ["/scholastech.js", ["scholastech.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/kiosk.css", ["kiosk.css", "text/css; charset=utf-8"]],
  ["/scholastech.css", ["scholastech.css", "text/css; charset=utf-8"]],
  ["/fbc-logo.jpg", ["fbc-logo.jpg", "image/jpeg"]],
  ["/favicon.ico", ["fbc-logo.jpg", "image/jpeg"]]
]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.statusCode = status;
  }
}

function json(response, status, value, headers = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers
  });
  response.end(body);
}

async function rawBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new HttpError(413, "Request body is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function bodyJson(request) {
  if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "Content-Type must be application/json.");
  }
  try { return JSON.parse((await rawBody(request)).toString("utf8")); }
  catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

function revision(state) {
  return `"${crypto.createHash("sha256").update(JSON.stringify(canonical(state))).digest("hex")}"`;
}

function equal(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function safeText(value, max = 500) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[<>]/.test(value);
}

function uniqueIds(items) {
  return Array.isArray(items) && items.every(item => item && safeText(item.id, 128)) &&
    new Set(items.map(item => item.id)).size === items.length;
}

function validPaypoint(state) {
  if (!state || !uniqueIds(state.students) || !uniqueIds(state.assessments) ||
      !uniqueIds(state.payments) || !uniqueIds(state.notes)) return false;
  const studentIds = new Set(state.students.map(item => item.id));
  const assessmentIds = new Set(state.assessments.map(item => item.id));
  const studentNumbers = state.students.map(item => String(item.studentNo || "").trim().toLowerCase());
  if (new Set(studentNumbers).size !== studentNumbers.length) return false;
  if (!state.students.every(item => safeText(item.studentNo, 128) && safeText(item.name, 255) &&
      safeText(item.course, 255) && safeText(item.year, 50) &&
      (item.email === "" || (safeText(item.email, 255) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item.email))))) return false;
  if (!state.assessments.every(item => studentIds.has(item.studentId) && safeText(item.term, 255) &&
      safeText(item.date, 32) && Array.isArray(item.items) && item.items.length > 0 &&
      item.items.every(fee => fee && safeText(fee.label, 255) && payments.amountToMinor(fee.amount)))) return false;
  if (!state.payments.every(item => studentIds.has(item.studentId) && assessmentIds.has(item.assessmentId) &&
      state.assessments.some(assessment => assessment.id === item.assessmentId && assessment.studentId === item.studentId) &&
      payments.amountToMinor(item.amount) && safeText(item.method, 128) &&
      safeText(item.date, 32) && safeText(item.reference, 255))) return false;
  return state.notes.every(item => studentIds.has(item.studentId) && payments.amountToMinor(item.amount) &&
    safeText(item.purpose, 500) && safeText(item.dueDate, 32) && safeText(item.createdAt, 64) &&
    Number.isInteger(Number(item.installments)) && Number(item.installments) > 0 &&
    ["Pending", "Approved", "Rejected", "Paid"].includes(item.status));
}

function validSchool(state) {
  if (!state || !uniqueIds(state.admissions) || !uniqueIds(state.notifications) ||
      !uniqueIds(state.schedules) || !uniqueIds(state.scholarships) ||
      !state.attendance || typeof state.attendance !== "object" || Array.isArray(state.attendance)) return false;
  for (const [date, entries] of Object.entries(state.attendance)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !entries || typeof entries !== "object" || Array.isArray(entries) ||
        !Object.entries(entries).every(([studentId, value]) => safeText(studentId, 128) &&
          !["__proto__", "constructor", "prototype"].includes(studentId) &&
          ["Present", "Absent", "Late", "Excused"].includes(value))) return false;
  }
  const textValuesSafe = value => {
    if (typeof value === "string") return value.length <= 2000 && !/[<>]/.test(value);
    if (Array.isArray(value)) return value.every(textValuesSafe);
    if (value && typeof value === "object") return Object.keys(value).every(key => !/[<>]/.test(key) && textValuesSafe(value[key]));
    return value === null || typeof value === "number" || typeof value === "boolean";
  };
  return textValuesSafe(state);
}

function appended(previous, next) {
  return next.length >= previous.length && previous.every((item, index) => equal(item, next[index]));
}

function roleView(key, state, role, paypoint) {
  if (key === PAYPOINT_KEY && role === "vp") {
    return {
      students: state.students.map(({ id, studentNo, name, course, year }) => ({ id, studentNo, name, course, year })),
      assessments: [], payments: [], notes: state.notes
    };
  }
  if (key === PAYPOINT_KEY && role === "cashier") return { ...state, notes: [] };
  if (key === SCHOOL_KEY && role === "vp") {
    return {
      admissions: [], notifications: [], schedules: [], scholarships: [],
      attendance: state.attendance,
      studentRoster: paypoint.students.map(({ id, studentNo, name, course, year }) => ({ id, studentNo, name, course, year }))
    };
  }
  return state;
}

function mergeRoleChanges(key, previous, submitted, role, paypoint) {
  const view = roleView(key, previous, role, paypoint);
  if (!submitted || typeof submitted !== "object") throw new HttpError(400, "Invalid state.");
  if (key === PAYPOINT_KEY) {
    for (const field of ["students", "assessments", "payments", "notes"]) {
      if (!Array.isArray(submitted[field])) throw new HttpError(400, "Invalid Paypoint state.");
    }
    let next;
    if (role === "registrar") {
      if (!equal(view.payments, submitted.payments) || !appended(view.students, submitted.students) ||
          !appended(view.assessments, submitted.assessments) || !appended(view.notes, submitted.notes)) {
        throw new HttpError(403, "Registrar changes may only add student, assessment, or note records.");
      }
      next = { ...previous, students: submitted.students, assessments: submitted.assessments, notes: submitted.notes };
    } else if (role === "cashier") {
      if (!equal(view.students, submitted.students) || !equal(view.assessments, submitted.assessments) ||
          !equal(view.notes, submitted.notes) || !appended(view.payments, submitted.payments)) {
        throw new HttpError(403, "Cashier changes may only add payments.");
      }
      next = { ...previous, payments: submitted.payments };
    } else if (role === "vp") {
      if (!equal(view.students, submitted.students) || !equal(view.assessments, submitted.assessments) ||
          !equal(view.payments, submitted.payments) || view.notes.length !== submitted.notes.length) {
        throw new HttpError(403, "VP changes may only update note status.");
      }
      for (let i = 0; i < view.notes.length; i++) {
        const old = view.notes[i];
        const updated = submitted.notes[i];
        if (!updated || !equal({ ...old, status: updated.status }, updated) ||
            !(updated.status === old.status ||
              (old.status === "Pending" && ["Approved", "Rejected"].includes(updated.status)) ||
              (old.status === "Approved" && updated.status === "Paid"))) {
          throw new HttpError(403, "Invalid note status change.");
        }
      }
      next = { ...previous, notes: submitted.notes };
    } else throw new HttpError(403, "Staff access required.");
    if (!validPaypoint(next)) throw new HttpError(400, "Paypoint records have an invalid format.");
    for (const assessment of next.assessments) {
      const total = assessment.items.reduce((sum, item) => sum + payments.amountToMinor(item.amount), 0);
      const paid = next.payments.filter(item => item.assessmentId === assessment.id)
        .reduce((sum, item) => sum + payments.amountToMinor(item.amount), 0);
      if (paid > total) throw new HttpError(409, "A payment exceeds the assessment balance.");
    }
    return next;
  }
  if (role === "vp") {
    for (const field of ["admissions", "notifications", "schedules", "scholarships", "studentRoster"]) {
      if (!equal(view[field], submitted[field])) throw new HttpError(403, "VP changes may only update attendance.");
    }
    const next = { ...previous, attendance: submitted.attendance };
    if (!validSchool(next)) throw new HttpError(400, "School records have an invalid format.");
    return next;
  }
  if (role !== "registrar") throw new HttpError(403, "Registrar access required.");
  if (!Array.isArray(submitted.admissions) || !Array.isArray(submitted.notifications) ||
      !Array.isArray(submitted.schedules) || !Array.isArray(submitted.scholarships) ||
      !appended(previous.admissions, submitted.admissions) ||
      !appended(previous.notifications, submitted.notifications) ||
      !appended(previous.schedules, submitted.schedules) ||
      submitted.scholarships.length < previous.scholarships.length) {
    throw new HttpError(403, "School changes cannot remove or alter existing records.");
  }
  for (let i = 0; i < previous.scholarships.length; i++) {
    const old = previous.scholarships[i];
    const updated = submitted.scholarships[i];
    if (!updated || !equal({ ...old, status: updated.status }, updated) ||
        !(old.status === updated.status || (old.status === "For review" && updated.status === "Active"))) {
      throw new HttpError(403, "Invalid scholarship change.");
    }
  }
  const next = { ...previous, admissions: submitted.admissions, notifications: submitted.notifications,
    schedules: submitted.schedules, scholarships: submitted.scholarships, attendance: submitted.attendance };
  if (!validSchool(next)) throw new HttpError(400, "School records have an invalid format.");
  return next;
}

async function initializeDatabase(db) {
  if (db.type === "postgres") {
    await db.exec(fs.readFileSync(path.join(ROOT, "supabase", "schema.sql"), "utf8"));
  } else {
    await db.exec(`PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS app_state (state_key TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS staff_users (username TEXT PRIMARY KEY, role TEXT NOT NULL,
        label TEXT NOT NULL, salt TEXT NOT NULL, password_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, role TEXT NOT NULL,
        subject_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS student_credentials (student_id TEXT PRIMARY KEY, salt TEXT NOT NULL,
        pin_hash TEXT NOT NULL, updated_at TEXT NOT NULL);`);
    await db.exec(fs.readFileSync(path.join(ROOT, "db", "payments.sql"), "utf8"));
  }
  const oldConstraint = db.type === "postgres"
    ? await db.prepare(`SELECT conname FROM pg_constraint WHERE conrelid = 'student_credit_ledger'::regclass
        AND contype = 'u' AND pg_get_constraintdef(oid) = 'UNIQUE (transaction_id, credit_type)'`).get()
    : await db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'student_credit_ledger'").get();
  if (db.type === "postgres" ? oldConstraint : /UNIQUE\s*\(\s*transaction_id\s*,\s*credit_type\s*\)/i.test(oldConstraint.sql)) {
    throw new Error("Credit ledger migration is required. Back up the database and follow PAYMENTS.md before starting.");
  }
  const now = new Date().toISOString();
  const insert = db.prepare("INSERT OR IGNORE INTO app_state(state_key, payload, updated_at) VALUES (?, ?, ?)");
  await insert.run(PAYPOINT_KEY, JSON.stringify({ students: [], assessments: [], payments: [], notes: [] }), now);
  await insert.run(SCHOOL_KEY, JSON.stringify({ admissions: [], attendance: {}, notifications: [], schedules: [], scholarships: [] }), now);
  await db.prepare("INSERT OR IGNORE INTO payment_sequence(id, next_number) VALUES (1, 1)").run();
}

function configuration(env = process.env) {
  const host = env.FBC_HOST || "127.0.0.1";
  const port = Number(env.PORT || 4177);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT must be a valid TCP port.");
  const certPath = env.FBC_TLS_CERT_PATH || "";
  const keyPath = env.FBC_TLS_KEY_PATH || "";
  if (Boolean(certPath) !== Boolean(keyPath)) throw new Error("Configure both FBC_TLS_CERT_PATH and FBC_TLS_KEY_PATH.");
  const localHost = ["127.0.0.1", "::1", "localhost"].includes(host);
  const httpsProxy = env.FBC_TRUST_HTTPS_PROXY === "true";
  const networkProxy = env.FBC_ALLOW_NETWORK_PROXY === "true";
  if (networkProxy && (host !== "0.0.0.0" || !httpsProxy || env.NODE_ENV !== "production")) {
    throw new Error("Network proxy mode requires production, FBC_HOST=0.0.0.0 and FBC_TRUST_HTTPS_PROXY=true.");
  }
  if (httpsProxy && ((!localHost && !networkProxy) || certPath || !env.FBC_PUBLIC_BASE_URL)) {
    throw new Error("HTTPS proxy mode requires an allowed HTTP binding and an HTTPS FBC_PUBLIC_BASE_URL.");
  }
  if (!localHost && !httpsProxy && (!certPath || !env.FBC_PUBLIC_BASE_URL)) {
    throw new Error("Network access requires TLS certificate/key files and an HTTPS FBC_PUBLIC_BASE_URL.");
  }
  let origin = "";
  if (env.FBC_PUBLIC_BASE_URL) {
    if (!certPath && !httpsProxy) throw new Error("FBC_PUBLIC_BASE_URL requires FBC_TLS_CERT_PATH and FBC_TLS_KEY_PATH.");
    const url = new URL(env.FBC_PUBLIC_BASE_URL);
    if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
      throw new Error("FBC_PUBLIC_BASE_URL must be an HTTPS origin without a path.");
    }
    origin = url.origin;
  }
  return { host, port, certPath, keyPath, origin, localHost, httpsProxy, networkExposed: !localHost || httpsProxy };
}

function makeApplication(db, config, options = {}) {
  const controller = new payments.PaymentController(db);
  const loginAttempts = new Map();
  const studentFailures = new Map();
  const checkStudentLock = key => {
    const item = studentFailures.get(key);
    if (item && item.until <= Date.now()) studentFailures.delete(key);
    else if (item && item.count >= 5) throw new HttpError(429, "Too many sign-in attempts. Try again later.");
  };
  const recordStudentFailure = key => {
    const now = Date.now();
    for (const [name, item] of studentFailures) if (item.until <= now) studentFailures.delete(name);
    const item = studentFailures.get(key) || { count: 0, until: now + 15 * 60000 };
    item.count++;
    studentFailures.set(key, item);
  };
  const cookieOptions = request => `Path=/; HttpOnly; SameSite=Lax${config.certPath || (config.httpsProxy && request.headers.origin === config.origin) ? "; Secure" : ""}`;
  const getState = async (database, key, lock = false) => {
    const sql = database.type === "postgres" && lock
      ? "SELECT payload FROM app_state WHERE state_key = ? FOR UPDATE"
      : "SELECT payload FROM app_state WHERE state_key = ?";
    const row = await database.prepare(sql).get(key);
    if (!row) throw new Error(`Missing ${key} state.`);
    return typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
  };
  const writeState = (database, key, state) => database.prepare("UPDATE app_state SET payload = ?, updated_at = ? WHERE state_key = ?")
    .run(JSON.stringify(state), new Date().toISOString(), key);
  const session = async request => {
    const match = /(?:^|;\s*)fbc_session=([a-f0-9]{64})(?:;|$)/.exec(request.headers.cookie || "");
    if (!match) return null;
    const hash = crypto.createHash("sha256").update(match[1]).digest("hex");
    const row = await db.prepare("SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?").get(hash, Date.now());
    if (!row) return null;
    return { role: row.role, subjectId: row.subject_id, tokenHash: hash };
  };
  const requireRole = async (request, roles) => {
    const current = await session(request);
    if (!current) throw new HttpError(401, "Please sign in.");
    if (!roles.includes(current.role)) throw new HttpError(403, "This account cannot perform that action.");
    return current;
  };
  const createSession = async (request, response, role, subjectId) => {
    const existing = await session(request);
    if (existing) await db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(existing.tokenHash);
    const token = crypto.randomBytes(32).toString("hex");
    const hash = crypto.createHash("sha256").update(token).digest("hex");
    const now = Date.now();
    await db.prepare("INSERT INTO sessions(token_hash, role, subject_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(hash, role, subjectId, now, now + SESSION_TTL_MS);
    response.setHeader("Set-Cookie", `fbc_session=${token}; ${cookieOptions(request)}; Max-Age=${SESSION_TTL_MS / 1000}`);
  };
  const clientIp = request => {
    const forwarded = config.httpsProxy && request.socket.remoteAddress && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress)
      ? String(request.headers["x-forwarded-for"] || "").split(",").pop().trim() : "";
    return forwarded || request.socket.remoteAddress || "unknown";
  };
  const limitLogin = request => {
    const now = Date.now();
    for (const [key, item] of loginAttempts) if (item.until <= now) loginAttempts.delete(key);
    const key = clientIp(request);
    const item = loginAttempts.get(key) || { count: 0, until: now + 60000 };
    if (++item.count > 15) throw new HttpError(429, "Too many sign-in attempts. Try again later.");
    loginAttempts.set(key, item);
  };
  const assertOrigin = request => {
    const origin = request.headers.origin;
    if (config.httpsProxy) {
      const localOrigins = ["localhost", "127.0.0.1", "[::1]"].map(host => `http://${host}:${request.socket.localPort}`);
      if (origin === config.origin || (config.localHost && localOrigins.includes(origin) && origin === `http://${request.headers.host}`)) return;
      throw new HttpError(403, "Request origin is not allowed.");
    }
    let expected = config.origin;
    if (!expected && config.localHost) expected = `${config.certPath ? "https" : "http"}://${request.headers.host}`;
    if (!origin || origin !== expected) throw new HttpError(403, "Request origin is not allowed.");
  };
  const sumMinor = (values, convert) => values.reduce((sum, value) => {
    const amount = convert(value);
    if (!Number.isSafeInteger(amount) || amount < 0 || !Number.isSafeInteger(sum + amount)) {
      throw new Error("Account contains invalid monetary amounts.");
    }
    return sum + amount;
  }, 0);
  const storedAmountMinor = value => {
    if (value === 0 || value === "0") return 0;
    return payments.amountToMinor(value);
  };
  const studentAccount = async studentId => {
    const state = await getState(db, PAYPOINT_KEY);
    const student = state.students.find(item => item.id === studentId);
    if (!student) throw new HttpError(404, "Student account was not found.");
    const assessments = state.assessments.filter(item => item.studentId === studentId).map(assessment => {
      const paid = sumMinor(state.payments.filter(payment => payment.assessmentId === assessment.id), item => storedAmountMinor(item.amount));
      const total = sumMinor(assessment.items, item => storedAmountMinor(item.amount));
      return { ...assessment, paid: paid / 100, balance: Math.max(0, total - paid) / 100 };
    });
    const credits = await db.prepare(`SELECT id, transaction_id AS "transactionId", credit_type AS type,
      amount_minor AS "amountMinor", description, created_at AS "createdAt"
      FROM student_credit_ledger WHERE student_id = ? ORDER BY created_at DESC`).all(studentId);
    return {
      student, assessments, payments: state.payments.filter(item => item.studentId === studentId),
      notes: state.notes.filter(item => item.studentId === studentId), credits,
      totalCreditsMinor: sumMinor(credits, credit => Number(credit.amountMinor)),
      totalBalance: sumMinor(assessments, assessment => Math.round(assessment.balance * 100)) / 100
    };
  };

  async function handle(request, response) {
    const url = new URL(request.url, "http://localhost");
    const pathname = url.pathname;
    if (pathname === "/health" && request.method === "GET") return json(response, 200, { ok: true });
    if (!pathname.startsWith("/api/")) {
      const file = FILES.get(pathname);
      if (!file || request.method !== "GET") throw new HttpError(404, "Not found.");
      response.writeHead(200, {
        "Content-Type": file[1], "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "strict-origin-when-cross-origin",
        "X-Frame-Options": "DENY"
      });
      return response.end(await fs.promises.readFile(path.join(ROOT, "public", file[0])));
    }
    const externalEvent = pathname === "/api/webhooks/paymongo" || pathname.startsWith("/api/hardware/cash/");
    if (request.method !== "GET" && !externalEvent) assertOrigin(request);
    if (pathname === "/api/kiosk/config" && request.method === "GET") {
      return json(response, 200, {
        demoGatewayEnabled: !config.networkExposed && process.env.NODE_ENV !== "production" && process.env.FBC_ENABLE_DEMO_GATEWAY === "true"
      });
    }
    if (pathname === "/api/auth/student" && request.method === "POST") {
      limitLogin(request);
      const body = await bodyJson(request);
      const studentNo = typeof body?.studentNo === "string" ? body.studentNo.trim() : "";
      if (!studentNo || studentNo.length > 32) throw new HttpError(401, STUDENT_LOGIN_ERROR);
      const normalizedStudentNo = studentNo.toLowerCase();
      const lockKey = `${clientIp(request)}:${normalizedStudentNo}`;
      checkStudentLock(lockKey);
      const state = await getState(db, PAYPOINT_KEY);
      const matches = state.students.filter(item => String(item.studentNo || "").trim().toLowerCase() === normalizedStudentNo);
      const student = matches.length === 1 ? matches[0] : null;
      if (!student) {
        recordStudentFailure(lockKey);
        throw new HttpError(401, STUDENT_LOGIN_ERROR);
      }
      studentFailures.delete(lockKey);
      await createSession(request, response, "student", student.id);
      return json(response, 200, { role: "student", student });
    }
    if (pathname === "/api/auth/staff" && request.method === "POST") {
      limitLogin(request);
      const body = await bodyJson(request);
      const username = String(body?.username || "").trim().toUpperCase();
      const role = String(body?.role || "");
      const password = String(body?.password || "");
      if (password.length > 1024) throw new HttpError(400, "Invalid credentials.");
      const staffLockKey = `staff:${username}:${role}`;
      checkStudentLock(staffLockKey);
      const user = await db.prepare("SELECT username, role, label, salt, password_hash FROM staff_users WHERE username = ? AND role = ?").get(username, role);
      const salt = user ? Buffer.from(user.salt, "hex") : Buffer.alloc(16);
      const expected = user ? Buffer.from(user.password_hash, "hex") : Buffer.alloc(64);
      const actual = await new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (error, key) => error ? reject(error) : resolve(key)));
      if (expected.length !== 64 || !crypto.timingSafeEqual(actual, expected) || !user) {
        recordStudentFailure(staffLockKey);
        throw new HttpError(401, "Staff ID, password, or role is incorrect.");
      }
      studentFailures.delete(staffLockKey);
      if (config.networkExposed && ["CashierDemo26!", "FinanceDemo26!", "RegistrarDemo26!"].includes(password)) {
        throw new HttpError(403, "Demo staff credentials cannot be used over the network.");
      }
      await createSession(request, response, user.role, user.username);
      return json(response, 200, { username: user.username, role: user.role, label: user.label });
    }
    if (pathname === "/api/auth/session" && request.method === "GET") {
      const current = await requireRole(request, ["student", "cashier", "vp", "registrar"]);
      if (current.role === "student") return json(response, 200, { role: "student", student: (await studentAccount(current.subjectId)).student });
      const user = await db.prepare("SELECT username, role, label FROM staff_users WHERE username = ? AND role = ?").get(current.subjectId, current.role);
      if (!user) throw new HttpError(401, "Staff account no longer exists.");
      return json(response, 200, user);
    }
    if (pathname === "/api/auth/logout" && request.method === "POST") {
      const current = await session(request);
      if (current) await db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(current.tokenHash);
      response.setHeader("Set-Cookie", `fbc_session=; ${cookieOptions(request)}; Max-Age=0`);
      return json(response, 200, { ok: true });
    }
    if (pathname === "/api/admissions" && request.method === "POST") {
      await requireRole(request, ["registrar"]);
      const body = await bodyJson(request);
      const applicant = {
        id: `ADM-${crypto.randomUUID()}`, applicant: String(body?.name || "").trim(),
        email: String(body?.email || "").trim(), course: String(body?.course || "").trim(),
        year: String(body?.year || "").trim(), status: "For review", appliedAt: new Date().toISOString().slice(0, 10)
      };
      if (!safeText(applicant.applicant, 255) || !safeText(applicant.email, 255) ||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(applicant.email) ||
          !safeText(applicant.course, 255) || !safeText(applicant.year, 50)) {
        throw new HttpError(400, "Provide a valid name, email, program and year level.");
      }
      await db.transaction(async transactionDb => {
        const school = await getState(transactionDb, SCHOOL_KEY, true);
        school.admissions.push(applicant);
        await writeState(transactionDb, SCHOOL_KEY, school);
      });
      return json(response, 201, applicant);
    }
    if (pathname === "/api/auth/admission" && request.method === "POST") {
      await requireRole(request, ["registrar"]);
      const body = await bodyJson(request);
      const student = await db.transaction(async transactionDb => {
        const paypoint = await getState(transactionDb, PAYPOINT_KEY, true);
        const school = await getState(transactionDb, SCHOOL_KEY, true);
        const applicant = school.admissions.find(item => item.id === body?.admissionId && item.status === "For review");
        if (!applicant) throw new HttpError(404, "Pending admission was not found.");
        const email = String(body?.email || "").trim();
        const name = String(body?.name || "").trim();
        const course = String(body?.course || "").trim();
        const year = String(body?.year || "").trim();
        if (!safeText(name, 255) || !safeText(email, 255) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
            !safeText(course, 255) || !safeText(year, 50)) throw new HttpError(400, "Provide valid student details.");
        if (paypoint.students.some(item => String(item.email || "").trim().toLowerCase() === email.toLowerCase())) {
          throw new HttpError(409, "That email is already associated with a student.");
        }
        const id = crypto.randomUUID();
        let studentNo;
        do studentNo = `${String(new Date().getFullYear()).slice(2)}${String(crypto.randomInt(0, 1000000)).padStart(6, "0")}`;
        while (paypoint.students.some(item => item.studentNo === studentNo));
        const enrolled = { id: `S-${id}`, studentNo, name, email, course, year };
        paypoint.students.push(enrolled);
        applicant.status = "Enrolled";
        await writeState(transactionDb, PAYPOINT_KEY, paypoint);
        await writeState(transactionDb, SCHOOL_KEY, school);
        return enrolled;
      });
      return json(response, 200, { student });
    }
    const studentSignoutMatch = /^\/api\/students\/([^/]+)\/signout$/.exec(pathname);
    if (studentSignoutMatch && request.method === "POST") {
      await requireRole(request, ["registrar"]);
      let studentId;
      try { studentId = decodeURIComponent(studentSignoutMatch[1]); }
      catch { throw new HttpError(400, "Invalid student record."); }
      const paypoint = await getState(db, PAYPOINT_KEY);
      if (!paypoint.students.some(item => item.id === studentId)) throw new HttpError(404, "Student record was not found.");
      await db.prepare("DELETE FROM sessions WHERE subject_id = ? AND role = 'student'").run(studentId);
      return json(response, 200, { ok: true });
    }
    if (pathname === "/api/staff/import-legacy" && request.method === "POST") {
      await requireRole(request, ["registrar"]);
      const body = await bodyJson(request);
      if (!validPaypoint(body?.paypoint) || !validSchool(body?.school)) throw new HttpError(400, "Legacy records have an invalid format.");
      const result = await db.transaction(async transactionDb => {
        const paypoint = await getState(transactionDb, PAYPOINT_KEY, true);
        const school = await getState(transactionDb, SCHOOL_KEY, true);
        let imported = 0;
        let conflicts = 0;
        const merge = (target, source, accept = () => true) => {
          for (const item of source) {
            if (target.some(existing => existing.id === item.id) || !accept(item)) conflicts++;
            else { target.push(item); imported++; }
          }
        };
        merge(paypoint.students, body.paypoint.students, item =>
          !paypoint.students.some(existing => existing.studentNo.toLowerCase() === item.studentNo.toLowerCase()));
        merge(paypoint.assessments, body.paypoint.assessments, item => paypoint.students.some(student => student.id === item.studentId));
        // Payments cannot be imported; they would bypass cashier role separation.
        conflicts += body.paypoint.payments.length;
        merge(paypoint.notes, body.paypoint.notes, item => item.status === "Pending" && paypoint.students.some(student => student.id === item.studentId));
        merge(school.scholarships, body.school.scholarships, item => item.status === "For review");
        for (const key of ["admissions", "notifications", "schedules"]) merge(school[key], body.school[key]);
        for (const [date, entries] of Object.entries(body.school.attendance)) {
          if (!entries || typeof entries !== "object" || Array.isArray(entries)) throw new HttpError(400, "Invalid attendance records.");
          if (!school.attendance[date]) school.attendance[date] = {};
          for (const [studentId, value] of Object.entries(entries)) {
            if (Object.hasOwn(school.attendance[date], studentId) || !paypoint.students.some(student => student.id === studentId)) conflicts++;
            else { school.attendance[date][studentId] = value; imported++; }
          }
        }
        if (!validPaypoint(paypoint) || !validSchool(school)) throw new HttpError(400, "Merged records have an invalid format.");
        await writeState(transactionDb, PAYPOINT_KEY, paypoint);
        await writeState(transactionDb, SCHOOL_KEY, school);
        return { imported, conflicts };
      });
      return json(response, 200, result);
    }
    if (pathname === "/api/student/account" && request.method === "GET") {
      const current = await requireRole(request, ["student"]);
      return json(response, 200, await studentAccount(current.subjectId));
    }
    if (pathname === "/api/pay" && request.method === "POST") {
      await requireRole(request, ["student"]);
      const headerName = process.env.N8N_HEADER_NAME;
      const headerValue = process.env.N8N_HEADER_VALUE;
      const kioskId = process.env.KIOSK_ID;
      if (!headerName || !headerValue || !kioskId) throw new HttpError(503, "Payment relay is not configured.");
      const body = await bodyJson(request);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Request body must be a JSON object.");
      let upstream;
      try {
        upstream = await fetch(N8N_PAYMENT_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", [headerName]: headerValue },
          body: JSON.stringify({ ...body, kioskId }),
          signal: AbortSignal.timeout(30000)
        });
      } catch {
        throw new HttpError(502, "Payment service is unreachable.");
      }
      const text = await upstream.text();
      response.writeHead(upstream.status, {
        "Content-Type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      });
      return response.end(text);
    }
    if (pathname === "/api/student/payments" && request.method === "POST") throw new HttpError(410, "Use the transaction API.");
    if (pathname === "/api/student/transactions" && request.method === "POST") {
      const current = await requireRole(request, ["student"]);
      const body = await bodyJson(request);
      if (String(body?.method || "").toUpperCase() === "FREE_GATEWAY" &&
          (config.networkExposed || process.env.NODE_ENV === "production" || process.env.FBC_ENABLE_DEMO_GATEWAY !== "true")) {
        throw new HttpError(403, "The demo gateway is disabled.");
      }
      return json(response, 201, await controller.createDigital(current, body, request.headers["idempotency-key"]));
    }
    if (pathname === "/api/student/cash-transactions" && request.method === "POST") {
      const current = await requireRole(request, ["student"]);
      return json(response, 201, await controller.createCash(current, await bodyJson(request), request.headers["idempotency-key"]));
    }
    const transactionMatch = /^\/api\/student\/transactions\/([^/]+)(\/cancel)?$/.exec(pathname);
    if (transactionMatch) {
      const current = await requireRole(request, ["student"]);
      const id = decodeURIComponent(transactionMatch[1]);
      if (request.method === "GET" && !transactionMatch[2]) return json(response, 200, await controller.status(current, id));
      if (request.method === "POST" && transactionMatch[2]) return json(response, 200, await controller.cancelCash(current, id));
    }
    if (pathname === "/api/webhooks/paymongo" && request.method === "POST") {
      return json(response, 200, await controller.paymongoWebhook(await rawBody(request), request.headers["paymongo-signature"]));
    }
    if (pathname.startsWith("/api/hardware/cash/")) {
      const configuredId = process.env.CASH_DEVICE_ID;
      const secret = process.env.CASH_DEVICE_HMAC_SECRET;
      if (!configuredId || !secret) throw new HttpError(503, "Cash device authentication is not configured.");
      const raw = await rawBody(request);
      const deviceId = request.headers["x-cash-device-id"];
      if (deviceId !== configuredId || !payments.verifyCashDeviceSignature(raw, deviceId, request.headers["x-cash-timestamp"], request.headers["x-cash-signature"], secret)) {
        throw new HttpError(401, "Cash device signature is invalid.");
      }
      if (pathname === "/api/hardware/cash/events" && request.method === "POST") {
        let event;
        try { event = JSON.parse(raw.toString("utf8")); }
        catch { throw new HttpError(400, "Cash event must be valid JSON."); }
        return json(response, 200, await controller.confirmCashDeviceEvent(deviceId, event));
      }
      if (pathname === "/api/hardware/cash/acceptance" && request.method === "GET") {
        return json(response, 200, await controller.cashDeviceAcceptance(url.searchParams.get("transactionId")));
      }
    }
    if (pathname === "/api/staff/state") {
      const current = await requireRole(request, ["cashier", "vp", "registrar"]);
      const key = url.searchParams.get("system");
      if (![PAYPOINT_KEY, SCHOOL_KEY].includes(key)) throw new HttpError(400, "Unknown system.");
      if (key === SCHOOL_KEY && current.role === "cashier") throw new HttpError(403, "School staff access required.");
      if (request.method === "GET") {
        const state = await getState(db, key);
        const paypoint = key === SCHOOL_KEY && current.role === "vp" ? await getState(db, PAYPOINT_KEY) : null;
        return json(response, 200, roleView(key, state, current.role, paypoint), { ETag: revision(state) });
      }
      if (request.method === "PUT") {
        const submitted = await bodyJson(request);
        const nextRevision = await db.transaction(async transactionDb => {
          const previous = await getState(transactionDb, key, true);
          if (!request.headers["if-match"] || request.headers["if-match"] !== revision(previous)) {
            throw new HttpError(409, "Records changed on another device. Reload and retry your changes.");
          }
          const paypoint = key === SCHOOL_KEY && current.role === "vp" ? await getState(transactionDb, PAYPOINT_KEY) : null;
          const next = mergeRoleChanges(key, previous, submitted, current.role, paypoint);
          await writeState(transactionDb, key, next);
          return revision(next);
        });
        return json(response, 200, { ok: true }, { ETag: nextRevision });
      }
    }
    throw new HttpError(404, "API route not found.");
  }
  return (request, response) => {
    Promise.resolve(handle(request, response)).catch(error => {
      if (response.headersSent) return response.destroy(error);
      const status = error.statusCode || 500;
      if (status >= 500) console.error("Request failed.", error);
      json(response, status, { error: status === 500 ? "Internal server error." : error.message });
    });
  };
}

async function start() {
  const envFile = path.join(ROOT, ".env");
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  const config = configuration();
  const db = createDatabase({ databasePath: path.resolve(process.env.SQLITE_DATABASE_PATH || path.join(ROOT, "data", "fbc-paypoint.sqlite")) });
  try {
    await initializeDatabase(db);
    const handler = makeApplication(db, config);
    const server = config.certPath
      ? https.createServer({ cert: fs.readFileSync(config.certPath), key: fs.readFileSync(config.keyPath) }, handler)
      : http.createServer(handler);
    const stopWorker = payments.startReceiptDeliveryWorker(db);
    server.listen(config.port, config.host, () => console.log(`FBC Paypoint listening on ${config.host}:${config.port}`));
    server.on("error", error => { console.error("Server failed.", error); process.exitCode = 1; });
    const shutdown = () => server.close(async () => { await stopWorker(); await db.close(); });
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch (error) {
    await db.close();
    throw error;
  }
}

if (require.main === module) {
  start().catch(error => { console.error(`Server startup failed: ${error.message}`); process.exitCode = 1; });
}

module.exports = { configuration, initializeDatabase, makeApplication };
