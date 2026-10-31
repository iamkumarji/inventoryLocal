import { mkdirSync } from "node:fs";

import { expect, type Page, test } from "@playwright/test";

const PASSWORD = "Demo-Passw0rd-2026!";
const SHOTS = "test-results/screens";
// 1×1 PNG: the documents service checks real file signatures.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    // Refused requests are logged by the browser as failed loads; those are expected in this suite.
    if (m.type() === "error" && !/Failed to load resource|ERR_INTERNET_DISCONNECTED|net::ERR_FAILED/.test(m.text())) errors.push(m.text());
  });
  return errors;
}

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByTestId("email").fill(email);
  await page.getByTestId("password").fill(PASSWORD);
  await page.getByTestId("sign-in").click();
  await expect(page.getByTestId("sign-out")).toBeVisible();
}

/** Calls the API as the signed-in user (token from the app's session storage). */
async function apiGet<T>(page: Page, path: string): Promise<T> {
  return page.evaluate(async (p) => {
    const token = sessionStorage.getItem("erp.session");
    const r = await fetch(p, { headers: { Authorization: `Bearer ${token}` } });
    return r.json();
  }, path) as Promise<T>;
}

/** Opens the outbox and presses "Send now" (after each backoff) until nothing is waiting. */
async function outboxSettles(page: Page) {
  await page.goto("/queue");
  for (let i = 0; i < 12; i++) {
    if ((await page.getByTestId("job-pending").count()) + (await page.getByTestId("job-running").count()) === 0) return;
    await page.waitForTimeout(2_500);
    const send = page.getByTestId("send-now");
    if (await send.isVisible()) await send.click();
  }
  await expect(page.getByTestId("job-pending")).toHaveCount(0);
}

test.describe.configure({ mode: "serial" });

test("storekeeper: lookup, receipt survives a lost response, refusal is shown, count and transfer", async ({ page, context }) => {
  const errors = watchConsole(page);
  await signIn(page, "sunil.stores@demo.local");
  for (const tile of ["lookup", "receive", "count", "transfers", "expense", "approvals"]) await expect(page.getByTestId(`tile-${tile}`)).toBeVisible();
  await expect(page.getByTestId("tile-deliveries")).toHaveCount(0); // not a driver
  await shot(page, "01-home");
  await noHorizontalScroll(page);

  // Lookup by barcode
  await page.getByTestId("tile-lookup").click();
  await page.getByTestId("lookup-code").fill("8901234567890");
  await page.getByTestId("lookup-code-find").click();
  await expect(page.getByText("CRC-SHEET")).toBeVisible();
  await expect(page.getByTestId("stock-PUN-RM")).toContainText("250");
  await shot(page, "02-lookup");

  // Goods receipt whose first response is lost: the server creates the GRN, the phone never hears back.
  let dropped = false;
  await page.route("**/api/v1/procurement/receipts/", async (route) => {
    if (!dropped && route.request().method() === "POST") {
      dropped = true;
      await route.fetch(); // reaches Django
      await route.abort("connectionreset"); // the response is lost on the way back
      return;
    }
    await route.continue();
  });
  await page.goto("/receive");
  await page.getByText(/PO\/.*Kolhapur Steels/).click();
  await page.getByTestId("qty-CRC-SHEET").fill("100");
  await page.getByTestId("delivery-note").fill("KS/DN/7781");
  await shot(page, "03-receipt");
  await page.getByTestId("save-receipt").click();
  await expect(page.getByTestId("job-pending")).toBeVisible();
  await expect(page.getByText(/Waiting for a connection/)).toBeVisible();
  await shot(page, "04-outbox-waiting");
  await page.unroute("**/api/v1/procurement/receipts/");
  await page.waitForTimeout(2_500); // first backoff
  await page.getByTestId("send-now").click();
  await expect(page.getByTestId("job-done")).toBeVisible({ timeout: 15_000 });
  const receipts = await apiGet<{ count: number; results: { status: string }[] }>(page, "/api/v1/procurement/receipts/");
  expect(receipts.count).toBe(1); // replayed with the same Idempotency-Key, not created twice
  expect(receipts.results[0].status).toBe("posted");
  await page.goto("/lookup");
  await page.getByTestId("lookup-code").fill("8901234567890");
  await page.getByTestId("lookup-code-find").click();
  await expect(page.getByTestId("stock-PUN-RM")).toContainText("350");

  // Over-receipt: the server refuses; the outbox shows its reason and nothing is posted.
  await page.goto("/receive");
  await page.getByText(/PO\/.*Kolhapur Steels/).click();
  await page.getByTestId("qty-CRC-SHEET").fill("900");
  await page.getByTestId("save-receipt").click();
  await expect(page.getByTestId("job-failed")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("job-failed")).toContainText(/exceed|tolerance|more than/i);
  await expect(page.getByTestId("queue-badge").filter({ visible: true })).toContainText("1 need attention");
  await shot(page, "05-outbox-refused");
  expect((await apiGet<{ count: number }>(page, "/api/v1/procurement/receipts/")).count).toBe(1);
  await page.getByText("Discard").click();
  await expect(page.getByTestId("job-failed")).toHaveCount(0);

  // Blind count entry made offline, sent when the connection returns.
  await page.goto("/count");
  await page.getByText(/^CNT\//).first().click();
  await expect(page.getByText(/System:/)).toHaveCount(0); // blind: counters don't see system quantity
  await page.getByTestId("count-BOLT-M8").fill("395");
  await context.setOffline(true);
  await page.getByTestId("save-count").click();
  await expect(page.getByTestId("job-pending")).toBeVisible();
  await context.setOffline(false);
  await page.waitForTimeout(2_500);
  await page.getByTestId("send-now").click();
  await expect(page.getByTestId("job-pending")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId("job-failed")).toHaveCount(0);
  const counts = await apiGet<{ results: { lines: { item_code: string; counted_quantity: string }[] }[] }>(page, "/api/v1/inventory/counts/");
  expect(Number(counts.results[0].lines[0].counted_quantity)).toBe(395);

  // Incoming transfer
  await page.goto("/transfers");
  await page.getByTestId(/^receive-/).first().click();
  await outboxSettles(page);
  const transfers = await apiGet<{ results: { status: string }[] }>(page, "/api/v1/inventory/transfers/");
  expect(transfers.results[0].status).toBe("received");
  await shot(page, "06-outbox-sent");
  expect(errors).toEqual([]);
});

test("employee: expense with a receipt photo is created and submitted", async ({ page }) => {
  const errors = watchConsole(page);
  await signIn(page, "sunil.stores@demo.local");
  await page.goto("/expense");
  await page.getByTestId("category-TRAVEL").click();
  await page.getByTestId("purpose").fill("Supplier visit, Kolhapur");
  await page.getByTestId("description").fill("Auto fare and parking");
  await page.getByTestId("amount").fill("650.00");
  await expect(page.getByText("Receipt photo (required for this amount)")).toBeVisible();
  await expect(page.getByTestId("save-expense")).toBeDisabled();
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("receipt").click();
  await (await chooser).setFiles({ name: "receipt.png", mimeType: "image/png", buffer: PNG });
  await shot(page, "07-expense");
  await page.getByTestId("save-expense").click();
  await outboxSettles(page);
  const claims = await apiGet<{ status: string; amount: string; lines: { receipt_reference: string }[] }[]>(page, "/api/v1/expenses/my/claims/");
  expect(claims).toHaveLength(1);
  expect(claims[0].status).toBe("submitted");
  expect(claims[0].lines[0].receipt_reference).toMatch(/[0-9a-f-]{36}/);
  expect(errors).toEqual([]);
});

test("driver: proof of delivery with signed-note photo and location", async ({ page }) => {
  const errors = watchConsole(page);
  await signIn(page, "dinesh.driver@demo.local");
  await page.getByTestId("tile-deliveries").click();
  await page.getByText(/^SHP\//).click();
  await page.getByTestId("delivery-1").click();
  await page.getByTestId("received-by").fill("Anita (reception)");
  await expect(page.getByTestId("save-proof")).toBeDisabled(); // a completed delivery needs the signed note
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("signed-note").click();
  await (await chooser).setFiles({ name: "note.png", mimeType: "image/png", buffer: PNG });
  await shot(page, "08-proof");
  await noHorizontalScroll(page);
  await page.getByTestId("save-proof").click();
  await outboxSettles(page);
  const shipments = await apiGet<{ results: { status: string; proofs: { latitude: string; signature_document_id: string }[] }[] }>(
    page,
    "/api/v1/logistics/shipments/",
  );
  expect(shipments.results[0].status).toBe("delivered");
  expect(shipments.results[0].proofs[0].signature_document_id).toBeTruthy();
  expect(Number(shipments.results[0].proofs[0].latitude)).toBeCloseTo(18.5204, 3);
  expect(errors).toEqual([]);
});

test("approver: decides a request from the inbox", async ({ page }) => {
  const errors = watchConsole(page);
  await signIn(page, "rahul.supervisor@demo.local");
  await page.getByTestId("tile-approvals").click();
  const first = page.getByTestId(/^request-/).first();
  await expect(first).toBeVisible();
  const before = (await apiGet<unknown[]>(page, "/api/v1/approvals/inbox/")).length;
  await first.click();
  await expect(page.getByTestId("reject")).toBeDisabled(); // a rejection needs a reason
  await shot(page, "09-approvals");
  await page.getByTestId("approve").click();
  await outboxSettles(page);
  await expect(page.getByTestId("job-done")).toBeVisible();
  const after = (await apiGet<unknown[]>(page, "/api/v1/approvals/inbox/")).length;
  expect(after).toBeLessThan(before);
  expect(errors).toEqual([]);
});
