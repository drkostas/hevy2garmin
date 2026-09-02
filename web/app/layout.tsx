import type { Metadata, Viewport } from "next";
import { NavBar } from "@/components/nav-bar";
import { authEnabled } from "@/lib/auth";
import "./globals.css";

export const metadata: Metadata = {
  title: "hevy2garmin",
  description: "Sync your Hevy workouts to Garmin Connect",
};

export const viewport: Viewport = {
  themeColor: "#0A1720",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="bg-base text-text min-h-screen antialiased">
        <NavBar authEnabled={authEnabled()} />
        <div className="pb-20 md:pb-0">{children}</div>
      </body>
    </html>
  );
}
