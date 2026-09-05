import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'MSBOOST · 游戏线路控制台',
  description: '自有 VPS 部署 Mieru，上传配置、选择线路、下载转发配置。',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
