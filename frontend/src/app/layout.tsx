import type { Metadata, Viewport } from "next";
import { Archivo } from "next/font/google";

import { Providers } from "@/components/providers";

import "./globals.css";

const archivo = Archivo({ subsets: ["latin"], axes: ["wdth"], variable: "--font-archivo", display: "swap" });

export const metadata: Metadata = {
  title: { default: "OtabuPro ERP", template: "%s | OtabuPro ERP" },
  description: "Manufacturing ERP",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#20262b" },
    { media: "(prefers-color-scheme: dark)", color: "#11161a" },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-IN" className={archivo.variable} suppressHydrationWarning>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
