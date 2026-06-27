import type { Metadata } from "next";
import { Noto_Sans_Mono } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";

const notoSansMono = Noto_Sans_Mono({
  subsets: ["latin", "cyrillic"],
  variable: "--font-noto-mono",
  display: "swap",
});

// LXGW WenKai — vendored in lib/fonts/, see lib/fonts/README.md
const wenkaiSans = localFont({
  src: "../lib/fonts/wenkai-regular.woff2",
  variable: "--font-wenkai-sans",
  display: "swap",
  weight: "400",
  style: "normal",
});

export const metadata: Metadata = {
  title: "Pi Work",
  description: "Pi Coding Agent Web Interface",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${notoSansMono.variable} ${wenkaiSans.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("pi-theme")||"default";document.documentElement.classList.add("theme-"+t)}catch(e){}})();`,
          }}
        />
      </head>
      <body style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
        {children}
      </body>
    </html>
  );
}
