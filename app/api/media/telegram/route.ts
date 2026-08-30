import { NextRequest, NextResponse } from 'next/server';
import { telegram, BOT_TOKEN } from '../../../../lib/telegram';

export async function GET(req: NextRequest) {
  const fileId = req.nextUrl.searchParams.get('fileId');
  if (!fileId) return new NextResponse('missing fileId', { status: 400 });
  try {
    const file = await telegram('getFile', { file_id: fileId });
    const res = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`, { cache: 'no-store' });
    if (!res.ok) return new NextResponse('telegram media error', { status: 502 });
    return new NextResponse(res.body, {
      status: 200,
      headers: {
        'content-type': res.headers.get('content-type') || 'image/jpeg',
        'cache-control': 'private, max-age=300'
      }
    });
  } catch (e) {
    return new NextResponse(e instanceof Error ? e.message : 'error', { status: 500 });
  }
}
