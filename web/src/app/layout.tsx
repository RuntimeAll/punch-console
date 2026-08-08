import type { Metadata } from "next";

import { NavBar } from "@/components/nav-bar";

import "./globals.css";

export const metadata: Metadata = {
  title: "资料产线控制台",
  description: "六类教学资料的本地生产线 + 可检索知识库",
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // 不用 next/font/google:本地内网工具,不该在 build 时依赖外网字体
    <html lang="zh-CN" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <NavBar />
        <main className="flex-1 w-full max-w-3xl mx-auto px-3 pb-16 pt-3">{children}</main>
      </body>
    </html>
  );
}
