import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'MSBOOST · 游戏线路控制台',
  description: '部署专属 MSBOOST 游戏节点，购买套餐并配置隧道中转。',
  icons: {
    icon: [{ url: '/maple-brand.png', type: 'image/png' }],
    apple: '/maple-brand.png',
  },
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
