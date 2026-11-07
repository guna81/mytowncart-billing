// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { MemoryRepository } from "../src/memory";
import { seedDemoData } from "../src/seed";

describe("seedDemoData", () => {
  it("seeds realistic demo data into MemoryRepository", async () => {
    const repo = new MemoryRepository();
    const anchor = new Date("2026-11-07T12:00:00+05:30");

    const summary = await seedDemoData(repo, { dateAnchor: anchor });

    expect(summary.categoriesCount).toBeGreaterThan(0);
    expect(summary.itemsCount).toBeGreaterThan(15);
    expect(summary.customersCount).toBeGreaterThan(0);
    expect(summary.suppliersCount).toBeGreaterThan(0);
    expect(summary.purchasesCount).toBeGreaterThan(0);
    expect(summary.billsCount).toBeGreaterThan(5);
    expect(summary.usersCount).toBeGreaterThan(0);

    const profile = await repo.getShopProfile();
    expect(profile?.name).toBe("GKS Mobiles and Computer");

    const items = await repo.listItems();
    expect(items.length).toBe(summary.itemsCount);

    const customers = await repo.listCustomers();
    expect(customers.length).toBe(summary.customersCount);

    const bills = await repo.listBills();
    expect(bills.length).toBe(summary.billsCount);

    const held = await repo.listHeldBills();
    expect(held.length).toBe(1);

    const users = await repo.listUsers();
    expect(users.length).toBe(2);
  });
});
