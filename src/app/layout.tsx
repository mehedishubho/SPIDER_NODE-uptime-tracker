import type { Metadata } from "next";
import "./globals.css";
import { Suspense } from "react";
import ReduxProvider from "@/redux/Provider";
import Loading from "@/components/Others/Loader/Loading";
import { ThemeProvider } from "@/components/theme/ThemeProvider";
import { ThemedToaster } from "@/components/theme/ThemedToaster";
import {
  inter,
  spaceGrotesk,
} from "@/fonts/Fonts";

export const metadata: Metadata = {
  title: "SpiderNode | Real-Time Uptime & Infrastructure Monitoring",
  description: "Developer-centric, real-time uptime monitoring for websites, APIs, and microservices.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${inter.variable} ${spaceGrotesk.variable} antialiased bg-background text-foreground min-h-screen`}
      >
        <ThemeProvider>
          <Suspense fallback={<Loading />}>
            <ReduxProvider>
              {children}
              <ThemedToaster />
            </ReduxProvider>
          </Suspense>
        </ThemeProvider>
      </body>
    </html>
  );
}
