-- SPDX-License-Identifier: Apache-2.0
-- 0013 — the read-only online-orders cache was never shown anywhere once the
-- orders list left the MyTownCart page (stock from online orders arrives through
-- the stock feed), so the table is dropped.

DROP INDEX IF EXISTS idx_remote_orders_placed;
DROP TABLE IF EXISTS remote_orders;
