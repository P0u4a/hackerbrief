import type { Metadata } from "next";
import { Newsreader, Geist_Mono } from "next/font/google";
import "./globals.css";

const primaryFont = Newsreader({
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
        {children}
      </body>
    </html>
  );
}
