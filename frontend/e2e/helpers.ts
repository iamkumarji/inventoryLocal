import { createHmac } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { expect, type Page } from "@playwright/test";

export const SHOTS = process.env.E2E_SCREENSHOTS ?? "test-results/screens";
// Outside Playwright's outputDir, which is wiped at the start of every run.
const STATE = path.join(process.env.E2E_STATE_DIR ?? path.join(__dirname, ".state"), "admin.json");
export const DEMO_PASSWORD = "Demo-Passw0rd-2026!";

function base32(secret: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of secret.replace(/\s|=/g, "").toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits) — what authenticator apps compute. */
export function totp(secret: string, offsetSteps = 0): string {
  const counter = Math.floor(Date.now() / 30_000) + offsetSteps;
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", base32(secret)).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, "0");
}

export const currentStep = () => Math.floor(Date.now() / 30_000);

export function saveAdmin(state: { secret: string; password: string; lastStep: number }) {
  mkdirSync(path.dirname(STATE), { recursive: true });
  writeFileSync(STATE, JSON.stringify(state));
}

export function loadAdmin(): { secret: string; password: string; lastStep: number } {
  return JSON.parse(readFileSync(STATE, "utf8"));
}

export async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(350); // let open/close animations settle so the capture shows the final state
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

/** No horizontal page scroll at the current viewport (layout must fit mobile widths). */
export async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, `page is ${overflow}px wider than the viewport`).toBeLessThanOrEqual(0);
}

/** Fails the test on console errors or unhandled exceptions (ignores expected 401/403 network logs). */
export function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    if (/status of 40[13]|WebSocket connection/.test(text)) return;
    errors.push(text);
  });
  return () => expect(errors, errors.join("\n")).toEqual([]);
}

let lastUsedStep = 0;

export async function signIn(page: Page, email: string, password: string, secret?: string, usedStep = 0) {
  lastUsedStep = Math.max(lastUsedStep, usedStep);
  await page.goto("/login");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  if (secret) {
    await expect(page.getByRole("heading", { name: "Two-step verification" })).toBeVisible();
    // The server rejects a code from a time step that was already used (replay protection),
    // so wait for the next step, as a person would wait for their app to show a new code.
    while (currentStep() <= lastUsedStep) await page.waitForTimeout(1000);
    lastUsedStep = currentStep();
    await page.getByLabel("Verification code").pressSequentially(totp(secret));
  }
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
}
