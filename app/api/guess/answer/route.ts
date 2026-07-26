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

function norm(v: string) {
  return v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/^@/, "").replace(/[^a-z0-9äöüß]+/g, " ").trim().replace(/\s+/g, " ");
}
function lev(a: string, b: string) {
  const d = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) d[i][0] = i;
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
function score(a: string, b: string) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  return 1 - lev(a, b) / Math.max(a.length, b.length);
}
function esc(v: string) {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
async function telegramApi(token: string, method: string, payload: unknown) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Telegram ${method} fehlgeschlagen.`);
}

export async function POST(req: NextRequest) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return NextResponse.json({ error: "Bot-Token fehlt." }, { status: 500 });
    const body = await req.json() as { initData?: string; gameId: string; personId: string; answer: string; chatId?: string };
    if (!groupTargetAllowed(body.chatId)) return NextResponse.json({ error: "Diese Gruppe ist für diesen Bot nicht freigegeben." }, { status: 403 });
    const auth = validateTelegramInitData(body.initData ?? "", token);
    if (!auth.ok) return NextResponse.json({ error: telegramAuthErrorMessage(auth.reason) }, { status: 401 });
    const user = JSON.parse(auth.params.get("user") ?? "{}");
    const sb = getSupabaseAdmin();

    const { data: game } = await sb.from("guess_games").select("title,send_images").eq("id", body.gameId).single();
    const { data: person } = await sb.from("guess_people").select("display_name,aliases").eq("id", body.personId).eq("game_id", body.gameId).single();
    if (!person || !game) return NextResponse.json({ error: "Influencerin nicht gefunden." }, { status: 404 });

    const input = norm(body.answer);
    const names = [person.display_name, ...(Array.isArray(person.aliases) ? person.aliases : [])].map(norm);
    const best = Math.max(...names.map((name) => score(input, name)));
    const exact = names.includes(input);
    const minimum = input.length <= 4 ? 0.92 : input.length <= 7 ? 0.84 : 0.78;
    const correct = exact || best >= minimum;
    const suggestion = !correct && best >= Math.max(0.7, minimum - 0.12) ? person.display_name : null;
    const points = correct ? 100 : 0;

    await sb.from("guess_answers").insert({
      game_id: body.gameId,
      person_id: body.personId,
      user_id: Number(user.id),
      chat_id: body.chatId ?? null,
      submitted_answer: body.answer,
      normalized_answer: input,
      similarity_score: best,
      is_correct: correct,
      points,
    });

    const resultText = [
      `<b>🧩 ${esc(game.title)}</b>`,
      "",
      correct ? "✅ <b>Richtig geraten!</b>" : "❌ <b>Leider falsch.</b>",
      `Deine Antwort: <b>${esc(body.answer.trim() || "–")}</b>`,
      `Lösung: <b>${esc(person.display_name)}</b>`,
      `Punkte: <b>${points}</b>`,
      suggestion ? `Meintest du vielleicht: <b>${esc(suggestion)}</b>` : "",
    ].filter(Boolean).join("\n");

    // Das Ergebnis folgt dem Startkontext:
    // privat gestartete Spiele -> privater Bot-Chat, Gruppenstart -> dieselbe Gruppe.
    // In Forengruppen wird das konfigurierte Ergebnis-Thema verwendet.
    const requestedChatId = Number(body.chatId);
    const targetChatId = Number.isSafeInteger(requestedChatId) && requestedChatId !== 0
      ? requestedChatId
      : Number(user.id);
    const isGroupTarget = targetChatId < 0;
    const { data: topic } = isGroupTarget
      ? await sb.from("group_topic_settings").select("results_thread_id").eq("chat_id", String(targetChatId)).maybeSingle()
      : { data: null as { results_thread_id?: number | null } | null };
    const topicPayload = topic?.results_thread_id ? { message_thread_id: topic.results_thread_id } : {};

    try {
      if (game.send_images) {
        const { data: media } = await sb.from("guess_media")
          .select("media_url,media_type")
          .eq("person_id", body.personId)
          .order("sort_order", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (media?.media_url) {
          const method = media.media_type === "animation" ? "sendAnimation" : "sendPhoto";
          const field = media.media_type === "animation" ? "animation" : "photo";
          await telegramApi(token, method, { chat_id: targetChatId, ...topicPayload, [field]: media.media_url, caption: resultText, parse_mode: "HTML" });
        } else {
          await telegramApi(token, "sendMessage", { chat_id: targetChatId, ...topicPayload, text: resultText, parse_mode: "HTML" });
        }
      } else {
        await telegramApi(token, "sendMessage", { chat_id: targetChatId, ...topicPayload, text: resultText, parse_mode: "HTML" });
      }
    } catch (telegramError) {
      console.error("Rate-Ergebnis konnte nicht an Telegram gesendet werden:", telegramError);
    }

    return NextResponse.json({ correct, score: Math.round(best * 100), suggestion, correctName: person.display_name, points });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Fehler" }, { status: 500 });
  }
}
