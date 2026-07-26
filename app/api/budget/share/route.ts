import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "../../../../lib/supabase";
import { telegramAuthErrorMessage, validateTelegramInitData } from "../../../../lib/telegram-auth";

function allowedGroupId(): number {
  const value = Number(process.env.ALLOWED_TELEGRAM_GROUP_ID);
  if (!Number.isSafeInteger(value) || value >= 0) throw new Error("ALLOWED_TELEGRAM_GROUP_ID fehlt oder ist ungültig.");
  return value;
}

function groupTargetAllowed(chatId: string | number | null | undefined): boolean {
  const target = Number(chatId);
  return !Number.isSafeInteger(target) || target >= 0 || target === allowedGroupId();
}

function escapeHtml(value: string) {
  return value.replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[char] ?? char));
}
async function telegramApi(token: string, method: string, payload: unknown) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.description || `Telegram-Fehler in ${method}`);
  return data.result;
}

export async function POST(request: NextRequest) {
  try {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) return NextResponse.json({ error: "Bot-Token fehlt." }, { status: 500 });
    const body = await request.json() as { initData?: string; chatId?: string; gameId?: string; selectedItemIds?: string[] };
    if (!groupTargetAllowed(body.chatId)) return NextResponse.json({ error: "Diese Gruppe ist für diesen Bot nicht freigegeben." }, { status: 403 });
    const auth = validateTelegramInitData(body.initData ?? "", botToken);
    if (!auth.ok) return NextResponse.json({ error: telegramAuthErrorMessage(auth.reason), code: auth.reason }, { status: 401 });
    if (!body.chatId || !/^-?\d+$/.test(body.chatId)) return NextResponse.json({ error: "Gruppen-ID fehlt." }, { status: 400 });
    if (!body.gameId || !Array.isArray(body.selectedItemIds)) return NextResponse.json({ error: "Auswahl fehlt." }, { status: 400 });
    if (!body.selectedItemIds.length || new Set(body.selectedItemIds).size !== body.selectedItemIds.length) return NextResponse.json({ error: "Wähle mindestens eine Influencerin und sende keine Duplikate." }, { status: 400 });

    const user = JSON.parse(auth.params.get("user") ?? "{}");
    const userId = Number(user.id);
    const player = user.username ? `@${user.username}` : [user.first_name, user.last_name].filter(Boolean).join(" ") || "Ein Spieler";
    if (!userId) return NextResponse.json({ error: "Telegram-Nutzer-ID fehlt." }, { status: 400 });

    const supabase = getSupabaseAdmin();
    const [{ data: game }, { data: items }, { data: topic }] = await Promise.all([
      supabase.from("budget_games").select("id,title,budget_amount,currency_label,min_selections,max_selections,is_active").eq("id", body.gameId).maybeSingle(),
      supabase.from("budget_items").select("id,name,image_url,price").eq("game_id", body.gameId),
      supabase.from("group_topic_settings").select("results_thread_id").eq("chat_id", body.chatId).maybeSingle()
    ]);
    if (!game?.is_active || !items?.length) return NextResponse.json({ error: "Ungültiges Budget-Spiel." }, { status: 400 });

    const byId = new Map(items.map((item) => [item.id, item]));
    const selected = body.selectedItemIds.map((id) => byId.get(id));
    if (selected.some((item) => !item)) return NextResponse.json({ error: "Mindestens eine Auswahl gehört nicht zu diesem Spiel." }, { status: 400 });
    if (game.min_selections && selected.length < game.min_selections) return NextResponse.json({ error: `Wähle mindestens ${game.min_selections} Influencerinnen.` }, { status: 400 });
    if (game.max_selections && selected.length > game.max_selections) return NextResponse.json({ error: `Wähle höchstens ${game.max_selections} Influencerinnen.` }, { status: 400 });
    const totalSpent = selected.reduce((sum, item) => sum + Number(item!.price), 0);
    const budget = Number(game.budget_amount);
    if (totalSpent > budget) return NextResponse.json({ error: "Deine Auswahl überschreitet das verfügbare Budget." }, { status: 400 });

    const { data: existing } = await supabase.from("budget_votes").select("id").eq("game_id", body.gameId).eq("chat_id", body.chatId).eq("user_id", userId).maybeSingle();
    if (existing?.id) return NextResponse.json({ error: "Du hast für dieses Budget-Spiel bereits abgestimmt." }, { status: 409 });

    const { data: vote, error: voteError } = await supabase.from("budget_votes").insert({
      game_id: body.gameId,
      chat_id: body.chatId,
      user_id: userId,
      player_name: player,
      total_spent: totalSpent,
      remaining_budget: budget - totalSpent
    }).select("id").single();
    if (voteError || !vote) throw voteError ?? new Error("Budget-Stimme konnte nicht gespeichert werden.");
    const { error: entriesError } = await supabase.from("budget_vote_entries").insert(selected.map((item) => ({ vote_id: vote.id, item_id: item!.id, price_at_vote: Number(item!.price) })));
    if (entriesError) { await supabase.from("budget_votes").delete().eq("id", vote.id); throw entriesError; }

    const { data: votes } = await supabase.from("budget_votes").select("id,total_spent").eq("game_id", body.gameId).eq("chat_id", body.chatId);
    const voteIds = (votes ?? []).map((entry) => entry.id);
    const { data: entries } = await supabase.from("budget_vote_entries").select("item_id").in("vote_id", voteIds);
    const counts = new Map(items.map((item) => [item.id, 0]));
    for (const entry of entries ?? []) counts.set(entry.item_id, (counts.get(entry.item_id) ?? 0) + 1);
    const count = voteIds.length;
    const average = count ? Math.round((votes ?? []).reduce((sum, entry) => sum + Number(entry.total_spent), 0) / count) : 0;
    const money = (value: number) => `${value.toLocaleString("de-DE")} ${game.currency_label}`;
    const own = selected.map((item) => `✅ <b>${escapeHtml(item!.name)}</b> – ${money(Number(item!.price))}`).join("\n");
    const community = [...items].sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0)).map((item) => `<b>${escapeHtml(item.name)}</b>: ${Math.round(((counts.get(item.id) ?? 0) / count) * 100)}%`).join("\n");

    await telegramApi(botToken, "sendMessage", {
      chat_id: body.chatId,
      parse_mode: "HTML",
      ...(topic?.results_thread_id ? { message_thread_id: topic.results_thread_id } : {}),
      text: `💰 <b>${escapeHtml(game.title)}</b> – Auswahl von ${escapeHtml(player)}\n\n${own}\n\nAusgegeben: <b>${money(totalSpent)}</b>\nVerfügbar: <b>${money(budget - totalSpent)}</b>\n\n━━━━━━━━━━━━━━\n\n📊 <b>Community</b> · ${count} ${count === 1 ? "Stimme" : "Stimmen"}\nDurchschnittlich ausgegeben: <b>${money(average)}</b>\n\n${community}`
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Budget share API error:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Budget-Auswahl konnte nicht gesendet werden." }, { status: 500 });
  }
}
