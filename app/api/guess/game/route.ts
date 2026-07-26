import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "../../../../lib/supabase";
import { telegramAuthErrorMessage, validateTelegramInitData } from "../../../../lib/telegram-auth";

export const dynamic = "force-dynamic";

function shuffled<T>(values: T[]) {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

export async function POST(request: NextRequest) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return NextResponse.json({ error: "Bot-Token fehlt." }, { status: 500 });

    const body = await request.json() as { initData?: string; gameId?: string; game_id?: string; categoryId?: string };
    const auth = validateTelegramInitData(body.initData ?? "", token);
    if (!auth.ok) return NextResponse.json({ error: telegramAuthErrorMessage(auth.reason) }, { status: 401 });

    const gameId = body.gameId ?? body.game_id ?? body.categoryId;
    if (!gameId) return NextResponse.json({ error: "Spiel-ID fehlt. Öffne das Spiel erneut über den Bot." }, { status: 400 });

    const sb = getSupabaseAdmin();
    const { data: game, error: gameError } = await sb
      .from("guess_games")
      .select("id,title,answer_mode,hints_enabled,send_images,is_active,game_mode")
      .eq("id", gameId)
      .maybeSingle();

    if (gameError) throw gameError;
    if (!game) return NextResponse.json({ error: "Rate-Kategorie nicht gefunden." }, { status: 404 });

    const { data: people, error: peopleError } = await sb
      .from("guess_people")
      .select("id,display_name,aliases,distractors,auto_fill_choices,sort_order")
      .eq("game_id", game.id)
      .order("sort_order");
    if (peopleError) throw peopleError;
    if (!people?.length) return NextResponse.json({ error: "In dieser Kategorie wurde noch keine Influencerin angelegt." }, { status: 400 });

    const ids = people.map((person) => person.id);
    const { data: media, error: mediaError } = await sb
      .from("guess_media")
      .select("id,person_id,media_url,media_type,hint_level,sort_order")
      .in("person_id", ids)
      .order("hint_level");
    if (mediaError) throw mediaError;

    const { data: choicePoolRows } = await sb.from("guess_people").select("display_name").limit(100);
    const choicePool: string[] = Array.from(new Set<string>((choicePoolRows ?? []).map((row) => String(row.display_name || "").trim()).filter(Boolean)));

    const rounds = people.map((person, roundIndex) => {
      const personMedia = (media ?? []).filter((entry) => entry.person_id === person.id);
      const configuredMode = ["free_text", "multiple_choice", "mixed"].includes(game.answer_mode) ? game.answer_mode : "free_text";
      const answerMode = configuredMode === "mixed" ? (roundIndex % 2 === 0 ? "free_text" : "multiple_choice") : configuredMode;
      const manual = Array.isArray(person.distractors) ? person.distractors.map((value: unknown) => String(value).trim()).filter(Boolean) : [];
      const automatic = person.auto_fill_choices === false ? [] : shuffled(choicePool.filter((name) => name.toLocaleLowerCase("de") !== person.display_name.toLocaleLowerCase("de") && !manual.some((manualName: string) => manualName.toLocaleLowerCase("de") === name.toLocaleLowerCase("de"))));
      const distractors = Array.from(new Set([...manual, ...automatic])).slice(0, 3);
      return {
        personId: person.id,
        answerMode: answerMode === "multiple_choice" && distractors.length < 2 ? "free_text" : answerMode,
        choices: shuffled([person.display_name, ...distractors]),
        media: personMedia,
      };
    });

    const playableRounds = rounds.filter((round) => round.media.length > 0);
    if (!playableRounds.length) return NextResponse.json({ error: "Für diese Kategorie fehlen noch Bildausschnitte oder Tipps." }, { status: 400 });

    return NextResponse.json({ game, rounds: playableRounds });
  } catch (error) {
    console.error("Guess game API error:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Spiel konnte nicht geladen werden." }, { status: 500 });
  }
}
