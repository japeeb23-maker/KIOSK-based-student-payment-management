const root = document.getElementById("kioskRoot");
const safe = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const cash = value => new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(Number(value));
let account = null;
let config = null;
let pollTimer = null;
let currentTransactionId = null;

function stopPolling() {
  clearTimeout(pollTimer);
  pollTimer = null;
  currentTransactionId = null;
}

function showError(message) {
  const element = document.getElementById("kioskMessage");
  if (element) element.textContent = message;
}

async function renderLogin(message = "") {
  stopPolling();
  account = null;
  document.body.classList.remove("student-dashboard-active");
  document.body.classList.add("student-login");
  root.innerHTML = `${config?.demoGatewayEnabled ? '<p class="kiosk-auth-note"><strong>LOCAL DEMO:</strong> Payments are simulated and do not transfer money.</p>' : ""}<div class="kiosk-step">STUDENT SIGN IN</div><h2>Access your fee account</h2>
    <p class="card-description">Enter your student number using the keypad or keyboard.</p>
    <form id="studentLoginForm"><div class="field"><label for="studentNo">Student number</label>
      <input id="studentNo" name="studentNo" inputmode="none" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="32" autofocus required></div>
      <div class="kiosk-keypad" role="group" aria-label="Student number keypad">
        ${["1", "2", "3", "4", "5", "6", "7", "8", "9"].map(digit => `<button type="button" class="kiosk-key" data-key="${digit}">${digit}</button>`).join("")}
        <button type="button" class="kiosk-key kiosk-key-action" data-key="clear" aria-label="Clear">Clear</button>
        <button type="button" class="kiosk-key" data-key="0">0</button>
        <button type="button" class="kiosk-key kiosk-key-action" data-key="back" aria-label="Backspace">&#9003;</button>
      </div>
      <button type="submit" class="button button-primary">Sign in</button></form>
    <div class="kiosk-message" id="kioskMessage" role="alert">${safe(message)}</div>
    <p class="kiosk-auth-note">Don't know your student number? Ask the Registrar or Finance Office.</p>`;
  const studentNoInput = document.getElementById("studentNo");
  studentNoInput.addEventListener("input", () => { studentNoInput.value = studentNoInput.value.replace(/[^0-9A-Za-z-]/g, ""); });
  document.querySelector(".kiosk-keypad").addEventListener("click", event => {
    const key = event.target.closest("[data-key]")?.dataset.key;
    if (!key) return;
    if (key === "clear") studentNoInput.value = "";
    else if (key === "back") studentNoInput.value = studentNoInput.value.slice(0, -1);
    else if (studentNoInput.value.length < studentNoInput.maxLength) studentNoInput.value += key;
    studentNoInput.focus();
  });
  document.getElementById("studentLoginForm").addEventListener("submit", async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await fbcApi.post("/api/auth/student", { studentNo: form.get("studentNo") });
      await refreshAccount();
      renderAccount();
    } catch (error) {
      console.error("Student sign-in failed.", error);
      studentNoInput.value = "";
      showError(error.message);
    }
  });
}

async function refreshAccount() {
  account = await fbcApi.get("/api/student/account");
}

async function logout() {
  stopPolling();
  try {
    await fbcApi.post("/api/auth/logout");
    sessionStorage.removeItem("fbcActiveTransaction");
    await renderLogin();
  } catch (error) {
    console.error("Student sign-out failed.", error);
    showError(`Sign-out failed: ${error.message}`);
  }
}

function studentHeader(includeSignout = true) {
  const student = account.student;
  return `<div class="kiosk-student-summary"><span><strong>${safe(student.name)}</strong>
    <small>Student ID ${safe(student.studentNo)} · ${safe(student.course)} · ${safe(student.year)}</small></span>
    ${includeSignout ? '<button type="button" class="kiosk-signout" id="studentLogout">Sign out</button>' : ""}</div>`;
}

function wireCommon() {
  document.getElementById("studentLogout")?.addEventListener("click", logout);
}

function renderAccount() {
  stopPolling();
  document.body.classList.remove("student-login");
  document.body.classList.add("student-dashboard-active");
  const assessments = account.assessments;
  const amountPaid = assessments.reduce((sum, item) => sum + Number(item.paid), 0);
  root.innerHTML = `<div class="student-dashboard-view">${config?.demoGatewayEnabled ? '<p class="kiosk-auth-note"><strong>LOCAL DEMO:</strong> Payments are simulated and do not transfer money.</p>' : ""}${studentHeader(false)}
    <section class="student-dashboard-welcome"><div class="kiosk-step">STUDENT PORTAL</div><h2>Welcome, ${safe(account.student.name)}</h2>
      <p class="card-description">Your student account at a glance. Review your fees or refresh to see payments from other devices.</p></section>
    <div class="student-dashboard-stats">
      <article class="student-dashboard-stat"><span>Outstanding balance</span><strong>${cash(account.totalBalance)}</strong><small>Current amount due</small></article>
      <article class="student-dashboard-stat"><span>Assessments</span><strong>${assessments.length}</strong><small>Available fee records</small></article>
      <article class="student-dashboard-stat"><span>Payments received</span><strong>${cash(amountPaid)}</strong><small>Across your assessments</small></article>
      <article class="student-dashboard-stat"><span>Account credits</span><strong>${cash(account.totalCreditsMinor / 100)}</strong><small>Not automatically applied</small></article>
    </div>
    <div class="student-dashboard-grid"><section class="student-assessment-panel">
      <div class="student-dashboard-panel-heading"><div><h3>Your assessments</h3><p>Choose an assessment to see fee details and payment options.</p></div>
        <button type="button" class="button button-secondary" id="refreshAccount">Refresh account</button></div>
      ${assessments.length ? `<div class="kiosk-assessments">${assessments.map(item => `<div class="kiosk-assessment-row">
      <span><strong>${safe(item.term)}</strong><small>Assessment ${safe(item.id)} · Balance ${cash(item.balance)}</small></span>
      <button type="button" class="button button-primary" data-assessment-id="${safe(item.id)}">View fees</button></div>`).join("")}</div>` :
      `<div class="kiosk-empty"><strong>No assessments yet</strong>Contact the Finance Office if you expect an assessment.</div>`}
      <div id="kioskMessage" class="kiosk-message" role="alert"></div></section>
      <aside class="student-account-panel"><div class="student-dashboard-panel-heading"><div><h3>Account summary</h3><p>Current fee account totals</p></div></div>
        <div class="kiosk-balance"><span>Total outstanding</span><strong>${cash(account.totalBalance)}</strong></div>
        <div class="kiosk-balance"><span>Payments received</span><strong>${cash(amountPaid)}</strong></div>
        <div class="kiosk-balance"><span>Account credits</span><strong>${cash(account.totalCreditsMinor / 100)}</strong></div>
        <div class="student-dashboard-actions">${sessionStorage.getItem("fbcActiveTransaction") ? '<button type="button" class="button button-primary" id="resumeTransaction">Resume payment</button>' : ""}
          <button type="button" class="kiosk-signout" id="studentLogout">Sign out</button></div></aside></div></div>`;
  wireCommon();
  document.getElementById("refreshAccount").addEventListener("click", async () => {
    try { await refreshAccount(); renderAccount(); }
    catch (error) { showError(error.message); }
  });
  document.getElementById("resumeTransaction")?.addEventListener("click", async () => {
    try {
      const id = sessionStorage.getItem("fbcActiveTransaction");
      renderTransaction(await fbcApi.get(`/api/student/transactions/${encodeURIComponent(id)}`));
    } catch (error) { showError(error.message); }
  });
  root.querySelectorAll("[data-assessment-id]").forEach(button =>
    button.addEventListener("click", () => renderAssessment(button.dataset.assessmentId)));
}

function renderAssessment(id) {
  document.body.classList.remove("student-dashboard-active");
  const assessment = account.assessments.find(item => item.id === id);
  if (!assessment) return renderAccount();
  root.innerHTML = `${studentHeader()}<button type="button" class="action-link kiosk-back" id="backToAccount">← All assessments</button>
    <div class="kiosk-step">ASSESSMENT DETAILS</div><h2>${safe(assessment.term)}</h2>
    <p class="card-description">Assessment ${safe(assessment.id)}</p>
    <div class="kiosk-assessments">${assessment.items.map(item => `<div class="kiosk-assessment-row"><strong>${safe(item.label)}</strong><strong>${cash(item.amount)}</strong></div>`).join("")}
    <div class="kiosk-balance"><span>Payments received</span><strong>${cash(assessment.paid)}</strong></div>
    <div class="kiosk-balance"><span>Balance due</span><strong>${cash(assessment.balance)}</strong></div></div>
    <div id="kioskMessage" class="kiosk-message" role="alert"></div>
    ${assessment.balance > 0 ? `<div class="form-footer"><button type="button" class="button button-primary" id="startPayment">Continue to payment</button></div>` : ""}`;
  wireCommon();
  document.getElementById("backToAccount").addEventListener("click", renderAccount);
  document.getElementById("startPayment")?.addEventListener("click", () => renderPayment(id));
}

function renderPayment(id) {
  document.body.classList.remove("student-dashboard-active");
  const assessment = account.assessments.find(item => item.id === id);
  if (!assessment || assessment.balance <= 0) return renderAccount();
  let key = crypto.randomUUID();
  root.innerHTML = `${studentHeader()}<button type="button" class="action-link kiosk-back" id="backToAssessment">← Assessment details</button>
    <div class="kiosk-step">PAYMENT OPTIONS</div><h2>Review your payment</h2>
    ${config.demoGatewayEnabled ? '<p class="kiosk-auth-note"><strong>LOCAL DEMO:</strong> The free demo gateway simulates payment; no money is transferred.</p>' : ""}
    <p class="card-description">Payments are confirmed by the payment provider or cash device, not by this screen.</p>
    <div class="kiosk-balance"><span>Balance due</span><strong>${cash(assessment.balance)}</strong></div>
    <form id="paymentForm"><div class="field"><label for="paymentAmount">Amount to pay (PHP)</label>
      <input id="paymentAmount" name="amount" type="number" min="0.01" max="${assessment.balance}" step="0.01" value="${Number(assessment.balance).toFixed(2)}" required></div>
      <div class="field"><label for="paymentMethod">Payment method</label><select id="paymentMethod" name="method">
      ${config.demoGatewayEnabled ? '<option value="FREE_GATEWAY" selected>Free demo gateway (no real payment)</option>' : ""}
      <option value="QRPH">QR Ph</option><option value="GCASH">GCash</option><option value="MAYA">Maya</option>
      <option value="CASH">Cash acceptor</option></select></div>
      <div id="kioskMessage" class="kiosk-message" role="alert"></div>
      <div class="form-footer"><button type="submit" class="button button-primary">Start payment</button></div></form>`;
  wireCommon();
  document.getElementById("backToAssessment").addEventListener("click", () => renderAssessment(id));
  const form = document.getElementById("paymentForm");
  form.addEventListener("change", () => { key = crypto.randomUUID(); });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const values = new FormData(form);
    const method = values.get("method");
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const url = method === "CASH" ? "/api/student/cash-transactions" : "/api/student/transactions";
      const transaction = await fbcApi.post(url, { assessmentId: id, amount: values.get("amount"), method }, { "Idempotency-Key": key });
      renderTransaction(transaction);
    } catch (error) {
      console.error("Payment could not be started.", error);
      showError(error.message);
      button.disabled = false;
    }
  });
}

function secureUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : "";
  } catch { return ""; }
}

function renderTransaction(transaction) {
  stopPolling();
  document.body.classList.remove("student-dashboard-active");
  currentTransactionId = transaction.transactionId;
  sessionStorage.setItem("fbcActiveTransaction", transaction.transactionId);
  const redirect = secureUrl(transaction.checkout?.redirectUrl);
  const image = secureUrl(transaction.checkout?.qrImageUrl);
  root.innerHTML = `${studentHeader()}${config.demoGatewayEnabled ? '<p class="kiosk-auth-note"><strong>LOCAL DEMO:</strong> Payments and receipts in this copy are not real.</p>' : ""}<div class="kiosk-step">PAYMENT STATUS</div><h2>${safe(transaction.status.replaceAll("_", " "))}</h2>
    <p class="card-description">Transaction ${safe(transaction.transactionId)}</p>
    <div class="kiosk-balance"><span>Payment amount</span><strong>${cash(transaction.amountDueMinor / 100)}</strong></div>
    ${transaction.channel === "CASH" ? `<div class="kiosk-balance"><span>Cash received</span><strong>${cash(transaction.amountTenderedMinor / 100)}</strong></div>` : ""}
    ${image ? `<p><img src="${safe(image)}" alt="Payment QR code" style="max-width:100%"></p>` : ""}
    ${redirect ? `<p><a class="button button-primary" href="${safe(redirect)}" target="_blank" rel="noopener noreferrer">Open payment provider</a></p>` : ""}
    ${transaction.receipt ? `<div class="kiosk-receipt"><strong>${config.demoGatewayEnabled ? "Demo receipt" : "Official receipt"} ${safe(transaction.receipt.orNumber)}</strong>
      ${transaction.receipt.feeBreakdown.map(item => `<div class="kiosk-receipt-line"><span>${safe(item.label)}</span><strong>${cash(item.amountMinor / 100)}</strong></div>`).join("")}</div>` : ""}
    <div id="kioskMessage" class="kiosk-message" role="alert"></div>
    <div class="form-footer">${transaction.channel === "CASH" && transaction.status === "CASH_ACCEPTING" ? '<button type="button" class="button button-secondary" id="cancelCash">Cancel cash payment</button>' : ""}
    <button type="button" class="button button-secondary" id="returnAccount">Return to account</button>
    ${transaction.receipt ? '<button type="button" class="button button-primary" id="printReceipt">Print receipt</button>' : ""}</div>`;
  wireCommon();
  document.getElementById("returnAccount").addEventListener("click", async () => {
    try { stopPolling(); await refreshAccount(); renderAccount(); }
    catch (error) { showError(error.message); }
  });
  document.getElementById("printReceipt")?.addEventListener("click", () => window.print());
  document.getElementById("cancelCash")?.addEventListener("click", async event => {
    event.currentTarget.disabled = true;
    try {
      const result = await fbcApi.post(`/api/student/transactions/${encodeURIComponent(transaction.transactionId)}/cancel`);
      renderTransaction(result);
    } catch (error) {
      showError(error.message);
      event.currentTarget.disabled = false;
    }
  });
  if (transaction.status === "PAID") {
    refreshAccount().catch(error => { console.error("Could not refresh account after payment.", error); showError(`Payment confirmed, but account refresh failed: ${error.message}`); });
  } else if (!["FAILED", "CANCELLED", "EXPIRED"].includes(transaction.status)) {
    const id = transaction.transactionId;
    pollTimer = setTimeout(async () => {
      try {
        const next = await fbcApi.get(`/api/student/transactions/${encodeURIComponent(id)}`);
        if (currentTransactionId === id) renderTransaction(next);
      } catch (error) {
        if (currentTransactionId === id) {
          showError(`Status refresh failed: ${error.message}`);
          pollTimer = setTimeout(() => { if (currentTransactionId === id) renderTransaction(transaction); }, 5000);
        }
      }
    }, 2000);
  }
}

const menuToggle = document.getElementById("kioskMenuToggle");
const menu = document.getElementById("kioskPortalMenu");
menuToggle.addEventListener("click", () => {
  menu.hidden = !menu.hidden;
  menuToggle.setAttribute("aria-expanded", String(!menu.hidden));
});

async function initialize() {
  try {
    config = await fbcApi.get("/api/kiosk/config");
    try {
      const session = await fbcApi.get("/api/auth/session");
      if (session.role === "student") { await refreshAccount(); return renderAccount(); }
    } catch (error) {
      if (error.status !== 401) throw error;
    }
    await renderLogin();
  } catch (error) {
    console.error("Student kiosk could not start.", error);
    root.innerHTML = `<div class="kiosk-step">STUDENT PAYMENT KIOSK</div><h2>Kiosk temporarily unavailable</h2>
      <p class="card-description">${safe(error.message)}</p>`;
  }
}

initialize();
