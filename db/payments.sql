CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL,
  assessment_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('PAYMONGO', 'CASH')),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('QRPH', 'GCASH', 'MAYA', 'CASH')),
  status TEXT NOT NULL CHECK (status IN ('INITIALIZING', 'PENDING', 'CASH_ACCEPTING', 'CHANGE_PENDING', 'PAID', 'CANCELLED', 'EXPIRED', 'FAILED')),
  currency TEXT NOT NULL DEFAULT 'PHP' CHECK (currency = 'PHP'),
  amount_due_minor INTEGER NOT NULL CHECK (amount_due_minor > 0),
  amount_tendered_minor INTEGER NOT NULL DEFAULT 0 CHECK (amount_tendered_minor >= 0),
  change_due_minor INTEGER NOT NULL DEFAULT 0 CHECK (change_due_minor >= 0),
  change_dispensed_minor INTEGER NOT NULL DEFAULT 0 CHECK (change_dispensed_minor >= 0),
  change_credited_minor INTEGER NOT NULL DEFAULT 0 CHECK (change_credited_minor >= 0),
  provider_payment_intent_id TEXT UNIQUE,
  provider_payment_method_id TEXT,
  provider_checkout_json TEXT,
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE (student_id, idempotency_key),
  CHECK (change_dispensed_minor + change_credited_minor <= change_due_minor)
);

CREATE INDEX IF NOT EXISTS transactions_student_created
  ON transactions(student_id, created_at DESC);
CREATE INDEX IF NOT EXISTS transactions_expiry
  ON transactions(status, expires_at);

CREATE TABLE IF NOT EXISTS transaction_items (
  id INTEGER PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id),
  label TEXT NOT NULL CHECK (length(trim(label)) > 0),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0)
);

CREATE TABLE IF NOT EXISTS cash_ledger_events (
  event_id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id),
  device_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('CASH_INSERTED', 'CASH_CANCELLED', 'CHANGE_DISPENSED', 'INSUFFICIENT_CHANGE')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS cash_ledger_transaction ON cash_ledger_events(transaction_id, received_at);

CREATE TABLE IF NOT EXISTS student_credit_ledger (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL REFERENCES transactions(id),
  credit_type TEXT NOT NULL CHECK (credit_type IN ('CASH_CANCELLED', 'CHANGE_SHORTAGE', 'OVERPAYMENT_CREDIT')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  description TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS student_credit_student ON student_credit_ledger(student_id, created_at DESC);

CREATE TABLE IF NOT EXISTS official_receipts (
  transaction_id TEXT PRIMARY KEY REFERENCES transactions(id),
  or_number TEXT NOT NULL UNIQUE,
  student_id TEXT NOT NULL,
  assessment_id TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency = 'PHP'),
  amount_due_minor INTEGER NOT NULL CHECK (amount_due_minor > 0),
  amount_tendered_minor INTEGER NOT NULL CHECK (amount_tendered_minor >= 0),
  change_dispensed_minor INTEGER NOT NULL CHECK (change_dispensed_minor >= 0),
  change_credited_minor INTEGER NOT NULL CHECK (change_credited_minor >= 0),
  payment_method TEXT NOT NULL,
  fee_breakdown_json TEXT NOT NULL,
  escpos_payload BLOB NOT NULL,
  issued_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_sequence (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  next_number INTEGER NOT NULL CHECK (next_number > 0)
);
INSERT OR IGNORE INTO payment_sequence(id, next_number) VALUES (1, 1);

CREATE TABLE IF NOT EXISTS paymongo_webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS receipt_delivery_jobs (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id),
  channel TEXT NOT NULL CHECK (channel IN ('EMAIL', 'SMS')),
  recipient TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'FAILED', 'BLOCKED')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (transaction_id, channel)
);
CREATE INDEX IF NOT EXISTS receipt_jobs_ready ON receipt_delivery_jobs(status, next_attempt_at);

CREATE TRIGGER IF NOT EXISTS transactions_valid_status_transition
BEFORE UPDATE OF status ON transactions
WHEN OLD.status <> NEW.status AND NOT (
  (OLD.status = 'INITIALIZING' AND NEW.status IN ('PENDING', 'FAILED', 'CANCELLED')) OR
  (OLD.status = 'PENDING' AND NEW.status IN ('PAID', 'FAILED', 'CANCELLED', 'EXPIRED')) OR
  (OLD.status = 'CASH_ACCEPTING' AND NEW.status IN ('CHANGE_PENDING', 'PAID', 'CANCELLED', 'EXPIRED')) OR
  (OLD.status = 'CHANGE_PENDING' AND NEW.status = 'PAID')
)
BEGIN
  SELECT RAISE(ABORT, 'Invalid payment transaction status transition.');
END;

CREATE TRIGGER IF NOT EXISTS cash_ledger_events_immutable_update
BEFORE UPDATE ON cash_ledger_events
BEGIN
  SELECT RAISE(ABORT, 'Cash ledger events are immutable.');
END;
CREATE TRIGGER IF NOT EXISTS cash_ledger_events_immutable_delete
BEFORE DELETE ON cash_ledger_events
BEGIN
  SELECT RAISE(ABORT, 'Cash ledger events are immutable.');
END;

CREATE TRIGGER IF NOT EXISTS student_credit_ledger_immutable_update
BEFORE UPDATE ON student_credit_ledger
BEGIN
  SELECT RAISE(ABORT, 'Student credit ledger entries are immutable.');
END;
CREATE TRIGGER IF NOT EXISTS student_credit_ledger_immutable_delete
BEFORE DELETE ON student_credit_ledger
BEGIN
  SELECT RAISE(ABORT, 'Student credit ledger entries are immutable.');
END;

CREATE TRIGGER IF NOT EXISTS official_receipts_immutable_update
BEFORE UPDATE ON official_receipts
BEGIN
  SELECT RAISE(ABORT, 'Official receipts are immutable.');
END;
CREATE TRIGGER IF NOT EXISTS official_receipts_immutable_delete
BEFORE DELETE ON official_receipts
BEGIN
  SELECT RAISE(ABORT, 'Official receipts are immutable.');
END;

CREATE TRIGGER IF NOT EXISTS webhook_events_immutable_update
BEFORE UPDATE ON paymongo_webhook_events
BEGIN
  SELECT RAISE(ABORT, 'Webhook events are immutable.');
END;
CREATE TRIGGER IF NOT EXISTS webhook_events_immutable_delete
BEFORE DELETE ON paymongo_webhook_events
BEGIN
  SELECT RAISE(ABORT, 'Webhook events are immutable.');
END;
