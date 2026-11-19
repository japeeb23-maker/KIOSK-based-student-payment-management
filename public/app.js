const money = value => new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP", maximumFractionDigits: 2 }).format(Number(value) || 0);
const dateLabel = value => value ? new Date(`${value}T00:00:00`).toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" }) : "—";
const today = () => new Date().toISOString().slice(0, 10);
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const initials = name => String(name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join("").toUpperCase();
const id = prefix => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const requestedStaffRole = new URLSearchParams(window.location.search).get("staffRole");

let data = { students: [], assessments: [], payments: [], notes: [] };
let currentPage = "dashboard";
let activeQuery = "";
let noteFilter = "all";
let pendingStaffAction = null;
let staffSession = null;
const STAFF_ROLES = { cashier: "Cashier", vp: "VP for Finance", registrar: "Registrar / Administrator" };

async function loadStaffData() {
  try {
    data = await fbcApi.get("/api/staff/state?system=paypoint");
    render();
    return true;
  } catch (error) {
    console.error("Could not load FBC Paypoint data.", error);
    toast(error.message);
    return false;
  }
}

async function saveData() {
  try {
    await fbcApi.put("/api/staff/state?system=paypoint", data);
    return true;
  } catch (error) {
    console.error("Could not save FBC Paypoint data.", error);
    toast(error.message);
    await loadStaffData();
    return false;
  }
}

function studentOf(studentId) { return data.students.find(student => student.id === studentId); }
function assessmentTotal(assessment) { return assessment.items.reduce((sum, item) => sum + Number(item.amount), 0); }
function assessmentPaid(assessmentId) { return data.payments.filter(payment => payment.assessmentId === assessmentId).reduce((sum, payment) => sum + Number(payment.amount), 0); }
function assessmentBalance(assessment) { return Math.max(0, assessmentTotal(assessment) - assessmentPaid(assessment.id)); }
function studentBalance(studentId) { return data.assessments.filter(item => item.studentId === studentId).reduce((sum, item) => sum + assessmentBalance(item), 0); }
function assessmentStatus(assessment) {
  const balance = assessmentBalance(assessment);
  if (balance <= 0) return "Paid";
  if (balance < assessmentTotal(assessment)) return "Partial";
  return "Pending";
}
function statusClass(status) { return ({ Paid: "paid", Approved: "paid", Pending: "pending", Partial: "partial", Rejected: "rejected", Overdue: "overdue" })[status] || "neutral"; }
function statusPill(status) { return `<span class="status ${statusClass(status)}">${escapeHtml(status)}</span>`; }
function studentBadge(student) { return `<span class="student-mini">${escapeHtml(initials(student?.name))}</span>`; }
function studentCell(student) {
  if (!student) return `<span class="student-cell"><span class="student-mini">?</span><span><strong>Unknown student</strong></span></span>`;
  return `<span class="student-cell">${studentBadge(student)}<span><strong>${escapeHtml(student.name)}</strong><small>${escapeHtml(student.studentNo)}</small></span></span>`;
}
function heading(kicker, title, description, actions = "") {
  return `<div class="page-heading"><div><div class="eyebrow">${kicker}</div><h1>${title}</h1><p class="page-subtitle">${description}</p></div><div class="heading-actions">${actions}</div></div>`;
}
function personSummary(student) {
  return `<div class="student-summary">${studentBadge(student)}<span><strong>${escapeHtml(student.name)}</strong><small>${escapeHtml(student.studentNo)} · ${escapeHtml(student.course)} · ${escapeHtml(student.year)}</small></span></div>`;
}
function latestPayments(limit = 5) { return [...data.payments].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id)).slice(0, limit); }
function toast(message) {
  const region = document.getElementById("toastRegion");
  const item = document.createElement("div");
  item.className = "toast";
  item.textContent = message;
  region.append(item);
  setTimeout(() => item.remove(), 3200);
}

function requireRole(role, action = "", targetId = "") {
  if (staffSession?.role === role) return true;
  pendingStaffAction = action ? { action, targetId, requiredRole: role } : null;
  showStaffLogin(role);
  return false;
}
function canManageRecords() { return staffSession?.role === "registrar"; }

function showStaffLogin(requiredRole = "") {
  const options = Object.entries(STAFF_ROLES).map(([key, label]) => `<option value="${key}" ${requiredRole === key ? "selected" : ""}>${label}</option>`).join("");
  const content = `<form class="modal-form" id="staffLoginForm"><div class="form-grid">
    <div class="field full"><label for="staffRole">Staff role</label><select id="staffRole" name="role" required>${options}</select></div>
    ${formField("Staff ID", "username", "Enter your assigned staff ID")}
    ${formField("Password", "password", "Enter your password", "password")}
    </div><div class="auth-demo-note">Use the staff credentials assigned by your administrator.</div><div id="staffLoginError" class="auth-error" role="alert"></div><div class="form-footer"><button type="button" class="button button-secondary" data-action="close-modal">Cancel</button><button type="submit" class="button button-primary">Sign in</button></div></form>`;
  openModal("Staff sign in", "Enter your assigned staff credentials to continue.", content, { auth: true });
  document.getElementById("staffLoginForm").addEventListener("submit", event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const role = form.get("role");
    if (pendingStaffAction && role !== pendingStaffAction.requiredRole) {
      document.getElementById("staffLoginError").textContent = `This action requires the ${STAFF_ROLES[pendingStaffAction.requiredRole]} role.`;
      return;
    }
    const submit = event.currentTarget.querySelector('button[type="submit"]');
    submit.disabled = true;
    fbcApi.post("/api/auth/staff", { role, username: form.get("username"), password: form.get("password") }).then(async user => {
      staffSession = user;
      if (user.role === "vp") currentPage = "promissory";
      else if (currentPage === "promissory" && user.role === "cashier") currentPage = "dashboard";
      const nextAction = pendingStaffAction;
      pendingStaffAction = null;
      closeModal();
      await loadStaffData();
      toast(`Signed in as ${user.label}.`);
      if (nextAction?.action === "payment") showPaymentForm(nextAction.targetId || "");
      if (nextAction?.action === "review-note") showNoteReview(nextAction.targetId);
      if (nextAction?.action === "settle-note") settlePromissoryNote(nextAction.targetId);
    }).catch(error => {
      document.getElementById("staffLoginError").textContent = error.message;
      submit.disabled = false;
    });
  });
}

async function signOutStaff() {
  try { await fbcApi.post("/api/auth/logout"); }
  catch (error) {
    console.error("Could not end the staff session on the server.", error);
    toast(`Sign-out failed: ${error.message}`);
    return;
  }
  staffSession = null;
  pendingStaffAction = null;
  render();
  toast("Staff session signed out.");
}

function renderDashboard() {
  const currentMonth = new Date().toISOString().slice(0, 7);
  const collected = data.payments.filter(payment => payment.date.startsWith(currentMonth)).reduce((sum, payment) => sum + payment.amount, 0);
  const outstanding = data.assessments.reduce((sum, assessment) => sum + assessmentBalance(assessment), 0);
  const pendingNotes = data.notes.filter(note => note.status === "Pending").length;
  const payments = latestPayments(4);
  const todayLabel = new Date().toLocaleDateString("en-PH", { weekday: "long", month: "long", day: "numeric", year: "numeric" }).toUpperCase();
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  return `<div class="dashboard-view staff-dashboard">${heading(todayLabel, `${greeting}, ${escapeHtml(STAFF_ROLES[staffSession.role])}`, "Here’s what’s happening with student accounts today.", `<button class="button button-secondary" data-action="export">↓ &nbsp;Export report</button><button class="button button-primary" data-page="assessments">Review fee assessments →</button>`)}
    <div class="stats-grid">
      <article class="stat-card"><div class="stat-top"><span>Collections this month</span><span class="stat-icon">₱</span></div><div class="stat-value">${money(collected)}</div><div class="stat-foot"><span class="trend-up">↑ 12.8%</span><span>from last month</span></div></article>
      <article class="stat-card"><div class="stat-top"><span>Outstanding balance</span><span class="stat-icon amber">◷</span></div><div class="stat-value">${money(outstanding)}</div><div class="stat-foot"><span>${data.assessments.filter(item => assessmentBalance(item) > 0).length} accounts</span><span>with remaining balance</span></div></article>
      <article class="stat-card"><div class="stat-top"><span>Enrolled students</span><span class="stat-icon blue">♙</span></div><div class="stat-value">${data.students.length.toLocaleString()}</div><div class="stat-foot"><span>For 1st semester</span><span>AY 2026–27</span></div></article>
      <article class="stat-card"><div class="stat-top"><span>Notes for review</span><span class="stat-icon purple">▧</span></div><div class="stat-value">${pendingNotes}</div><div class="stat-foot"><span>Promissory note requests</span><span>awaiting review</span></div></article>
    </div>
    <div class="dashboard-grid">
      <section class="panel"><div class="panel-header"><div><h2 class="panel-title">Recent payments</h2><p class="panel-caption">Latest transactions across all student accounts</p></div><button class="action-link" data-page="payments">View all →</button></div>
        <div class="table-wrap"><table><thead><tr><th>STUDENT</th><th>REFERENCE</th><th>DATE</th><th>AMOUNT</th><th>METHOD</th></tr></thead><tbody>${payments.length ? payments.map(payment => {
    const student = studentOf(payment.studentId);
    return `<tr><td>${studentCell(student)}</td><td>${escapeHtml(payment.reference)}</td><td>${dateLabel(payment.date)}</td><td class="amount">${money(payment.amount)}</td><td>${escapeHtml(payment.method)}</td></tr>`;
  }).join("") : `<tr><td colspan="5"><div class="empty-state">No payments recorded yet.</div></td></tr>`}</tbody></table></div>
      </section>
      <section class="panel"><div class="panel-header"><div><h2 class="panel-title">Recent activity</h2><p class="panel-caption">The latest updates from your finance office</p></div></div><div class="panel-body"><div class="activity-list">
        ${payments.length ? payments.slice(0, 3).map(payment => `<div class="activity-item"><span class="activity-icon">↙</span><span><strong>Payment received</strong><small>${escapeHtml(studentOf(payment.studentId)?.name || "Student")} · ${dateLabel(payment.date)}</small></span><span class="activity-amount">${money(payment.amount)}</span></div>`).join("") : `<div class="activity-empty">Activity will appear here as payments are recorded.</div>`}
        ${pendingNotes ? `<div class="activity-item"><span class="activity-icon" style="color:#a16c24;background:#fbf4e8">▧</span><span><strong>Note needs review</strong><small>${pendingNotes} promissory note${pendingNotes === 1 ? "" : "s"} awaiting review</small></span><button class="action-link" data-page="promissory">Review</button></div>` : ""}
      </div></div></section>
    </div>
    ${canManageRecords() ? `<div class="quick-actions">
      <button class="quick-action" data-action="add-student"><span class="quick-action-icon">♙</span><span><strong>Add a student</strong><small>Create a student account</small></span></button>
      <button class="quick-action" data-action="add-assessment"><span class="quick-action-icon">▤</span><span><strong>New assessment</strong><small>Set up semester fees</small></span></button>
      <button class="quick-action" data-action="add-note"><span class="quick-action-icon">▧</span><span><strong>New promissory note</strong><small>Record a payment request</small></span></button>
    </div>` : ""}</div>`;
}

function renderStudents() {
  const search = activeQuery.toLowerCase();
  const students = data.students.filter(student => `${student.name} ${student.studentNo} ${student.course} ${student.year}`.toLowerCase().includes(search));
  const action = canManageRecords() ? `<button class="button button-primary" data-action="add-student"><span class="plus">+</span> Add student</button>` : "";
  return `${heading("STUDENT DIRECTORY", "Students", `${data.students.length} student accounts in the current term.`, action)}
    <div class="toolbar"><label class="search-box"><span>⌕</span><input id="pageSearch" type="search" placeholder="Search by name, student ID, or course…" value="${escapeHtml(activeQuery)}"></label><div class="toolbar-right"><button class="button button-secondary" data-action="export">↓ &nbsp;Export</button></div></div>
    <section class="panel data-panel"><div class="table-wrap"><table><thead><tr><th>STUDENT</th><th>PROGRAM</th><th>YEAR LEVEL</th><th>ASSESSMENT</th><th>BALANCE DUE</th><th>CONTACT</th></tr></thead><tbody>${students.length ? students.map(student => {
    const assessments = data.assessments.filter(item => item.studentId === student.id);
    const total = assessments.reduce((sum, item) => sum + assessmentTotal(item), 0);
    return `<tr><td>${studentCell(student)}</td><td>${escapeHtml(student.course)}</td><td>${escapeHtml(student.year)}</td><td>${assessments.length ? money(total) : "—"}</td><td class="amount">${money(studentBalance(student.id))}</td><td>${escapeHtml(student.email || "—")}</td></tr>`;
  }).join("") : `<tr><td colspan="6"><div class="empty-state"><strong>No students found</strong>Try a different search or add a new student.</div></td></tr>`}</tbody></table></div><div class="pagination"><span>Showing ${students.length} of ${data.students.length} students</span><span>Current term · AY 2026–27</span></div></section>`;
}

function renderAssessments() {
  const search = activeQuery.toLowerCase();
  const assessments = [...data.assessments].filter(item => {
    const student = studentOf(item.studentId);
    return `${student?.name || ""} ${student?.studentNo || ""} ${item.term} ${item.id}`.toLowerCase().includes(search);
  }).sort((a, b) => b.date.localeCompare(a.date));
  const paymentAction = staffSession?.role === "cashier" ? "pay" : "staff-cashier-login";
  const paymentLabel = staffSession?.role === "cashier" ? "Record payment" : "Cashier login";
  const action = canManageRecords() ? `<button class="button button-primary" data-action="add-assessment"><span class="plus">+</span> New assessment</button>` : "";
  return `${heading("FEE MANAGEMENT", "Assessments", "Create and track student fee assessments by semester.", action)}
    <div class="toolbar"><label class="search-box"><span>⌕</span><input id="pageSearch" type="search" placeholder="Search student or assessment…" value="${escapeHtml(activeQuery)}"></label><div class="toolbar-right"><button class="button button-secondary" data-action="export">↓ &nbsp;Export</button></div></div>
    <section class="panel data-panel"><div class="table-wrap"><table><thead><tr><th>ASSESSMENT ID</th><th>STUDENT</th><th>TERM</th><th>ASSESSED</th><th>PAID</th><th>BALANCE</th><th>STATUS</th><th></th></tr></thead><tbody>${assessments.length ? assessments.map(item => `<tr><td class="amount">${escapeHtml(item.id)}</td><td>${studentCell(studentOf(item.studentId))}</td><td>${escapeHtml(item.term)}</td><td class="amount">${money(assessmentTotal(item))}</td><td>${money(assessmentPaid(item.id))}</td><td class="amount">${money(assessmentBalance(item))}</td><td>${statusPill(assessmentStatus(item))}</td><td>${assessmentBalance(item) > 0 ? `<button class="action-link" data-action="${paymentAction}" data-id="${escapeHtml(item.id)}">${paymentLabel}</button>` : ""}</td></tr>`).join("") : `<tr><td colspan="8"><div class="empty-state"><strong>No assessments found</strong>Create a fee assessment to get started.</div></td></tr>`}</tbody></table></div><div class="pagination"><span>Showing ${assessments.length} of ${data.assessments.length} assessments</span><span>All amounts in PHP</span></div></section>`;
}

function renderPayments() {
  const search = activeQuery.toLowerCase();
  const payments = [...data.payments].filter(payment => {
    const student = studentOf(payment.studentId);
    return `${student?.name || ""} ${student?.studentNo || ""} ${payment.reference} ${payment.method} ${payment.id}`.toLowerCase().includes(search);
  }).sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
  const total = payments.reduce((sum, payment) => sum + Number(payment.amount), 0);
  const paymentButton = staffSession?.role === "cashier" ? `<button class="button button-primary" data-action="new-payment"><span class="plus">+</span> Record payment</button>` : `<button class="button button-primary" data-action="staff-cashier-login">Cashier login to record</button>`;
  return `${heading("TRANSACTION REGISTER", "Payments", "Review student payments and issue receipts.", `<button class="button button-secondary" data-action="export">↓ &nbsp;Export</button>${paymentButton}`)}
    <div class="stats-grid" style="grid-template-columns:repeat(2,minmax(0,1fr));max-width:510px"><article class="stat-card"><div class="stat-top"><span>Transactions</span><span class="stat-icon">⇄</span></div><div class="stat-value">${payments.length}</div><div class="stat-foot">Recorded in this register</div></article><article class="stat-card"><div class="stat-top"><span>Total collected</span><span class="stat-icon blue">₱</span></div><div class="stat-value">${money(total)}</div><div class="stat-foot">Based on filtered transactions</div></article></div>
    <div class="toolbar"><label class="search-box"><span>⌕</span><input id="pageSearch" type="search" placeholder="Search student, reference, or method…" value="${escapeHtml(activeQuery)}"></label><div class="toolbar-right"><button class="button button-secondary" data-action="export">↓ &nbsp;Export</button></div></div>
    <section class="panel data-panel"><div class="table-wrap"><table><thead><tr><th>REFERENCE</th><th>STUDENT</th><th>ASSESSMENT</th><th>DATE</th><th>METHOD</th><th>AMOUNT</th><th></th></tr></thead><tbody>${payments.length ? payments.map(payment => `<tr><td class="amount">${escapeHtml(payment.reference)}</td><td>${studentCell(studentOf(payment.studentId))}</td><td>${escapeHtml(payment.assessmentId)}</td><td>${dateLabel(payment.date)}</td><td>${escapeHtml(payment.method)}</td><td class="amount">${money(payment.amount)}</td><td><button class="action-link" data-action="receipt" data-id="${escapeHtml(payment.id)}">Receipt</button></td></tr>`).join("") : `<tr><td colspan="7"><div class="empty-state"><strong>No payments found</strong>Record a payment to see it here.</div></td></tr>`}</tbody></table></div><div class="pagination"><span>Showing ${payments.length} transaction${payments.length === 1 ? "" : "s"}</span><span>Receipts are available for each payment</span></div></section>`;
}

function renderPromissory() {
  const notes = [...data.notes].filter(note => {
    const student = studentOf(note.studentId);
    const queryMatch = `${student?.name || ""} ${student?.studentNo || ""} ${note.id} ${note.purpose}`.toLowerCase().includes(activeQuery.toLowerCase());
    return queryMatch && (noteFilter === "all" || note.status.toLowerCase() === noteFilter);
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const pendingCount = data.notes.filter(note => note.status === "Pending").length;
  const financeAction = staffSession?.role === "vp" ? "review-note" : "staff-vp-login";
  const financeLabel = staffSession?.role === "vp" ? "VP review" : "VP Finance login";
  const action = canManageRecords() ? `<button class="button button-primary" data-action="add-note"><span class="plus">+</span> New promissory note</button>` : "";
  return `${heading("PAYMENT ARRANGEMENTS", "Promissory notes", "Manage student requests to defer payment of outstanding fees.", action)}
    ${pendingCount ? `<div class="note-callout"><span>◷</span><div><strong>${pendingCount} note${pendingCount === 1 ? "" : "s"} need${pendingCount === 1 ? "s" : ""} your review</strong><p>Review the request details, then approve or decline the payment arrangement.</p></div></div>` : ""}
    <div class="toolbar"><label class="search-box"><span>⌕</span><input id="pageSearch" type="search" placeholder="Search student or note ID…" value="${escapeHtml(activeQuery)}"></label><div class="toolbar-right"><select class="filter-select" id="noteFilter" aria-label="Filter promissory notes"><option value="all" ${noteFilter === "all" ? "selected" : ""}>All notes</option><option value="pending" ${noteFilter === "pending" ? "selected" : ""}>Pending</option><option value="approved" ${noteFilter === "approved" ? "selected" : ""}>Approved</option><option value="rejected" ${noteFilter === "rejected" ? "selected" : ""}>Declined</option></select><button class="button button-secondary" data-action="export">↓ &nbsp;Export</button></div></div>
    <section class="panel data-panel"><div class="table-wrap"><table><thead><tr><th>NOTE ID</th><th>STUDENT</th><th>AMOUNT</th><th>PAYMENT PURPOSE</th><th>INSTALLMENTS</th><th>DUE DATE</th><th>STATUS</th><th>ACTION</th></tr></thead><tbody>${notes.length ? notes.map(note => `<tr><td class="amount">${escapeHtml(note.id)}</td><td>${studentCell(studentOf(note.studentId))}</td><td class="amount">${money(note.amount)}</td><td>${escapeHtml(note.purpose)}</td><td>${note.installments} payments</td><td>${dateLabel(note.dueDate)}</td><td>${statusPill(note.status)}</td><td>${note.status === "Pending" ? `<button class="action-link" data-action="${financeAction}" data-id="${escapeHtml(note.id)}">${financeLabel}</button>` : note.status === "Approved" ? (staffSession?.role === "vp" ? `<button class="action-link" data-action="settle-note" data-id="${escapeHtml(note.id)}">Mark settled</button>` : `<button class="action-link" data-action="staff-vp-login" data-next="settle-note" data-id="${escapeHtml(note.id)}">VP Finance login</button>`) : "—"}</td></tr>`).join("") : `<tr><td colspan="8"><div class="empty-state"><strong>No promissory notes found</strong>Create a note to document a student's payment arrangement.</div></td></tr>`}</tbody></table></div><div class="pagination"><span>Showing ${notes.length} of ${data.notes.length} promissory notes</span><span>${pendingCount} pending review</span></div></section>`;
}

const pageRenderers = { dashboard: renderDashboard, students: renderStudents, assessments: renderAssessments, payments: renderPayments, promissory: renderPromissory };
const pageTitles = { dashboard: "Overview", students: "Students", assessments: "Assessments", payments: "Payments", promissory: "Promissory notes" };
function render() {
  const label = staffSession ? STAFF_ROLES[staffSession.role] : "";
  if (document.body) document.body.classList.toggle("staff-dashboard-active", Boolean(staffSession && currentPage === "dashboard"));
  document.getElementById("pageRoot").innerHTML = staffSession
    ? `<div class="demo-banner"><span>BACKEND CONNECTED</span> Use Refresh to load changes made on other devices.</div>${pageRenderers[currentPage]()}`
    : `<section class="signin-screen"><div class="signin-card"><img class="signin-logo" src="fbc-logo.jpg" alt="Fellowship Baptist College seal" width="72" height="72"><div class="eyebrow">FBC PAYPOINT</div><h1>Welcome</h1><p class="page-subtitle">Choose how you would like to continue.</p><div class="signin-actions"><a class="button button-primary signin-choice" href="kiosk.html"><strong>Student Kiosk</strong><small>Check balances and pay fees</small></a><button class="button button-secondary signin-choice" data-action="staff-login"><strong>Staff Sign In</strong><small>Cashier, VP for Finance, Registrar</small></button></div></div></section>`;
  document.body?.classList.toggle("signed-out", !staffSession);
  document.getElementById("breadcrumbCurrent").textContent = pageTitles[currentPage];
  document.getElementById("staffRefresh").hidden = !staffSession;
  document.getElementById("staffAccess").hidden = !staffSession;
  const identity = document.getElementById("staffIdentity");
  identity.hidden = !staffSession;
  document.getElementById("staffIdentityName").textContent = staffSession?.username || "";
  document.getElementById("staffIdentityRole").textContent = label;
  const profile = document.querySelector(".profile-button");
  if (profile) {
    profile.querySelector(".avatar").textContent = staffSession ? initials(label) : "";
    profile.querySelector("strong").textContent = staffSession?.username || "";
    profile.querySelector("small").textContent = label;
  }
  document.getElementById("topAvatar").textContent = staffSession ? initials(label) : "";
  document.getElementById("studentNavCount").textContent = data.students.length;
  document.getElementById("noteNavCount").textContent = data.notes.filter(note => note.status === "Pending").length;
  document.querySelectorAll(".nav-item").forEach(button => {
    const hidden = (staffSession?.role === "vp" && button.dataset.page !== "promissory") ||
      (staffSession?.role === "cashier" && button.dataset.page === "promissory");
    button.hidden = hidden;
    button.classList.toggle("active", button.dataset.page === currentPage);
  });
  const search = document.getElementById("pageSearch");
  if (search) search.addEventListener("input", event => {
    const cursor = event.target.selectionStart;
    activeQuery = event.target.value;
    render();
    const next = document.getElementById("pageSearch");
    next?.focus();
    next?.setSelectionRange(cursor, cursor);
  });
  document.getElementById("noteFilter")?.addEventListener("change", event => { noteFilter = event.target.value; render(); });
}

function goTo(page) {
  if (!pageRenderers[page]) return;
  if (staffSession?.role === "vp" && page !== "promissory") return;
  if (staffSession?.role === "cashier" && page === "promissory") return;
  currentPage = page;
  activeQuery = "";
  document.getElementById("sidebar").classList.remove("open");
  render();
}

function openModal(title, subtitle, content, options = {}) {
  const modal = document.getElementById("modal");
  modal.className = `modal${options.wide ? " modal-wide" : ""}${options.auth ? " auth-modal" : ""}`;
  const header = `<div class="modal-header"><div>${options.auth ? '<div class="auth-eyebrow">SECURE STAFF ACCESS</div>' : ""}<h2 id="modalTitle">${escapeHtml(title)}</h2><p>${escapeHtml(subtitle || "")}</p></div><button class="modal-close" data-action="close-modal" aria-label="Close dialog">×</button></div>`;
  modal.innerHTML = options.auth
    ? `<div class="auth-intro"><div class="auth-brand"><img src="fbc-logo.jpg" alt="" width="56" height="56"><span><strong>Fellowship Baptist College</strong><small>FBC Paypoint</small></span></div><div><span class="auth-badge">Secure staff services</span><h2>Welcome back.<br><span>Ready to serve.</span></h2><p>Access the tools you need to support students and manage college records securely.</p></div></div><div class="auth-panel">${header}${content}</div>`
    : `${header}${content}`;
  document.getElementById("modalBackdrop").hidden = false;
  modal.querySelector("input,select,textarea,button")?.focus();
}
function closeModal() { document.getElementById("modalBackdrop").hidden = true; }
function formField(label, name, placeholder, type = "text", required = true, extra = "") {
  return `<div class="field"><label for="${name}">${escapeHtml(label)}${required ? "" : ` <span class="optional">(optional)</span>`}</label><input id="${name}" name="${name}" type="${type}" placeholder="${escapeHtml(placeholder)}" ${required ? "required" : ""} ${extra}></div>`;
}
function studentOptions(selected = "") {
  return `<option value="">Select a student</option>${data.students.slice().sort((a, b) => a.name.localeCompare(b.name)).map(student => `<option value="${escapeHtml(student.id)}" ${selected === student.id ? "selected" : ""}>${escapeHtml(student.name)} · ${escapeHtml(student.studentNo)}</option>`).join("")}`;
}

function showStudentForm() {
  const content = `<form class="modal-form" id="studentForm"><div class="form-grid">
    ${formField("Student number", "studentNo", "e.g. 2026-00412")}
    ${formField("Full name", "name", "Student's complete name")}
    ${formField("Program / course", "course", "e.g. BS Information Technology")}
    <div class="field"><label for="year">Year level</label><select id="year" name="year" required><option value="">Select year level</option>${["1st Year", "2nd Year", "3rd Year", "4th Year", "5th Year"].map(year => `<option>${year}</option>`).join("")}</select></div>
    ${formField("Email address", "email", "student@example.com", "email", false)}
    </div><div class="form-footer"><button type="button" class="button button-secondary" data-action="close-modal">Cancel</button><button class="button button-primary" type="submit">Add student</button></div></form>`;
  openModal("Add student", "Create a student profile for fee assessment and payment.", content);
  document.getElementById("studentForm").addEventListener("submit", async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const studentNo = form.get("studentNo").trim();
    if (data.students.some(student => student.studentNo.toLowerCase() === studentNo.toLowerCase())) return toast("That student number already exists.");
    data.students.push({ id: id("S"), studentNo, name: form.get("name").trim(), course: form.get("course").trim(), year: form.get("year"), email: form.get("email").trim() });
    if (!await saveData()) return;
    closeModal(); render(); toast("Student account created.");
  });
}

function showAssessmentForm() {
  if (!data.students.length) return toast("Add a student before creating an assessment.");
  const content = `<form class="modal-form" id="assessmentForm"><div class="form-grid">
    <div class="field full"><label for="assessmentStudent">Student</label><select id="assessmentStudent" name="studentId" required>${studentOptions()}</select></div>
    <div class="field full"><label for="term">Academic term</label><input id="term" name="term" value="1st Semester · AY 2026–27" required></div>
    <div class="field full"><label for="feeItems">Fee items</label><textarea id="feeItems" name="items" placeholder="Tuition fee - 18500&#10;Laboratory fee - 4200&#10;Library & student services - 2300" required></textarea><span class="field-hint">Enter one fee per line in the format: Fee name - amount (PHP).</span></div>
    </div><div class="form-footer"><button type="button" class="button button-secondary" data-action="close-modal">Cancel</button><button class="button button-primary" type="submit">Create assessment</button></div></form>`;
  openModal("New assessment", "Add semester charges to a student's account.", content, { wide: true });
  document.getElementById("assessmentForm").addEventListener("submit", async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const items = String(form.get("items")).split(/\r?\n/).map(line => {
      const match = line.trim().match(/^(.+?)\s*[-–:]\s*([\d,]+(?:\.\d{1,2})?)$/);
      return match ? { label: match[1].trim(), amount: Number(match[2].replace(/,/g, "")) } : null;
    }).filter(Boolean);
    const rawLines = String(form.get("items")).split(/\r?\n/).filter(line => line.trim());
    if (!items.length || items.length !== rawLines.length || items.some(item => item.amount <= 0)) return toast("Check each fee line. Use “Fee name - amount” with a positive amount.");
    const assessmentId = `A-${Date.now().toString().slice(-6)}`;
    data.assessments.push({ id: assessmentId, studentId: form.get("studentId"), term: form.get("term").trim(), date: today(), items });
    if (!await saveData()) return;
    closeModal(); render(); toast(`Assessment ${assessmentId} created.`);
  });
}

function showPaymentForm(selectedAssessment = "", selectedStudent = "") {
  if (!requireRole("cashier", "payment", selectedAssessment)) return;
  const eligible = data.assessments.filter(assessment => assessmentBalance(assessment) > 0 && (!selectedStudent || assessment.studentId === selectedStudent));
  if (!eligible.length) return toast(selectedStudent ? "This student has no outstanding assessments." : "There are no assessments with a balance due.");
  const assessmentOptions = eligible.map(assessment => `<option value="${escapeHtml(assessment.id)}" ${selectedAssessment === assessment.id ? "selected" : ""}>${escapeHtml(studentOf(assessment.studentId)?.name || "Student")} · ${escapeHtml(assessment.id)} · balance ${money(assessmentBalance(assessment))}</option>`).join("");
  const current = eligible.find(item => item.id === selectedAssessment) || eligible[0];
  const content = `<form class="modal-form" id="paymentForm">
    <div id="paymentStudentSummary">${personSummary(studentOf(current.studentId))}</div>
    <div class="form-grid">
    <div class="field full"><label for="paymentAssessment">Assessment</label><select id="paymentAssessment" name="assessmentId" required>${assessmentOptions}</select></div>
    ${formField("Amount received (PHP)", "amount", "0.00", "number", true, `min="0.01" max="${assessmentBalance(current)}" step="0.01"`)}
    <div class="field"><label for="method">Payment method</label><select id="method" name="method" required><option>Cash</option><option>GCash</option><option>Bank transfer</option><option>Debit / credit card</option><option>Other</option></select></div>
    <div class="field"><label for="paymentDate">Payment date</label><input id="paymentDate" name="date" type="date" value="${today()}" required></div>
    ${formField("Reference number", "reference", "Auto-generated if blank", "text", false)}
    </div><div class="form-footer"><button type="button" class="button button-secondary" data-action="close-modal">Cancel</button><button class="button button-primary" type="submit">Record payment</button></div></form>`;
  openModal("Record payment", "Enter payment details to update the student balance.", content);
  const updatePaymentOptions = () => {
    const assessment = data.assessments.find(item => item.id === document.getElementById("paymentAssessment").value);
    if (!assessment) return;
    document.getElementById("paymentStudentSummary").innerHTML = personSummary(studentOf(assessment.studentId));
    const amount = document.getElementById("amount");
    amount.max = assessmentBalance(assessment);
    amount.placeholder = `Up to ${assessmentBalance(assessment).toFixed(2)}`;
  };
  document.getElementById("paymentAssessment").addEventListener("change", updatePaymentOptions);
  document.getElementById("paymentForm").addEventListener("submit", async event => {
    event.preventDefault();
    if (staffSession?.role !== "cashier") return toast("A cashier must be signed in to record payments.");
    const form = new FormData(event.currentTarget);
    const assessment = data.assessments.find(item => item.id === form.get("assessmentId"));
    const amount = Number(form.get("amount"));
    if (!assessment || amount <= 0 || amount > assessmentBalance(assessment)) return toast("Enter an amount greater than zero and no more than the remaining balance.");
    const payment = { id: id("FP"), studentId: assessment.studentId, assessmentId: assessment.id, amount, method: form.get("method"), date: form.get("date"), reference: form.get("reference").trim() || `FBC-${Date.now().toString().slice(-8)}` };
    data.payments.push(payment);
    if (!await saveData()) return;
    closeModal(); render(); toast("Payment recorded. Receipt is ready."); showReceipt(payment.id);
  });
}

function showNoteForm() {
  if (!data.students.length) return toast("Add a student before creating a promissory note.");
  const content = `<form class="modal-form" id="noteForm"><div class="form-grid">
    <div class="field full"><label for="noteStudent">Student</label><select id="noteStudent" name="studentId" required>${studentOptions()}</select></div>
    ${formField("Amount covered (PHP)", "amount", "0.00", "number", true, 'min="0.01" step="0.01"')}
    <div class="field"><label for="installments">Number of installments</label><select id="installments" name="installments" required>${[1, 2, 3, 4, 5, 6].map(count => `<option value="${count}" ${count === 3 ? "selected" : ""}>${count} installment${count > 1 ? "s" : ""}</option>`).join("")}</select></div>
    <div class="field full"><label for="purpose">Payment purpose</label><input id="purpose" name="purpose" placeholder="e.g. Remaining 1st semester fees" required></div>
    <div class="field"><label for="dueDate">Commitment due date</label><input id="dueDate" name="dueDate" type="date" min="${today()}" required></div>
    <div class="field"><label for="noteDate">Date received</label><input id="noteDate" name="createdAt" type="date" value="${today()}" required></div>
    </div><div class="form-footer"><button type="button" class="button button-secondary" data-action="close-modal">Cancel</button><button class="button button-primary" type="submit">Submit for review</button></div></form>`;
  openModal("New promissory note", "Document a student's request to defer payment.", content);
  document.getElementById("noteForm").addEventListener("submit", async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const note = { id: `PN-${Date.now().toString().slice(-6)}`, studentId: form.get("studentId"), amount: Number(form.get("amount")), purpose: form.get("purpose").trim(), dueDate: form.get("dueDate"), createdAt: form.get("createdAt"), installments: Number(form.get("installments")), status: "Pending" };
    if (note.amount <= 0) return toast("Enter a note amount greater than zero.");
    data.notes.push(note);
    if (!await saveData()) return;
    closeModal(); render(); toast("Promissory note submitted for review.");
  });
}

function showReceipt(paymentId) {
  const payment = data.payments.find(item => item.id === paymentId);
  if (!payment) return;
  const student = studentOf(payment.studentId);
  const content = `<div class="receipt"><div class="receipt-brand"><span class="receipt-mark">F+</span><strong>Fellowship Baptist College</strong><small>Kabankalan City · Payment record (not an official receipt)</small></div>
    <div class="receipt-details">
      <div class="receipt-line"><span>Receipt reference</span><strong>${escapeHtml(payment.reference)}</strong></div>
      <div class="receipt-line"><span>Student</span><strong>${escapeHtml(student?.name || "Unknown student")}</strong></div>
      <div class="receipt-line"><span>Student number</span><strong>${escapeHtml(student?.studentNo || "—")}</strong></div>
      <div class="receipt-line"><span>Assessment</span><strong>${escapeHtml(payment.assessmentId)}</strong></div>
      <div class="receipt-line"><span>Payment date</span><strong>${dateLabel(payment.date)}</strong></div>
      <div class="receipt-line"><span>Payment method</span><strong>${escapeHtml(payment.method)}</strong></div>
      <div class="receipt-line receipt-total"><span>Amount paid</span><strong>${money(payment.amount)}</strong></div>
      <div class="receipt-line"><span>Remaining balance</span><strong>${money(assessmentBalance(data.assessments.find(item => item.id === payment.assessmentId) || { id: payment.assessmentId, items: [] }))}</strong></div>
    </div><div class="receipt-thanks">Thank you. Please keep this receipt for your records.</div>
    <div class="form-footer"><button class="button button-secondary" data-action="close-modal">Close</button><button class="button button-primary" data-action="print-receipt">Print receipt</button></div></div>`;
  openModal("Payment receipt", "Transaction successfully recorded.", content);
}

function showNoteReview(noteId) {
  if (!requireRole("vp", "review-note", noteId)) return;
  const note = data.notes.find(item => item.id === noteId);
  if (!note) return;
  const student = studentOf(note.studentId);
  const content = `<div class="modal-form">${personSummary(student)}<div class="receipt-details">
    <div class="receipt-line"><span>Note ID</span><strong>${escapeHtml(note.id)}</strong></div><div class="receipt-line"><span>Amount covered</span><strong>${money(note.amount)}</strong></div>
    <div class="receipt-line"><span>Purpose</span><strong>${escapeHtml(note.purpose)}</strong></div><div class="receipt-line"><span>Installments</span><strong>${note.installments} payments</strong></div>
    <div class="receipt-line"><span>Commitment due date</span><strong>${dateLabel(note.dueDate)}</strong></div>
    </div><div class="form-footer"><button class="button button-danger" data-action="note-decline" data-id="${escapeHtml(note.id)}">Decline</button><button class="button button-primary" data-action="note-approve" data-id="${escapeHtml(note.id)}">Approve note</button></div></div>`;
  openModal("Review promissory note", "Check the arrangement details before making a decision.", content);
}

async function settlePromissoryNote(noteId) {
  if (!requireRole("vp", "settle-note", noteId)) return;
  const note = data.notes.find(item => item.id === noteId);
  if (!note || note.status !== "Approved") return;
  note.status = "Paid";
  if (!await saveData()) return;
  render(); toast("Promissory note marked as settled.");
}

function exportCurrent() {
  let filename, headers, rows;
  if (currentPage === "students") {
    filename = "fbc-students.csv"; headers = ["Student number", "Name", "Program", "Year level", "Email", "Balance due"];
    rows = data.students.map(student => [student.studentNo, student.name, student.course, student.year, student.email, studentBalance(student.id)]);
  } else if (currentPage === "assessments") {
    filename = "fbc-assessments.csv"; headers = ["Assessment ID", "Student number", "Student name", "Term", "Total", "Paid", "Balance", "Status"];
    rows = data.assessments.map(item => [item.id, studentOf(item.studentId)?.studentNo, studentOf(item.studentId)?.name, item.term, assessmentTotal(item), assessmentPaid(item.id), assessmentBalance(item), assessmentStatus(item)]);
  } else if (currentPage === "payments") {
    filename = "fbc-payments.csv"; headers = ["Reference", "Student number", "Student name", "Assessment", "Date", "Method", "Amount"];
    rows = data.payments.map(payment => [payment.reference, studentOf(payment.studentId)?.studentNo, studentOf(payment.studentId)?.name, payment.assessmentId, payment.date, payment.method, payment.amount]);
  } else if (currentPage === "promissory") {
    filename = "fbc-promissory-notes.csv"; headers = ["Note ID", "Student number", "Student name", "Amount", "Purpose", "Installments", "Due date", "Status"];
    rows = data.notes.map(note => [note.id, studentOf(note.studentId)?.studentNo, studentOf(note.studentId)?.name, note.amount, note.purpose, note.installments, note.dueDate, note.status]);
  } else {
    filename = "fbc-payments.csv"; headers = ["Reference", "Student number", "Student name", "Assessment", "Date", "Method", "Amount"];
    rows = data.payments.map(payment => [payment.reference, studentOf(payment.studentId)?.studentNo, studentOf(payment.studentId)?.name, payment.assessmentId, payment.date, payment.method, payment.amount]);
  }
  const csv = [headers, ...rows].map(row => row.map(value => `"${String(value ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" }));
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
  toast("Your CSV export is ready.");
}

document.addEventListener("click", async event => {
  const pageButton = event.target.closest("[data-page]");
  if (pageButton) { goTo(pageButton.dataset.page); return; }
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  if (action === "close-modal") closeModal();
  else if (action === "refresh-data") await loadStaffData();
  else if (action === "staff-login") { pendingStaffAction = null; showStaffLogin(); }
  else if (action === "staff-logout") signOutStaff();
  else if (action === "staff-cashier-login") requireRole("cashier", "payment", button.dataset.id || "");
  else if (action === "staff-vp-login") requireRole("vp", button.dataset.next || "review-note", button.dataset.id || "");
  else if (action === "add-student") { if (canManageRecords()) showStudentForm(); }
  else if (action === "add-assessment") { if (canManageRecords()) showAssessmentForm(); }
  else if (action === "add-note") { if (canManageRecords()) showNoteForm(); }
  else if (action === "new-payment") showPaymentForm();
  else if (action === "pay") showPaymentForm(button.dataset.id);
  else if (action === "receipt") showReceipt(button.dataset.id);
  else if (action === "export") exportCurrent();
  else if (action === "review-note") showNoteReview(button.dataset.id);
  else if (action === "note-approve" || action === "note-decline") {
    if (!requireRole("vp", "review-note", button.dataset.id)) return;
    const note = data.notes.find(item => item.id === button.dataset.id);
    if (!note) return;
    note.status = action === "note-approve" ? "Approved" : "Rejected";
    if (!await saveData()) return;
    closeModal(); render(); toast(`Promissory note ${note.status.toLowerCase()}.`);
  } else if (action === "settle-note") {
    settlePromissoryNote(button.dataset.id);
  } else if (action === "print-receipt") window.print();
});

document.getElementById("mobileMenu").addEventListener("click", () => document.getElementById("sidebar").classList.toggle("open"));
document.getElementById("modalBackdrop").addEventListener("click", event => { if (event.target.id === "modalBackdrop") closeModal(); });
document.addEventListener("keydown", event => { if (event.key === "Escape") closeModal(); });

async function initializeStaffApp() {
  try {
    staffSession = await fbcApi.get("/api/auth/session");
    if (["cashier", "vp", "registrar"].includes(requestedStaffRole) && staffSession.role !== requestedStaffRole) {
      staffSession = null;
      render();
      toast(`Sign in as ${STAFF_ROLES[requestedStaffRole]} to switch accounts.`);
      showStaffLogin(requestedStaffRole);
      return;
    }
    if (staffSession.role === "student") {
      staffSession = null;
      render();
      toast("Please use the student kiosk to access your account.");
      return;
    }
    if (staffSession.role === "vp") currentPage = "promissory";
    await loadStaffData();
  } catch (error) {
    staffSession = null;
    render();
    if (["cashier", "vp", "registrar"].includes(requestedStaffRole)) showStaffLogin(requestedStaffRole);
    if (error.status !== 401) toast(error.message);
  }
}

render();
initializeStaffApp();
