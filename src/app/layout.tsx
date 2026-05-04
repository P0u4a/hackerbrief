import type { Metadata, Viewport } from "next";
import { Lora, Geist_Mono } from "next/font/google";
import "./globals.css";
import { SwRegister } from "@/components/sw-register";

const primaryFont = Lora({
  variable: "--font-primary",
  subsets: ["latin"],
});

const primaryMonoFont = Geist_Mono({
  variable: "--font-primary-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Hackerbrief",
  description: "Daily Hacker News front-page digest",
  manifest: "/manifest.webmanifest",
  applicationName: "Hackerbrief",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Hackerbrief",
  },
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
    shortcut: "/icon.svg",
    apple: "/icon.svg",
  },
};

export const viewport: Viewport = {
  themeColor: "#F97316",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${primaryFont.variable} ${primaryMonoFont.variable} antialiased`}
      >
        <SwRegister />
        {children}
      </body>
    </html>
  );
}
