import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "../../../../lib/supabase";
import { telegramAuthErrorMessage, validateTelegramInitData } from "../../../../lib/telegram-auth";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) return NextResponse.json({ error: "Bot-Token fehlt." }, { status: 500 });

    const body = await request.json() as { initData?: string; chatId?: string | null; gameId?: string | null };
    const auth = validateTelegramInitData(body.initData ?? "", botToken);
    if (!auth.ok) return NextResponse.json({ error: telegramAuthErrorMessage(auth.reason), code: auth.reason }, { status: 401 });
    if (!body.chatId || !/^-?\d+$/.test(body.chatId)) return NextResponse.json({ error: "Gruppen-ID fehlt." }, { status: 400 });
    if (!body.gameId) return NextResponse.json({ error: "Budget-Spiel-ID fehlt." }, { status: 400 });

    const user = JSON.parse(auth.params.get("user") ?? "{}");
    const userId = Number(user.id);
    if (!userId) return NextResponse.json({ error: "Telegram-Nutzer-ID fehlt." }, { status: 400 });

    const supabase = getSupabaseAdmin();
    const [{ data: game, error: gameError }, { data: items, error: itemError }] = await Promise.all([
      supabase.from("budget_games").select("id,title,budget_amount,currency_label,min_selections,max_selections,is_active").eq("id", body.gameId).maybeSingle(),
      supabase.from("budget_items").select("id,name,image_url,price,sort_order").eq("game_id", body.gameId).order("sort_order", { ascending: true })
    ]);
    if (gameError) throw gameError;
    if (itemError) throw itemError;
    if (!game || !game.is_active || !items?.length) return NextResponse.json({ error: "Dieses Budget-Spiel ist nicht aktiv oder enthält keine Influencerinnen." }, { status: 404 });

    const { data: existing } = await supabase.from("budget_votes").select("id,total_spent,remaining_budget").eq("game_id", body.gameId).eq("chat_id", body.chatId).eq("user_id", userId).maybeSingle();
    let previousSelection: string[] | null = null;
    if (existing?.id) {
      const { data: entries } = await supabase.from("budget_vote_entries").select("item_id").eq("vote_id", existing.id);
      previousSelection = (entries ?? []).map((entry) => entry.item_id);
    }

    const { data: votes } = await supabase.from("budget_votes").select("id,total_spent").eq("game_id", body.gameId).eq("chat_id", body.chatId);
    const voteIds = (votes ?? []).map((vote) => vote.id);
    const { data: allEntries } = voteIds.length
      ? await supabase.from("budget_vote_entries").select("item_id").in("vote_id", voteIds)
      : { data: [] as Array<{ item_id: string }> };
    const counts = new Map(items.map((item) => [item.id, 0]));
    for (const entry of allEntries ?? []) counts.set(entry.item_id, (counts.get(entry.item_id) ?? 0) + 1);
    const totalVotes = voteIds.length;
    const averageSpent = totalVotes
      ? Math.round((votes ?? []).reduce((sum, vote) => sum + Number(vote.total_spent), 0) / totalVotes)
      : 0;

    return NextResponse.json({
      gameId: game.id,
      title: game.title,
      budget: Number(game.budget_amount),
      currency: game.currency_label,
      minSelections: game.min_selections,
      maxSelections: game.max_selections,
      items: items.map((item) => ({ id: item.id, name: item.name, image: item.image_url, price: Number(item.price) })),
      alreadyVoted: Boolean(existing?.id),
      previousSelection,
      totalVotes,
      averageSpent,
      community: items.map((item) => ({ itemId: item.id, percent: totalVotes ? Math.round(((counts.get(item.id) ?? 0) / totalVotes) * 100) : 0 }))
    });
  } catch (error) {
    console.error("Budget game API error:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Budget-Spiel konnte nicht geladen werden." }, { status: 500 });
  }
}
