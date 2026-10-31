/**
 * Browser build only (testing): the token is kept for the tab's lifetime in sessionStorage.
 * Production use is the native app, which stores it in the OS keychain.
 */
const TOKEN = "erp.session";
const COMPANY = "erp.company";
const DEVICE = "erp.device";
const s = () => globalThis.sessionStorage;

export const tokenStore = {
  get: async () => s()?.getItem(TOKEN) ?? null,
  set: async (token: string) => s()?.setItem(TOKEN, token),
  clear: async () => s()?.removeItem(TOKEN),
  getCompany: async () => s()?.getItem(COMPANY) ?? null,
  setCompany: async (id: string) => s()?.setItem(COMPANY, id),
  getDevice: async () => globalThis.localStorage?.getItem(DEVICE) ?? null,
  setDevice: async (id: string) => globalThis.localStorage?.setItem(DEVICE, id),
};
