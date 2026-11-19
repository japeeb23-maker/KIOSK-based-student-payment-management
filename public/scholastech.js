const currency = amount => new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP", maximumFractionDigits: 2 }).format(Number(amount) || 0);
const escapeText = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const localToday = () => {
  const date = new Date();
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 10);
};
const shortDate = value => value ? new Date(`${value}T00:00:00`).toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" }) : "—";
const newId = prefix => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
const initialsFor = name => String(name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join("").toUpperCase();
const schoolParams = new URLSearchParams(window.location.search);
const registrarPortal = schoolParams.get("portal") === "registrar" || schoolParams.get("staffRole") === "registrar";
const requestedStaffRole = registrarPortal ? "registrar" : schoolParams.get("staffRole");
let paypoint = { students: [], assessments: [], payments: [], notes: [] };
let school = { admissions: [], attendance: {}, notifications: [], schedules: [], scholarships: [] };
let staffSession = null;
let dataError = "";

let page = "dashboard";
let query = "";
let attendanceDate = localToday();
let legacyImportPayload = null;
const pageNames = { dashboard: registrarPortal ? "Dashboard" : "Overview", students: "Student records", admissions: "Admissions", attendance: "Attendance", timetable: "Timetable", finance: "Financial reports", notifications: "Notifications", compliance: "DepEd & CHED", scholarships: "Scholarships", assessments: "Assessments" };
const root = document.getElementById("schoolPageRoot");
const schoolRoles = { registrar: "Registrar / Administrator", vp: "VP for Finance" };
if (registrarPortal) {
  document.title = "Registrar Dashboard — FBC Paypoint";
  const brand = document.getElementById("schoolBrand");
  brand.href = "scholastech.html?portal=registrar";
  brand.setAttribute("aria-label", "Registrar dashboard home");
  document.getElementById("schoolBrandName").textContent = "Registrar";
  document.getElementById("schoolBrandSubtitle").textContent = "STUDENT RECORDS";
  document.getElementById("schoolHomeLabel").textContent = "Dashboard";
  document.getElementById("schoolPortalName").textContent = "Registrar";
  document.getElementById("schoolNavigation").setAttribute("aria-label", "Registrar navigation");
  document.getElementById("schoolSupportTitle").textContent = "Registrar support";
}
const personBadge = student => `<span class="student-mini">${escapeText(initialsFor(student?.name))}</span>`;
const personCell = student => student ? `<span class="student-cell">${personBadge(student)}<span><strong>${escapeText(student.name)}</strong><small>${escapeText(student.studentNo)}</small></span></span>` : `<span class="student-cell"><span class="student-mini">?</span><span><strong>Unknown student</strong></span></span>`;
const assessmentTotal = assessment => assessment.items.reduce((sum, item) => sum + Number(item.amount), 0);
const paidAmount = assessmentId => paypoint.payments.filter(payment => payment.assessmentId === assessmentId).reduce((sum, payment) => sum + Number(payment.amount), 0);
const balanceOf = assessment => Math.max(0, assessmentTotal(assessment) - paidAmount(assessment.id));
const studentBalance = studentId => paypoint.assessments.filter(assessment => assessment.studentId === studentId).reduce((sum, assessment) => sum + balanceOf(assessment), 0);
const collected = () => paypoint.payments.reduce((sum, payment) => sum + Number(payment.amount), 0);
const toast = message => {
  const item = document.createElement("div");
  item.className = "toast school-toast";
  item.textContent = message;
  document.getElementById("schoolToastRegion").append(item);
  setTimeout(() => item.remove(), 3200);
};
async function loadSchoolData() {
  const [paypointState, schoolState] = await Promise.all([
    fbcApi.get("/api/staff/state?system=paypoint"),
    fbcApi.get("/api/staff/state?system=school")
  ]);
  if (staffSession?.role === "vp") {
    paypoint = { students: schoolState.studentRoster, assessments: [], payments: [], notes: [] };
  } else {
    paypoint = paypointState;
  }
  school = schoolState;
}
async function saveSchool() {
  try {
    await fbcApi.put("/api/staff/state?system=school", school);
    return true;
  } catch (error) {
    console.error("Could not save FellowTech changes.", error);
    toast(error.message);
    try { await loadSchoolData(); }
    catch (loadError) {
      dataError = loadError.message;
      console.error("Could not reload FellowTech data after a failed save.", loadError);
    }
    return false;
  }
}
function canManageSchool() { return staffSession?.role === "registrar"; }
function canManageAttendance() { return staffSession?.role === "vp" || canManageSchool(); }
function requireSchoolRole(role) {
  if (staffSession?.role === role || (role === "vp" && canManageSchool())) return true;
  showStaffLogin(role);
  return false;
}
async function refreshSchoolData() {
  dataError = "";
  try {
    await loadSchoolData();
    render();
    return true;
  } catch (error) {
    dataError = error.message;
    console.error("Could not load FellowTech records.", error);
    render();
    return false;
  }
}
function showStaffLogin(requiredRole = registrarPortal ? "registrar" : "") {
  const options = Object.entries(schoolRoles).map(([key, label]) => `<option value="${key}" ${requiredRole === key ? "selected" : ""}>${label}</option>`).join("");
  const content = `<form class="modal-form" id="schoolLoginForm"><div class="form-grid">
    <div class="field full"><label for="schoolStaffRole">Staff role</label><select id="schoolStaffRole" name="role" required>${options}</select></div>
    ${field("Staff ID", "username", "Enter your assigned staff ID")}
    ${field("Password", "password", "Enter your password", "password")}
    </div><div class="auth-demo-note">Use the staff credentials assigned by your administrator.</div><div id="schoolLoginError" class="auth-error" role="alert"></div><div class="form-footer"><button type="button" class="button button-secondary" data-school-action="close">Cancel</button><button type="submit" class="button button-primary">Sign in</button></div></form>`;
  openDialog(registrarPortal ? "Registrar sign in" : "FellowTech staff sign in", "Enter your assigned staff credentials to continue.", content, false, true);
  document.getElementById("schoolLoginForm").addEventListener("submit", async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const role = String(form.get("role"));
    if (requiredRole && role !== requiredRole) {
      document.getElementById("schoolLoginError").textContent = `This action requires the ${schoolRoles[requiredRole]} role.`;
      return;
    }
    const submit = event.currentTarget.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      staffSession = await fbcApi.post("/api/auth/staff", { role, username: form.get("username"), password: form.get("password") });
      page = staffSession.role === "vp" ? "attendance" : "dashboard";
      closeDialog();
      if (await refreshSchoolData()) toast(`Signed in as ${staffSession.label}.`);
    } catch (error) {
      document.getElementById("schoolLoginError").textContent = error.message;
      submit.disabled = false;
    }
  });
}
async function signOutSchoolStaff() {
  try { await fbcApi.post("/api/auth/logout"); }
  catch (error) {
    console.error("Could not end the staff session on the server.", error);
    toast(`Sign-out failed: ${error.message}`);
    return;
  }
  staffSession = null;
  paypoint = { students: [], assessments: [], payments: [], notes: [] };
  school = { admissions: [], attendance: {}, notifications: [], schedules: [], scholarships: [] };
  render();
  toast("Staff session signed out.");
}
function head(kicker, title, description, actions = "") {
  return `<div class="page-heading"><div><div class="eyebrow">${kicker}</div><h1>${title}</h1><p class="page-subtitle">${description}</p></div><div class="heading-actions">${actions}</div></div>`;
}
function toolbar(placeholder, buttons = "") {
  return `<div class="toolbar"><label class="search-box"><span>⌕</span><input id="schoolSearch" type="search" placeholder="${placeholder}" value="${escapeText(query)}"></label><div class="toolbar-right">${buttons}</div></div>`;
}
function tablePanel(headers, rows, empty, footer = "") {
  return `<section class="panel data-panel"><div class="table-wrap"><table><thead><tr>${headers.map(header => `<th>${header}</th>`).join("")}</tr></thead><tbody>${rows || `<tr><td colspan="${headers.length}"><div class="empty-state"><strong>${empty}</strong></div></td></tr>`}</tbody></table></div>${footer ? `<div class="pagination">${footer}</div>` : ""}</section>`;
}
function statusBadge(status) {
  const className = status === "Active" || status === "Enrolled" || status === "Approved" ? "" : status === "Declined" ? "rejected" : "pending";
  return `<span class="school-status ${className}">${escapeText(status)}</span>`;
}

function dashboard() {
  const roster = paypoint.students.length;
  const paidStudents = paypoint.assessments.filter(assessment => balanceOf(assessment) === 0).length;
  const presentToday = Object.values(school.attendance[localToday()] || {}).filter(value => value === "Present").length;
  const activeScholarships = school.scholarships.filter(item => item.status === "Active").length;
  const recent = [...paypoint.payments].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 4);
  const modules = [["♙", "Student records", "students"], ["✚", "Admissions", "admissions"], ["✓", "Attendance", "attendance"], ["▦", "Timetable", "timetable"], ["₱", "Financial reports", "finance"], ["♧", "Notifications", "notifications"], ["▤", "DepEd & CHED", "compliance"], ["✦", "Scholarships", "scholarships"], ["▧", "Assessments", "assessments"]];
  const importAction = canManageSchool() ? `<button class="button button-secondary" data-school-action="import-legacy">Import old browser records</button>` : "";
  return `<div class="dashboard-view school-dashboard"><section class="school-hero"><div class="eyebrow">FELLOWSHIP BAPTIST COLLEGE · KABANKALAN CITY</div><h1>One campus. One connected student record.</h1><p>Manage student information and school operations, while keeping fee assessments and kiosk payments connected to FBC Paypoint.</p><a class="button" href="kiosk.html">Open student payment kiosk ↗</a> ${importAction}</section>
    <div class="stats-grid school-stats">
      <article class="stat-card school-stat"><div class="stat-top"><span>Student records</span><span class="stat-icon">♙</span></div><div class="stat-value">${roster}</div><div class="stat-foot">Synced with FBC Paypoint</div></article>
      <article class="stat-card school-stat"><div class="stat-top"><span>Collected fees</span><span class="stat-icon amber">₱</span></div><div class="stat-value">${currency(collected())}</div><div class="stat-foot">Recorded in Paypoint</div></article>
      <article class="stat-card school-stat"><div class="stat-top"><span>Assessments paid</span><span class="stat-icon blue">✓</span></div><div class="stat-value">${paidStudents} / ${paypoint.assessments.length}</div><div class="stat-foot">Current assessment records</div></article>
      <article class="stat-card school-stat"><div class="stat-top"><span>Active scholarships</span><span class="stat-icon purple">✦</span></div><div class="stat-value">${activeScholarships}</div><div class="stat-foot">${school.admissions.filter(item => item.status === "For review").length} admissions for review</div></article>
    </div>
    <div class="school-grid"><section class="panel"><div class="panel-header"><div><h2 class="panel-title">School operations</h2><p class="panel-caption">Choose a workspace to manage the current semester</p></div></div><div class="panel-body"><div class="school-module-grid">${modules.map(([icon, label, target]) => `<button class="school-module" data-school-page="${target}"><span class="school-module-icon">${icon}</span><strong>${label} →</strong></button>`).join("")}</div></div></section>
    <section class="panel"><div class="panel-header"><div><h2 class="panel-title">Recent Paypoint activity</h2><p class="panel-caption">Latest recorded fee payments</p></div><button class="action-link" data-school-page="finance">View report →</button></div><div class="panel-body"><div class="activity-list">${recent.length ? recent.map(payment => `<div class="activity-item"><span class="activity-icon">₱</span><span><strong>${escapeText(paypoint.students.find(student => student.id === payment.studentId)?.name || "Student payment")}</strong><small>${shortDate(payment.date)} · ${escapeText(payment.method)}</small></span><span class="activity-amount">${currency(payment.amount)}</span></div>`).join("") : `<div class="activity-empty">No payments have been recorded.</div>`}</div></div></section></div>
    <div class="school-kpi-row" style="margin-top:14px"><div class="school-kpi"><span>Attendance marked today</span><strong>${presentToday} / ${roster} present</strong></div><div class="school-kpi"><span>Financial records</span><strong>${paypoint.assessments.length} assessments</strong></div><div class="school-kpi"><span>Current academic year</span><strong>AY 2026–27</strong></div></div></div>`;
}

function registrarDashboard() {
  const pending = school.admissions.filter(item => item.status === "For review").length;
  const enrolled = school.admissions.filter(item => item.status === "Enrolled").length;
  const modules = [["♙", "Student records", "students"], ["✚", "Admissions", "admissions"], ["▧", "Assessments", "assessments"], ["✦", "Scholarships", "scholarships"]];
  return `<div class="dashboard-view school-dashboard"><section class="school-hero"><div class="eyebrow">FELLOWSHIP BAPTIST COLLEGE · REGISTRAR</div><h1>Registrar dashboard</h1><p>Manage admissions, student records, assessments, and scholarships from one place.</p><a class="button" href="scholastech.html">Open FellowTech ↗</a></section>
    <div class="stats-grid school-stats">
      <article class="stat-card school-stat"><div class="stat-top"><span>Student records</span><span class="stat-icon">♙</span></div><div class="stat-value">${paypoint.students.length}</div><div class="stat-foot">Shared student directory</div></article>
      <article class="stat-card school-stat"><div class="stat-top"><span>Admissions for review</span><span class="stat-icon amber">✚</span></div><div class="stat-value">${pending}</div><div class="stat-foot">Applications awaiting review</div></article>
      <article class="stat-card school-stat"><div class="stat-top"><span>Enrolled admissions</span><span class="stat-icon blue">✓</span></div><div class="stat-value">${enrolled}</div><div class="stat-foot">Applications marked enrolled</div></article>
      <article class="stat-card school-stat"><div class="stat-top"><span>Assessment records</span><span class="stat-icon purple">▧</span></div><div class="stat-value">${paypoint.assessments.length}</div><div class="stat-foot">Shared with FBC Paypoint</div></article>
    </div>
    <section class="panel"><div class="panel-header"><div><h2 class="panel-title">Registrar workspaces</h2><p class="panel-caption">Choose a task to continue</p></div></div><div class="panel-body"><div class="school-module-grid">${modules.map(([icon, label, target]) => `<button class="school-module" data-school-page="${target}"><span class="school-module-icon">${icon}</span><strong>${label} →</strong></button>`).join("")}</div>    </div></section></div>`;
}

function studentsPage() {
  const filtered = paypoint.students.filter(student => `${student.name} ${student.studentNo} ${student.course} ${student.year}`.toLowerCase().includes(query.toLowerCase()));
  const rows = filtered.map(student => `<tr><td><span class="student-cell">${personBadge(student)}<span><strong>${escapeText(student.name)}</strong></span></span></td><td>${escapeText(student.studentNo || "—")}</td><td>${escapeText(student.course)}</td><td>${escapeText(student.year)}</td><td>${escapeText(student.email || "—")}</td><td class="amount">${currency(studentBalance(student.id))}</td><td>${paypoint.assessments.filter(item => item.studentId === student.id).length} assessments</td><td>${canManageSchool() ? `<button class="action-link" data-school-action="signout-student" data-id="${escapeText(student.id)}">Sign out</button>` : "—"}</td></tr>`).join("");
  const action = canManageSchool() ? `<button class="button button-primary" data-school-action="new-admission">+ &nbsp;Enroll student</button>` : "";
  return `${head("CENTRAL STUDENT DIRECTORY", "Student records", "The shared student directory used by FellowTech and FBC Paypoint.", action)}${toolbar("Search by student name, number, or program…", `<a class="button button-secondary" href="index.html">Open FBC Paypoint ↗</a>`)}${tablePanel(["STUDENT", "STUDENT ID", "PROGRAM", "YEAR LEVEL", "EMAIL", "FEE BALANCE", "ASSESSMENTS", "KIOSK SESSION"], rows, "No matching students found.", `Showing ${filtered.length} of ${paypoint.students.length} student records · Shared with Paypoint`)}`;
}

async function signOutStudent(studentId) {
  if (!requireSchoolRole("registrar")) return;
  const student = paypoint.students.find(item => item.id === studentId);
  if (!student) return toast("Student record was not found.");
  try {
    await fbcApi.post(`/api/students/${encodeURIComponent(student.id)}/signout`);
    toast(`${student.name} was signed out of all kiosk sessions.`);
  } catch (error) {
    toast(error.message);
  }
}

function admissionsPage() {
  const applicants = school.admissions.filter(applicant => `${applicant.applicant} ${applicant.course} ${applicant.id}`.toLowerCase().includes(query.toLowerCase()));
  const rows = applicants.map(applicant => `<tr><td class="amount">${escapeText(applicant.id)}</td><td><span class="student-cell"><span class="student-mini">${escapeText(initialsFor(applicant.applicant))}</span><span><strong>${escapeText(applicant.applicant)}</strong><small>${escapeText(applicant.email)}</small></span></span></td><td>${escapeText(applicant.course)}</td><td>${escapeText(applicant.year)}</td><td>${shortDate(applicant.appliedAt)}</td><td>${statusBadge(applicant.status)}</td><td>${canManageSchool() && applicant.status === "For review" ? `<button class="action-link" data-school-action="review-admission" data-id="${escapeText(applicant.id)}">Review</button>` : "—"}</td></tr>`).join("");
  const action = canManageSchool() ? `<button class="button button-primary" data-school-action="new-admission">+ &nbsp;New applicant</button>` : "";
  return `${head("ENROLLMENT & ADMISSIONS", "Admissions", "Review applicant records and enroll accepted students into the shared directory.", action)}${toolbar("Search applicant or application ID…")}${tablePanel(["APPLICATION", "APPLICANT", "PROGRAM", "YEAR LEVEL", "APPLIED", "STATUS", "ACTION"], rows, "No admission applications match your search.", `${school.admissions.length} applications · Enrolling adds the student to FBC Paypoint`)}`;
}

function attendancePage() {
  const attendanceForDay = school.attendance[attendanceDate] || {};
  const rows = paypoint.students.filter(student => `${student.name} ${student.studentNo} ${student.course}`.toLowerCase().includes(query.toLowerCase())).map(student => {
    const current = attendanceForDay[student.id] || "Unmarked";
    const control = canManageAttendance() ? `<select class="school-select attendance-select" data-student="${escapeText(student.id)}" aria-label="Attendance for ${escapeText(student.name)}"><option ${current === "Unmarked" ? "selected" : ""}>Unmarked</option><option ${current === "Present" ? "selected" : ""}>Present</option><option ${current === "Absent" ? "selected" : ""}>Absent</option><option ${current === "Late" ? "selected" : ""}>Late</option><option ${current === "Excused" ? "selected" : ""}>Excused</option></select>` : escapeText(current);
    return `<tr><td>${personCell(student)}</td><td>${escapeText(student.course)}</td><td>${control}</td><td>${current === "Unmarked" ? "—" : statusBadge(current)}</td></tr>`;
  }).join("");
  const action = canManageAttendance() ? `<button class="button button-primary" data-school-action="mark-present">✓ &nbsp;Mark all present</button>` : "";
  return `${head("CAMPUS ATTENDANCE", "Attendance tracking", "Record a daily attendance register for the connected student roster.", action)}<div class="toolbar"><label class="field" style="display:flex;align-items:center;gap:8px"><span style="font-size:10px;font-weight:600">Attendance date</span><input class="school-select" id="attendanceDate" type="date" value="${escapeText(attendanceDate)}"></label><div class="attendance-legend"><span><i class="legend-dot"></i>Present</span><span><i class="legend-dot absent"></i>Absent</span><span><i class="legend-dot late"></i>Late</span></div></div>${tablePanel(["STUDENT", "PROGRAM", "MARK ATTENDANCE", "STATUS"], rows, "No students found for this register.", `${Object.keys(attendanceForDay).length} of ${paypoint.students.length} records marked · Saved to the backend`)}`;
}

function timetablePage() {
  const entries = school.schedules.filter(item => `${item.day} ${item.course} ${item.subject} ${item.room} ${item.instructor}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].indexOf(a.day) - ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].indexOf(b.day) || a.start.localeCompare(b.start));
  const rows = entries.map(item => `<tr><td><span class="schedule-time">${escapeText(item.start)}–${escapeText(item.end)}</span></td><td>${escapeText(item.day)}</td><td><strong>${escapeText(item.subject)}</strong></td><td>${escapeText(item.course)}</td><td>${escapeText(item.room)}</td><td>${escapeText(item.instructor)}</td></tr>`).join("");
  const action = canManageSchool() ? `<button class="button button-primary" data-school-action="new-schedule">+ &nbsp;Add class schedule</button>` : "";
  return `${head("ACADEMIC SCHEDULING", "Timetable", "View class schedules and coordinate rooms and instructors.", action)}${toolbar("Search subject, instructor, course, or room…")}${tablePanel(["TIME", "DAY", "SUBJECT", "PROGRAM / YEAR", "ROOM", "INSTRUCTOR"], rows, "No schedules found.", `${entries.length} class schedules · AY 2026–27`)}`;
}

function financePage() {
  const currentMonth = new Date().toISOString().slice(0, 7);
  const monthTotal = paypoint.payments.filter(payment => payment.date.startsWith(currentMonth)).reduce((sum, payment) => sum + Number(payment.amount), 0);
  const outstanding = paypoint.assessments.reduce((sum, assessment) => sum + balanceOf(assessment), 0);
  const rows = [...paypoint.payments].sort((a, b) => b.date.localeCompare(a.date)).filter(payment => `${payment.reference} ${paypoint.students.find(student => student.id === payment.studentId)?.name || ""} ${payment.method}`.toLowerCase().includes(query.toLowerCase())).map(payment => `<tr><td class="amount">${escapeText(payment.reference)}</td><td>${personCell(paypoint.students.find(student => student.id === payment.studentId))}</td><td>${shortDate(payment.date)}</td><td>${escapeText(payment.method)}</td><td class="amount">${currency(payment.amount)}</td></tr>`).join("");
  return `${head("PAYMENT & FINANCIAL REPORTS", "Financial reports", "Read-only finance summaries connected directly to FBC Paypoint.", `<a class="button button-primary" href="index.html">Manage payments ↗</a>`)}<div class="school-kpi-row"><div class="school-kpi"><span>Total collected</span><strong>${currency(collected())}</strong></div><div class="school-kpi"><span>Collected this month</span><strong>${currency(monthTotal)}</strong></div><div class="school-kpi"><span>Outstanding assessments</span><strong>${currency(outstanding)}</strong></div></div>${toolbar("Search student, reference, or payment method…", `<a class="button button-secondary" href="index.html">Open payment register ↗</a>`)}${tablePanel(["REFERENCE", "STUDENT", "PAYMENT DATE", "METHOD", "AMOUNT"], rows, "No payments match your search.", `${rows ? paypoint.payments.length : 0} shared transactions · Payment posting is handled by FBC Paypoint`)}`;
}

function notificationsPage() {
  const notifications = (school.notifications || []).filter(item => `${item.title} ${item.message} ${item.audience}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const rows = notifications.map(item => `<tr><td><strong>${escapeText(item.title)}</strong><small class="notification-message">${escapeText(item.message)}</small></td><td>${escapeText(item.audience)}</td><td>${shortDate(item.createdAt)}</td><td>In-app demo</td><td>${statusBadge(item.status)}</td></tr>`).join("");
  const action = canManageSchool() ? `<button class="button button-primary" data-school-action="new-notification">+ &nbsp;Compose notification</button>` : "";
  return `${head("STUDENT COMMUNICATIONS", "Notifications", "Prepare announcements for student accounts and review queued demo messages.", action)}<div class="note-callout"><span>ⓘ</span><div><strong>Demo notifications are not delivered to mobile devices</strong><p>Messages are stored in the backend only. SMS, push notifications, email delivery, and student mobile apps are not configured.</p></div></div>${toolbar("Search message or recipient…")}${tablePanel(["ANNOUNCEMENT", "AUDIENCE", "CREATED", "CHANNEL", "STATUS"], rows, "No notifications have been composed.", `${notifications.length} demo notification${notifications.length === 1 ? "" : "s"} · No external delivery`)}`;
}

function compliancePage() {
  const checks = [
    ["DepEd learner records", "Student directory records available for school reporting", `${paypoint.students.length} student records`],
    ["CHED program information", "Program and year-level data are recorded for students", `${new Set(paypoint.students.map(student => student.course)).size} programs`],
    ["Enrollment register", "Admissions decisions and enrolled student roster", `${school.admissions.length} applications`],
    ["Attendance register", "Daily attendance records for active student accounts", `${Object.keys(school.attendance).length} days recorded`],
    ["Scholarship register", "Scholarship awards and review statuses", `${school.scholarships.length} scholarship records`],
    ["Student assessment records", "Fee assessments and payment balances from Paypoint", `${paypoint.assessments.length} assessments`]
  ];
  return `${head("INSTITUTIONAL RECORDS", "DepEd & CHED readiness", "A summary checklist of school records that may support institutional reporting.", `<button class="button button-secondary" data-school-action="export-compliance">↓ &nbsp;Export checklist</button>`)}<div class="note-callout"><span>ⓘ</span><div><strong>Readiness checklist, not an official submission</strong><p>These indicators help organize records. Confirm applicable requirements, formats, and reporting periods with DepEd, CHED, and the college registrar.</p></div></div><section class="panel"><div class="panel-header"><div><h2 class="panel-title">Records overview</h2><p class="panel-caption">Data coverage in this FellowTech demo</p></div></div><div class="panel-body"><div class="compliance-list">${checks.map(([title, detail, count]) => `<div class="compliance-item"><span class="compliance-mark">✓</span><span><strong>${title}</strong><small>${detail}</small></span><span class="school-status">${count}</span></div>`).join("")}</div><div class="compliance-note">This prototype does not certify DepEd or CHED compliance, generate official forms, or submit records to government systems.</div></div></section>`;
}

function scholarshipsPage() {
  const entries = school.scholarships.filter(item => {
    const student = paypoint.students.find(person => person.id === item.studentId);
    return `${item.program} ${student?.name || ""} ${student?.studentNo || ""} ${item.status}`.toLowerCase().includes(query.toLowerCase());
  });
  const rows = entries.map(item => {
    const student = paypoint.students.find(person => person.id === item.studentId);
    return `<tr><td class="amount">${escapeText(item.id)}</td><td>${personCell(student)}</td><td>${escapeText(item.program)}</td><td>${escapeText(item.coverage)}</td><td>${escapeText(item.academicYear)}</td><td>${statusBadge(item.status)}</td><td>${canManageSchool() && item.status === "For review" ? `<button class="action-link" data-school-action="award-scholarship" data-id="${escapeText(item.id)}">Mark active</button>` : "—"}</td></tr>`;
  }).join("");
  const action = canManageSchool() ? `<button class="button button-primary" data-school-action="new-scholarship">+ &nbsp;Add scholarship</button>` : "";
  return `${head("STUDENT SUPPORT", "Scholarship management", "Track scholarship programs, student awards, and review status.", action)}${toolbar("Search scholarship or student…")}${tablePanel(["AWARD ID", "STUDENT", "PROGRAM", "COVERAGE", "ACADEMIC YEAR", "STATUS", "ACTION"], rows, "No scholarship records found.", `${school.scholarships.length} scholarship records · Awards do not automatically alter Paypoint balances`)}`;
}

function assessmentsPage() {
  const filtered = paypoint.assessments.filter(assessment => {
    const student = paypoint.students.find(person => person.id === assessment.studentId);
    return `${assessment.id} ${assessment.term} ${student?.name || ""} ${student?.studentNo || ""}`.toLowerCase().includes(query.toLowerCase());
  }).sort((a, b) => b.date.localeCompare(a.date));
  const rows = filtered.map(assessment => {
    const student = paypoint.students.find(person => person.id === assessment.studentId);
    const total = assessmentTotal(assessment);
    const paid = paidAmount(assessment.id);
    const balance = balanceOf(assessment);
    const status = balance === 0 ? "Paid" : paid > 0 ? "Partial" : "Pending";
    return `<tr><td class="amount">${escapeText(assessment.id)}</td><td>${personCell(student)}</td><td>${escapeText(assessment.term)}</td><td class="amount">${currency(total)}</td><td>${currency(paid)}</td><td class="amount">${currency(balance)}</td><td><span class="status ${status === "Paid" ? "" : status === "Partial" ? "partial" : "pending"}">${status}</span></td></tr>`;
  }).join("");
  return `${head("REAL-TIME STUDENT ASSESSMENTS", "Assessment viewing", "Current fee assessments and balances shared with FBC Paypoint.", `<a class="button button-primary" href="index.html">Manage assessments ↗</a>`)}${toolbar("Search student, term, or assessment ID…", `<a class="button button-secondary" href="index.html">FBC Paypoint ↗</a>`)}${tablePanel(["ASSESSMENT", "STUDENT", "ACADEMIC TERM", "ASSESSED", "PAID", "BALANCE", "STATUS"], rows, "No assessment records found.", `${filtered.length} of ${paypoint.assessments.length} shared assessments · Updated when Paypoint records change`)}`;
}

const pages = { dashboard: registrarPortal ? registrarDashboard : dashboard, students: studentsPage, admissions: admissionsPage, attendance: attendancePage, timetable: timetablePage, finance: financePage, notifications: notificationsPage, compliance: compliancePage, scholarships: scholarshipsPage, assessments: assessmentsPage };
function render() {
  const allowed = staffSession && ["registrar", "vp"].includes(staffSession.role);
  if (document.body) document.body.classList.toggle("school-dashboard-active", Boolean(allowed && !dataError && page === "dashboard"));
  document.querySelector(".page-content").classList.toggle("school-overview", Boolean(allowed && !dataError && page === "dashboard"));
  const sidebar = document.getElementById("schoolSidebar");
  if (sidebar) {
    sidebar.classList.toggle("staff-locked", !staffSession || !allowed);
    sidebar.setAttribute("aria-hidden", String(!staffSession || !allowed));
  }
  if (!staffSession) {
    root.innerHTML = `<section class="panel"><div class="panel-body"><div class="eyebrow">STAFF ACCESS</div><h1>Sign in to ${registrarPortal ? "Registrar" : "FellowTech"}</h1><p class="page-subtitle">${dataError ? escapeText(dataError) : "School and student records are stored in the FBC Paypoint backend. Sign in with an authorized account to continue."}</p><button class="button button-primary" data-school-action="school-login">Staff sign in</button></div></section>`;
  } else if (!allowed) {
    root.innerHTML = `<section class="panel"><div class="panel-body"><div class="eyebrow">ACCESS RESTRICTED</div><h1>FellowTech staff access required</h1><p class="page-subtitle">${escapeText(staffSession.label || staffSession.role)} accounts cannot access school-management records. Sign out and use a Registrar or VP for Finance account.</p><button class="button button-secondary" data-school-action="school-logout">Sign out</button> <button class="button button-primary" data-school-action="school-login">Sign in with another account</button></div></section>`;
  } else if (dataError) {
    root.innerHTML = `<div class="note-callout"><span>!</span><div><strong>Backend data unavailable</strong><p>${escapeText(dataError)}</p><button class="action-link" data-school-action="retry">Retry</button></div></div>`;
  } else {
    root.innerHTML = pages[page]();
  }
  document.getElementById("schoolBreadcrumb").textContent = allowed ? pageNames[page] : "Staff access";
  document.getElementById("admissionCount").textContent = school.admissions.filter(item => item.status === "For review").length;
  const staffAccess = document.getElementById("schoolStaffAccess");
  document.getElementById("schoolRefresh").hidden = !allowed;
  if (staffAccess) {
    staffAccess.textContent = allowed ? `${staffSession.label} · Sign out` : staffSession ? "Sign out" : "Staff sign in";
    staffAccess.dataset.schoolAction = staffSession ? "school-logout" : "school-login";
  }
  const profile = document.querySelector(".profile-button");
  if (profile) {
    profile.querySelector(".avatar").textContent = staffSession ? initialsFor(staffSession.label) : "—";
    profile.querySelector("strong").textContent = staffSession?.username || "Not signed in";
    profile.querySelector("small").textContent = staffSession?.label || "FellowTech staff";
  }
  document.querySelector(".top-avatar").textContent = staffSession ? initialsFor(staffSession.label) : "—";
  document.querySelectorAll(".school-nav .nav-item").forEach(button => {
    button.hidden = staffSession?.role === "vp" && button.dataset.schoolPage !== "attendance";
  });
  if (!allowed || dataError) return;
  document.querySelectorAll("[data-school-page]").forEach(button => button.classList.toggle("active", button.dataset.schoolPage === page && button.classList.contains("nav-item")));
  const search = document.getElementById("schoolSearch");
  if (search) search.addEventListener("input", event => {
    const cursor = event.target.selectionStart;
    query = event.target.value;
    render();
    const next = document.getElementById("schoolSearch");
    next?.focus();
    next?.setSelectionRange(cursor, cursor);
  });
  document.getElementById("attendanceDate")?.addEventListener("change", event => { attendanceDate = event.target.value; render(); });
  document.querySelectorAll(".attendance-select").forEach(select => select.addEventListener("change", async () => {
    if (!school.attendance[attendanceDate]) school.attendance[attendanceDate] = {};
    if (select.value === "Unmarked") delete school.attendance[attendanceDate][select.dataset.student];
    else school.attendance[attendanceDate][select.dataset.student] = select.value;
    if (await saveSchool()) { render(); toast("Attendance record saved."); }
  }));
}
function navigate(nextPage) {
  if (!pages[nextPage]) return;
  if (!staffSession || !["registrar", "vp"].includes(staffSession.role)) return showStaffLogin();
  if (staffSession.role === "vp" && nextPage !== "attendance") return;
  page = nextPage;
  query = "";
  document.getElementById("schoolSidebar").classList.remove("open");
  render();
}
function openDialog(title, subtitle, formMarkup, wide = false, auth = false) {
  const modal = document.getElementById("schoolModal");
  modal.className = `modal${wide ? " modal-wide" : ""}${auth ? " auth-modal" : ""}`;
  const header = `<div class="modal-header"><div>${auth ? '<div class="auth-eyebrow">SECURE STAFF ACCESS</div>' : ""}<h2 id="schoolModalTitle">${escapeText(title)}</h2><p>${escapeText(subtitle)}</p></div><button class="modal-close" data-school-action="close" aria-label="Close dialog">×</button></div>`;
  modal.innerHTML = auth
    ? `<div class="auth-intro"><div class="auth-brand"><img src="fbc-logo.jpg" alt="" width="56" height="56"><span><strong>Fellowship Baptist College</strong><small>FBC Paypoint</small></span></div><div><span class="auth-badge">Secure staff services</span><h2>Welcome back.<br><span>Ready to serve.</span></h2><p>Access the tools you need to support students and manage college records securely.</p></div></div><div class="auth-panel">${header}${formMarkup}</div>`
    : `${header}${formMarkup}`;
  document.getElementById("schoolModalBackdrop").hidden = false;
  modal.querySelector("input,select,textarea,button")?.focus();
}
function closeDialog() { document.getElementById("schoolModalBackdrop").hidden = true; }
function field(label, name, placeholder, type = "text", required = true, extra = "") {
  return `<div class="field"><label for="${name}">${escapeText(label)}</label><input id="${name}" name="${name}" type="${type}" placeholder="${escapeText(placeholder)}" ${required ? "required" : ""} ${extra}></div>`;
}
function formFooter(label) {
  return `<div class="form-footer"><button type="button" class="button button-secondary" data-school-action="close">Cancel</button><button type="submit" class="button button-primary">${label}</button></div>`;
}

function showLegacyImport() {
  let paypointState;
  let schoolState;
  try {
    paypointState = JSON.parse(localStorage.getItem("fbc-paypoint-v1") || "null");
    schoolState = JSON.parse(localStorage.getItem("fbc-scholastech-v1") || "null");
  } catch (error) {
    return toast(`Could not read the previous browser records: ${error.message}`);
  }
  if (!paypointState && !schoolState) return toast("No previous FBC browser records were found in this browser profile.");
  if (!paypointState || !schoolState) return toast("Both Paypoint and FellowTech browser records are needed for a safe import.");
  if (!Array.isArray(schoolState.notifications)) schoolState.notifications = [];
  if (!Array.isArray(paypointState.students) || !Array.isArray(paypointState.assessments) ||
      !Array.isArray(paypointState.payments) || !Array.isArray(paypointState.notes) ||
      !Array.isArray(schoolState.admissions) || !Array.isArray(schoolState.schedules) ||
      !Array.isArray(schoolState.scholarships) || !Array.isArray(schoolState.notifications) ||
      !schoolState.attendance || typeof schoolState.attendance !== "object" || Array.isArray(schoolState.attendance)) {
    return toast("The previous browser records have an unsupported format and were not imported.");
  }
  legacyImportPayload = { paypoint: paypointState, school: schoolState };
  const recordCount = paypointState.students.length + paypointState.assessments.length + paypointState.payments.length +
    paypointState.notes.length + schoolState.admissions.length + schoolState.schedules.length +
    schoolState.scholarships.length + schoolState.notifications.length;
  const content = `<div class="modal-form"><p>This will merge ${recordCount} old records into SQLite. Existing backend records are never overwritten; conflicting IDs will be kept as they are in the backend and reported after import.</p><p class="school-modal-hint">The old browser data will not be deleted. Review the import result and keep a backup of the browser profile.</p><div class="form-footer"><button class="button button-secondary" data-school-action="close">Cancel</button><button class="button button-primary" data-school-action="confirm-legacy-import">Merge records</button></div></div>`;
  openDialog("Import old browser records", "Merge existing localStorage data into the backend.", content);
}

function showAdmissionForm(existing = null) {
  const applicant = existing || {};
  const content = `<form class="modal-form" id="admissionForm"><div class="form-grid">
    ${field("Applicant's full name", "name", "Complete name", "text", true, `value="${escapeText(applicant.applicant || "")}"`)}
    ${field("Email address", "email", "applicant@example.com", "email", true, `value="${escapeText(applicant.email || "")}"`)}
    ${field("Program / course", "course", "e.g. BS Information Technology", "text", true, `value="${escapeText(applicant.course || "")}"`)}
    <div class="field"><label for="year">Year level</label><select id="year" name="year" required><option value="">Select year level</option>${["1st Year", "2nd Year", "3rd Year", "4th Year", "5th Year"].map(year => `<option ${applicant.year === year ? "selected" : ""}>${year}</option>`).join("")}</select></div>
    </div><p class="school-modal-hint">Approving an applicant creates a student record shared with FBC Paypoint and the kiosk.</p>${formFooter(existing ? "Approve & enroll" : "Save applicant")}</form>`;
  openDialog(existing ? "Review applicant" : "New admission", "Enter applicant details for the current academic year.", content);
  document.getElementById("admissionForm").addEventListener("submit", async event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const submit = event.currentTarget.querySelector('button[type="submit"]');
    submit.disabled = true;
    if (existing) {
      try {
        const result = await fbcApi.post("/api/auth/admission", { admissionId: existing.id, ...values });
        closeDialog();
        if (await refreshSchoolData()) toast(`${result.student.name} enrolled and synced to FBC Paypoint.`);
      } catch (error) {
        toast(error.message);
        submit.disabled = false;
      }
      return;
    }
    try {
      await fbcApi.post("/api/admissions", values);
      closeDialog();
      if (await refreshSchoolData()) toast("Admission application saved.");
    } catch (error) {
      toast(error.message);
      submit.disabled = false;
    }
  });
}

function reviewAdmission(admissionId) {
  const applicant = school.admissions.find(item => item.id === admissionId);
  if (!applicant) return;
  showAdmissionForm(applicant);
}

function showScheduleForm() {
  const content = `<form class="modal-form" id="scheduleForm"><div class="form-grid">
    <div class="field"><label for="day">Day</label><select id="day" name="day" required>${["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map(day => `<option>${day}</option>`).join("")}</select></div>
    ${field("Subject", "subject", "Subject name")}
    ${field("Start time", "start", "", "time")}
    ${field("End time", "end", "", "time")}
    ${field("Program / year", "course", "e.g. BS Accountancy · 1st Year")}
    ${field("Room", "room", "Room or laboratory")}
    ${field("Instructor", "instructor", "Instructor name")}
    </div>${formFooter("Add to timetable")}</form>`;
  openDialog("Add class schedule", "Add a schedule to the campus timetable.", content, true);
  document.getElementById("scheduleForm").addEventListener("submit", async event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    if (values.end <= values.start) return toast("End time must be after start time.");
    school.schedules.push({ id: newId("SCH"), ...values });
    if (await saveSchool()) { closeDialog(); render(); toast("Class schedule added."); }
  });
}

function showScholarshipForm() {
  if (!paypoint.students.length) return toast("Add a student record before assigning a scholarship.");
  const students = paypoint.students.map(student => `<option value="${escapeText(student.id)}">${escapeText(student.name)} · ${escapeText(student.studentNo)}</option>`).join("");
  const content = `<form class="modal-form" id="scholarshipForm"><div class="form-grid">
    <div class="field full"><label for="studentId">Student</label><select id="studentId" name="studentId" required>${students}</select></div>
    ${field("Scholarship program", "program", "Program name")}
    ${field("Coverage", "coverage", "e.g. 50% tuition")}
    ${field("Academic year", "academicYear", "AY 2026–27", "text", true, 'value="AY 2026–27"')}
    </div>${formFooter("Save scholarship")}</form>`;
  openDialog("Add scholarship", "Create a scholarship record for an enrolled student.", content);
  document.getElementById("scholarshipForm").addEventListener("submit", async event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    school.scholarships.push({ id: newId("FBC-SCH"), ...values, status: "For review" });
    if (await saveSchool()) { closeDialog(); render(); toast("Scholarship submitted for review."); }
  });
}

function showNotificationForm() {
  if (!Array.isArray(school.notifications)) school.notifications = [];
  const recipients = `<option value="all">All students (${paypoint.students.length})</option>${paypoint.students.map(student => `<option value="${escapeText(student.id)}">${escapeText(student.name)} · ${escapeText(student.studentNo)}</option>`).join("")}`;
  const content = `<form class="modal-form" id="notificationForm"><div class="form-grid">
    ${field("Announcement title", "title", "e.g. Enrollment reminder")}
    <div class="field"><label for="audience">Recipient</label><select id="audience" name="audience" required>${recipients}</select></div>
    <div class="field full"><label for="message">Message</label><textarea id="message" name="message" maxlength="500" placeholder="Write the announcement for students…" required></textarea><span class="school-modal-hint">Maximum 500 characters. This will be saved as a demo notification, not sent externally.</span></div>
    </div>${formFooter("Queue demo notification")}</form>`;
  openDialog("Compose notification", "Create a demo announcement for the selected student audience.", content, true);
  document.getElementById("notificationForm").addEventListener("submit", async event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const audience = values.audience === "all" ? "All students" : paypoint.students.find(student => student.id === values.audience)?.name;
    school.notifications.push({ id: newId("NTF"), title: String(values.title).trim(), message: String(values.message).trim(), audience: audience || "Student", audienceId: values.audience, createdAt: localToday(), status: "Queued (demo)" });
    if (await saveSchool()) { closeDialog(); render(); toast("Demo notification queued in the backend."); }
  });
}

function exportCsv(filename, headers, rows) {
  const csv = [headers, ...rows].map(row => row.map(value => `"${String(value ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" }));
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
  toast("CSV export ready.");
}

document.addEventListener("click", async event => {
  const pageButton = event.target.closest("[data-school-page]");
  if (pageButton) { navigate(pageButton.dataset.schoolPage); return; }
  const button = event.target.closest("[data-school-action]");
  if (!button) return;
  const action = button.dataset.schoolAction;
  if (action === "close") closeDialog();
  else if (action === "school-login") showStaffLogin();
  else if (action === "school-logout") signOutSchoolStaff();
  else if (action === "retry") refreshSchoolData();
  else if (action === "import-legacy") { if (requireSchoolRole("registrar")) showLegacyImport(); }
  else if (action === "confirm-legacy-import") {
    if (!requireSchoolRole("registrar") || !legacyImportPayload) return;
    button.disabled = true;
    try {
      const result = await fbcApi.post("/api/staff/import-legacy", legacyImportPayload);
      legacyImportPayload = null;
      closeDialog();
      if (await refreshSchoolData()) toast(`Imported ${result.imported} new records. ${result.conflicts} conflicting records were left unchanged in SQLite.`);
    } catch (error) {
      toast(error.message);
      button.disabled = false;
    }
  }
  else if (action === "new-admission") { if (requireSchoolRole("registrar")) showAdmissionForm(); }
  else if (action === "signout-student") signOutStudent(button.dataset.id);
  else if (action === "review-admission") reviewAdmission(button.dataset.id);
  else if (action === "new-schedule") { if (requireSchoolRole("registrar")) showScheduleForm(); }
  else if (action === "new-scholarship") { if (requireSchoolRole("registrar")) showScholarshipForm(); }
  else if (action === "new-notification") { if (requireSchoolRole("registrar")) showNotificationForm(); }
  else if (action === "mark-present") {
    if (!requireSchoolRole("vp")) return;
    const daily = school.attendance[attendanceDate] || {};
    paypoint.students.forEach(student => { daily[student.id] = "Present"; });
    school.attendance[attendanceDate] = daily;
    if (await saveSchool()) { render(); toast(`Attendance saved for ${paypoint.students.length} students.`); }
  } else if (action === "award-scholarship") {
    if (!requireSchoolRole("registrar")) return;
    const scholarship = school.scholarships.find(item => item.id === button.dataset.id);
    if (!scholarship) return;
    scholarship.status = "Active";
    if (await saveSchool()) { render(); toast("Scholarship marked active."); }
  } else if (action === "export-compliance") {
    exportCsv("scholastech-compliance-checklist.csv", ["Record area", "Count", "Academic year"], [
      ["Student records", paypoint.students.length, "AY 2026–27"],
      ["Admissions", school.admissions.length, "AY 2026–27"],
      ["Attendance days", Object.keys(school.attendance).length, "AY 2026–27"],
      ["Scholarship awards", school.scholarships.length, "AY 2026–27"],
      ["Fee assessments", paypoint.assessments.length, "AY 2026–27"]
    ]);
  }
});

document.getElementById("schoolMobileMenu").addEventListener("click", () => document.getElementById("schoolSidebar").classList.toggle("open"));
document.getElementById("schoolModalBackdrop").addEventListener("click", event => { if (event.target.id === "schoolModalBackdrop") closeDialog(); });
document.addEventListener("keydown", event => { if (event.key === "Escape") closeDialog(); });
async function initializeSchoolApp() {
  try {
    staffSession = await fbcApi.get("/api/auth/session");
    if (["registrar", "vp"].includes(requestedStaffRole) && staffSession.role !== requestedStaffRole) {
      staffSession = null;
      render();
      toast(`Sign in as ${schoolRoles[requestedStaffRole]} to switch accounts.`);
      showStaffLogin(requestedStaffRole);
      return;
    }
    if (!["registrar", "vp"].includes(staffSession.role)) {
      render();
      return;
    }
    if (staffSession.role === "vp") page = "attendance";
    await refreshSchoolData();
  } catch (error) {
    if (error.status !== 401) {
      dataError = error.message;
      console.error("FellowTech could not start.", error);
    }
    render();
    if (["registrar", "vp"].includes(requestedStaffRole)) showStaffLogin(requestedStaffRole);
  }
}
render();
initializeSchoolApp();
