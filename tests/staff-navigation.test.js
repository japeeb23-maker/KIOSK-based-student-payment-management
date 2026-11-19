const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

async function loadApp(filename, query, session, records = {}) {
  const elements = new Map();
  const listeners = new Map();
  const calls = [];
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      innerHTML: "", textContent: "", hidden: false, dataset: {},
      classList: { toggle() {}, remove() {} },
      setAttribute() {}, append() {}, focus() {},
      addEventListener(type, handler) { listeners.set(`${id}:${type}`, handler); },
      querySelector() { return element(`${id}:child`); },
      querySelectorAll() { return []; }
    });
    return elements.get(id);
  }
  const document = {
    getElementById: element,
    querySelector: element,
    querySelectorAll() { return []; },
    createElement: element,
    addEventListener(type, handler) { listeners.set(`document:${type}`, handler); }
  };
  const context = {
    document, window: { location: { search: query } }, URLSearchParams, Intl, Date,
    console, setTimeout() {},
    FormData: class { get(key) { return { role: "registrar", username: "REG", password: "test" }[key]; } },
    fbcApi: {
      async get(url) {
        calls.push(url);
        if (url === "/api/auth/session") {
          if (!session) throw Object.assign(new Error("Not signed in"), { status: 401 });
          return session;
        }
        if (url.includes("system=school")) return records.school || { admissions: [], attendance: {}, notifications: [], schedules: [], scholarships: [], studentRoster: [] };
        return records.paypoint || { students: [], assessments: [], payments: [], notes: [] };
      },
      async post(url) {
        calls.push(url);
        return { role: "registrar", username: "REG", label: "Registrar" };
      }
    }
  };
  const initializer = filename === "app.js" ? "initializeStaffApp" : "initializeSchoolApp";
  const source = fs.readFileSync(path.join(__dirname, "..", "public", filename), "utf8")
    .replace(new RegExp(`${initializer}\\(\\);\\s*$`), `globalThis.initialization = ${initializer}();`);
  vm.runInNewContext(source, context, { filename });
  await context.initialization;
  return { element, listeners, calls };
}

test("registrar link prompts to switch from a VP session and opens registrar dashboard", async () => {
  const app = await loadApp("scholastech.js", "?portal=registrar", { role: "vp", username: "VP", label: "VP" });
  assert.equal(app.element("schoolModalBackdrop").hidden, false);
  assert.match(app.element("schoolModal").innerHTML, /value="registrar" selected/);
  assert.equal(app.calls.includes("/api/staff/state?system=school"), false);
  const form = app.element("schoolLoginForm");
  await app.listeners.get("schoolLoginForm:submit")({ preventDefault() {}, currentTarget: form });
  assert.match(app.element("schoolPageRoot").innerHTML, /Registrar dashboard/);
  assert.match(app.element("schoolPageRoot").innerHTML, /href="scholastech\.html">Open FellowTech/);
  assert.equal(app.element("schoolBreadcrumb").textContent, "Dashboard");
});

test("registrar student records offer a kiosk sign-out action", async () => {
  const app = await loadApp("scholastech.js", "?portal=registrar", { role: "registrar", username: "REG", label: "Registrar" }, {
    paypoint: {
      students: [{ id: "s1", studentNo: "S001", name: "Test Student", course: "IT", year: "1st Year", email: "student@fbc.ph.education" }],
      assessments: [], payments: [], notes: []
    }
  });
  const click = app.listeners.get("document:click");
  await click({ target: { closest: selector => selector === "[data-school-page]" ? { dataset: { schoolPage: "students" } } : null } });
  assert.match(app.element("schoolPageRoot").innerHTML,   /data-school-action="signout-student" data-id="s1">Sign out/);
    assert.doesNotMatch(app.element("schoolPageRoot").innerHTML, /PIN/);
});

test("role-specific finance link prompts when a registrar session exists", async () => {
  const app = await loadApp("app.js", "?staffRole=vp", { role: "registrar", username: "REG", label: "Registrar" });
  assert.equal(app.element("modalBackdrop").hidden, false);
  assert.match(app.element("modal").innerHTML, /value="vp" selected/);
  assert.equal(app.calls.includes("/api/staff/state?system=paypoint"), false);
});

test("FellowTech retains its overview for a signed-in registrar", async () => {
  const app = await loadApp("scholastech.js", "", { role: "registrar", username: "REG", label: "Registrar" });
  assert.match(app.element("schoolPageRoot").innerHTML, /One campus\. One connected student record\./);
  assert.equal(app.element("schoolModal").innerHTML, "");
  assert.ok(app.calls.includes("/api/staff/state?system=school"));
});

test("existing registrar login links open the registrar dashboard", async () => {
  const app = await loadApp("scholastech.js", "?staffRole=registrar", { role: "registrar", username: "REG", label: "Registrar" });
  assert.match(app.element("schoolPageRoot").innerHTML, /Registrar dashboard/);
  assert.equal(app.element("schoolModal").innerHTML, "");
});

test("registrar dashboard summarizes shared records and links to registrar workspaces", async () => {
  const app = await loadApp("scholastech.js", "?portal=registrar", { role: "registrar", username: "REG", label: "Registrar" }, {
    paypoint: { students: [{ id: "s1" }, { id: "s2" }], assessments: [{ id: "a1" }], payments: [], notes: [] },
    school: { admissions: [{ status: "For review" }, { status: "For review" }, { status: "Enrolled" }], attendance: {}, notifications: [], schedules: [], scholarships: [] }
  });
  const dashboard = app.element("schoolPageRoot").innerHTML;
  assert.match(dashboard, /Student records[\s\S]*?stat-value">2</);
  assert.match(dashboard, /Admissions for review[\s\S]*?stat-value">2</);
  assert.match(dashboard, /Enrolled admissions[\s\S]*?stat-value">1</);
  assert.match(dashboard, /Assessment records[\s\S]*?stat-value">1</);
  assert.match(dashboard, /data-school-page="admissions"/);
});

test("student payment demo is labeled and selected without changing live payment options", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "kiosk.js"), "utf8").replace(/initialize\(\);\s*$/, "");
  for (const demoEnabled of [true, false]) {
    const elements = new Map();
    const element = id => {
      if (!elements.has(id)) elements.set(id, {
        innerHTML: "", addEventListener() {}, querySelectorAll() { return []; }
      });
      return elements.get(id);
    };
    const context = {
      document: { getElementById: element, body: { classList: { remove() {} } } },
      crypto: { randomUUID: () => "test-id" }, Intl, clearTimeout,
      sessionStorage: { setItem() {} }, fbcApi: { get: async () => ({}) }, console
    };
    vm.runInNewContext(`${source}
      config = { demoGatewayEnabled: ${demoEnabled} };
      account = { student: { name: "Student", studentNo: "S1", course: "IT", year: "1" },
        assessments: [{ id: "a1", balance: 100 }] };
      renderPayment("a1");`, context);
    const paymentView = element("kioskRoot").innerHTML;
    assert.equal(paymentView.includes('value="FREE_GATEWAY" selected'), demoEnabled);
    assert.equal(paymentView.includes("LOCAL DEMO"), demoEnabled);
    vm.runInNewContext(`renderTransaction({ transactionId: "t1", status: "PAID",
      channel: "DIGITAL", amountDueMinor: 10000, receipt: { orNumber: "1", feeBreakdown: [] } });`, context);
    const receiptView = element("kioskRoot").innerHTML;
    assert.match(receiptView, demoEnabled ? /Demo receipt/ : /Official receipt/);
    assert.equal(receiptView.includes("LOCAL DEMO"), demoEnabled);
  }
});
