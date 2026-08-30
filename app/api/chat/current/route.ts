import { NextRequest, NextResponse } from 'next/server';
import { db } from '../../../../lib/supabase';
import { validateInitData } from '../../../../lib/telegram';

export async function GET(req: NextRequest) {
  const initData = req.headers.get('x-telegram-init-data') || '';
  const user = validateInitData(initData);
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const supabase = db();
  const { data: chat, error } = await supabase.from('chat_drafts')
    .select('*').eq('owner_telegram_id', user.id).eq('is_active', true)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!chat) return NextResponse.json({ chat: null, messages: [] });
  const { data: messages, error: msgError } = await supabase.from('chat_messages')
    .select('*').eq('chat_id', chat.id).order('created_at', { ascending: true });
  if (msgError) return NextResponse.json({ error: msgError.message }, { status: 500 });
  return NextResponse.json({ chat, messages: messages || [] });
}
