import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "PerformanceLabs",
  description: "Plataforma de ingenieria sismica basada en OpenSees",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="es"
      className={`${inter.variable} ${jetbrainsMono.variable} h-full antialiased`}
    >
      {/* Aplica el tema almacenado antes del primer render para evitar flash */}
      <head>
        <script dangerouslySetInnerHTML={{ __html: `
          try {
            var t = localStorage.getItem('pl-theme');
            if (t === 'dark' || (!t && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
              document.documentElement.setAttribute('data-theme', 'dark');
            }
          } catch {}
        `}} />
      </head>
      <body className="min-h-full flex flex-col bg-bg text-text">{children}</body>
    </html>
  );
}
