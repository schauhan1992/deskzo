import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { getBranding } from "@/actions/branding";
import { brandingCss } from "@/lib/branding";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export async function generateMetadata(): Promise<Metadata> {
  const branding = await getBranding();
  return {
    title: branding.appName,
    description: branding.tagline ?? "Internal ERP — CRM, inventory, and the modules that follow.",
    icons: branding.faviconDataUrl ? { icon: branding.faviconDataUrl } : undefined,
  };
}

/**
 * Applies the saved theme before first paint. Without this the page renders light and then flips,
 * which is far more jarring than a fraction of a second of nothing.
 */
const themeScript = `(function(){try{var s=localStorage.getItem("theme");var d=document.documentElement.dataset.defaultTheme;var t=s||d||"system";var dark=t==="dark"||(t==="system"&&window.matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",dark);}catch(e){}})();`;

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const branding = await getBranding();

  return (
    <html
      lang="en"
      data-default-theme={branding.defaultTheme}
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <style dangerouslySetInnerHTML={{ __html: brandingCss(branding) }} />
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="flex min-h-full flex-col bg-bg text-text">{children}</body>
    </html>
  );
}
