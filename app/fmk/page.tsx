"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Role = "fuck" | "marry" | "kill";
type Item = { id: string; title: string; image: string };
type SelectionEntry = { itemId: string; role: Role };
type CommunityItem = Item & { itemId: string; fuck: number; marry: number; kill: number };
type GameData = {
  categoryId: string;
  title: string;
  items: Item[];
  alreadyVoted: boolean;
  previousSelection: SelectionEntry[] | null;
  community: CommunityItem[] | null;
  totalVotes: number;
};
type TelegramWebApp = {
  ready: () => void;
  expand: () => void;
  initData: string;
  close: () => void;
  setHeaderColor?: (color: string) => void;
  setBackgroundColor?: (color: string) => void;
  HapticFeedback?: { impactOccurred: (style: string) => void };
};

declare global {
  interface Window {
    Telegram?: { WebApp: TelegramWebApp };
  }
}

const ROLES: Array<{ value: Role; label: string; emoji: string }> = [
  { value: "fuck", label: "Fuck", emoji: "🔥" },
  { value: "marry", label: "Marry", emoji: "❤️" },
  { value: "kill", label: "Kill", emoji: "💀" }
];

function roleLabel(role: Role) {
  return ROLES.find((entry) => entry.value === role) ?? ROLES[0];
}

function useEqualImageHeight() {
  const gridRef = useRef<HTMLElement | null>(null);

  const equalize = useCallback(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const wrappers = Array.from(grid.querySelectorAll<HTMLElement>(".fmk-image-wrap"));
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

export default function FmkPage() {
  const { gridRef, equalize } = useEqualImageHeight();
  const [game, setGame] = useState<GameData | null>(null);
  const [loadError, setLoadError] = useState("");
  const [chatId, setChatId] = useState<string | null>(null);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [telegramInitData, setTelegramInitData] = useState("");
  const [selection, setSelection] = useState<Record<string, Role | undefined>>({});
  const [sharing, setSharing] = useState(false);
  const [status, setStatus] = useState("");
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadGame() {
      const webApp = window.Telegram?.WebApp;
      webApp?.ready();
      webApp?.expand();
      webApp?.setHeaderColor?.("#120c12");
      webApp?.setBackgroundColor?.("#120c12");

      const params = new URLSearchParams(window.location.search);
      const requestedChatId = params.get("chat_id");
      const requestedCategoryId = params.get("category_id");
      setChatId(requestedChatId);
      setCategoryId(requestedCategoryId);

      let initData = "";
      const deadline = Date.now() + 4000;
      while (!initData && Date.now() < deadline && !cancelled) {
        initData = window.Telegram?.WebApp?.initData?.trim() ?? "";
        if (!initData) await new Promise((resolve) => window.setTimeout(resolve, 100));
      }

      if (cancelled) return;
      if (!initData) {
        throw new Error("Telegram-Anmeldedaten wurden nicht geladen. Bitte die Mini App schließen und erneut über den aktuellen FMK-Button öffnen.");
      }
      setTelegramInitData(initData);

      const response = await fetch("/api/fmk/game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ initData, chatId: requestedChatId, categoryId: requestedCategoryId })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "FMK-Spiel konnte nicht geladen werden.");
      if (!Array.isArray(data.items) || data.items.length !== 3) {
        throw new Error("Ein FMK-Spiel muss genau drei Personen enthalten.");
      }

      if (!cancelled) {
        setGame(data as GameData);
        if (Array.isArray(data.previousSelection)) {
          setSelection(Object.fromEntries(data.previousSelection.map((entry: SelectionEntry) => [entry.itemId, entry.role])));
        }
      }
    }

    loadGame().catch((error) => {
      if (!cancelled) setLoadError(error instanceof Error ? error.message : "Unbekannter Ladefehler");
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const selectedRoles = useMemo(() => new Set(Object.values(selection).filter(Boolean)), [selection]);
  const complete = game?.items.every((item) => Boolean(selection[item.id])) ?? false;
  const showResults = Boolean(game?.alreadyVoted || submitted);

  function choose(itemId: string, role: Role) {
    setSelection((current) => {
      const next = { ...current };
      for (const [otherItemId, assignedRole] of Object.entries(next)) {
        if (otherItemId !== itemId && assignedRole === role) next[otherItemId] = undefined;
      }
      next[itemId] = current[itemId] === role ? undefined : role;
      return next;
    });
    window.Telegram?.WebApp.HapticFeedback?.impactOccurred("medium");
  }

  async function submit() {
    if (!game || !complete) return;
    setSharing(true);
    setStatus("Deine Auswahl wird gesendet …");

    try {
      const payload: SelectionEntry[] = game.items.map((item) => ({
        itemId: item.id,
        role: selection[item.id] as Role
      }));
      const response = await fetch("/api/fmk/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          initData: telegramInitData || window.Telegram?.WebApp?.initData || "",
          chatId,
          categoryId: game.categoryId ?? categoryId,
          selection: payload
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Senden fehlgeschlagen.");

      setSubmitted(true);
      setStatus("✅ Deine Auswahl wurde in die Gruppe gesendet.");
      window.Telegram?.WebApp.HapticFeedback?.impactOccurred("heavy");

      const refresh = await fetch("/api/fmk/game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ initData: telegramInitData, chatId, categoryId: game.categoryId })
      });
      const refreshed = await refresh.json();
      if (refresh.ok) setGame(refreshed as GameData);
    } catch (error) {
      setStatus(`❌ ${error instanceof Error ? error.message : "Unbekannter Fehler"}`);
    } finally {
      setSharing(false);
    }
  }

  if (loadError) {
    return (
      <main className="fmk-shell">
        <section className="fmk-panel fmk-error">
          <p className="fmk-eyebrow">Fuck · Marry · Kill</p>
          <h1>Spiel konnte nicht geladen werden</h1>
          <p>{loadError}</p>
          <button className="fmk-submit" onClick={() => window.location.reload()}>Erneut versuchen</button>
        </section>
      </main>
    );
  }

  if (!game) {
    return (
      <main className="fmk-shell">
        <section className="fmk-panel fmk-loading">
          <div className="fmk-loader" aria-hidden="true" />
          <p>FMK-Spiel wird geladen …</p>
        </section>
      </main>
    );
  }

  return (
    <main className="fmk-shell">
      <header className="fmk-header">
        <p className="fmk-eyebrow">🔥 Fuck · ❤️ Marry · 💀 Kill</p>
        <h1>{game.title}</h1>
        <p>Vergib jede Rolle genau einmal.</p>
      </header>

      <section ref={gridRef} className="fmk-grid" aria-label="FMK-Auswahl">
        {game.items.map((item) => {
          const assigned = selection[item.id];
          return (
            <article className={`fmk-card${assigned ? ` is-${assigned}` : ""}`} key={item.id}>
              <div className="fmk-image-wrap">
                <img src={item.image} alt={item.title} onLoad={equalize} />
                {assigned && <span className="fmk-assigned" aria-label={roleLabel(assigned).label}>{roleLabel(assigned).emoji}</span>}
              </div>
              <div className="fmk-card-body">
                <h2>{item.title}</h2>
                <div className="fmk-role-list">
                  {ROLES.map((role) => {
                    const active = assigned === role.value;
                    const usedElsewhere = selectedRoles.has(role.value) && !active;
                    return (
                      <button
                        type="button"
                        className={`fmk-role is-${role.value}${active ? " is-active" : ""}`}
                        key={role.value}
                        disabled={showResults || sharing || usedElsewhere}
                        aria-pressed={active}
                        onClick={() => choose(item.id, role.value)}
                      >
                        <span>{role.emoji}</span>
                        {role.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </article>
          );
        })}
      </section>

      {!showResults && (
        <section className="fmk-action-bar">
          <div>
            <strong>{Object.values(selection).filter(Boolean).length}/3 Rollen vergeben</strong>
            <span>{complete ? "Bereit zum Abstimmen" : "Jede Rolle darf nur einmal vorkommen"}</span>
          </div>
          <button className="fmk-submit" disabled={!complete || sharing} onClick={submit}>
            {sharing ? "Wird gesendet …" : "Einmalig abstimmen"}
          </button>
        </section>
      )}

      {status && <p className="fmk-status" role="status">{status}</p>}

      {showResults && game.community && (
        <section className="fmk-results">
          <div className="fmk-results-heading">
            <p className="fmk-eyebrow">Community-Ergebnis</p>
            <h2>{game.totalVotes} {game.totalVotes === 1 ? "Stimme" : "Stimmen"}</h2>
          </div>
          <div className="fmk-results-grid">
            {game.community.map((item) => (
              <article className="fmk-result-card" key={item.itemId}>
                <div className="fmk-result-image">
                  <img src={item.image} alt={item.title} onLoad={equalize} />
                </div>
                <div>
                  <h3>{item.title}</h3>
                  <p><span>🔥 Fuck</span><strong>{item.fuck}%</strong></p>
                  <p><span>❤️ Marry</span><strong>{item.marry}%</strong></p>
                  <p><span>💀 Kill</span><strong>{item.kill}%</strong></p>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
