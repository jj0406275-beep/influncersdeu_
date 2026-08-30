import { NextRequest, NextResponse } from 'next/server';
import { db } from '../../../../lib/supabase';
import { validateInitData } from '../../../../lib/telegram';

export async function POST(req: NextRequest) {
  const initData = req.headers.get('x-telegram-init-data') || '';
  const user = validateInitData(initData);
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const supabase = db();
  await supabase.from('chat_drafts').update({ is_active: false }).eq('owner_telegram_id', user.id);
  const { data, error } = await supabase.from('chat_drafts').insert({
    owner_telegram_id: user.id,
    contact_name: 'Kontakt',
    current_side: 'other',
    theme: 'light',
    is_active: true
  }).select('*').single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ chat: data });
}
