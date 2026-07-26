import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "../../../lib/supabase";
import { telegramAuthErrorMessage, validateTelegramInitData } from "../../../lib/telegram-auth";

function allowedGroupId(): number {
  const value = Number(process.env.ALLOWED_TELEGRAM_GROUP_ID);
  if (!Number.isSafeInteger(value) || value >= 0) throw new Error("ALLOWED_TELEGRAM_GROUP_ID fehlt oder ist ungültig.");
  return value;
}

function groupTargetAllowed(chatId: string | number | null | undefined): boolean {
  const target = Number(chatId);
  return !Number.isSafeInteger(target) || target >= 0 || target === allowedGroupId();
}

const MAX_ITEMS = 30;

type RankingEntry = { position: number; itemId: string; title: string };
type ItemRow = { id: string; title: string; image_url: string; category_id: string };

function escapeHtml(value: string) {
  return value.replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[char] ?? char));
}

async function telegramApi(token: string, method: string, payload: unknown) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.description || `Telegram-Fehler in ${method}`);
  return data.result;
}

async function sendImagesFirst(token: string, chatId: string, urls: string[], threadId?: number | null) {
  for (let offset = 0; offset < urls.length; offset += 10) {
    const chunk = urls.slice(offset, offset + 10);
    if (chunk.length === 1) {
      await telegramApi(token, "sendPhoto", { chat_id: chatId, photo: chunk[0], ...(threadId ? { message_thread_id: threadId } : {}) });
    } else {
      await telegramApi(token, "sendMediaGroup", {
        chat_id: chatId,
        ...(threadId ? { message_thread_id: threadId } : {}),
        media: chunk.map((url) => ({ type: "photo", media: url }))
      });
    }
  }
}

function agreementPercent(userRanking: RankingEntry[], communityOrder: string[]): number {
  const count = userRanking.length;
  if (count < 2 || communityOrder.length !== count) return 0;
  const communityPosition = new Map(communityOrder.map((itemId, index) => [itemId, index + 1]));
  const distance = userRanking.reduce((sum, entry) => {
    const comparison = communityPosition.get(entry.itemId) ?? entry.position;
    return sum + Math.abs(entry.position - comparison);
  }, 0);
  const maximumDistance = Math.floor((count * count) / 2);
  if (!maximumDistance) return 100;
  return Math.max(0, Math.min(100, Math.round((1 - distance / maximumDistance) * 100)));
}

export async function POST(request: NextRequest) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return NextResponse.json({ error: "Bot-Token fehlt." }, { status: 500 });

  const body = await request.json();
  const { initData, chatId, categoryId, ranking } = body as {
    initData?: string;
    chatId?: string | null;
    categoryId?: string | null;
    ranking?: RankingEntry[];
    gameType?: "blind_ranking" | "fmk";
  };

  if (!groupTargetAllowed(chatId)) return NextResponse.json({ error: "Diese Gruppe ist für diesen Bot nicht freigegeben." }, { status: 403 });

  const auth = validateTelegramInitData(initData ?? "", botToken);
  if (!auth.ok) {
    console.error("Telegram auth failed", { reason: auth.reason, ageSeconds: auth.ageSeconds, route: "share" });
    return NextResponse.json({ error: telegramAuthErrorMessage(auth.reason), code: auth.reason }, { status: 401 });
  }
  if (!chatId || !/^-?\d+$/.test(chatId)) return NextResponse.json({ error: "Gruppen-ID fehlt." }, { status: 400 });
  if (!categoryId) return NextResponse.json({ error: "Kategorie-ID fehlt." }, { status: 400 });
  if (
    !Array.isArray(ranking) ||
    ranking.length < 2 ||
    ranking.length > MAX_ITEMS ||
    ranking.some((entry, index) => entry.position !== index + 1 || !entry.itemId || !entry.title) ||
    new Set(ranking.map((entry) => entry.itemId)).size !== ranking.length
  ) {
    return NextResponse.json({ error: "Ranking ist ungültig." }, { status: 400 });
  }

  const initParams = new URLSearchParams(initData);
  let player = "Ein Spieler";
  let userId = 0;
  try {
    const user = JSON.parse(initParams.get("user") ?? "{}");
    userId = Number(user.id);
    player = user.username ? `@${user.username}` : [user.first_name, user.last_name].filter(Boolean).join(" ") || player;
  } catch {}
  if (!userId) return NextResponse.json({ error: "Telegram-Nutzer-ID fehlt." }, { status: 400 });

  const supabase = getSupabaseAdmin();
  const { data: topicSettings, error: topicSettingsError } = await supabase
    .from("group_topic_settings")
    .select("results_thread_id")
    .eq("chat_id", chatId)
    .maybeSingle();
  if (topicSettingsError) throw topicSettingsError;
  const resultsThreadId = topicSettings?.results_thread_id ?? null;

  const itemIds = ranking.map((entry) => entry.itemId);
  const [{ data: items, error: itemError }, { data: category, error: categoryError }] = await Promise.all([
    supabase.from("items").select("id,title,image_url,category_id").eq("category_id", categoryId).in("id", itemIds),
    supabase.from("categories").select("name,send_images,game_type").eq("id", categoryId).single()
  ]);
  if (itemError || categoryError || !items || items.length !== ranking.length) {
    return NextResponse.json({ error: "Kategorie oder Bilder konnten nicht geladen werden." }, { status: 500 });
  }

  const typedItems = items as ItemRow[];
  if (category.game_type !== "blind_ranking") {
    return NextResponse.json({ error: "FMK-Ergebnisse müssen über den eigenen FMK-Spielmodus gesendet werden." }, { status: 400 });
  }
  const isFmk = false;
  const roleLabels = ["🔥 Fuck", "❤️ Marry", "💀 Kill"];
  const byId = new Map(typedItems.map((item) => [item.id, item]));
  const orderedItems = ranking.map((entry) => byId.get(entry.itemId)!).filter(Boolean);

  const { data: existingVote, error: existingError } = await supabase
    .from("game_votes")
    .select("id")
    .eq("category_id", categoryId)
    .eq("chat_id", chatId)
    .eq("user_id", userId)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existingVote?.id) {
    return NextResponse.json({ error: "Du hast in dieser Gruppe für diese Kategorie bereits abgestimmt." }, { status: 409 });
  }

  const { data: vote, error: voteError } = await supabase
    .from("game_votes")
    .insert({ category_id: categoryId, chat_id: chatId, user_id: userId, player_name: player })
    .select("id")
    .single();
  if (voteError || !vote) throw voteError ?? new Error("Stimme konnte nicht gespeichert werden.");

  const { error: voteEntryError } = await supabase.from("vote_entries").insert(
    ranking.map((entry) => ({ vote_id: vote.id, item_id: entry.itemId, position: entry.position }))
  );
  if (voteEntryError) {
    await supabase.from("game_votes").delete().eq("id", vote.id);
    throw voteEntryError;
  }

  try {
    const { data: communityVotes, error: communityVotesError } = await supabase
      .from("game_votes")
      .select("id")
      .eq("category_id", categoryId)
      .eq("chat_id", chatId);
    if (communityVotesError) throw communityVotesError;

    // Das Community-Ranking enthält ausdrücklich auch die soeben abgegebene Stimme.
    const communityVoteIds = (communityVotes ?? []).map((entry) => entry.id);
    let communityText = "";
    let agreementText = "";

    if (communityVoteIds.length > 0) {
      const { data: communityEntries, error: communityEntriesError } = await supabase
        .from("vote_entries")
        .select("item_id,position")
        .in("vote_id", communityVoteIds);
      if (communityEntriesError) throw communityEntriesError;

      const itemCount = ranking.length;
      const maxPointsPerItem = itemCount * communityVoteIds.length;
      const pointsByItem = new Map<string, number>();
      for (const entry of communityEntries ?? []) {
        const points = Math.max(1, itemCount - entry.position + 1);
        pointsByItem.set(entry.item_id, (pointsByItem.get(entry.item_id) ?? 0) + points);
      }

      const community = typedItems
        .map((item) => ({
          id: item.id,
          title: item.title,
          points: pointsByItem.get(item.id) ?? 0
        }))
        .sort((a, b) => b.points - a.points || a.title.localeCompare(b.title, "de"));

      const communityLines = community.map((item, index) => {
        const percentage = maxPointsPerItem > 0 ? Math.round((item.points / maxPointsPerItem) * 100) : 0;
        return `${index + 1}. <b>${escapeHtml(item.title)}</b> — ${percentage}%`;
      });
      communityText = `\n\n━━━━━━━━━━━━━━\n\n${isFmk ? "📊 <b>Community-Auswertung</b>" : "📊 <b>Community-Ranking</b>"}\n${communityVoteIds.length} ${communityVoteIds.length === 1 ? "Stimme" : "Stimmen"} inklusive deiner Stimme\n\n${communityLines.join("\n")}`;

      const agreement = agreementPercent(ranking, community.map((item) => item.id));
      agreementText = `\n\n🤝 <b>Deine Übereinstimmung mit der Community</b>\n${agreement}%`;
    }

    if (category.send_images !== false) {
      await sendImagesFirst(botToken, chatId, orderedItems.map((item) => item.image_url), resultsThreadId);
    }

    const rankingText = ranking
      .map((entry) => {
        const title = byId.get(entry.itemId)?.title ?? entry.title;
        return `${isFmk ? roleLabels[entry.position - 1] : `${entry.position}.`} <b>${escapeHtml(title)}</b>`;
      })
      .join("\n");

    let text = `${isFmk ? "🔥" : "🏆"} <b>${escapeHtml(category.name)}</b> – ${isFmk ? "FMK-Auswahl" : "Ranking"} von ${escapeHtml(player)}\n\n${rankingText}${communityText}${agreementText}`;
    if (text.length > 4090) text = text.slice(0, 4050) + "\n…";
    await telegramApi(botToken, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML", ...(resultsThreadId ? { message_thread_id: resultsThreadId } : {}) });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Share failed:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Telegram konnte das Ranking nicht senden." }, { status: 502 });
  }
}
