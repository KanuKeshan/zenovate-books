-- The front end attaches fields the relational columns do not model (bank-import
-- fingerprints, an invoice's client email, line items, payment details). Until
-- now the snapshot save silently dropped them. They ride in a JSONB column,
-- the same way deferred features ride in businesses.extras.
ALTER TABLE invoices ADD COLUMN extra JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE expenses ADD COLUMN extra JSONB NOT NULL DEFAULT '{}'::jsonb;
