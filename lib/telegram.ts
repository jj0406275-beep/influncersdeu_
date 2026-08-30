import crypto from 'crypto';

export const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

export async function telegram(method: string, body: Record<string, unknown>) {
  if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN fehlt');
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store'
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram ${method}: ${json.description || 'Fehler'}`);
  return json.result;
}

export function validateInitData(initData: string) {
  if (!BOT_TOKEN || !initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const entries = Array.from(params.entries()).sort(([a], [b]) => a.localeCompare(b));
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const expected = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(hash, 'hex'))) return null;
  } catch { return null; }
  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Math.abs(Date.now() / 1000 - authDate) > 86400) return null;
  const userRaw = params.get('user');
  if (!userRaw) return null;
  try { return JSON.parse(userRaw) as { id: number; first_name?: string; username?: string }; }
  catch { return null; }
}
