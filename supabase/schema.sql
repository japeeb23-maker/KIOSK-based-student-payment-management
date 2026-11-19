CREATE TABLE IF NOT EXISTS app_state (
  state_key TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS staff_users (
  username TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('cashier', 'vp', 'registrar')),
  label TEXT NOT NULL,
  salt TEXT NOT NULL,
  password_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS student_credentials (
  student_id TEXT PRIMARY KEY,
  salt TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('student', 'cashier', 'vp', 'registrar')),
  subject_id TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);

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

CREATE INDEX IF NOT EXISTS transactions_student_created ON transactions(student_id, created_at DESC);
CREATE INDEX IF NOT EXISTS transactions_expiry ON transactions(status, expires_at);

CREATE TABLE IF NOT EXISTS transaction_items (
  id BIGSERIAL PRIMARY KEY,
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
  escpos_payload BYTEA NOT NULL,
  issued_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_sequence (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  next_number INTEGER NOT NULL CHECK (next_number > 0)
);

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

CREATE OR REPLACE FUNCTION enforce_transaction_status_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status <> NEW.status AND NOT (
    (OLD.status = 'INITIALIZING' AND NEW.status IN ('PENDING', 'FAILED', 'CANCELLED')) OR
    (OLD.status = 'PENDING' AND NEW.status IN ('PAID', 'FAILED', 'CANCELLED', 'EXPIRED')) OR
    (OLD.status = 'CASH_ACCEPTING' AND NEW.status IN ('CHANGE_PENDING', 'PAID', 'CANCELLED', 'EXPIRED')) OR
    (OLD.status = 'CHANGE_PENDING' AND NEW.status = 'PAID')
  ) THEN
    RAISE EXCEPTION 'Invalid payment transaction status transition.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS transactions_valid_status_transition ON transactions;
CREATE TRIGGER transactions_valid_status_transition
BEFORE UPDATE OF status ON transactions
FOR EACH ROW EXECUTE FUNCTION enforce_transaction_status_transition();

CREATE OR REPLACE FUNCTION prevent_payment_ledger_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable.', TG_TABLE_NAME;
END;
$$;

DROP TRIGGER IF EXISTS cash_ledger_events_immutable ON cash_ledger_events;
CREATE TRIGGER cash_ledger_events_immutable
BEFORE UPDATE OR DELETE ON cash_ledger_events
FOR EACH ROW EXECUTE FUNCTION prevent_payment_ledger_mutation();

DROP TRIGGER IF EXISTS student_credit_ledger_immutable ON student_credit_ledger;
CREATE TRIGGER student_credit_ledger_immutable
BEFORE UPDATE OR DELETE ON student_credit_ledger
FOR EACH ROW EXECUTE FUNCTION prevent_payment_ledger_mutation();

DROP TRIGGER IF EXISTS official_receipts_immutable ON official_receipts;
CREATE TRIGGER official_receipts_immutable
BEFORE UPDATE OR DELETE ON official_receipts
FOR EACH ROW EXECUTE FUNCTION prevent_payment_ledger_mutation();

DROP TRIGGER IF EXISTS webhook_events_immutable ON paymongo_webhook_events;
CREATE TRIGGER webhook_events_immutable
BEFORE UPDATE OR DELETE ON paymongo_webhook_events
FOR EACH ROW EXECUTE FUNCTION prevent_payment_ledger_mutation();

-- Lock down the Supabase Data API: only the server (table owner via DATABASE_URL) may access these tables.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['app_state', 'staff_users', 'student_credentials', 'sessions', 'transactions',
    'transaction_items', 'cash_ledger_events', 'student_credit_ledger', 'official_receipts',
    'payment_sequence', 'paymongo_webhook_events', 'receipt_delivery_jobs']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON %I FROM anon, authenticated', t);
  END LOOP;
END $$;
