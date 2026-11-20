const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createDatabase } = require("../src/server/database");
const { configuration, initializeDatabase, makeApplication } = require("../src/server/server");

const scrypt = (password, salt) => new Promise((resolve, reject) =>
  crypto.scrypt(password, salt, 64, (error, key) => error ? reject(error) : resolve(key)));

test("network proxy mode requires explicit production configuration", async () => {
  const env = {
    NODE_ENV: "production", FBC_HOST: "0.0.0.0", FBC_ALLOW_NETWORK_PROXY: "true",
    FBC_TRUST_HTTPS_PROXY: "true", FBC_PUBLIC_BASE_URL: "https://example.onrender.com"
  };
  const config = configuration(env);
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.networkExposed, true);
  assert.throws(() => configuration({ ...env, FBC_ALLOW_NETWORK_PROXY: "false" }));
  assert.throws(() => configuration({ ...env, FBC_TRUST_HTTPS_PROXY: "false" }));
  assert.throws(() => configuration({ ...env, NODE_ENV: "development" }));

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fbc-proxy-test-"));
  const originalUrl = process.env.DATABASE_URL;
  const originalEnv = process.env.NODE_ENV;
  delete process.env.DATABASE_URL;
  process.env.NODE_ENV = "test";
  const db = createDatabase({ databasePath: path.join(directory, "test.sqlite") });
  let server;
  try {
    await initializeDatabase(db);
    server = http.createServer(makeApplication(db, config));
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const login = origin => fetch(`${base}/api/auth/student`, {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: "{}"
    });
    assert.equal((await login(env.FBC_PUBLIC_BASE_URL)).status, 401);
    assert.equal((await login(base)).status, 403);
    assert.equal((await login("https://evil.example")).status, 403);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await db.close();
    if (originalUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = originalUrl;
    if (originalEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = originalEnv;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("sessions, roles, payments and registrar actions are enforced by the server", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fbc-server-test-"));
  const originalUrl = process.env.DATABASE_URL;
  const originalEnv = process.env.NODE_ENV;
  const originalDemo = process.env.FBC_ENABLE_DEMO_GATEWAY;
  delete process.env.DATABASE_URL;
  process.env.NODE_ENV = "test";
  process.env.FBC_ENABLE_DEMO_GATEWAY = "true";
  const db = createDatabase({ databasePath: path.join(directory, "test.sqlite") });
  let server;
  let proxyServer;
  try {
    await initializeDatabase(db);
    const paypoint = {
      students: [
        { id: "s1", studentNo: "S001", name: "Test Student", course: "IT", year: "1st Year", email: "a@fbc.ph.education" },
        { id: "s2", studentNo: "S002", name: "Other Student", course: "IT", year: "1st Year", email: "b@fbc.ph.education" }
      ],
      assessments: [
        { id: "a1", studentId: "s1", term: "Test Term", date: "2026-01-01", items: [{ label: "Tuition", amount: 100 }] },
        { id: "a2", studentId: "s2", term: "Test Term", date: "2026-01-01", items: [{ label: "Fee", amount: 0.2 }] }
      ],
      payments: [],
      notes: [{ id: "n1", studentId: "s1", amount: 10, purpose: "Please review", dueDate: "2026-01-01", installments: 1, createdAt: "2026-01-01T00:00:00Z", status: "Pending" }]
    };
    await db.prepare("UPDATE app_state SET payload = ? WHERE state_key = 'paypoint'").run(JSON.stringify(paypoint));
    for (const [username, role] of [["CASHIER", "cashier"], ["REGISTRAR", "registrar"], ["VP", "vp"]]) {
      const salt = crypto.randomBytes(16);
      const hash = await scrypt("test-staff-password", salt);
      await db.prepare("INSERT INTO staff_users(username, role, label, salt, password_hash) VALUES (?, ?, ?, ?, ?)")
        .run(username, role, username, salt.toString("hex"), hash.toString("hex"));
    }
    const persistedStaffRoles = (await db.prepare("SELECT role, COUNT(*) AS count FROM staff_users GROUP BY role ORDER BY role").all())
      .map(row => [row.role, Number(row.count)]);
    assert.deepEqual(persistedStaffRoles, [
      ["cashier", 1],
      ["registrar", 1],
      ["vp", 1]
    ]);
    server = http.createServer(makeApplication(db, configuration({})));
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = (route, options = {}) => fetch(`${base}${route}`, {
      ...options,
      headers: { ...(options.method && options.method !== "GET" ? { Origin: base, "Content-Type": "application/json" } : {}), ...options.headers }
    });
    const post = (route, body, headers = {}) => request(route, { method: "POST", headers, body: JSON.stringify(body) });

    const publicOrigin = "https://example.test";
    proxyServer = http.createServer(makeApplication(db, configuration({
      PORT: "0", FBC_TRUST_HTTPS_PROXY: "true", FBC_PUBLIC_BASE_URL: publicOrigin
    })));
    await new Promise(resolve => proxyServer.listen(0, "127.0.0.1", resolve));
    const proxyBase = `http://127.0.0.1:${proxyServer.address().port}`;
    const proxyLogin = origin => fetch(`${proxyBase}/api/auth/staff`, {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ username: "REGISTRAR", role: "registrar", password: "test-staff-password" })
    });
    const proxiedLogin = await proxyLogin(publicOrigin);
    assert.equal(proxiedLogin.status, 200);
    assert.match(proxiedLogin.headers.get("set-cookie"), /; Secure(?:;|$)/);
    const proxyCookie = proxiedLogin.headers.get("set-cookie").split(";")[0];
    const proxyLogout = await fetch(`${proxyBase}/api/auth/logout`, {
      method: "POST", headers: { Origin: publicOrigin, Cookie: proxyCookie, "Content-Type": "application/json" }, body: "{}"
    });
    assert.equal(proxyLogout.status, 200);
    assert.match(proxyLogout.headers.get("set-cookie"), /; Secure(?:;|$)/);
    assert.equal((await proxyLogin("https://evil.example")).status, 403);
    const localLogin = await proxyLogin(proxyBase);
    assert.equal(localLogin.status, 200);
    assert.doesNotMatch(localLogin.headers.get("set-cookie"), /; Secure(?:;|$)/);
    assert.equal((await (await fetch(`${proxyBase}/api/kiosk/config`)).json()).demoGatewayEnabled, false);

    assert.equal((await request("/api/student/account")).status, 401);
    assert.equal((await post("/api/auth/google", { credential: "ok" })).status, 404);
    assert.equal((await post("/api/auth/student", { studentNo: "S001" }, { Origin: "https://evil.example" })).status, 403);
    const failures = [];
    for (const credentials of [{ studentNo: "NOPE" }, {}, { studentNo: 1 }]) failures.push(await post("/api/auth/student", credentials));
    for (const failure of failures) {
      assert.equal(failure.status, 401);
      assert.equal(failure.headers.get("set-cookie"), null);
    }
    assert.equal(new Set(await Promise.all(failures.map(failure => failure.text()))).size, 1);
    const login = await post("/api/auth/student", { studentNo: " s001 " });
    assert.equal(login.status, 200, await login.clone().text());
    const studentCookie = login.headers.get("set-cookie").split(";")[0];
    const account = await request("/api/student/account", { headers: { Cookie: studentCookie } });
    assert.equal((await account.json()).totalBalance, 100);
    assert.equal((await request("/api/staff/state?system=paypoint", { headers: { Cookie: studentCookie } })).status, 403);

    const staffLogin = await post("/api/auth/staff", { username: "CASHIER", role: "cashier", password: "test-staff-password" });
    assert.equal(staffLogin.status, 200);
    const staffCookie = staffLogin.headers.get("set-cookie").split(";")[0];
    const staffState = await request("/api/staff/state?system=paypoint", { headers: { Cookie: staffCookie } });
    const etag = staffState.headers.get("etag");
    const snapshot = await staffState.json();
    const payment = await post("/api/student/transactions", { assessmentId: "a1", amount: "20", method: "FREE_GATEWAY" },
      { Cookie: studentCookie, "Idempotency-Key": "test-payment-0001" });
    assert.equal(payment.status, 201);
    const paidTransaction = await payment.json();
    assert.equal(paidTransaction.status, "PAID");
    const refreshed = await request("/api/student/account", { headers: { Cookie: studentCookie } });
    assert.equal((await refreshed.json()).totalBalance, 80);

    const staleWrite = await request("/api/staff/state?system=paypoint", {
      method: "PUT", headers: { Cookie: staffCookie, "If-Match": etag }, body: JSON.stringify(snapshot)
    });
    assert.equal(staleWrite.status, 409);
    assert.equal((await request("/api/staff/state?system=school", { headers: { Cookie: staffCookie } })).status, 403);
    const otherLogin = await post("/api/auth/student", { studentNo: "S002" });
    const otherCookie = otherLogin.headers.get("set-cookie").split(";")[0];
    const otherAccount = await request("/api/student/account", { headers: { Cookie: otherCookie } });
    assert.equal((await otherAccount.json()).totalBalance, 0.2);
    assert.equal((await request(`/api/student/transactions/${paidTransaction.transactionId}`, { headers: { Cookie: otherCookie } })).status, 404);
    assert.equal((await post("/api/student/transactions", { assessmentId: "a1", amount: "1", method: "FREE_GATEWAY" },
      { Cookie: otherCookie, "Idempotency-Key": "other-student-01" })).status, 404);

    const registrarLogin = await post("/api/auth/staff", { username: "REGISTRAR", role: "registrar", password: "test-staff-password" });
    const registrarCookie = registrarLogin.headers.get("set-cookie").split(";")[0];
    const admission = await post("/api/admissions", { name: "New Student", email: "new@fbc.ph.education", course: "IT", year: "1st Year" }, { Cookie: registrarCookie });
    assert.equal(admission.status, 201);
    const applicant = await admission.json();
    assert.equal((await post("/api/auth/admission", { admissionId: applicant.id, name: "New Student",
      email: "new@fbc.ph.education", course: "IT", year: "1st Year" }, { Cookie: registrarCookie })).status, 200);
    assert.equal((await post("/api/auth/admission", { admissionId: applicant.id }, { Cookie: registrarCookie })).status, 404);

    const vpLogin = await post("/api/auth/staff", { username: "VP", role: "vp", password: "test-staff-password" });
    const vpCookie = vpLogin.headers.get("set-cookie").split(";")[0];
    const vpStateResponse = await request("/api/staff/state?system=paypoint", { headers: { Cookie: vpCookie } });
    const vpState = await vpStateResponse.json();
    assert.equal(vpState.students[0].email, undefined);
    vpState.notes[0].status = "Approved";
    assert.equal((await request("/api/staff/state?system=paypoint", {
      method: "PUT", headers: { Cookie: vpCookie, "If-Match": vpStateResponse.headers.get("etag") }, body: JSON.stringify(vpState)
    })).status, 200);
    const schoolResponse = await request("/api/staff/state?system=school", { headers: { Cookie: vpCookie } });
    const school = await schoolResponse.json();
    school.attendance["2026-01-01"] = { s1: "Present" };
    assert.equal((await request("/api/staff/state?system=school", {
      method: "PUT", headers: { Cookie: vpCookie, "If-Match": schoolResponse.headers.get("etag") }, body: JSON.stringify(school)
    })).status, 200);
    assert.equal((await post("/api/admissions", {}, { Cookie: vpCookie })).status, 403);

    assert.equal((await post("/api/students/s1/signout", {})).status, 401);
    assert.equal((await post("/api/students/s1/signout", {}, { Cookie: staffCookie })).status, 403);
    const signedOut = await post("/api/students/s1/signout", {}, { Cookie: registrarCookie });
    assert.equal(signedOut.status, 200, await signedOut.clone().text());
    assert.deepEqual(await signedOut.json(), { ok: true });
    assert.equal((await request("/api/student/account", { headers: { Cookie: studentCookie } })).status, 401);
    const relogin = await post("/api/auth/student", { studentNo: "S001" });
    assert.equal(relogin.status, 200);
    const reloginCookie = relogin.headers.get("set-cookie").split(";")[0];
    assert.equal((await request("/api/student/account", { headers: { Cookie: reloginCookie } })).status, 200);
    assert.equal((await post("/api/auth/logout", {}, { Cookie: reloginCookie })).status, 200);
    assert.equal((await request("/api/student/account", { headers: { Cookie: reloginCookie } })).status, 401);
  } finally {
    if (proxyServer) await new Promise(resolve => proxyServer.close(resolve));
    if (server) await new Promise(resolve => server.close(resolve));
    await db.close();
    fs.rmSync(directory, { recursive: true, force: true });
    if (originalUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = originalUrl;
    if (originalEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = originalEnv;
    if (originalDemo === undefined) delete process.env.FBC_ENABLE_DEMO_GATEWAY; else process.env.FBC_ENABLE_DEMO_GATEWAY = originalDemo;
  }
});

test("student number login hides unknown numbers and locks repeated failures", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fbc-login-test-"));
  const originalUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  const db = createDatabase({ databasePath: path.join(directory, "test.sqlite") });
  let server;
  try {
    await initializeDatabase(db);
    const state = { students: [{ id: "s1", studentNo: "S001", name: "Test Student", course: "IT", year: "1st Year", email: "a@fbc.ph.education" }], assessments: [], payments: [], notes: [] };
    await db.prepare("UPDATE app_state SET payload = ? WHERE state_key = 'paypoint'").run(JSON.stringify(state));
    server = http.createServer(makeApplication(db, configuration({})));
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const login = body => fetch(`${base}/api/auth/student`, { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await login({ studentNo: "S999" })).status, 401);
    for (let attempt = 0; attempt < 4; attempt++) assert.equal((await login({ studentNo: "S999" })).status, 401);
    assert.equal((await login({ studentNo: "S999" })).status, 429);
    assert.equal((await login({ studentNo: "S001" })).status, 200);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await db.close();
    fs.rmSync(directory, { recursive: true, force: true });
    if (originalUrl !== undefined) process.env.DATABASE_URL = originalUrl;
  }
});

test("POST /api/pay relays to n8n with a server-side header and kiosk id", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fbc-pay-test-"));
  const saved = { fetch: globalThis.fetch, url: process.env.DATABASE_URL };
  const keys = ["N8N_HEADER_NAME", "N8N_HEADER_VALUE", "KIOSK_ID"];
  const savedEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  delete process.env.DATABASE_URL;
  const db = createDatabase({ databasePath: path.join(directory, "test.sqlite") });
  let server;
  try {
    await initializeDatabase(db);
    const state = { students: [{ id: "s1", studentNo: "S001", name: "T", course: "IT", year: "1st Year", email: "" }], assessments: [], payments: [], notes: [] };
    await db.prepare("UPDATE app_state SET payload = ? WHERE state_key = 'paypoint'").run(JSON.stringify(state));
    server = http.createServer(makeApplication(db, configuration({})));
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (route, body, headers = {}) => fetch(`${base}${route}`, {
      method: "POST", headers: { Origin: base, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body)
    });
    assert.equal((await post("/api/pay", { amount: 1 })).status, 401);
    const login = await post("/api/auth/student", { studentNo: "S001" });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    for (const key of keys) delete process.env[key];
    assert.equal((await post("/api/pay", { amount: 1 }, { Cookie: cookie })).status, 503);
    Object.assign(process.env, { N8N_HEADER_NAME: "X-Test-Key", N8N_HEADER_VALUE: "secret-value", KIOSK_ID: "KIOSK-7" });
    let captured;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      if (!String(url).startsWith("https://japheth30.app.n8n.cloud/")) return realFetch(url, options);
      captured = { url: String(url), options };
      return new Response(JSON.stringify({ accepted: false, reason: "declined" }), { status: 422, headers: { "Content-Type": "application/json" } });
    };
    const result = await post("/api/pay", { amount: 5, kioskId: "spoofed" }, { Cookie: cookie });
    globalThis.fetch = realFetch;
    assert.equal(result.status, 422);
    assert.deepEqual(await result.json(), { accepted: false, reason: "declined" });
    assert.equal(captured.url, "https://japheth30.app.n8n.cloud/webhook/fbc-kiosk-payment-request");
    assert.equal(captured.options.headers["X-Test-Key"], "secret-value");
    assert.deepEqual(JSON.parse(captured.options.body), { amount: 5, kioskId: "KIOSK-7" });
    assert.equal((await post("/api/pay", [1], { Cookie: cookie })).status, 400);
  } finally {
    globalThis.fetch = saved.fetch;
    for (const key of keys) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key]; }
    if (server) await new Promise(resolve => server.close(resolve));
    await db.close();
    fs.rmSync(directory, { recursive: true, force: true });
    if (saved.url !== undefined) process.env.DATABASE_URL = saved.url;
  }
});
