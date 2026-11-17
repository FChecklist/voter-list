-- Voter List: the price slot follows the Games pattern. Every payment goes through the central payment service of
-- IT SERVICES BY RAJAT AGARWAL (Razorpay, one ledger). This site never talks to Razorpay itself and holds no Razorpay key.
-- An order may now be a real one (test = 0) opened by the central service; its Razorpay order id, the public checkout key id
-- and the payment id are kept so a payment can be matched to exactly this order. Nothing is charged until the owner sets
-- PRICE_INR, PAY_SERVICE_KEY and PAY_SITE and the site is registered in the central ledger.
PRAGMA foreign_keys = ON;

CREATE TABLE orders_new (
  id             TEXT PRIMARY KEY,
  society_id     TEXT NOT NULL REFERENCES societies(id),
  purpose        TEXT NOT NULL CHECK (purpose IN ('save_version_1')),
  amount_paise   INTEGER NOT NULL CHECK (amount_paise > 0),
  currency       TEXT NOT NULL DEFAULT 'INR',
  status         TEXT NOT NULL CHECK (status IN ('created','paid')),
  test           INTEGER NOT NULL DEFAULT 1 CHECK (test IN (0,1)),
  created_by     TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  paid_at        INTEGER,
  used_for_version TEXT,
  rzp_order_id   TEXT,
  rzp_key_id     TEXT,
  rzp_payment_id TEXT,
  CHECK (test = 1 OR status = 'created' OR (rzp_payment_id IS NOT NULL AND rzp_order_id IS NOT NULL))
);
INSERT INTO orders_new (id, society_id, purpose, amount_paise, currency, status, test, created_by, created_at, paid_at, used_for_version)
  SELECT id, society_id, purpose, amount_paise, currency, status, test, created_by, created_at, paid_at, used_for_version FROM orders;
DROP TABLE orders;
ALTER TABLE orders_new RENAME TO orders;
CREATE UNIQUE INDEX uq_order_open ON orders(society_id, purpose) WHERE used_for_version IS NULL;
CREATE UNIQUE INDEX uq_order_rzp ON orders(rzp_order_id) WHERE rzp_order_id IS NOT NULL;
