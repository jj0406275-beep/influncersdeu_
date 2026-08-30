'use client';

import { useEffect, useMemo, useState } from 'react';

declare global { interface Window { Telegram?: { WebApp?: any } } }

type Chat = {
  id: string;
  contact_name: string;
  contact_status?: string;
  profile_photo_file_id?: string|null;
  current_side: 'me'|'other';
  theme: 'light'|'dark';
  receipt_style?: 'single'|'double'|'blue';
};
type Msg = { id: string; sender_side: 'me'|'other'; message_type: 'text'|'image'; text?: string|null; telegram_file_id?: string|null; created_at: string };

function Checks({ style }: { style?: Chat['receipt_style'] }) {
  if (style === 'single') return <span className="checks single">✓</span>;
  return <span className={`checks ${style === 'blue' ? 'blue' : ''}`}>✓✓</span>;
}

export default function ChatPage() {
  const [chat, setChat] = useState<Chat|null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const initData = useMemo(() => typeof window !== 'undefined' ? (window.Telegram?.WebApp?.initData || '') : '', []);

  async function load() {
    try {
      const id = window.Telegram?.WebApp?.initData || initData;
      const res = await fetch('/api/chat/current', { headers: { 'x-telegram-init-data': id }, cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Fehler');
      setChat(data.chat); setMessages(data.messages || []); setError('');
    } catch (e) { setError(e instanceof Error ? e.message : 'Fehler'); }
  }

  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    tg?.ready?.(); tg?.expand?.();
    setReady(true);
    load();
    const t = setInterval(load, 1800);
    return () => clearInterval(t);
  }, []);

  const photoUrl = chat?.profile_photo_file_id ? `/api/media/telegram?fileId=${encodeURIComponent(chat.profile_photo_file_id)}` : '';

  return (
    <main className={`wa-page ${chat?.theme === 'dark' ? 'dark' : ''}`}>
      <section className="wa-phone">
        <header className="wa-header">
          <div className="wa-back" aria-hidden="true">‹</div>
          <div className="wa-avatar">
            {photoUrl ? <img src={photoUrl} alt="Profilbild" /> : <span>{(chat?.contact_name || 'K').slice(0,1).toUpperCase()}</span>}
          </div>
          <div className="wa-contact">
            <strong>{chat?.contact_name || 'Kontakt'}</strong>
            <span>{chat?.contact_status || 'online'}</span>
          </div>
          <div className="wa-actions" aria-hidden="true">
            <span className="video-icon">▭</span>
            <span className="phone-icon">⌕</span>
            <span className="dots">⋮</span>
          </div>
        </header>

        <div className="wa-wallpaper" aria-live="polite">
          <div className="date-pill">Heute</div>
          {!ready && <div className="notice-pill">Chat wird geladen …</div>}
          {error && <div className="notice-pill error">{error}</div>}
          {!error && messages.length === 0 && <div className="notice-pill">Noch keine Nachrichten</div>}
          {messages.map((m, index) => {
            const prev = messages[index - 1];
            const next = messages[index + 1];
            const groupedBefore = !!prev && prev.sender_side === m.sender_side;
            const groupedAfter = !!next && next.sender_side === m.sender_side;
            return (
              <div key={m.id} className={`wa-row ${m.sender_side === 'me' ? 'mine' : 'theirs'} ${groupedBefore ? 'grouped-before' : ''} ${groupedAfter ? 'grouped-after' : ''}`}>
                <div className={`wa-bubble ${m.message_type === 'image' ? 'has-image' : ''}`}>
                  {m.message_type === 'image' && m.telegram_file_id && (
                    <img className="chat-image" src={`/api/media/telegram?fileId=${encodeURIComponent(m.telegram_file_id)}`} alt="Bildnachricht" />
                  )}
                  {m.text && <div className="wa-text">{m.text}</div>}
                  <div className="wa-meta">
                    <span>{new Date(m.created_at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</span>
                    {m.sender_side === 'me' && <Checks style={chat?.receipt_style || 'blue'} />}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="wa-composer" aria-hidden="true">
          <div className="composer-box"><span className="smile">◡</span><span className="placeholder">Nachricht</span><span className="paperclip">⌇</span><span className="camera">▣</span></div>
          <div className="mic">●</div>
        </div>
      </section>
      <div className="sim-note">Chat-Simulation</div>
    </main>
  );
}
