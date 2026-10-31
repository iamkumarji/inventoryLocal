import Constants from "expo-constants";
import { Platform } from "react-native";

/**
 * Where the ERP API lives. The browser build is served from the same origin as the API (a proxy in
 * front of both), so it uses relative URLs; native builds need the server's address, set with
 * EXPO_PUBLIC_API_URL at build time or `extra.apiBaseUrl` in app.json.
 */
export function apiBaseUrl(): string {
  const configured = process.env.EXPO_PUBLIC_API_URL || (Constants.expoConfig?.extra?.apiBaseUrl as string | undefined) || "";
  if (Platform.OS === "web") return configured;
  return configured.replace(/\/$/, "");
}
