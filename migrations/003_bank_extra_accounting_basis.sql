-- Bank rows carry fields with no column of their own (which account they belong
-- to, where a row was posted on the balance sheet, whether it is a transfer).
-- Like invoices and expenses in 002, they ride in a JSONB column instead of
-- being dropped on save.
ALTER TABLE bank_txns ADD COLUMN extra JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Cash vs accrual accounting, chosen per business. NULL means "not chosen yet":
-- every business that existed before this column keeps the calculations it has
-- always had until its owner picks one.
ALTER TABLE businesses ADD COLUMN accounting_basis TEXT
  CHECK (accounting_basis IN ('cash', 'accrual'));
