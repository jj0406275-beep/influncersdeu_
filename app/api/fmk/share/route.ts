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

type Role = "fuck" | "marry" | "kill";
type Selection = { itemId: string; role: Role };

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
    const body = await request.json() as { initData?: string; chatId?: string; categoryId?: string; selection?: Selection[] };
    if (!groupTargetAllowed(body.chatId)) return NextResponse.json({ error: "Diese Gruppe ist für diesen Bot nicht freigegeben." }, { status: 403 });
    const auth = validateTelegramInitData(body.initData ?? "", botToken);
    if (!auth.ok) return NextResponse.json({ error: telegramAuthErrorMessage(auth.reason), code: auth.reason }, { status: 401 });
    if (!body.chatId || !/^-?\d+$/.test(body.chatId)) return NextResponse.json({ error: "Gruppen-ID fehlt." }, { status: 400 });
    if (!body.categoryId) return NextResponse.json({ error: "FMK-Spiel-ID fehlt." }, { status: 400 });
    const roles: Role[] = ["fuck", "marry", "kill"];
    if (!Array.isArray(body.selection) || body.selection.length !== 3 || new Set(body.selection.map((x) => x.itemId)).size !== 3 || new Set(body.selection.map((x) => x.role)).size !== 3 || body.selection.some((x) => !roles.includes(x.role))) {
      return NextResponse.json({ error: "Jede Rolle muss genau einmal vergeben werden." }, { status: 400 });
    }

    const user = JSON.parse(auth.params.get("user") ?? "{}");
    const userId = Number(user.id);
    const player = user.username ? `@${user.username}` : [user.first_name, user.last_name].filter(Boolean).join(" ") || "Ein Spieler";
    if (!userId) return NextResponse.json({ error: "Telegram-Nutzer-ID fehlt." }, { status: 400 });

    const supabase = getSupabaseAdmin();
    const [{ data: category }, { data: items }, { data: topic }] = await Promise.all([
      supabase.from("categories").select("name,game_type,send_images").eq("id", body.categoryId).single(),
      supabase.from("items").select("id,title,image_url").eq("category_id", body.categoryId),
      supabase.from("group_topic_settings").select("results_thread_id").eq("chat_id", body.chatId).maybeSingle()
    ]);
    if (!category || category.game_type !== "fmk" || !items || items.length !== 3) return NextResponse.json({ error: "Ungültiges FMK-Spiel." }, { status: 400 });
    const allowed = new Set(items.map((item) => item.id));
    if (body.selection.some((entry) => !allowed.has(entry.itemId))) return NextResponse.json({ error: "Ungültige Bildauswahl." }, { status: 400 });

    const { data: existing } = await supabase.from("fmk_votes").select("id").eq("category_id", body.categoryId).eq("chat_id", body.chatId).eq("user_id", userId).maybeSingle();
    if (existing?.id) return NextResponse.json({ error: "Du hast für dieses FMK-Spiel bereits abgestimmt." }, { status: 409 });

    const { data: vote, error: voteError } = await supabase.from("fmk_votes").insert({ category_id: body.categoryId, chat_id: body.chatId, user_id: userId, player_name: player }).select("id").single();
    if (voteError || !vote) throw voteError ?? new Error("FMK-Stimme konnte nicht gespeichert werden.");
    const { error: entriesError } = await supabase.from("fmk_vote_entries").insert(body.selection.map((entry) => ({ vote_id: vote.id, item_id: entry.itemId, role: entry.role })));
    if (entriesError) { await supabase.from("fmk_votes").delete().eq("id", vote.id); throw entriesError; }

    const { data: votes } = await supabase.from("fmk_votes").select("id").eq("category_id", body.categoryId).eq("chat_id", body.chatId);
    const voteIds = (votes ?? []).map((v) => v.id);
    const { data: allEntries } = await supabase.from("fmk_vote_entries").select("item_id,role").in("vote_id", voteIds);
    const count = voteIds.length;
    const counts = new Map(items.map((item) => [item.id, { fuck: 0, marry: 0, kill: 0 }]));
    for (const entry of allEntries ?? []) counts.get(entry.item_id)![entry.role as Role] += 1;
    const byId = new Map(items.map((item) => [item.id, item]));
    const labels: Record<Role, string> = { fuck: "🔥 Fuck", marry: "❤️ Marry", kill: "💀 Kill" };

    if (category.send_images !== false) {
      await telegramApi(botToken, "sendMediaGroup", {
        chat_id: body.chatId,
        ...(topic?.results_thread_id ? { message_thread_id: topic.results_thread_id } : {}),
        media: body.selection.map((entry) => ({ type: "photo", media: byId.get(entry.itemId)!.image_url }))
      });
    }

    const own = body.selection.map((entry) => `${labels[entry.role]}: <b>${escapeHtml(byId.get(entry.itemId)!.title)}</b>`).join("\n");
    const community = items.map((item) => {
      const c = counts.get(item.id)!;
      return `<b>${escapeHtml(item.title)}</b>\n🔥 ${Math.round(c.fuck / count * 100)}% · ❤️ ${Math.round(c.marry / count * 100)}% · 💀 ${Math.round(c.kill / count * 100)}%`;
    }).join("\n\n");
    await telegramApi(botToken, "sendMessage", {
      chat_id: body.chatId,
      parse_mode: "HTML",
      ...(topic?.results_thread_id ? { message_thread_id: topic.results_thread_id } : {}),
      text: `🔥 <b>${escapeHtml(category.name)}</b> – Fuck, Marry, Kill von ${escapeHtml(player)}\n\n${own}\n\n━━━━━━━━━━━━━━\n\n📊 <b>FMK-Community</b>\n${count} ${count === 1 ? "Stimme" : "Stimmen"} inklusive deiner Stimme\n\n${community}`
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("FMK share API error:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "FMK-Ergebnis konnte nicht gesendet werden." }, { status: 500 });
  }
}
