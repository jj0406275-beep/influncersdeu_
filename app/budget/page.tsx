"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Item = { id: string; name: string; image: string; price: number };
type Community = { itemId: string; percent: number };
type Game = {
  gameId: string; title: string; budget: number; currency: string;
  minSelections: number | null; maxSelections: number | null;
  items: Item[]; alreadyVoted: boolean; previousSelection: string[] | null;
  totalVotes: number; averageSpent: number; community: Community[];
};

function useEqualImageHeight() {
  const gridRef = useRef<HTMLElement | null>(null);

  const equalize = useCallback(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const wrappers = Array.from(grid.querySelectorAll<HTMLElement>(".budget-image"));
    wrappers.forEach((wrapper) => { wrapper.style.height = "auto"; });
    const heights = wrappers.map((wrapper) => {
      const image = wrapper.querySelector<HTMLImageElement>("img");
      return image?.getBoundingClientRect().height ?? 0;
    });
    const maxHeight = Math.max(0, ...heights);
    if (maxHeight > 0) wrappers.forEach((wrapper) => { wrapper.style.height = `${Math.ceil(maxHeight)}px`; });
  }, []);

  useEffect(() => {
    const onResize = () => requestAnimationFrame(equalize);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [equalize]);

  return { gridRef, equalize };
}

export default function BudgetPage() {
  const { gridRef, equalize } = useEqualImageHeight();
  const [game, setGame] = useState<Game | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [initData, setInitData] = useState("");
  const [chatId, setChatId] = useState<string | null>(null);
  const [gameId, setGameId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [sending, setSending] = useState(false);

  async function load(currentInitData?: string) {
    const params = new URLSearchParams(window.location.search);
    const requestedChatId = params.get("chat_id");
    const requestedGameId = params.get("game_id");
    setChatId(requestedChatId); setGameId(requestedGameId);
    let auth = currentInitData ?? "";
    const deadline = Date.now() + 4000;
    while (!auth && Date.now() < deadline) {
      auth = (window as any).Telegram?.WebApp?.initData?.trim() ?? "";
      if (!auth) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!auth) throw new Error("Telegram-Anmeldedaten fehlen. Bitte das Spiel erneut über den aktuellen Bot-Button öffnen.");
    setInitData(auth);
    const response = await fetch("/api/budget/game", { method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store", body: JSON.stringify({ initData: auth, chatId: requestedChatId, gameId: requestedGameId }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Budget-Spiel konnte nicht geladen werden.");
    setGame(data);
    setSelected(new Set(data.previousSelection ?? []));
  }

  useEffect(() => {
    (window as any).Telegram?.WebApp?.ready(); (window as any).Telegram?.WebApp?.expand();
    load().catch((reason) => setError(reason instanceof Error ? reason.message : "Unbekannter Fehler"));
  }, []);

  const spent = useMemo(() => game?.items.filter((item) => selected.has(item.id)).reduce((sum, item) => sum + item.price, 0) ?? 0, [game, selected]);

  useEffect(() => {
    requestAnimationFrame(equalize);
  }, [game, equalize]);
  const remaining = (game?.budget ?? 0) - spent;
  const validCount = Boolean(game && (!game.minSelections || selected.size >= game.minSelections) && (!game.maxSelections || selected.size <= game.maxSelections));

  function toggle(item: Item) {
    if (!game || game.alreadyVoted) return;
    const next = new Set(selected);
    if (next.has(item.id)) next.delete(item.id);
    else {
      if (item.price > remaining) return;
      if (game.maxSelections && next.size >= game.maxSelections) return;
      next.add(item.id);
    }
    setSelected(next);
    (window as any).Telegram?.WebApp?.HapticFeedback?.impactOccurred("medium");
  }

  async function submit() {
    if (!game || !validCount || spent > game.budget || selected.size === 0) return;
    setSending(true); setStatus("Auswahl wird gespeichert …");
    try {
      const response = await fetch("/api/budget/share", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initData, chatId, gameId: game.gameId, selectedItemIds: [...selected] }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Senden fehlgeschlagen.");
      setStatus("✅ Deine Auswahl wurde in die Gruppe gesendet.");
      await load(initData);
    } catch (reason) { setStatus(`❌ ${reason instanceof Error ? reason.message : "Unbekannter Fehler"}`); }
    finally { setSending(false); }
  }

  const money = (value: number) => `${value.toLocaleString("de-DE")} ${game?.currency ?? "€"}`;
  if (error) return <main className="budget-shell"><section className="budget-error"><h1>Spiel konnte nicht geladen werden</h1><p>{error}</p><button onClick={() => location.reload()}>Erneut versuchen</button></section></main>;
  if (!game) return <main className="budget-shell"><section className="budget-loading">💰 Budget Challenge wird geladen …</section></main>;

  return <main className="budget-shell">
    <header className="budget-header">
      <p className="budget-kicker">💰 INFLUENCERINNEN · BUDGET CHALLENGE</p>
      <h1>{game.title}</h1>
      <p>Wähle die Influencerinnen, die du am besten findest – ohne dein Budget zu überschreiten.</p>
    </header>

    <section className="budget-meter">
      <div><span>Verfügbar</span><strong>{money(remaining)}</strong></div>
      <div><span>Ausgegeben</span><strong>{money(spent)}</strong></div>
      <div><span>Auswahl</span><strong>{selected.size}</strong></div>
    </section>

    <section ref={gridRef} className="budget-grid">
      {game.items.map((item) => {
        const active = selected.has(item.id);
        const unavailable = !active && (item.price > remaining || Boolean(game.maxSelections && selected.size >= game.maxSelections));
        const percent = game.community.find((entry) => entry.itemId === item.id)?.percent ?? 0;
        return <article className={`budget-card${active ? " is-selected" : ""}${unavailable ? " is-disabled" : ""}`} key={item.id}>
          <div className="budget-image"><img src={item.image} alt={item.name} onLoad={equalize}/>{active && <span>✓</span>}</div>
          <div className="budget-card-body"><h2>{item.name}</h2><strong className="budget-price">{money(item.price)}</strong>
            {game.alreadyVoted ? <div className="budget-community"><span>Von der Community gewählt</span><strong>{percent}%</strong></div> :
              <button type="button" disabled={unavailable || sending} onClick={() => toggle(item)}>{active ? "Entfernen" : unavailable ? "Nicht verfügbar" : "Auswählen"}</button>}
          </div>
        </article>;
      })}
    </section>

    {!game.alreadyVoted && <section className="budget-action">
      <div><strong>{remaining < 0 ? "Budget überschritten" : validCount && selected.size ? "Auswahl bereit" : "Wähle deine Favoritinnen"}</strong><span>{game.minSelections ? `Mindestens ${game.minSelections}` : "Freie Auswahl"}{game.maxSelections ? ` · maximal ${game.maxSelections}` : ""}</span></div>
      <button disabled={sending || remaining < 0 || !validCount || selected.size === 0} onClick={submit}>{sending ? "Wird gesendet …" : "Auswahl bestätigen"}</button>
    </section>}

    {status && <p className="budget-status">{status}</p>}
    {game.alreadyVoted && <section className="budget-result"><h2>📊 Community-Ergebnis</h2><p>{game.totalVotes} {game.totalVotes === 1 ? "Stimme" : "Stimmen"} · Ø ausgegeben: <b>{money(game.averageSpent)}</b></p></section>}
  </main>;
}
