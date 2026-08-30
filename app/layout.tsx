import './styles.css';

export const metadata = {
  title: 'Chat Simulation',
  description: 'Telegram Mini App für simulierte Chat-Mockups'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="de"><body>{children}</body></html>;
}
