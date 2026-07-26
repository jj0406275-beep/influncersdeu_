"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export default function GuessPage() {
  const [data, setData] = useState<any>(null);
  const [i, setI] = useState(0);
  const [answer, setAnswer] = useState("");
  const [result, setResult] = useState<any>(null);
  const [submitting, setSubmitting] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [hint, setHint] = useState(0);
  const resultRef = useRef<HTMLDivElement | null>(null);
  const params = useMemo(
    () => new URLSearchParams(typeof location !== "undefined" ? location.search : ""),
    []
  );
  const gameId = params.get("game_id") ?? params.get("gameId");
  const chatId = params.get("chat_id") ?? params.get("chatId");

  useEffect(() => {
    const tg = window.Telegram?.WebApp as any;

    const syncViewport = () => {
      const height = tg?.viewportStableHeight || tg?.viewportHeight || window.visualViewport?.height || window.innerHeight;
      document.documentElement.style.setProperty("--guess-app-height", `${Math.round(height)}px`);
    };

    tg?.ready();
    tg?.expand();
    syncViewport();
    tg?.onEvent?.("viewportChanged", syncViewport);
    window.visualViewport?.addEventListener("resize", syncViewport);
    window.addEventListener("orientationchange", syncViewport);

    fetch("/api/guess/game", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: tg?.initData ?? "", gameId }),
    })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Spiel konnte nicht geladen werden.");
        return payload;
      })
      .then(setData)
      .catch((error) => setLoadError(error instanceof Error ? error.message : "Spiel konnte nicht geladen werden."));

    return () => {
      tg?.offEvent?.("viewportChanged", syncViewport);
      window.visualViewport?.removeEventListener("resize", syncViewport);
      window.removeEventListener("orientationchange", syncViewport);
    };
  }, [gameId]);

  useEffect(() => {
    if (!result) return;
    (document.activeElement as HTMLElement | null)?.blur?.();
    window.setTimeout(() => {
      resultRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 120);
  }, [result]);

  if (loadError) return <main className="app-shell guess-shell"><section className="guess-card"><h1>Fehler</h1><p>{loadError}</p><button type="button" onClick={() => window.location.reload()}>Erneut versuchen</button></section></main>;
  if (!data) return <main className="app-shell guess-shell"><section className="guess-card"><p>Spiel wird geladen …</p></section></main>;
  if (data.error) return <main className="app-shell guess-shell"><section className="guess-card"><h1>Fehler</h1><p>{data.error}</p></section></main>;

  const round = data.rounds[i];
  if (!round) return <main className="app-shell guess-shell"><h1>Geschafft 🎉</h1></main>;

  const media = round.media[Math.min(hint, round.media.length - 1)];
  const answerMode = round.answerMode ?? data.game.answer_mode;

  async function check(value = answer) {
    const cleaned = value.replace(/\s+/g, " ").trim();
    if (!cleaned || submitting) return;
    setSubmitting(true);
    const tg = window.Telegram?.WebApp as any;
    const response = await fetch("/api/guess/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        initData: tg?.initData ?? "",
        gameId,
        personId: round.personId,
        answer: cleaned,
        chatId,
      }),
    });
    const payload = await response.json();
    setSubmitting(false);
    if (!response.ok) {
      setResult({ error: payload.error || "Antwort konnte nicht geprüft werden." });
      return;
    }
    setAnswer(cleaned);
    setResult(payload);
  }

  function nextRound() {
    setI((value) => value + 1);
    setAnswer("");
    setResult(null);
    setHint(0);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <main className="app-shell guess-shell">
      <section className="hero">
        <span className="eyebrow">🧩 INFLUENCERIN ERRATEN</span>
        <h1>{data.game.title}</h1>
        <p>Runde {i + 1} von {data.rounds.length}</p>
      </section>

      <section className="guess-card">
        {media?.media_type === "animation" ? (
          <video src={media.media_url} autoPlay loop muted playsInline />
        ) : (
          <img src={media?.media_url} alt="Bildausschnitt oder Tipp" />
        )}

        <div className="guess-controls">
          {answerMode === "multiple_choice" ? (
            round.choices.map((choice: string) => (
              <button key={choice} type="button" disabled={Boolean(result) || submitting} onClick={() => check(choice)}>
                {choice}
              </button>
            ))
          ) : (
            <>
              <input
                value={answer}
                onChange={(event) => setAnswer(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") check();
                }}
                disabled={Boolean(result) || submitting}
                placeholder="Vor- und Nachname oder @Handle"
                autoComplete="name"
                autoCorrect="on"
                autoCapitalize="words"
                enterKeyHint="done"
                spellCheck={false}
              />
              <p className="guess-helper">Tippfehler und bekannte alternative Schreibweisen werden berücksichtigt.</p>
              <button type="button" disabled={Boolean(result) || submitting || !answer.trim()} onClick={() => check()}>
                {submitting ? "Wird geprüft …" : "Antwort prüfen"}
              </button>
            </>
          )}

          {data.game.hints_enabled && hint < round.media.length - 1 && !result && (
            <button type="button" onClick={() => setHint((value) => value + 1)}>
              Größeren Ausschnitt / Tipp zeigen
            </button>
          )}
        </div>

        {result && (
          <div className="result-box" ref={resultRef} aria-live="polite">
            <strong>{result.error ? "❌ Fehler" : result.correct ? "✅ Richtig" : "❌ Noch nicht richtig"}</strong>
            {result.error && <p>{result.error}</p>}
            {result.suggestion && <p>Meintest du „{result.suggestion}“?</p>}
            <p>Lösung: {result.correctName}</p>
            <p>Punkte: {result.points ?? 0}</p>
            <button type="button" onClick={nextRound}>Weiter</button>
          </div>
        )}
      </section>
    </main>
  );
}
