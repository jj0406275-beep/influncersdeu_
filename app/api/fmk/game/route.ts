import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "../../../../lib/supabase";
import { telegramAuthErrorMessage, validateTelegramInitData } from "../../../../lib/telegram-auth";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) return NextResponse.json({ error: "Bot-Token fehlt." }, { status: 500 });

    const body = await request.json() as { initData?: string; chatId?: string | null; categoryId?: string | null };
    const auth = validateTelegramInitData(body.initData ?? "", botToken);
    if (!auth.ok) return NextResponse.json({ error: telegramAuthErrorMessage(auth.reason), code: auth.reason }, { status: 401 });
    if (!body.chatId || !/^-?\d+$/.test(body.chatId)) return NextResponse.json({ error: "Gruppen-ID fehlt." }, { status: 400 });
    if (!body.categoryId) return NextResponse.json({ error: "FMK-Spiel-ID fehlt." }, { status: 400 });

    const user = JSON.parse(auth.params.get("user") ?? "{}");
    const userId = Number(user.id);
    if (!userId) return NextResponse.json({ error: "Telegram-Nutzer-ID fehlt." }, { status: 400 });

    const supabase = getSupabaseAdmin();
    const [{ data: category, error: categoryError }, { data: items, error: itemsError }] = await Promise.all([
      supabase.from("categories").select("id,name,game_type").eq("id", body.categoryId).single(),
      supabase.from("items").select("id,title,image_url,position").eq("category_id", body.categoryId).order("position", { ascending: true })
    ]);
    if (categoryError) throw categoryError;
    if (itemsError) throw itemsError;
    if (category.game_type !== "fmk") return NextResponse.json({ error: "Dieses Spiel ist kein Fuck, Marry, Kill." }, { status: 400 });
    if (!items || items.length !== 3) return NextResponse.json({ error: "Ein FMK-Spiel muss genau 3 Bilder enthalten." }, { status: 400 });

    const { data: existingVote, error: voteError } = await supabase
      .from("fmk_votes")
      .select("id")
      .eq("category_id", body.categoryId)
      .eq("chat_id", body.chatId)
      .eq("user_id", userId)
      .maybeSingle();
    if (voteError) throw voteError;

    let previousSelection = null;
    let community = null;
    let totalVotes = 0;
    if (existingVote?.id) {
      const [{ data: own }, { data: votes }] = await Promise.all([
        supabase.from("fmk_vote_entries").select("item_id,role").eq("vote_id", existingVote.id),
        supabase.from("fmk_votes").select("id").eq("category_id", body.categoryId).eq("chat_id", body.chatId)
      ]);
      const voteIds = (votes ?? []).map((vote) => vote.id);
      totalVotes = voteIds.length;
      const { data: allEntries } = voteIds.length
        ? await supabase.from("fmk_vote_entries").select("item_id,role").in("vote_id", voteIds)
        : { data: [] as Array<{ item_id: string; role: string }> };
      const counts = new Map<string, Record<string, number>>();
      for (const item of items) counts.set(item.id, { fuck: 0, marry: 0, kill: 0 });
      for (const entry of allEntries ?? []) counts.get(entry.item_id)![entry.role] += 1;
      previousSelection = (own ?? []).map((entry) => ({ itemId: entry.item_id, role: entry.role }));
      community = items.map((item) => ({
        itemId: item.id,
        title: item.title,
        image: item.image_url,
        fuck: totalVotes ? Math.round((counts.get(item.id)!.fuck / totalVotes) * 100) : 0,
        marry: totalVotes ? Math.round((counts.get(item.id)!.marry / totalVotes) * 100) : 0,
        kill: totalVotes ? Math.round((counts.get(item.id)!.kill / totalVotes) * 100) : 0
      }));
    }

    return NextResponse.json({
      categoryId: category.id,
      title: category.name,
      items: [...items].sort(() => Math.random() - 0.5).map((item) => ({ id: item.id, title: item.title, image: item.image_url })),
      alreadyVoted: Boolean(existingVote?.id),
      previousSelection,
      community,
      totalVotes
    });
  } catch (error) {
    console.error("FMK game API error:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "FMK-Spiel konnte nicht geladen werden." }, { status: 500 });
  }
}
