import * as SecureStore from "expo-secure-store";

const TOKEN = "erp.session";
const COMPANY = "erp.company";
const DEVICE = "erp.device";

/** The session token lives in the device keychain/keystore, never in plain storage. */
export const tokenStore = {
  get: () => SecureStore.getItemAsync(TOKEN),
  set: (token: string) => SecureStore.setItemAsync(TOKEN, token, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }),
  clear: () => SecureStore.deleteItemAsync(TOKEN),
  getCompany: () => SecureStore.getItemAsync(COMPANY),
  setCompany: (id: string) => SecureStore.setItemAsync(COMPANY, id),
  getDevice: () => SecureStore.getItemAsync(DEVICE),
  setDevice: (id: string) => SecureStore.setItemAsync(DEVICE, id),
};
