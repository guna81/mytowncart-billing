-- Older versions saved the cash handed over, not the cash kept, so a bill paid
-- with a Rs 500 note for Rs 380 stored Rs 500 of cash. That inflated the
-- sales-by-payment-mode report. Take the change back off the last cash payment
-- of every bill whose payments add up to more than its total. Bills paid exactly
-- are untouched. (The runner copies the database to backups-local first.)
UPDATE payments
SET amount_paise = amount_paise - MIN(
  amount_paise,
  (SELECT SUM(p2.amount_paise) FROM payments p2 WHERE p2.bill_id = payments.bill_id)
    - (SELECT b.total_paise FROM bills b WHERE b.id = payments.bill_id)
)
WHERE mode = 'cash'
  AND id = (SELECT MAX(p3.id) FROM payments p3
            WHERE p3.bill_id = payments.bill_id AND p3.mode = 'cash' AND p3.amount_paise > 0)
  AND (SELECT SUM(p2.amount_paise) FROM payments p2 WHERE p2.bill_id = payments.bill_id)
        > (SELECT b.total_paise FROM bills b WHERE b.id = payments.bill_id);
UPDATE payments
SET amount_paise = amount_paise - MIN(
  amount_paise,
  (SELECT SUM(p2.amount_paise) FROM payments p2 WHERE p2.bill_id = payments.bill_id)
    - (SELECT b.total_paise FROM bills b WHERE b.id = payments.bill_id)
)
WHERE mode = 'cash'
  AND id = (SELECT MAX(p3.id) FROM payments p3
            WHERE p3.bill_id = payments.bill_id AND p3.mode = 'cash' AND p3.amount_paise > 0)
  AND (SELECT SUM(p2.amount_paise) FROM payments p2 WHERE p2.bill_id = payments.bill_id)
        > (SELECT b.total_paise FROM bills b WHERE b.id = payments.bill_id);
UPDATE payments
SET amount_paise = amount_paise - MIN(
  amount_paise,
  (SELECT SUM(p2.amount_paise) FROM payments p2 WHERE p2.bill_id = payments.bill_id)
    - (SELECT b.total_paise FROM bills b WHERE b.id = payments.bill_id)
)
WHERE mode = 'cash'
  AND id = (SELECT MAX(p3.id) FROM payments p3
            WHERE p3.bill_id = payments.bill_id AND p3.mode = 'cash' AND p3.amount_paise > 0)
  AND (SELECT SUM(p2.amount_paise) FROM payments p2 WHERE p2.bill_id = payments.bill_id)
        > (SELECT b.total_paise FROM bills b WHERE b.id = payments.bill_id);
DELETE FROM payments WHERE mode = 'cash' AND amount_paise = 0;
