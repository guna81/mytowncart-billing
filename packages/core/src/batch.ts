// SPDX-License-Identifier: Apache-2.0

/**
 * Pure domain logic for inventory batches and expiry tracking.
 */

export interface ItemBatch {
  id: number;
  itemId: number;
  batchNo: string;
  mfgDate: string | null;
  expiryDate: string; // YYYY-MM-DD
  costPricePaise: number;
  mrpPaise: number;
  stockMilli: number;
  createdAt: string;
}

/**
 * Check if a batch has expired relative to `now`.
 */
export function isBatchExpired(expiryDate: string, now: Date = new Date()): boolean {
  if (!expiryDate) return false;
  const expiry = new Date(`${expiryDate.slice(0, 10)}T23:59:59.999`);
  return now.getTime() > expiry.getTime();
}

/**
 * Check if a batch is expiring within `daysThreshold` days (default 30 days) and not already expired.
 */
export function isBatchNearExpiry(
  expiryDate: string,
  daysThreshold = 30,
  now: Date = new Date(),
): boolean {
  if (!expiryDate || isBatchExpired(expiryDate, now)) return false;
  const expiry = new Date(`${expiryDate.slice(0, 10)}T23:59:59.999`);
  const thresholdMs = daysThreshold * 24 * 60 * 60 * 1000;
  return expiry.getTime() - now.getTime() <= thresholdMs;
}

/**
 * Sort batches using FIFO (First-Expired, First-Out).
 */
export function sortBatchesFifo<T extends { expiryDate: string }>(batches: T[]): T[] {
  return [...batches].sort((a, b) => a.expiryDate.localeCompare(b.expiryDate));
}
