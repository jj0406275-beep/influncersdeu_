import { NextRequest, NextResponse } from 'next/server';
import { db } from '../../../../../lib/supabase';
import { telegram } from '../../../../../lib/telegram';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || '';
const OWNER_ID = Number(process.env.ADMIN_TELEGRAM_USER_ID || 0);

type TgMessage = {
  message_id: number;
  chat: { id: number; type: string };
  from?: { id: number };
  text?: string;
  caption?: string;
  photo?: Array<{ file_id: string; width: number; height: number }>;
};

type TgCallback = {
  id: string;
  from: { id: number };
  message?: TgMessage;
  data?: string;
};

function mainKb() {
  return {
    inline_keyboard: [
      [
        { text: '⬅️ Andere Person', callback_data: 'side:other' },
        { text: '➡️ Ich', callback_data: 'side:me' }
      ],
      [{ text: '📱 Chat öffnen', web_app: { url: `${APP_URL}/chat` } }],
      [{ text: '⚙️ Chat einstellen', callback_data: 'settings' }],
      [
        { text: '🗑 Letzte Nachricht', callback_data: 'delete:last' },
        { text: '🆕 Neuer Chat', callback_data: 'chat:new' }
      ]
    ]
  };
}

function settingsKb() {
  return {
    inline_keyboard: [
      [{ text: '✏️ Kontaktname', callback_data: 'settings:name' }, { text: '🖼 Profilbild', callback_data: 'settings:photo' }],
      [{ text: '🟢 Status', callback_data: 'settings:status' }],
      [{ text: '☀️ Light', callback_data: 'theme:light' }, { text: '🌙 Dark', callback_data: 'theme:dark' }],
      [{ text: '✓ Haken', callback_data: 'receipts' }],
      [{ text: '⬅️ Zurück', callback_data: 'menu' }]
    ]
  };
}

function receiptsKb() {
  return {
    inline_keyboard: [
      [{ text: '✓ Gesendet', callback_data: 'receipt:single' }],
      [{ text: '✓✓ Zugestellt', callback_data: 'receipt:double' }],
      [{ text: '✓✓ Blau gelesen', callback_data: 'receipt:blue' }],
      [{ text: '⬅️ Zurück', callback_data: 'settings' }]
    ]
  };
}

async function activeChat(ownerId: number) {
  const supabase = db();
  const { data, error } = await supabase.from('chat_drafts').select('*')
    .eq('owner_telegram_id', ownerId).eq('is_active', true)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return data;
}

async function createChat(ownerId: number) {
  const supabase = db();
  await supabase.from('chat_drafts').update({ is_active: false }).eq('owner_telegram_id', ownerId);
  const { data, error } = await supabase.from('chat_drafts').insert({
    owner_telegram_id: ownerId,
    contact_name: 'Kontakt',
    contact_status: 'online',
    current_side: 'other',
    theme: 'light',
    receipt_style: 'blue',
    admin_state: null,
    is_active: true
  }).select('*').single();
  if (error) throw error;
  return data;
}

async function ensureChat(ownerId: number) {
  return (await activeChat(ownerId)) || createChat(ownerId);
}

async function sendMain(chatId: number, draft: any) {
  await telegram('sendMessage', {
    chat_id: chatId,
    text: `💬 Chat-Simulator\n\nAktueller Absender: ${draft.current_side === 'me' ? '➡️ Ich' : '⬅️ Andere Person'}\nKontakt: ${draft.contact_name || 'Kontakt'}\n\nWähle den Absender und sende danach Text oder ein Bild.`,
    reply_markup: mainKb()
  });
}

export async function POST(req: NextRequest) {
  try {
    const secret = process.env.WEBHOOK_SECRET || '';
    if (secret && req.headers.get('x-telegram-bot-api-secret-token') !== secret) {
      return NextResponse.json({ ok: false }, { status: 401 });
    }

    const update = await req.json();
    const callback = update.callback_query as TgCallback | undefined;
    const message = update.message as TgMessage | undefined;

    if (callback) {
      if (OWNER_ID && callback.from.id !== OWNER_ID) return NextResponse.json({ ok: true });
      const chatId = callback.message?.chat.id;
      if (!chatId) return NextResponse.json({ ok: true });
      let draft = await ensureChat(callback.from.id);
      const supabase = db();
      const data = callback.data || '';

      if (data === 'side:other' || data === 'side:me') {
        const side = data.endsWith('me') ? 'me' : 'other';
        await supabase.from('chat_drafts').update({ current_side: side, admin_state: null }).eq('id', draft.id);
        await telegram('answerCallbackQuery', { callback_query_id: callback.id, text: side === 'me' ? 'Absender: Ich' : 'Absender: Andere Person' });
        draft = { ...draft, current_side: side };
        await sendMain(chatId, draft);
      } else if (data === 'delete:last') {
        const { data: last } = await supabase.from('chat_messages').select('id').eq('chat_id', draft.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
        if (last) await supabase.from('chat_messages').delete().eq('id', last.id);
        await telegram('answerCallbackQuery', { callback_query_id: callback.id, text: last ? 'Letzte Nachricht gelöscht' : 'Noch keine Nachricht' });
      } else if (data === 'chat:new') {
        draft = await createChat(callback.from.id);
        await telegram('answerCallbackQuery', { callback_query_id: callback.id, text: 'Neuer Chat erstellt' });
        await sendMain(chatId, draft);
      } else if (data === 'settings') {
        await supabase.from('chat_drafts').update({ admin_state: null }).eq('id', draft.id);
        await telegram('answerCallbackQuery', { callback_query_id: callback.id });
        await telegram('sendMessage', { chat_id: chatId, text: '⚙️ Chat einstellen', reply_markup: settingsKb() });
      } else if (data === 'menu') {
        await supabase.from('chat_drafts').update({ admin_state: null }).eq('id', draft.id);
        await telegram('answerCallbackQuery', { callback_query_id: callback.id });
        await sendMain(chatId, draft);
      } else if (data === 'settings:name') {
        await supabase.from('chat_drafts').update({ admin_state: 'await_name' }).eq('id', draft.id);
        await telegram('answerCallbackQuery', { callback_query_id: callback.id });
        await telegram('sendMessage', { chat_id: chatId, text: '✏️ Schicke mir jetzt den Kontaktname als normale Textnachricht.' });
      } else if (data === 'settings:status') {
        await supabase.from('chat_drafts').update({ admin_state: 'await_status' }).eq('id', draft.id);
        await telegram('answerCallbackQuery', { callback_query_id: callback.id });
        await telegram('sendMessage', { chat_id: chatId, text: '🟢 Schicke mir jetzt den Status, z. B. „online“, „tippt …“ oder „zuletzt online heute um 20:14“.' });
      } else if (data === 'settings:photo') {
        await supabase.from('chat_drafts').update({ admin_state: 'await_photo' }).eq('id', draft.id);
        await telegram('answerCallbackQuery', { callback_query_id: callback.id });
        await telegram('sendMessage', { chat_id: chatId, text: '🖼 Schicke mir jetzt das gewünschte Profilbild als Foto.' });
      } else if (data === 'theme:light' || data === 'theme:dark') {
        const theme = data.endsWith('dark') ? 'dark' : 'light';
        await supabase.from('chat_drafts').update({ theme, admin_state: null }).eq('id', draft.id);
        await telegram('answerCallbackQuery', { callback_query_id: callback.id, text: theme === 'dark' ? 'Dark Mode' : 'Light Mode' });
      } else if (data === 'receipts') {
        await telegram('answerCallbackQuery', { callback_query_id: callback.id });
        await telegram('sendMessage', { chat_id: chatId, text: '✓ Welche Haken sollen bei deinen Nachrichten erscheinen?', reply_markup: receiptsKb() });
      } else if (data.startsWith('receipt:')) {
        const style = data.split(':')[1];
        if (['single','double','blue'].includes(style)) {
          await supabase.from('chat_drafts').update({ receipt_style: style, admin_state: null }).eq('id', draft.id);
          await telegram('answerCallbackQuery', { callback_query_id: callback.id, text: 'Haken geändert' });
        }
      }
      return NextResponse.json({ ok: true });
    }

    if (!message?.from || message.chat.type !== 'private') return NextResponse.json({ ok: true });
    if (OWNER_ID && message.from.id !== OWNER_ID) return NextResponse.json({ ok: true });

    const ownerId = message.from.id;
    const chatId = message.chat.id;

    if (message.text === '/start' || message.text === '/menu') {
      const draft = await ensureChat(ownerId);
      await sendMain(chatId, draft);
      return NextResponse.json({ ok: true });
    }

    const draft = await ensureChat(ownerId);
    const supabase = db();

    if (draft.admin_state === 'await_name' && message.text && !message.text.startsWith('/')) {
      const name = message.text.trim().slice(0, 80) || 'Kontakt';
      await supabase.from('chat_drafts').update({ contact_name: name, admin_state: null }).eq('id', draft.id);
      await telegram('sendMessage', { chat_id: chatId, text: `✅ Kontaktname geändert zu „${name}“.`, reply_markup: settingsKb() });
      return NextResponse.json({ ok: true });
    }

    if (draft.admin_state === 'await_status' && message.text && !message.text.startsWith('/')) {
      const status = message.text.trim().slice(0, 120) || 'online';
      await supabase.from('chat_drafts').update({ contact_status: status, admin_state: null }).eq('id', draft.id);
      await telegram('sendMessage', { chat_id: chatId, text: `✅ Status geändert zu „${status}“.`, reply_markup: settingsKb() });
      return NextResponse.json({ ok: true });
    }

    if (draft.admin_state === 'await_photo') {
      if (message.photo?.length) {
        const photo = message.photo[message.photo.length - 1];
        await supabase.from('chat_drafts').update({ profile_photo_file_id: photo.file_id, admin_state: null }).eq('id', draft.id);
        await telegram('sendMessage', { chat_id: chatId, text: '✅ Profilbild gespeichert.', reply_markup: settingsKb() });
      } else {
        await telegram('sendMessage', { chat_id: chatId, text: 'Bitte sende ein Foto als Profilbild.' });
      }
      return NextResponse.json({ ok: true });
    }

    if (message.photo?.length) {
      const photo = message.photo[message.photo.length - 1];
      const { error } = await supabase.from('chat_messages').insert({
        chat_id: draft.id,
        sender_side: draft.current_side,
        message_type: 'image',
        text: message.caption || null,
        telegram_file_id: photo.file_id,
        telegram_message_id: message.message_id
      });
      if (error) throw error;
      await telegram('sendMessage', { chat_id: chatId, text: `🖼 Bild hinzugefügt als ${draft.current_side === 'me' ? 'Ich' : 'Andere Person'}.`, reply_markup: mainKb() });
      return NextResponse.json({ ok: true });
    }

    if (message.text && !message.text.startsWith('/')) {
      const { error } = await supabase.from('chat_messages').insert({
        chat_id: draft.id,
        sender_side: draft.current_side,
        message_type: 'text',
        text: message.text,
        telegram_message_id: message.message_id
      });
      if (error) throw error;
      await telegram('sendMessage', { chat_id: chatId, text: `✅ Nachricht hinzugefügt als ${draft.current_side === 'me' ? 'Ich' : 'Andere Person'}.`, reply_markup: mainKb() });
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error('webhook error', e);
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'unknown error' }, { status: 500 });
  }
}
