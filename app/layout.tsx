import type { Metadata, Viewport } from "next";
import "./globals.css";


export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
};

export const metadata: Metadata = {
  title: "Blind Ranking Games",
  description: "Blind Ranking und Fuck, Marry, Kill als Telegram Mini Apps"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="de">
      <head>
        <script src="https://telegram.org/js/telegram-web-app.js" async />
      </head>
      <body>{children}</body>
    </html>
  );
}
