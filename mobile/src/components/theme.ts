import { useColorScheme } from "react-native";

/** Same tokens as the web app: graphite and concrete with the marking-yellow accent and ISO 3864 status colours. */
const light = {
  bg: "#EEF0F1",
  surface: "#FFFFFF",
  ink: "#1F2326",
  muted: "#5B6368",
  line: "#D3D7DA",
  accent: "#F5C400",
  accentInk: "#1F2326",
  danger: "#C8102E",
  ok: "#00843D",
  info: "#1F5FA8",
  warn: "#B36B00",
};
const dark: typeof light = {
  bg: "#16191B",
  surface: "#1F2326",
  ink: "#ECEFF1",
  muted: "#A3ABB0",
  line: "#343A3E",
  accent: "#F5C400",
  accentInk: "#1F2326",
  danger: "#FF5A6E",
  ok: "#3DBE75",
  info: "#6FA6E8",
  warn: "#F0A23B",
};

export type Palette = typeof light;
export function usePalette(): Palette {
  return useColorScheme() === "dark" ? dark : light;
}
