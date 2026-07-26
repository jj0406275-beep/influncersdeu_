import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin, IMAGE_BUCKET } from "../../../../lib/supabase";

type TelegramChat = { id: number; type: "private" | "group" | "supergroup" | "channel"; title?: string };
type TelegramUser = { id: number; username?: string; first_name?: string };
type TelegramPhoto = { file_id: string; width: number; height: number };
type TelegramMessage = {
  message_id: number;
  text?: string;
  caption?: string;
  chat?: TelegramChat;
  from?: TelegramUser;
  photo?: TelegramPhoto[];
  message_thread_id?: number;
  is_topic_message?: boolean;
};
type CallbackQuery = {
  id: string;
  from: TelegramUser;
  data?: string;
  message?: TelegramMessage;
};
type TelegramUpdate = { message?: TelegramMessage; callback_query?: CallbackQuery };

type CategoryRow = { id: string; name: string; game_type?: "blind_ranking" | "fmk" };
type SessionRow = {
  category_id: string | null;
  mode: string;
  pending_file_id: string | null;
  pending_item_id: string | null;
};

type BotRole = "owner" | "creator" | "player";
type BotUserRow = { user_id: number; role: BotRole; active: boolean; username?: string | null; display_name?: string | null; category_limit?: number | null; categories_used?: number | null };

function configuredGroupId(): number {
  const value = Number(process.env.ALLOWED_TELEGRAM_GROUP_ID);
  if (!Number.isSafeInteger(value) || value >= 0) {
    throw new Error("ALLOWED_TELEGRAM_GROUP_ID fehlt oder ist ungültig.");
  }
  return value;
}

function isConfiguredGroup(chatId: string | number): boolean {
  try { return Number(chatId) === configuredGroupId(); } catch { return false; }
}

function tokenHash(value: string) {
  return crypto.createHash("sha256").update(value.trim().toUpperCase()).digest("hex");
}

function newInviteToken() {
  const raw = crypto.randomBytes(9).toString("base64url").toUpperCase();
  return `BR-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

async function getRole(userId: number, ownerId: number): Promise<BotRole> {
  if (userId === ownerId) return "owner";
  const { data, error } = await getSupabaseAdmin().from("bot_users").select("role,active").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  if (data?.active && data.role === "owner") return "owner";
  if (data?.active && data.role === "creator") return "creator";
  return "player";
}

async function saveCreator(user: TelegramUser, approvedBy: number, categoryLimit: number | null) {
  const displayName = user.first_name || user.username || String(user.id);
  const { error } = await getSupabaseAdmin().from("bot_users").upsert({
    user_id: user.id,
    role: "creator",
    active: true,
    username: user.username ?? null,
    display_name: displayName,
    approved_by: approvedBy,
    category_limit: categoryLimit,
    updated_at: new Date().toISOString()
  }, { onConflict: "user_id" });
  if (error) throw error;
}

async function getCreatorQuota(userId: number) {
  const { data, error } = await getSupabaseAdmin().from("bot_users")
    .select("category_limit,categories_used,active,role")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data?.active || data.role !== "creator") return null;
  return { limit: data.category_limit as number | null, used: Number(data.categories_used ?? 0) };
}

async function assertCreatorCanCreate(userId: number, role: BotRole) {
  if (role === "owner") return;
  if (role !== "creator") throw new Error("Nur Owner oder Creator dürfen Kategorien erstellen.");
  const quota = await getCreatorQuota(userId);
  if (!quota) throw new Error("Dein Creator-Zugang ist nicht aktiv.");
  if (quota.limit !== null && quota.used >= quota.limit) {
    throw new Error(`Dein Kategorienkontingent ist aufgebraucht (${quota.used}/${quota.limit}).`);
  }
}

async function incrementCreatorUsage(userId: number, role: BotRole) {
  if (role !== "creator") return;
  const quota = await getCreatorQuota(userId);
  if (!quota) throw new Error("Creator-Konto nicht gefunden.");
  const { error } = await getSupabaseAdmin().from("bot_users")
    .update({ categories_used: quota.used + 1, updated_at: new Date().toISOString() })
    .eq("user_id", userId);
  if (error) throw error;
}

async function canManageCategory(userId: number, role: BotRole, categoryId: string) {
  if (role === "owner") return true;
  if (role !== "creator") return false;
  const { data, error } = await getSupabaseAdmin().from("categories").select("created_by").eq("id", categoryId).maybeSingle();
  if (error) throw error;
  return Number(data?.created_by) === userId;
}

async function canManageItem(userId: number, role: BotRole, itemId: string) {
  if (role === "owner") return true;
  if (role !== "creator") return false;
  const { data, error } = await getSupabaseAdmin().from("items").select("category_id,categories!inner(created_by)").eq("id", itemId).maybeSingle();
  if (error) throw error;
  const categories = data?.categories as unknown as { created_by?: number } | null;
  return Number(categories?.created_by) === userId;
}

async function telegramApi(token: string, method: string, payload: unknown) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.description || `Telegram API error in ${method}`);
  return data.result;
}

async function send(token: string, chatId: string | number, text: string, extra: Record<string, unknown> = {}) {
  return telegramApi(token, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML", ...extra });
}


type ShareGameKind = "b" | "f" | "u" | "g" | "p";

function shareKindLabel(kind: ShareGameKind) {
  return kind === "b" ? "Blind Ranking" : kind === "f" ? "Fuck, Marry, Kill" : kind === "u" ? "Budget Challenge" : kind === "g" ? "Influencerin erraten" : "Position Ranking";
}

async function registerKnownGroup(chat: TelegramChat) {
  if (chat.type !== "group" && chat.type !== "supergroup") return;
  if (!isConfiguredGroup(chat.id)) return;
  await getSupabaseAdmin().from("bot_groups").upsert({
    chat_id: chat.id,
    title: chat.title || `Gruppe ${chat.id}`,
    chat_type: chat.type,
    active: true,
    last_seen_at: new Date().toISOString()
  }, { onConflict: "chat_id" });
}


async function syncKnownGroups(token: string) {
  const supabase = getSupabaseAdmin();
  const ids = new Set<number>();

  const sources = await Promise.all([
    supabase.from("bot_groups").select("chat_id").limit(500),
    supabase.from("group_topic_settings").select("chat_id").limit(500),
    supabase.from("votes").select("chat_id").limit(500),
    supabase.from("budget_votes").select("chat_id").limit(500),
    supabase.from("guess_answers").select("chat_id").limit(500),
    supabase.from("position_votes").select("chat_id").limit(500),
  ]);

  for (const source of sources) {
    for (const row of source.data ?? []) {
      const value = Number((row as { chat_id?: string | number }).chat_id);
      if (Number.isSafeInteger(value) && value < 0) ids.add(value);
    }
  }

  let synced = 0;
  for (const chatId of ids) {
    try {
      const chat = await telegramApi(token, "getChat", { chat_id: chatId });
      if (chat?.type !== "group" && chat?.type !== "supergroup") continue;
      const bot = await telegramApi(token, "getMe", {});
      const botMember = await telegramApi(token, "getChatMember", { chat_id: chatId, user_id: bot.id });
      const active = !["left", "kicked"].includes(botMember?.status);
      await supabase.from("bot_groups").upsert({
        chat_id: chatId,
        title: chat.title || `Gruppe ${chatId}`,
        chat_type: chat.type,
        active,
        last_seen_at: new Date().toISOString(),
      }, { onConflict: "chat_id" });
      if (active) synced += 1;
    } catch {
      await supabase.from("bot_groups").update({ active: false, last_seen_at: new Date().toISOString() }).eq("chat_id", chatId);
    }
  }
  return synced;
}

function miniAppUrlFor(kind: ShareGameKind, gameId: string, chatId: string | number) {
  const raw = process.env.NEXT_PUBLIC_APP_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL || "";
  const base = raw.startsWith("http") ? raw : `https://${raw}`;
  const path = kind === "f" ? "/fmk" : kind === "u" ? "/budget" : kind === "g" ? "/guess" : kind === "p" ? "/position" : "";
  const idParam = kind === "u" || kind === "g" || kind === "p" ? "game_id" : "category_id";
  return `${base.replace(/\/$/, "")}${path}/?chat_id=${encodeURIComponent(String(chatId))}&${idParam}=${encodeURIComponent(gameId)}`;
}

async function canManageShareGame(userId: number, role: BotRole, kind: ShareGameKind, gameId: string) {
  if (role === "owner") return true;
  if (role !== "creator") return false;
  const supabase = getSupabaseAdmin();
  if (kind === "b" || kind === "f") {
    const { data } = await supabase.from("categories").select("created_by,game_type").eq("id", gameId).maybeSingle();
    return Number(data?.created_by) === userId && data?.game_type === (kind === "f" ? "fmk" : "blind_ranking");
  }
  if (kind === "u") {
    const { data } = await supabase.from("budget_games").select("creator_id").eq("id", gameId).maybeSingle();
    return Number(data?.creator_id) === userId;
  }
  if (kind === "g") {
    const { data } = await supabase.from("guess_games").select("creator_id").eq("id", gameId).maybeSingle();
    return Number(data?.creator_id) === userId;
  }
  const { data } = await supabase.from("position_games").select("creator_id").eq("id", gameId).maybeSingle();
  return Number(data?.creator_id) === userId;
}

async function getShareGameTitle(kind: ShareGameKind, gameId: string) {
  const supabase = getSupabaseAdmin();
  if (kind === "b" || kind === "f") {
    const { data } = await supabase.from("categories").select("name,game_type").eq("id", gameId).maybeSingle();
    if (!data || data.game_type !== (kind === "f" ? "fmk" : "blind_ranking")) return null;
    return data.name as string;
  }
  if (kind === "u") {
    const { data } = await supabase.from("budget_games").select("title").eq("id", gameId).maybeSingle();
    return data?.title as string | undefined ?? null;
  }
  if (kind === "g") {
    const { data } = await supabase.from("guess_games").select("title").eq("id", gameId).maybeSingle();
    return data?.title as string | undefined ?? null;
  }
  const { data } = await supabase.from("position_games").select("title").eq("id", gameId).maybeSingle();
  return data?.title as string | undefined ?? null;
}

async function telegramAdminCheck(token: string, chatId: number, userId: number) {
  try {
    const userMember = await telegramApi(token, "getChatMember", { chat_id: chatId, user_id: userId });
    const bot = await telegramApi(token, "getMe", {});
    const botMember = await telegramApi(token, "getChatMember", { chat_id: chatId, user_id: bot.id });
    const userAllowed = userMember?.status === "administrator" || userMember?.status === "creator";
    const botAllowed = botMember?.status === "administrator" || botMember?.status === "creator";
    return { userAllowed, botAllowed };
  } catch {
    return { userAllowed: false, botAllowed: false };
  }
}

async function showGroupPicker(token: string, privateChatId: string | number, userId: number, role: BotRole, kind: ShareGameKind, gameId: string, back: string) {
  if (role !== "owner") return send(token, privateChatId, "Nur Owner dürfen Spiele in der Gruppe starten.");
  if (!(await canManageShareGame(userId, role, kind, gameId))) return send(token, privateChatId, "Du darfst dieses Spiel nicht starten.");
  const title = await getShareGameTitle(kind, gameId);
  if (!title) return send(token, privateChatId, "Spiel nicht gefunden.");

  const groupId = configuredGroupId();
  const check = await telegramAdminCheck(token, groupId, userId);
  if (!check.userAllowed) return send(token, privateChatId, "Du bist in der festgelegten Gruppe nicht mehr Administrator oder Eigentümer.", { reply_markup: { inline_keyboard: [backButton(back)] } });
  if (!check.botAllowed) return send(token, privateChatId, "Der Bot muss in der festgelegten Gruppe Administrator sein.", { reply_markup: { inline_keyboard: [backButton(back)] } });

  let groupTitle = String(groupId);
  try {
    const chat = await telegramApi(token, "getChat", { chat_id: groupId });
    groupTitle = chat?.title || groupTitle;
    await registerKnownGroup({ id: groupId, type: chat.type, title: chat.title });
  } catch {}

  return send(token, privateChatId, `<b>📣 In feste Gruppe starten</b>

Spiel: <b>${escapeHtml(title)}</b>
Gruppe: <b>${escapeHtml(groupTitle)}</b>

Dieser Bot teilt Spiele ausschließlich in diese fest konfigurierte Gruppe.`, { reply_markup: { inline_keyboard: [
    [{ text: "✅ Jetzt in Gruppe starten", callback_data: `cg:${kind}|${gameId}|${groupId}` }],
    backButton(back)
  ] } });
}

async function sendGameToGroup(token: string, kind: ShareGameKind, gameId: string, groupId: number) {
  if (groupId !== configuredGroupId()) throw new Error("Diese Gruppe ist für diesen Bot nicht freigegeben.");
  const title = await getShareGameTitle(kind, gameId);
  if (!title) throw new Error("Spiel nicht gefunden.");
  const bot = await telegramApi(token, "getMe", {});
  const payloadType = kind === "b" ? "group" : kind === "f" ? "fmk" : kind === "u" ? "budget" : kind === "g" ? "guess" : "position";
  const deepLink = `https://t.me/${bot.username}?start=${payloadType}_${groupId}_${gameId}`;
  const heading = kind === "b" ? "🎲 <b>Blind Ranking</b>" : kind === "f" ? "🔥 <b>Fuck, Marry, Kill</b>" : kind === "u" ? "💰 <b>Budget Challenge</b>" : kind === "g" ? "🧩 <b>Influencerin erraten</b>" : "📍 <b>Position Ranking</b>";
  const button = kind === "b" ? "🎮 Blind Ranking starten" : kind === "f" ? "🔥 FMK starten" : kind === "u" ? "💰 Budget-Spiel starten" : kind === "g" ? "🧩 Ratespiel starten" : "📍 Position Ranking starten";
  const topicSettings = await getGroupTopicSettings(groupId);
  await send(token, groupId, `${heading}\nSpiel: <b>${escapeHtml(title)}</b>\n\nTippe auf den Button, um mitzuspielen.`, { ...topicExtra(topicSettings.poll_thread_id), reply_markup: { inline_keyboard: [[{ text: button, url: deepLink }]] } });
}

async function lookupTelegramUser(token: string, userId: number): Promise<TelegramUser> {
  try {
    const chat = await telegramApi(token, "getChat", { chat_id: userId });
    return { id: userId, username: chat.username, first_name: chat.first_name || chat.title };
  } catch {
    return { id: userId };
  }
}

function backButton(callbackData: string, text = "⬅️ Zurück") {
  return [{ text, callback_data: callbackData }];
}

type GroupTopicSettings = { poll_thread_id: number | null; results_thread_id: number | null };

async function getGroupTopicSettings(chatId: string | number): Promise<GroupTopicSettings> {
  const { data, error } = await getSupabaseAdmin()
    .from("group_topic_settings")
    .select("poll_thread_id,results_thread_id")
    .eq("chat_id", String(chatId))
    .maybeSingle();
  if (error) throw error;
  return {
    poll_thread_id: data?.poll_thread_id ?? null,
    results_thread_id: data?.results_thread_id ?? null
  };
}

async function setGroupTopicSetting(chatId: string | number, field: "poll_thread_id" | "results_thread_id", threadId: number | null) {
  const supabase = getSupabaseAdmin();
  const current = await getGroupTopicSettings(chatId);
  const payload = {
    chat_id: String(chatId),
    poll_thread_id: field === "poll_thread_id" ? threadId : current.poll_thread_id,
    results_thread_id: field === "results_thread_id" ? threadId : current.results_thread_id,
    updated_at: new Date().toISOString()
  };
  const { error } = await supabase.from("group_topic_settings").upsert(payload, { onConflict: "chat_id" });
  if (error) throw error;
}

function topicExtra(threadId: number | null | undefined): Record<string, unknown> {
  return threadId ? { message_thread_id: threadId } : {};
}

async function answerCallback(token: string, callbackQueryId: string, text?: string) {
  return telegramApi(token, "answerCallbackQuery", { callback_query_id: callbackQueryId, text });
}

function escapeHtml(value: string) {
  return value.replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[char] ?? char));
}

function commandArg(text: string) {
  const firstSpace = text.indexOf(" ");
  return firstSpace === -1 ? "" : text.slice(firstSpace + 1).trim();
}

async function uploadTelegramPhoto(token: string, fileId: string, userId: number) {
  const file = await telegramApi(token, "getFile", { file_id: fileId });
  if (!file.file_path) throw new Error("Telegram hat keinen Dateipfad geliefert.");
  const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
  if (!response.ok) throw new Error("Bild konnte nicht von Telegram geladen werden.");
  const arrayBuffer = await response.arrayBuffer();
  const extension = String(file.file_path).split(".").pop()?.toLowerCase() || "jpg";
  const objectPath = `${userId}/${Date.now()}-${crypto.randomUUID()}.${extension}`;
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.storage.from(IMAGE_BUCKET).upload(objectPath, arrayBuffer, {
    contentType: response.headers.get("content-type") || "image/jpeg",
    upsert: false
  });
  if (error) throw error;
  const imageUrl = supabase.storage.from(IMAGE_BUCKET).getPublicUrl(objectPath).data.publicUrl;
  return { imageUrl, objectPath };
}

async function findCategoryByName(
  name: string,
  gameType?: "blind_ranking" | "fmk"
): Promise<CategoryRow | null> {
  if (!name.trim()) return null;
  let query = getSupabaseAdmin()
    .from("categories")
    .select("id,name,game_type")
    .ilike("name", name.trim())
    .limit(1);
  if (gameType) query = query.eq("game_type", gameType);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return data as CategoryRow | null;
}

async function getSession(userId: number): Promise<SessionRow | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("admin_sessions")
    .select("category_id,mode,pending_file_id,pending_item_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data as SessionRow | null;
}

async function setSession(userId: number, values: Partial<SessionRow> & { category_id?: string | null }) {
  const supabase = getSupabaseAdmin();
  const existing = await getSession(userId);
  const payload = {
    user_id: userId,
    category_id: values.category_id ?? existing?.category_id ?? null,
    mode: values.mode ?? existing?.mode ?? "awaiting_photo",
    pending_file_id: values.pending_file_id !== undefined ? values.pending_file_id : existing?.pending_file_id ?? null,
    pending_item_id: values.pending_item_id !== undefined ? values.pending_item_id : existing?.pending_item_id ?? null,
    updated_at: new Date().toISOString()
  };
  const { error } = await supabase.from("admin_sessions").upsert(payload);
  if (error) throw error;
}

async function categoryCount(categoryId: string) {
  const { count, error } = await getSupabaseAdmin().from("items").select("id", { count: "exact", head: true }).eq("category_id", categoryId);
  if (error) throw error;
  return count ?? 0;
}

async function normalizePositions(categoryId: string) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("items").select("id").eq("category_id", categoryId).order("position", { ascending: true });
  if (error) throw error;
  for (let i = 0; i < (data ?? []).length; i += 1) {
    const { error: updateError } = await supabase.from("items").update({ position: i + 1 }).eq("id", data![i].id);
    if (updateError) throw updateError;
  }
}


type BudgetSessionRow = { game_id: string | null; mode: string; pending_file_id: string | null };
async function getBudgetSession(userId: number): Promise<BudgetSessionRow | null> {
  const { data, error } = await getSupabaseAdmin().from("budget_admin_sessions").select("game_id,mode,pending_file_id").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  return data as BudgetSessionRow | null;
}
async function setBudgetSession(userId: number, values: Partial<BudgetSessionRow>) {
  const existing = await getBudgetSession(userId);
  const { error } = await getSupabaseAdmin().from("budget_admin_sessions").upsert({ user_id: userId, game_id: values.game_id !== undefined ? values.game_id : existing?.game_id ?? null, mode: values.mode ?? existing?.mode ?? "idle", pending_file_id: values.pending_file_id !== undefined ? values.pending_file_id : existing?.pending_file_id ?? null, updated_at: new Date().toISOString() });
  if (error) throw error;
}

type GuessSessionRow = { game_id: string | null; person_id: string | null; mode: string; game_mode: string | null; pending_value: string | null };
async function getGuessSession(userId: number): Promise<GuessSessionRow | null> {
  const { data, error } = await getSupabaseAdmin().from("guess_admin_sessions").select("game_id,person_id,mode,game_mode,pending_value").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  return data as GuessSessionRow | null;
}
async function setGuessSession(userId: number, values: Partial<GuessSessionRow>) {
  const existing = await getGuessSession(userId);
  const { error } = await getSupabaseAdmin().from("guess_admin_sessions").upsert({
    user_id: userId,
    game_id: values.game_id !== undefined ? values.game_id : existing?.game_id ?? null,
    person_id: values.person_id !== undefined ? values.person_id : existing?.person_id ?? null,
    mode: values.mode ?? existing?.mode ?? "idle",
    game_mode: values.game_mode !== undefined ? values.game_mode : existing?.game_mode ?? null,
    pending_value: values.pending_value !== undefined ? values.pending_value : existing?.pending_value ?? null,
    updated_at: new Date().toISOString()
  });
  if (error) throw error;
}
type PositionSessionRow = { game_id: string | null; mode: string; ranking_mode: string | null; pending_value: string | null };
async function getPositionSession(userId: number): Promise<PositionSessionRow | null> {
  const { data, error } = await getSupabaseAdmin().from("position_admin_sessions").select("game_id,mode,ranking_mode,pending_value").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  return data as PositionSessionRow | null;
}
async function setPositionSession(userId: number, values: Partial<PositionSessionRow>) {
  const existing = await getPositionSession(userId);
  const { error } = await getSupabaseAdmin().from("position_admin_sessions").upsert({
    user_id: userId,
    game_id: values.game_id !== undefined ? values.game_id : existing?.game_id ?? null,
    mode: values.mode ?? existing?.mode ?? "idle",
    ranking_mode: values.ranking_mode !== undefined ? values.ranking_mode : existing?.ranking_mode ?? null,
    pending_value: values.pending_value !== undefined ? values.pending_value : existing?.pending_value ?? null,
    updated_at: new Date().toISOString()
  });
  if (error) throw error;
}

function normalizedGuessName(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/@/g, "").replace(/[^a-z0-9äöüß]+/gi, " ").trim();
}
function parseBudgetItem(value: string) {
  const parts = value.split("|").map((part) => part.trim());
  const price = Number(parts.at(-1)?.replace(/[^0-9]/g, ""));
  const name = parts.slice(0, -1).join(" | ").trim();
  return name && Number.isInteger(price) && price > 0 ? { name, price } : null;
}
async function addBudgetItem(token: string, chatId: string | number, userId: number, gameId: string, fileId: string, label: string) {
  const parsed = parseBudgetItem(label);
  if (!parsed) { await setBudgetSession(userId, { game_id: gameId, mode: "awaiting_budget_item_label", pending_file_id: fileId }); await send(token, chatId, "Sende jetzt <code>Name | Preis</code>, zum Beispiel <code>Anna | 30</code>."); return; }
  const { count, error: countError } = await getSupabaseAdmin().from("budget_items").select("id", { count: "exact", head: true }).eq("game_id", gameId);
  if (countError) throw countError;
  if ((count ?? 0) >= 20) { await send(token, chatId, "Maximal 20 Influencerinnen pro Budget-Spiel."); return; }
  const uploaded = await uploadTelegramPhoto(token, fileId, userId);
  const { error } = await getSupabaseAdmin().from("budget_items").insert({ game_id: gameId, name: parsed.name, price: parsed.price, image_url: uploaded.imageUrl, storage_path: uploaded.objectPath, sort_order: (count ?? 0) + 1 });
  if (error) throw error;
  await setBudgetSession(userId, { game_id: gameId, mode: "awaiting_budget_photo", pending_file_id: null });
  await send(token, chatId, `✅ <b>${escapeHtml(parsed.name)}</b> für <b>${parsed.price}</b> hinzugefügt (${(count ?? 0) + 1}/20).\n\nSende das nächste Bild mit <code>Name | Preis</code> als Bildunterschrift. Wenn du fertig bist, nutze den Button im Spielmenü oder sende <code>/fertigbudget</code>.`);
}

async function sendCommands(token: string, chatId: string | number, role: BotRole | null) {
  const isManager = role === "owner" || role === "creator";
  const keyboard: Array<Array<{ text: string; callback_data: string }>> = isManager
    ? [
        [{ text: "➕ Neues Spiel erstellen", callback_data: "createmenu:x" }],
        [{ text: "🎮 Meine Spiele", callback_data: "gamesmenu:x" }],
        [{ text: "📊 Statistiken", callback_data: "statsmenu:x" }],
        [{ text: "⚙️ Konto & Einstellungen", callback_data: "accountmenu:x" }],
        ...(role === "owner" ? [[{ text: "🔐 Rollen & Tokens", callback_data: "rolemenu:x" }]] : [])
      ]
    : [
        [{ text: "📊 Statistiken", callback_data: "statsmenu:x" }],
        [{ text: "🎟 Creator-Token einlösen", callback_data: "tokenredeem:x" }]
      ];

  await send(token, chatId,
    `<b>🎮 Game Hub</b>

Willkommen! Wähle einfach einen Bereich aus. Commands sind nur noch als schnelle Abkürzung gedacht.`,
    { reply_markup: { inline_keyboard: keyboard } }
  );
}

async function categoryMenu(token: string, chatId: string | number, userId: number, role: BotRole, gameType: "blind_ranking" | "fmk" = "blind_ranking") {
  const supabase = getSupabaseAdmin();
  let query = supabase.from("categories").select("id,name,game_type,items(count)").eq("game_type", gameType).order("created_at", { ascending: false });
  if (role === "creator") query = query.eq("created_by", userId);
  const { data, error } = await query;
  if (error) throw error;
  if (!data?.length) {
    await send(token, chatId, gameType === "fmk"
      ? "Noch keine FMK-Spiele vorhanden. Erstelle eines über <b>Spiele → Fuck, Marry, Kill → Neues Spiel</b> oder mit <code>/neuesfmk Name</code>."
      : "Noch keine Blind-Ranking-Kategorien vorhanden. Erstelle eine mit <code>/neuekategorie Name</code>.", { reply_markup: { inline_keyboard: [backButton("menuhelp:x")] } });
    return;
  }
  const buttons = data.map((category: any) => [{
    text: `${category.name} (${category.items?.[0]?.count ?? 0})`,
    callback_data: `cat:${category.id}`
  }]);
  await send(token, chatId, `<b>${gameType === "fmk" ? "🔥 FMK" : "🏆 Blind Ranking"} – Kategorien</b>\n\nTippe eine Kategorie an:`, {
    reply_markup: { inline_keyboard: [...buttons, backButton("gamesmenu:x")] }
  });
}

async function budgetGameMenu(token: string, chatId: string | number, userId: number, role: BotRole) {
  const supabase = getSupabaseAdmin();
  let query = supabase.from("budget_games").select("id,title,budget_amount,currency_label,is_active,budget_items(count)").order("created_at", { ascending: false });
  if (role === "creator") query = query.eq("creator_id", userId);
  const { data, error } = await query;
  if (error) throw error;
  if (!data?.length) {
    await send(token, chatId, "Noch keine Budget-Kategorien vorhanden. Erstelle eine über <b>Spiele → Budget Challenge → Neues Spiel</b>.", { reply_markup: { inline_keyboard: [backButton("managebudget:x")] } });
    return;
  }
  const buttons = data.map((game: any) => [{
    text: `${game.is_active ? "✅" : "📝"} ${game.title} · ${game.budget_amount} ${game.currency_label ?? "€"} (${game.budget_items?.[0]?.count ?? 0})`,
    callback_data: `budgetcat:${game.id}`
  }]);
  await send(token, chatId, "<b>💰 Budget Challenge – Kategorien</b>\n\nWähle eine Kategorie:", { reply_markup: { inline_keyboard: [...buttons, backButton("managebudget:x")] } });
}

async function showBudgetGameActions(token: string, chatId: string | number, gameId: string, userId: number, role: BotRole) {
  const supabase = getSupabaseAdmin();
  let query = supabase.from("budget_games").select("id,title,budget_amount,currency_label,is_active,creator_id,send_images,budget_items(count)").eq("id", gameId);
  if (role === "creator") query = query.eq("creator_id", userId);
  const { data: game, error } = await query.maybeSingle();
  if (error) throw error;
  if (!game) return send(token, chatId, "Budget-Kategorie nicht gefunden oder nicht erlaubt.");
  const count = game.budget_items?.[0]?.count ?? 0;
  const imageMode = game.send_images !== false ? "✅ Ja" : "❌ Nein";
  await send(token, chatId, `<b>⚙️ Kategorie verwalten</b>\n\n<b>💰 ${escapeHtml(game.title)}</b>\nBudget: <b>${game.budget_amount} ${escapeHtml(game.currency_label ?? "€")}</b>\nInfluencerinnen: <b>${count}</b>\nStatus: <b>${game.is_active ? "aktiv" : "in Bearbeitung"}</b>\nBilder in Ergebnissen: <b>${imageMode}</b>`, { reply_markup: { inline_keyboard: [
    [{ text: "▶️ Privat starten", callback_data: `privateplay:u|${game.id}` }],
    [{ text: "📣 In Gruppe starten", callback_data: `grp:u|${game.id}` }],
    [{ text: "🖼 Medien verwalten", callback_data: `budgetitems:${game.id}` }],
    [{ text: "✏️ Kategorie umbenennen", callback_data: `renamebudget:${game.id}` }],
    [{ text: "📊 Ergebnisse & Statistiken", callback_data: `budgetstats:${game.id}` }],
    [{ text: "⚙️ Ergebnis-Einstellungen", callback_data: `budgetresults:${game.id}` }],
    [{ text: "🎮 Spieleinstellungen", callback_data: `budgetsettings:${game.id}` }],
    [{ text: "🗑 Kategorie löschen", callback_data: `deletebudgetask:${game.id}` }],
    backButton("catsbudget:x")
  ] } });
}

async function showCategoryActions(token: string, chatId: string | number, categoryId: string) {
  const supabase = getSupabaseAdmin();
  const { data: category, error } = await supabase.from("categories").select("id,name,send_images,game_type").eq("id", categoryId).maybeSingle();
  if (error) throw error;
  if (!category) {
    await send(token, chatId, "Kategorie nicht gefunden.");
    return;
  }
  const count = await categoryCount(categoryId);
  const imageMode = category.send_images !== false ? "🖼 Bilder werden gesendet" : "📝 Nur Text wird gesendet";
  await send(token, chatId, `<b>⚙️ Kategorie verwalten</b>\n\n<b>${escapeHtml(category.name)}</b>\n${count} Medien\n${imageMode}`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "▶️ Privat starten", callback_data: `privateplay:${category.game_type === "fmk" ? "f" : "b"}|${categoryId}` }],
        [{ text: "📣 In Gruppe starten", callback_data: `grp:${category.game_type === "fmk" ? "f" : "b"}|${categoryId}` }],
        [{ text: "🖼 Medien verwalten", callback_data: `items:${categoryId}` }],
        [{ text: "✏️ Kategorie umbenennen", callback_data: `renamecat:${categoryId}` }],
        [{ text: "📊 Ergebnisse & Statistiken", callback_data: `categorystats:${categoryId}` }],
        [{ text: "⚙️ Ergebnis-Einstellungen", callback_data: `resultsettings:${categoryId}` }],
        [{ text: "🎮 Spieleinstellungen", callback_data: `gamesettings:${categoryId}` }],
        [{ text: "🗑 Kategorie löschen", callback_data: `delcatask:${categoryId}` }],
        backButton(category.game_type === "fmk" ? "catsfmk:x" : "catsbr:x")
      ]
    }
  });
}

async function showItems(token: string, chatId: string | number, categoryId: string) {
  const supabase = getSupabaseAdmin();
  const { data: category } = await supabase.from("categories").select("name").eq("id", categoryId).maybeSingle();
  const { data, error } = await supabase.from("items").select("id,title,position,image_url").eq("category_id", categoryId).order("position", { ascending: true });
  if (error) throw error;
  if (!data?.length) {
    await send(token, chatId, "Diese Kategorie enthält noch keine Bilder.");
    return;
  }

  // Telegram erlaubt maximal 10 Medien pro Album. Die Bilder werden deshalb in Blöcken gesendet.
  for (let offset = 0; offset < data.length; offset += 10) {
    const chunk = data.slice(offset, offset + 10);
    if (chunk.length === 1) {
      await telegramApi(token, "sendPhoto", {
        chat_id: chatId,
        photo: chunk[0].image_url,
        caption: `${chunk[0].position}. ${chunk[0].title}`
      });
    } else {
      await telegramApi(token, "sendMediaGroup", {
        chat_id: chatId,
        media: chunk.map((item) => ({
          type: "photo",
          media: item.image_url,
          caption: `${item.position}. ${item.title}`
        }))
      });
    }
  }

  const buttons = data.map((item) => [{ text: `${item.position}. ${item.title}`, callback_data: `item:${item.id}` }]);
  await send(token, chatId, `<b>Bilder: ${escapeHtml(category?.name ?? "Kategorie")}</b>\n\nOben siehst du alle hinterlegten Bilder. Tippe unten einen Eintrag zum Bearbeiten an:`, {
    reply_markup: { inline_keyboard: [...buttons, backButton(`cat:${categoryId}`)] }
  });
}

async function showRoleMenu(token: string, chatId: string | number) {
  await send(token, chatId, `<b>🔐 Creator- & Tokenverwaltung</b>

Player sind automatisch alle Nutzer. Nur Owner können dieses Menü verwenden.`, {
    reply_markup: { inline_keyboard: [
      [{ text: "🎟 Creator-Token erstellen", callback_data: "tokenmenu:x" }],
      [{ text: "👑 Owner per ID hinzufügen", callback_data: "owneraddmenu:x" }],
      [{ text: "➕ Creator per ID genehmigen", callback_data: "approvemenu:x" }],
      [{ text: "👥 Owner & Creator verwalten", callback_data: "roleusers:x" }],
      [{ text: "🧾 Offene Tokens", callback_data: "roletokens:x" }],
      [{ text: "📊 Kontingent ändern", callback_data: "quotaedit:x" }],
      backButton("menuhelp:x")
    ] }
  });
}

function quotaLabel(limit: number | null, used = 0) {
  return limit === null ? `unbegrenzt · ${used} erstellt` : `${used}/${limit} verwendet`;
}

function quotaButtons(prefix: string, backTo?: string) {
  const rows = [
    [{ text: "1 Kategorie", callback_data: `${prefix}:1` }, { text: "3 Kategorien", callback_data: `${prefix}:3` }],
    [{ text: "5 Kategorien", callback_data: `${prefix}:5` }, { text: "10 Kategorien", callback_data: `${prefix}:10` }],
    [{ text: "♾ Unbegrenzt", callback_data: `${prefix}:u` }]
  ];
  if (backTo) rows.push(backButton(backTo));
  return rows;
}

function tokenDurationButtons(quotaCode: string) {
  return [
    [{ text: "1 Stunde", callback_data: `tokentime:${quotaCode}_1h` }, { text: "24 Stunden", callback_data: `tokentime:${quotaCode}_24h` }],
    [{ text: "7 Tage", callback_data: `tokentime:${quotaCode}_7d` }, { text: "30 Tage", callback_data: `tokentime:${quotaCode}_30d` }],
    [{ text: "♾ Ohne Ablauf", callback_data: `tokentime:${quotaCode}_never` }],
    backButton("tokenmenu:x")
  ];
}

function tokenExpiry(durationCode: string): string | null {
  const now = Date.now();
  const milliseconds: Record<string, number> = {
    "1h": 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
    "30d": 30 * 24 * 60 * 60 * 1000
  };
  return durationCode === "never" ? null : new Date(now + (milliseconds[durationCode] ?? 0)).toISOString();
}

async function listRoleUsers(token: string, chatId: string | number, ownerId: number) {
  const { data, error } = await getSupabaseAdmin().from("bot_users").select("user_id,role,username,display_name,active,category_limit,categories_used").in("role", ["owner", "creator"]).eq("active", true).order("created_at");
  if (error) throw error;
  const rows = [`👑 <b>Haupt-Owner</b> — <code>${ownerId}</code>`];
  const buttons: Array<Array<{ text: string; callback_data: string }>> = [];
  for (const user of data ?? []) {
    if (Number(user.user_id) === ownerId) continue;
    const label = user.username ? `@${escapeHtml(user.username)}` : escapeHtml(user.display_name || String(user.user_id));
    if (user.role === "owner") {
      rows.push(`✅ 👑 <b>Owner</b> — ${label} · <code>${user.user_id}</code>`);
      buttons.push([{ text: `👑 ${user.username ? `@${user.username}` : user.display_name || user.user_id}`, callback_data: `roleuser:${user.user_id}` }]);
    } else {
      rows.push(`✅ <b>Creator</b> — ${label} · <code>${user.user_id}</code> · ${quotaLabel(user.category_limit, Number(user.categories_used ?? 0))}`);
      buttons.push([{ text: `🛠 ${user.username ? `@${user.username}` : user.display_name || user.user_id}`, callback_data: `roleuser:${user.user_id}` }]);
    }
  }
  buttons.push(backButton("rolemenu:x"));
  await send(token, chatId, `<b>👥 Owner & Creator</b>\n\n${rows.join("\n")}\n\nTippe eine Person an, um sie zu verwalten.`, { reply_markup: { inline_keyboard: buttons } });
}

async function showRoleUser(token: string, chatId: string | number, targetId: number, ownerId: number) {
  if (targetId === ownerId) return send(token, chatId, "Der Haupt-Owner kann nicht entfernt werden.", { reply_markup: { inline_keyboard: [backButton("roleusers:x")] } });
  const { data, error } = await getSupabaseAdmin().from("bot_users").select("user_id,role,username,display_name,active,category_limit,categories_used").eq("user_id", targetId).maybeSingle();
  if (error) throw error;
  if (!data?.active || !["owner", "creator"].includes(data.role)) return send(token, chatId, "Nutzer nicht gefunden.", { reply_markup: { inline_keyboard: [backButton("roleusers:x")] } });
  const label = data.username ? `@${escapeHtml(data.username)}` : escapeHtml(data.display_name || String(data.user_id));
  const quota = data.role === "creator" ? `
Kontingent: <b>${quotaLabel(data.category_limit, Number(data.categories_used ?? 0))}</b>` : "";
  await send(token, chatId, `<b>${data.role === "owner" ? "👑 Owner" : "🛠 Creator"}</b>

Name: ${label}
Telegram-ID: <code>${data.user_id}</code>${quota}`, {
    reply_markup: { inline_keyboard: [
      [{ text: "🗑 Berechtigung entfernen", callback_data: `removeauth:${data.user_id}` }],
      backButton("roleusers:x")
    ] }
  });
}

async function listOpenTokens(token: string, chatId: string | number) {
  const { data, error } = await getSupabaseAdmin().from("invite_tokens").select("token_hint,role,expires_at,created_at,category_limit").is("used_at", null).is("revoked_at", null).order("created_at", { ascending: false }).limit(30);
  if (error) throw error;
  if (!data?.length) return send(token, chatId, "Keine offenen Tokens vorhanden.", { reply_markup: { inline_keyboard: [backButton("rolemenu:x")] } });
  const rows = data.map((entry) => `• <code>${escapeHtml(entry.token_hint)}</code> — Creator · ${entry.category_limit === null ? "unbegrenzt" : `${entry.category_limit} Kategorien`}${entry.expires_at ? ` · gültig bis ${new Date(entry.expires_at).toLocaleDateString("de-DE")}` : ""}`);
  await send(token, chatId, `<b>🧾 Offene Tokens</b>\n\n${rows.join("\n")}\n\nAus Sicherheitsgründen wird nur ein Hinweis, nicht der vollständige Token, gespeichert.`, { reply_markup: { inline_keyboard: [backButton("rolemenu:x")] } });
}

async function handleCallback(token: string, callback: CallbackQuery, ownerId: number) {
  if (!callback.message?.chat?.id || !callback.data) { await answerCallback(token, callback.id, "Ungültige Aktion"); return; }
  const role = await getRole(callback.from.id, ownerId);
  const chatId = String(callback.message.chat.id);
  const callbackIsPrivate = callback.message.chat.type === "private";
  if (!callbackIsPrivate && (!isConfiguredGroup(chatId) || role !== "owner")) {
    // In Gruppen reagiert der Bot ausschließlich auf Owner und nur in der festgelegten Gruppe.
    return;
  }
  const [action, id] = callback.data.split(":", 2);
  const supabase = getSupabaseAdmin();
  await answerCallback(token, callback.id);
  const deferPrivateMenuDelete = callback.message.chat?.type === "private" && (action === "grp" || action === "syncgrp");
  if (callback.message.chat?.type === "private" && !deferPrivateMenuDelete) {
    try { await telegramApi(token, "deleteMessage", { chat_id: chatId, message_id: callback.message.message_id }); } catch {}
  }

  if (action === "menuhelp") return sendCommands(token, chatId, role);
  if (action === "noop") return;
  if (action === "privateplay") {
    const [kindRaw, gameId] = id.split("|");
    const kind = kindRaw as ShareGameKind;
    if (!(["b", "f", "u", "g", "p"] as string[]).includes(kind) || !gameId) return send(token, chatId, "Ungültige Spielauswahl.");
    const title = await getShareGameTitle(kind, gameId);
    if (!title) return send(token, chatId, "Spiel nicht gefunden.");
    const labels: Record<ShareGameKind, string> = { b: "🏆 Blind Ranking öffnen", f: "🔥 FMK öffnen", u: "💰 Budget-Spiel öffnen", g: "🧩 Ratespiel öffnen", p: "📍 Position Ranking öffnen" };
    return send(token, chatId, `<b>${escapeHtml(title)}</b>\n\nStarte das Spiel direkt im privaten Chat:`, { reply_markup: { inline_keyboard: [[{ text: labels[kind], web_app: { url: miniAppUrlFor(kind, gameId, chatId) } }], backButton(kind === "b" || kind === "f" ? `cat:${gameId}` : kind === "u" ? `budgetcat:${gameId}` : kind === "g" ? `guesscat:${gameId}` : `positioncat:${gameId}`)] } });
  }
  if (action === "syncgrp") {
    if (role !== "owner") return send(token, chatId, "Nur Owner dürfen Spiele in der Gruppe starten.");
    const [kindRaw, gameId] = id.split("|");
    const kind = kindRaw as ShareGameKind;
    if (!(["b", "f", "u", "g", "p"] as string[]).includes(kind) || !gameId) return send(token, chatId, "Ungültige Spielauswahl.");
    const statusMessage = await send(token, chatId, "🔍 <b>Gruppen und Berechtigungen werden geprüft …</b>\n\nBitte einen Moment warten.");
    try { await telegramApi(token, "deleteMessage", { chat_id: chatId, message_id: callback.message.message_id }); } catch {}
    try {
      const back = kind === "b" || kind === "f" ? `cat:${gameId}` : kind === "u" ? `budgetcat:${gameId}` : kind === "g" ? `guesscat:${gameId}` : `positioncat:${gameId}`;
      try { await telegramApi(token, "deleteMessage", { chat_id: chatId, message_id: statusMessage.message_id }); } catch {}
      return showGroupPicker(token, chatId, callback.from.id, role, kind, gameId, back);
    } catch (error) {
      try { await telegramApi(token, "deleteMessage", { chat_id: chatId, message_id: statusMessage.message_id }); } catch {}
      return send(token, chatId, error instanceof Error ? `❌ ${escapeHtml(error.message)}` : "❌ Gruppen konnten nicht geprüft werden.");
    }
  }
  if (action === "grp") {
    if (role !== "owner") return send(token, chatId, "Nur Owner dürfen Spiele in der Gruppe starten.");
    const [kindRaw, gameId] = id.split("|");
    const kind = kindRaw as ShareGameKind;
    if (!(["b", "f", "u", "g", "p"] as string[]).includes(kind) || !gameId) return send(token, chatId, "Ungültige Spielauswahl.");
    const statusMessage = await send(token, chatId, "🔍 <b>Gruppen und Berechtigungen werden geprüft …</b>\n\nBitte einen Moment warten.");
    try { await telegramApi(token, "deleteMessage", { chat_id: chatId, message_id: callback.message.message_id }); } catch {}
    const back = kind === "b" || kind === "f" ? `cat:${gameId}` : kind === "u" ? `budgetcat:${gameId}` : kind === "g" ? `guesscat:${gameId}` : `positioncat:${gameId}`;
    try {
      try { await telegramApi(token, "deleteMessage", { chat_id: chatId, message_id: statusMessage.message_id }); } catch {}
      return showGroupPicker(token, chatId, callback.from.id, role, kind, gameId, back);
    } catch (error) {
      try { await telegramApi(token, "deleteMessage", { chat_id: chatId, message_id: statusMessage.message_id }); } catch {}
      return send(token, chatId, error instanceof Error ? `❌ ${escapeHtml(error.message)}` : "❌ Gruppen konnten nicht geprüft werden.");
    }
  }
  if (action === "sg") {
    if (role !== "owner") return send(token, chatId, "Nur Owner dürfen Spiele in der Gruppe starten.");
    const [kindRaw, gameId, groupIdRaw] = id.split("|");
    const kind = kindRaw as ShareGameKind;
    const groupId = Number(groupIdRaw);
    if (!(["b", "f", "u", "g", "p"] as string[]).includes(kind) || !gameId || !Number.isSafeInteger(groupId)) return send(token, chatId, "Ungültige Auswahl.");
    if (groupId !== configuredGroupId()) return send(token, chatId, "Diese Gruppe ist für diesen Bot nicht freigegeben.");
    if (!(await canManageShareGame(callback.from.id, role, kind, gameId))) return send(token, chatId, "Du darfst dieses Spiel nicht starten.");
    const check = await telegramAdminCheck(token, groupId, callback.from.id);
    if (!check.userAllowed) return send(token, chatId, "Du bist in dieser Gruppe nicht mehr Administrator oder Eigentümer.");
    if (!check.botAllowed) return send(token, chatId, "Der Bot muss in dieser Gruppe Administrator sein.");
    const title = await getShareGameTitle(kind, gameId);
    const { data: group } = await supabase.from("bot_groups").select("title").eq("chat_id", groupId).maybeSingle();
    return send(token, chatId, `<b>Spiel wirklich starten?</b>\n\nSpiel: <b>${escapeHtml(title ?? shareKindLabel(kind))}</b>\nGruppe: <b>${escapeHtml(group?.title ?? String(groupId))}</b>`, { reply_markup: { inline_keyboard: [[{ text: "✅ Jetzt starten", callback_data: `cg:${kind}|${gameId}|${groupId}` }], [{ text: "⬅️ Andere Gruppe wählen", callback_data: `grp:${kind}|${gameId}` }]] } });
  }
  if (action === "cg") {
    if (role !== "owner") return send(token, chatId, "Nur Owner dürfen Spiele in der Gruppe starten.");
    const [kindRaw, gameId, groupIdRaw] = id.split("|");
    const kind = kindRaw as ShareGameKind;
    const groupId = Number(groupIdRaw);
    if (!(["b", "f", "u", "g", "p"] as string[]).includes(kind) || !gameId || !Number.isSafeInteger(groupId)) return send(token, chatId, "Ungültige Auswahl.");
    if (groupId !== configuredGroupId()) return send(token, chatId, "Diese Gruppe ist für diesen Bot nicht freigegeben.");
    if (!(await canManageShareGame(callback.from.id, role, kind, gameId))) return send(token, chatId, "Du darfst dieses Spiel nicht starten.");
    const check = await telegramAdminCheck(token, groupId, callback.from.id);
    if (!check.userAllowed || !check.botAllowed) return send(token, chatId, "Start nicht erlaubt. Du und der Bot müssen in der Gruppe Administrator sein.");
    await sendGameToGroup(token, kind, gameId, groupId);
    return send(token, chatId, "✅ Das Spiel wurde in der festgelegten Gruppe gestartet.", { reply_markup: { inline_keyboard: [backButton(kind === "b" || kind === "f" ? `cat:${gameId}` : kind === "u" ? `budgetcat:${gameId}` : kind === "g" ? `guesscat:${gameId}` : `positioncat:${gameId}`)] } });
  }
  if (action === "tokenredeem") {
    if (role !== "player") return send(token, chatId, "Du bist bereits Owner oder Creator.", { reply_markup: { inline_keyboard: [backButton("menuhelp:x")] } });
    await setSession(callback.from.id, { category_id: null, mode: "awaiting_token_redeem", pending_file_id: null, pending_item_id: null });
    return send(token, chatId, `<b>🎟 Creator-Token einlösen</b>

Sende jetzt deinen vollständigen Token, zum Beispiel <code>BR-XXXX-XXXX-XXXX</code>.`, { reply_markup: { inline_keyboard: [backButton("menuhelp:x")] } });
  }
  if (action === "createmenu") {
    if (role === "player") return send(token, chatId, "Nur Owner oder Creator dürfen Spiele erstellen.", { reply_markup: { inline_keyboard: [backButton("menuhelp:x")] } });
    return send(token, chatId, "<b>➕ Neues Spiel erstellen</b>\n\nWelchen Spieltyp möchtest du anlegen?", { reply_markup: { inline_keyboard: [
      [{ text: "🏆 Blind Ranking", callback_data: "newbr:x" }],
      [{ text: "🔥 Fuck, Marry, Kill", callback_data: "newfmk:x" }],
      [{ text: "💰 Budget Challenge", callback_data: "newbudget:x" }],
      [{ text: "🧩 Influencerin erraten", callback_data: "newguess:x" }],
      [{ text: "📍 Position Ranking", callback_data: "newposition:x" }],
      backButton("menuhelp:x")
    ] } });
  }
  if (action === "playmenu") {
    return send(token, chatId, "<b>▶️ Spiel starten</b>\n\nWähle den Spieltyp:", { reply_markup: { inline_keyboard: [
      [{ text: "🏆 Blind Ranking", callback_data: "playbr:x" }],
      [{ text: "🔥 Fuck, Marry, Kill", callback_data: "playfmk:x" }],
      [{ text: "💰 Budget Challenge", callback_data: "playbudget:x" }],
      [{ text: "🧩 Influencerin erraten", callback_data: "playguess:x" }],
      [{ text: "📍 Position Ranking", callback_data: "playposition:x" }],
      backButton("menuhelp:x")
    ] } });
  }
  if (action === "statsmenu") {
    return send(token, chatId, "<b>📊 Statistiken</b>\n\nDie ausführlichen Statistiken bleiben vorerst über kurze Schnellbefehle erreichbar:", { reply_markup: { inline_keyboard: [
      [{ text: "🏆 Top Spiele", callback_data: "quickhelp:top" }],
      [{ text: "👥 Leaderboard", callback_data: "quickhelp:leaderboard" }],
      [{ text: "🕘 Letzte Abstimmungen", callback_data: "quickhelp:history" }],
      backButton("menuhelp:x")
    ] } });
  }
  if (action === "quickhelp") {
    const commands: Record<string,string> = { top: "/top", leaderboard: "/leaderboard", history: "/history", id: "/id" };
    const command = commands[id] ?? "/commands";
    return send(token, chatId, `Sende <code>${command}</code> in der Gruppe.`, { reply_markup: { inline_keyboard: [backButton("statsmenu:x")] } });
  }
  if (action === "accountmenu") {
    return send(token, chatId, "<b>⚙️ Konto & Einstellungen</b>", { reply_markup: { inline_keyboard: [
      [{ text: "🪪 Meine Telegram-ID", callback_data: "quickhelp:id" }],
      [{ text: "🎟 Creator-Token einlösen", callback_data: "tokenredeem:x" }],
      backButton("menuhelp:x")
    ] } });
  }
  if (action === "gamesmenu") {
    if (role === "player") return send(token, chatId, "Nur Owner oder Creator dürfen Spiele verwalten.", { reply_markup: { inline_keyboard: [backButton("menuhelp:x")] } });
    return send(token, chatId, "<b>🎮 Meine Spiele</b>\n\nWelchen Spieltyp möchtest du verwalten?", { reply_markup: { inline_keyboard: [
      [{ text: "🏆 Blind Ranking", callback_data: "managebr:x" }],
      [{ text: "🔥 Fuck, Marry, Kill", callback_data: "managefmk:x" }],
      [{ text: "💰 Budget Challenge", callback_data: "managebudget:x" }],
      [{ text: "🧩 Influencerin erraten", callback_data: "manageguess:x" }],
      [{ text: "📍 Position Ranking", callback_data: "manageposition:x" }],
      backButton("menuhelp:x")
    ] } });
  }
  if (action === "manageguess") {
    if (role === "player") return send(token, chatId, "Nur Owner oder Creator dürfen Kategorien verwalten.");
    return send(token, chatId, "<b>🧩 Influencerin erraten</b>", { reply_markup: { inline_keyboard: [
      [{ text: "➕ Neue Kategorie", callback_data: "newguess:x" }],
      [{ text: "📂 Kategorien verwalten", callback_data: "catsguess:x" }],
      [{ text: "🎮 Aktives Spiel öffnen", callback_data: "playguess:x" }],
      backButton("gamesmenu:x")
    ] } });
  }
  if (action === "newguess") {
    if (role === "player") return send(token, chatId, "Nicht erlaubt.");
    await setPositionSession(callback.from.id, { game_id: null, mode: "idle", ranking_mode: null, pending_value: null });
    return send(token, chatId, "<b>🧩 Neue Rate-Kategorie</b>\n\nWelche Art möchtest du erstellen?", { reply_markup: { inline_keyboard: [
      [{ text: "👤 Einzelne Influencerin", callback_data: "guessmode:single" }],
      [{ text: "👥 Mehrere Influencerinnen", callback_data: "guessmode:collection" }],
      backButton("manageguess:x")
    ] } });
  }
  if (action === "catsguess") {
    const { data } = await supabase.from("guess_games").select("id,title,is_active").order("created_at", { ascending: false });
    const rows = (data ?? []).map((g:any) => [{ text: `${g.is_active ? "✅" : "⏸"} ${g.title}`, callback_data: `guesscat:${g.id}` }]);
    return send(token, chatId, "<b>🧩 Kategorien verwalten</b>", { reply_markup: { inline_keyboard: [...rows, backButton("manageguess:x")] } });
  }
  if (action === "guesscat") {
    const { data:g } = await supabase.from("guess_games").select("id,title,send_images,answer_mode,hints_enabled,is_active,game_mode").eq("id", id).maybeSingle();
    if (!g) return send(token, chatId, "Kategorie nicht gefunden.", { reply_markup: { inline_keyboard: [backButton("catsguess:x")] } });
    const modeLabel = g.game_mode === "single" ? "Einzelne Influencerin" : "Mehrere Influencerinnen";
    return send(token, chatId, `<b>⚙️ Kategorie verwalten</b>\n\n<b>🧩 ${escapeHtml(g.title)}</b>\nModus: <b>${modeLabel}</b>\nAntwortmodus: <b>${g.answer_mode}</b>\nHinweise: <b>${g.hints_enabled ? "Ja" : "Nein"}</b>\nBilder in Ergebnissen: <b>${g.send_images ? "Ja" : "Nein"}</b>`, { reply_markup: { inline_keyboard: [
      [{ text: "▶️ Privat starten", callback_data: `privateplay:g|${g.id}` }],
      [{ text: "📣 In Gruppe starten", callback_data: `grp:g|${g.id}` }],
      [{ text: "🖼 Medien verwalten", callback_data: `guesspeople:${g.id}` }],
      [{ text: "✏️ Kategorie umbenennen", callback_data: `renameguess:${g.id}` }],
      [{ text: "📊 Ergebnisse & Statistiken", callback_data: `guessstats:${g.id}` }],
      [{ text: "⚙️ Ergebnis-Einstellungen", callback_data: `guessresults:${g.id}` }],
      [{ text: "🎮 Spieleinstellungen", callback_data: `guesssettings:${g.id}` }],
      [{ text: "🗑 Kategorie löschen", callback_data: `deleteguessask:${g.id}` }],
      backButton("catsguess:x")
    ] } });
  }
  if (action === "resultsettings") {
    const { data:c } = await supabase.from("categories").select("id,name,send_images").eq("id", id).maybeSingle();
    if (!c) return send(token, chatId, "Kategorie nicht gefunden.");
    return send(token, chatId, `<b>⚙️ Ergebnis-Einstellungen</b>\n\nKategorie: <b>${escapeHtml(c.name)}</b>`, { reply_markup: { inline_keyboard: [
      [{ text: `🖼 Bilder mitsenden: ${c.send_images !== false ? "✅ Ja" : "❌ Nein"}`, callback_data: `toggleimages:${id}` }],
      backButton(`cat:${id}`)
    ] } });
  }
  if (action === "gamesettings") {
    const { data:c } = await supabase.from("categories").select("name,game_type").eq("id", id).maybeSingle();
    if (!c) return send(token, chatId, "Kategorie nicht gefunden.");
    const lines = c.game_type === "fmk" ? "Genau 3 Medien · jede Rolle einmal" : "Reihenfolge zufällig · Rangplätze entsprechen der Medienanzahl";
    return send(token, chatId, `<b>🎮 Spieleinstellungen</b>\n\n<b>${escapeHtml(c.name)}</b>\n${lines}`, { reply_markup: { inline_keyboard: [backButton(`cat:${id}`)] } });
  }
  if (action === "categorystats") return send(token, chatId, "<b>📊 Ergebnisse & Statistiken</b>\n\nDie Kategorie-Statistiken werden aus den gespeicherten Abstimmungen berechnet.", { reply_markup: { inline_keyboard: [backButton(`cat:${id}`)] } });
  if (action === "budgetresults") {
    const { data:g } = await supabase.from("budget_games").select("title,send_images").eq("id", id).maybeSingle();
    if (!g) return send(token, chatId, "Kategorie nicht gefunden.");
    return send(token, chatId, `<b>⚙️ Ergebnis-Einstellungen</b>\n\nKategorie: <b>${escapeHtml(g.title)}</b>\n\nSollen Bilder oder GIFs im Ergebnis gesendet werden?`, { reply_markup: { inline_keyboard: [
      [{ text: `🖼 Bilder mitsenden: ${g.send_images !== false ? "✅ Ja" : "❌ Nein"}`, callback_data: `togglebudgetimages:${id}` }],
      backButton(`budgetcat:${id}`)
    ] } });
  }
  if (action === "togglebudgetimages") {
    const { data:g } = await supabase.from("budget_games").select("send_images").eq("id", id).single();
    await supabase.from("budget_games").update({ send_images: g?.send_images === false }).eq("id", id);
    return showBudgetGameActions(token, chatId, id, callback.from.id, role);
  }
  if (action === "budgetsettings") {
    const { data:g } = await supabase.from("budget_games").select("title,budget_amount,currency_label,min_selections,max_selections").eq("id", id).maybeSingle();
    if (!g) return send(token, chatId, "Kategorie nicht gefunden.");
    return send(token, chatId, `<b>🎮 Spieleinstellungen</b>\n\nBudget: <b>${g.budget_amount} ${escapeHtml(g.currency_label ?? "€")}</b>\nMinimum: <b>${g.min_selections ?? "frei"}</b>\nMaximum: <b>${g.max_selections ?? "frei"}</b>`, { reply_markup: { inline_keyboard: [backButton(`budgetcat:${id}`)] } });
  }
  if (action === "budgetstats") return send(token, chatId, "<b>📊 Ergebnisse & Statistiken</b>\n\nAuswahlquoten, Durchschnittsausgaben und Restbudget werden pro Kategorie ausgewertet.", { reply_markup: { inline_keyboard: [backButton(`budgetcat:${id}`)] } });
  if (action === "budgetitems") {
    const { data:items } = await supabase.from("budget_items").select("id,name,price,image_url,sort_order").eq("game_id", id).order("sort_order");
    for (const item of items ?? []) await telegramApi(token, "sendPhoto", { chat_id: chatId, photo: item.image_url, caption: `${item.sort_order}. ${item.name} · ${item.price}` });
    const rows=(items??[]).map((item:any)=>[{text:`${item.sort_order}. ${item.name} · ${item.price}`,callback_data:`budgetitem:${item.id}`}]);
    return send(token, chatId, "<b>🖼 Medien verwalten</b>", { reply_markup: { inline_keyboard: [[{text:"➕ Bild oder GIF hinzufügen",callback_data:`addbudget:${id}`}],...rows,backButton(`budgetcat:${id}`)] } });
  }
  if (action === "budgetitem") {
    const { data:item } = await supabase.from("budget_items").select("id,game_id,name,price,image_url").eq("id", id).maybeSingle();
    if (!item) return send(token, chatId, "Eintrag nicht gefunden.");
    return send(token, chatId, `<b>${escapeHtml(item.name)}</b>\nPreis: <b>${item.price}</b>`, { reply_markup: { inline_keyboard: [[{text:"🗑 Eintrag entfernen",callback_data:`deletebudgetitem:${item.id}`}],backButton(`budgetitems:${item.game_id}`)] } });
  }
  if (action === "deletebudgetitem") {
    const { data:item } = await supabase.from("budget_items").select("game_id").eq("id", id).maybeSingle();
    if (!item) return send(token, chatId, "Eintrag nicht gefunden.");
    await supabase.from("budget_items").delete().eq("id", id);
    return send(token, chatId, "✅ Eintrag entfernt.", { reply_markup: { inline_keyboard: [backButton(`budgetitems:${item.game_id}`)] } });
  }
  if (action === "renamebudget") {
    await setBudgetSession(callback.from.id, { game_id: id, mode: "awaiting_budget_rename", pending_file_id: null });
    return send(token, chatId, "Sende jetzt den neuen Kategorienamen.", { reply_markup: { inline_keyboard: [backButton(`budgetcat:${id}`)] } });
  }
  if (action === "deletebudgetask") return send(token, chatId, "Budget-Kategorie wirklich löschen?", { reply_markup: { inline_keyboard: [[{text:"🗑 Ja, löschen",callback_data:`deletebudget:${id}`}],backButton(`budgetcat:${id}`)] } });
  if (action === "deletebudget") { await supabase.from("budget_games").delete().eq("id", id); return send(token, chatId, "✅ Budget-Kategorie gelöscht.", { reply_markup: { inline_keyboard: [backButton("catsbudget:x")] } }); }
  if (action === "renameguess") {
    await setGuessSession(callback.from.id, { game_id: id, person_id: null, mode: "awaiting_game_rename" });
    return send(token, chatId, "Sende jetzt den neuen neutralen Kategorienamen.", { reply_markup: { inline_keyboard: [backButton(`guesscat:${id}`)] } });
  }
  if (action === "guessaliases") {
    const { data:person } = await supabase.from("guess_people").select("game_id,display_name,aliases").eq("id", id).maybeSingle();
    if (!person) return send(token, chatId, "Influencerin nicht gefunden.");
    await setGuessSession(callback.from.id, { game_id: person.game_id, person_id: id, mode: "awaiting_alias_edit" });
    return send(token, chatId, `Sende alle akzeptierten Alternativnamen für <b>${escapeHtml(person.display_name)}</b> mit Komma getrennt.\n\nAktuell: ${escapeHtml((person.aliases ?? []).join(", ") || "Keine")}`, { reply_markup: { inline_keyboard: [backButton(`guessperson:${id}`)] } });
  }
  if (action === "deleteguesspersonask") return send(token, chatId, "Influencerin und alle Hinweise wirklich entfernen?", { reply_markup: { inline_keyboard: [[{text:"🗑 Ja, entfernen",callback_data:`deleteguessperson:${id}`}],backButton(`guessperson:${id}`)] } });
  if (action === "deleteguessperson") {
    const { data:person } = await supabase.from("guess_people").select("game_id").eq("id", id).maybeSingle();
    if (!person) return send(token, chatId, "Influencerin nicht gefunden.");
    await supabase.from("guess_people").delete().eq("id", id);
    return send(token, chatId, "✅ Influencerin entfernt.", { reply_markup: { inline_keyboard: [backButton(`guesspeople:${person.game_id}`)] } });
  }
  if (action === "deleteguessask") return send(token, chatId, "Rate-Kategorie wirklich löschen?", { reply_markup: { inline_keyboard: [[{text:"🗑 Ja, löschen",callback_data:`deleteguess:${id}`}],backButton(`guesscat:${id}`)] } });
  if (action === "deleteguess") { await supabase.from("guess_games").delete().eq("id", id); return send(token, chatId, "✅ Rate-Kategorie gelöscht.", { reply_markup: { inline_keyboard: [backButton("catsguess:x")] } }); }
  if (action === "guessresults") {
    const { data:g } = await supabase.from("guess_games").select("title,send_images").eq("id", id).maybeSingle();
    if (!g) return send(token, chatId, "Kategorie nicht gefunden.");
    return send(token, chatId, `<b>⚙️ Ergebnis-Einstellungen</b>\n\nKategorie: <b>${escapeHtml(g.title)}</b>\n\nSollen Bilder oder GIFs im Ergebnis gesendet werden?`, { reply_markup: { inline_keyboard: [[{ text: `🖼 Bilder/GIFs senden: ${g.send_images ? "✅ Ja" : "❌ Nein"}`, callback_data: `toggleguessimages:${id}` }], backButton(`guesscat:${id}`)] } });
  }
  if (action === "guesssettings") {
    const { data:g } = await supabase.from("guess_games").select("title,answer_mode,hints_enabled,game_mode").eq("id", id).maybeSingle();
    if (!g) return send(token, chatId, "Kategorie nicht gefunden.");
    const answerLabel = g.answer_mode === "multiple_choice" ? "Namen auswählen" : g.answer_mode === "mixed" ? "Gemischter Modus" : "Namen eingeben";
    return send(token, chatId, `<b>🎮 Rate-Einstellungen</b>

Kategorie: <b>${escapeHtml(g.title)}</b>
Modus: <b>${g.game_mode === "single" ? "Einzelne Influencerin" : "Mehrere Influencerinnen"}</b>
Antwortmodus: <b>${answerLabel}</b>
Hinweise: <b>${g.hints_enabled ? "Ja" : "Nein"}</b>`, { reply_markup: { inline_keyboard: [
      [{ text: `${g.answer_mode === "free_text" ? "✅ " : ""}⌨️ Namen eingeben`, callback_data: `guessanswerfree:${id}` }],
      [{ text: `${g.answer_mode === "multiple_choice" ? "✅ " : ""}🔘 Namen auswählen`, callback_data: `guessanswerchoice:${id}` }],
      [{ text: `${g.answer_mode === "mixed" ? "✅ " : ""}🎲 Gemischter Modus`, callback_data: `guessanswermixed:${id}` }],
      backButton(`guesscat:${id}`)
    ] } });
  }
  if (["guessanswerfree", "guessanswerchoice", "guessanswermixed"].includes(action)) {
    const mode = action === "guessanswerchoice" ? "multiple_choice" : action === "guessanswermixed" ? "mixed" : "free_text";
    const { error } = await supabase.from("guess_games").update({ answer_mode: mode, updated_at: new Date().toISOString() }).eq("id", id);
    if (error) return send(token, chatId, `❌ Antwortmodus konnte nicht gespeichert werden: ${escapeHtml(error.message)}`, { reply_markup: { inline_keyboard: [backButton(`guesssettings:${id}`)] } });
    const label = mode === "multiple_choice" ? "Namen auswählen" : mode === "mixed" ? "Gemischter Modus" : "Namen eingeben";
    return send(token, chatId, `✅ Antwortmodus gespeichert: <b>${label}</b>`, { reply_markup: { inline_keyboard: [[{ text: "🎮 Einstellungen erneut öffnen", callback_data: `guesssettings:${id}` }], backButton(`guesscat:${id}`)] } });
  }
  if (action === "guessstats") return send(token, chatId, "<b>📊 Ergebnisse & Statistiken</b>\n\nTrefferquote, Punkte und verwendete Hinweise werden pro Kategorie ausgewertet.", { reply_markup: { inline_keyboard: [backButton(`guesscat:${id}`)] } });
  if (action === "guesspeople") {
    const { data:game } = await supabase.from("guess_games").select("game_mode").eq("id", id).maybeSingle();
    const { data:people } = await supabase.from("guess_people").select("id,display_name,sort_order").eq("game_id", id).order("sort_order");
    const rows=(people??[]).map((person:any)=>[{text:`👤 ${person.display_name}`,callback_data:`guessperson:${person.id}`}]);
    const addRow = game?.game_mode === "collection" || (people?.length ?? 0) === 0
      ? [[{text:"➕ Influencerin hinzufügen",callback_data:`addguessperson:${id}`}]]
      : [];
    return send(token, chatId, "<b>🖼 Medien verwalten</b>\n\nInfluencerinnen und ihre Hinweise:", { reply_markup: { inline_keyboard: [...addRow,...rows,backButton(`guesscat:${id}`)] } });
  }
  if (action === "guessmode") {
    try { await assertCreatorCanCreate(callback.from.id, role); } catch (error) { return send(token, chatId, error instanceof Error ? error.message : "Nicht erlaubt."); }
    return send(token, chatId, `<b>${id === "single" ? "👤 Einzelne Influencerin" : "👥 Mehrere Influencerinnen"}</b>

Wie sollen Spieler antworten?`, { reply_markup: { inline_keyboard: [
      [{ text: "⌨️ Namen eingeben", callback_data: `guesscreatemode:${id}|free_text` }],
      [{ text: "🔘 Namen auswählen", callback_data: `guesscreatemode:${id}|multiple_choice` }],
      [{ text: "🎲 Gemischter Modus", callback_data: `guesscreatemode:${id}|mixed` }],
      backButton("newguess:x")
    ] } });
  }
  if (action === "guesscreatemode") {
    const [gameMode, answerMode] = id.split("|");
    if (!["single", "collection"].includes(gameMode) || !["free_text", "multiple_choice", "mixed"].includes(answerMode)) return send(token, chatId, "Ungültige Auswahl.");
    await setGuessSession(callback.from.id, { game_id: null, person_id: null, mode: "awaiting_title", game_mode: gameMode, pending_value: answerMode });
    return send(token, chatId, "Sende jetzt einen neutralen Spielnamen, der die Lösung nicht verrät.", { reply_markup: { inline_keyboard: [backButton("newguess:x")] } });
  }
  if (action === "addguessperson") {
    const { data:game } = await supabase.from("guess_games").select("game_mode").eq("id", id).maybeSingle();
    const { count } = await supabase.from("guess_people").select("id", { count: "exact", head: true }).eq("game_id", id);
    if (game?.game_mode === "single" && (count ?? 0) >= 1) {
      return send(token, chatId, "Diese Kategorie ist als <b>einzelne Influencerin</b> angelegt. Es kann keine weitere Influencerin hinzugefügt werden.", { reply_markup: { inline_keyboard: [backButton(`guesspeople:${id}`)] } });
    }
    await setGuessSession(callback.from.id, { game_id: id, person_id: null, mode: "awaiting_person_name", pending_value: null });
    return send(token, chatId, "<b>➕ Influencerin hinzufügen</b>\n\nSende jetzt den korrekten Namen. Dieser Name bleibt während des Spiels verborgen.", { reply_markup: { inline_keyboard: [backButton(`guesspeople:${id}`)] } });
  }
  if (action === "finishguess") {
    const { data:g } = await supabase.from("guess_games").select("game_mode,title").eq("id", id).maybeSingle();
    const { count } = await supabase.from("guess_people").select("id", { count: "exact", head: true }).eq("game_id", id);
    const minimum = g?.game_mode === "single" ? 1 : 2;
    if ((count ?? 0) < minimum) return send(token, chatId, `Füge zuerst mindestens ${minimum} Influencerin${minimum > 1 ? "nen" : ""} hinzu.`, { reply_markup: { inline_keyboard: [backButton(`guesspeople:${id}`)] } });
    await supabase.from("guess_games").update({ is_active: true, updated_at: new Date().toISOString() }).eq("id", id);
    await setGuessSession(callback.from.id, { game_id: null, person_id: null, mode: "idle", game_mode: null, pending_value: null });
    return send(token, chatId, `✅ <b>${escapeHtml(g?.title ?? "Rate-Kategorie")}</b> ist fertig.`, { reply_markup: { inline_keyboard: [[{text:"▶️ Privat starten",callback_data:`privateplay:g|${id}`}],[{text:"📣 In Gruppe starten",callback_data:`grp:g|${id}`}],backButton(`guesscat:${id}`)] } });
  }
  if (action === "guessperson") {
    const { data:p } = await supabase.from("guess_people").select("id,game_id,display_name,aliases,social_handle,distractors,auto_fill_choices").eq("id", id).maybeSingle();
    if (!p) return send(token, chatId, "Influencerin nicht gefunden.");
    const { count } = await supabase.from("guess_media").select("id", { count:"exact", head:true }).eq("person_id", id);
    return send(token, chatId, `<b>⚙️ Influencerin verwalten</b>\n\n<b>${escapeHtml(p.display_name)}</b>\nHinweise: <b>${count ?? 0}</b>`, { reply_markup: { inline_keyboard: [
      [{text:"🖼 Hinweise ansehen",callback_data:`guessmedia:${id}`}],
      [{text:"➕ Hinweis hinzufügen",callback_data:`addguessmedia:${id}`}],
      [{text:"🔤 Aliase bearbeiten",callback_data:`guessaliases:${id}`}],
      [{text:"🔘 Antwortnamen verwalten",callback_data:`guesschoices:${id}`}],
      [{text:"🗑 Influencerin entfernen",callback_data:`deleteguesspersonask:${id}`}],
      backButton(`guesspeople:${p.game_id}`)
    ] } });
  }
  if (action === "addguessmedia") {
    const { data:p } = await supabase.from("guess_people").select("game_id,display_name").eq("id", id).maybeSingle();
    if (!p) return send(token, chatId, "Influencerin nicht gefunden.");
    await setGuessSession(callback.from.id, { game_id: p.game_id, person_id: id, mode: "awaiting_hint_media", pending_value: null });
    return send(token, chatId, `Sende jetzt einen Bildausschnitt oder ein GIF für <b>${escapeHtml(p.display_name)}</b>. Die Reihenfolge bestimmt den Schwierigkeitsgrad.`, { reply_markup: { inline_keyboard: [backButton(`guessperson:${id}`)] } });
  }
  if (action === "guessmedia") {
    const { data:p } = await supabase.from("guess_people").select("game_id,display_name").eq("id", id).maybeSingle();
    const { data:media } = await supabase.from("guess_media").select("id,media_url,media_type,hint_level,sort_order").eq("person_id", id).order("sort_order");
    for (const m of media ?? []) {
      const method = m.media_type === "animation" ? "sendAnimation" : "sendPhoto";
      const field = m.media_type === "animation" ? "animation" : "photo";
      await telegramApi(token, method, { chat_id: chatId, [field]: m.media_url, caption: `Hinweis ${m.hint_level}` });
    }
    return send(token, chatId, `<b>🖼 Hinweise: ${escapeHtml(p?.display_name ?? "Influencerin")}</b>`, { reply_markup: { inline_keyboard: [[{text:"➕ Hinweis hinzufügen",callback_data:`addguessmedia:${id}`}],backButton(`guessperson:${id}`)] } });
  }
  if (action === "toggleguessimages") {
    const { data:g } = await supabase.from("guess_games").select("send_images").eq("id", id).single();
    if (!g) return send(token, chatId, "Kategorie nicht gefunden.");
    await supabase.from("guess_games").update({ send_images: !g.send_images }).eq("id", id);
    const { data:updated } = await supabase.from("guess_games").select("title,send_images,answer_mode,hints_enabled").eq("id", id).single();
    if (!updated) return send(token, chatId, "Kategorie nicht gefunden.");
    return send(token, chatId, `<b>🧩 ${escapeHtml(updated.title)}</b>\n\nAntwortmodus: <b>${updated.answer_mode}</b>\nHinweise: <b>${updated.hints_enabled ? "Ja" : "Nein"}</b>\nBilder in Ergebnissen: <b>${updated.send_images ? "Ja" : "Nein"}</b>`, { reply_markup: { inline_keyboard: [[{ text: updated.send_images ? "📝 Ergebnisse ohne Bilder" : "🖼 Ergebnisse mit Bildern", callback_data: `toggleguessimages:${id}` }], [{ text: "🎮 Spiel öffnen", callback_data: `playguessid:${id}` }], backButton("catsguess:x")] } });
  }
  if (action === "playguess" || action === "playguessid") {
    let q = supabase.from("guess_games").select("id,title").eq("is_active", true).order("created_at", { ascending: false }).limit(1);
    if (action === "playguessid") q = supabase.from("guess_games").select("id,title").eq("id", id).limit(1);
    const { data } = await q; const g = data?.[0];
    if (!g) return send(token, chatId, "Keine aktive Rate-Kategorie gefunden.", { reply_markup: { inline_keyboard: [backButton("manageguess:x")] } });
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL || "";
    const url = `${baseUrl.startsWith("http") ? baseUrl : `https://${baseUrl}`}/guess?gameId=${g.id}`;
    return send(token, chatId, `<b>🧩 ${escapeHtml(g.title)}</b>`, { reply_markup: { inline_keyboard: [[{ text: "🧩 Spiel öffnen", web_app: { url } }], backButton("manageguess:x")] } });
  }
  if (action === "guesschoices") {
    const { data:p } = await supabase.from("guess_people").select("game_id,display_name,distractors,auto_fill_choices").eq("id", id).maybeSingle();
    if (!p) return send(token, chatId, "Influencerin nicht gefunden.");
    const names = Array.isArray(p.distractors) ? p.distractors : [];
    return send(token, chatId, `<b>🔘 Antwortnamen verwalten</b>\n\nRichtige Lösung: <b>${escapeHtml(p.display_name)}</b>\nEigene falsche Namen: <b>${names.length}</b>\nAutomatisch ergänzen: <b>${p.auto_fill_choices ? "Ja" : "Nein"}</b>\n\n${names.map((v:string,i:number)=>`${i+1}. ${escapeHtml(v)}`).join("\n") || "Noch keine eigenen Namen."}`, { reply_markup:{ inline_keyboard:[
      [{text:"➕ Namen eingeben / ersetzen",callback_data:`editguesschoices:${id}`}],
      [{text:p.auto_fill_choices?"🚫 Nicht automatisch ergänzen":"🎲 Automatisch ergänzen",callback_data:`toggleguessautofill:${id}`}],
      [{text:"🗑 Eigene Namen leeren",callback_data:`clearguesschoices:${id}`}],
      backButton(`guessperson:${id}`)
    ]}});
  }
  if (action === "editguesschoices") {
    const { data:p } = await supabase.from("guess_people").select("game_id").eq("id", id).maybeSingle();
    if (!p) return send(token, chatId, "Influencerin nicht gefunden.");
    await setGuessSession(callback.from.id,{game_id:p.game_id,person_id:id,mode:"awaiting_distractors"});
    return send(token, chatId, "Sende die falschen Antwortnamen mit Komma getrennt. Beispiel:\n<code>Pamela Reif, Lisa Marie Schiffner, Bianca Heinicke</code>", {reply_markup:{inline_keyboard:[backButton(`guesschoices:${id}`)]}});
  }
  if (action === "toggleguessautofill") {
    const {data:p}=await supabase.from("guess_people").select("auto_fill_choices").eq("id",id).maybeSingle();
    if(!p)return send(token,chatId,"Influencerin nicht gefunden.");
    await supabase.from("guess_people").update({auto_fill_choices:!p.auto_fill_choices}).eq("id",id);
    return handleCallback(token,{...callback,data:`guesschoices:${id}`},ownerId);
  }
  if (action === "clearguesschoices") {
    await supabase.from("guess_people").update({distractors:[]}).eq("id",id);
    return handleCallback(token,{...callback,data:`guesschoices:${id}`},ownerId);
  }
  if (action === "manageposition") {
    if (role === "player") return send(token,chatId,"Nur Owner oder Creator dürfen Position Rankings verwalten.");
    return send(token,chatId,"<b>📍 Position Ranking</b>",{reply_markup:{inline_keyboard:[
      [{text:"➕ Neue Kategorie",callback_data:"newposition:x"}],
      [{text:"📂 Kategorien verwalten",callback_data:"catsposition:x"}],
      [{text:"🎮 Aktives Spiel öffnen",callback_data:"playposition:x"}],
      backButton("gamesmenu:x")
    ]}});
  }
  if (action === "newposition") {
    if(role==="player")return send(token,chatId,"Nicht erlaubt.");
    await setGuessSession(callback.from.id, { game_id: null, person_id: null, mode: "idle", game_mode: null, pending_value: null });
    return send(token,chatId,"<b>📍 Neues Position Ranking</b>\n\nSollen die Influencerinnen nacheinander unbekannt erscheinen oder vorher alle sichtbar sein?",{reply_markup:{inline_keyboard:[
      [{text:"🎲 Blind Ranking",callback_data:"positionmode:blind"}],
      [{text:"👁 Alle vorher sichtbar",callback_data:"positionmode:open"}],
      backButton("manageposition:x")
    ]}});
  }
  if (action === "positionmode") {
    if(!["blind","open"].includes(id))return send(token,chatId,"Ungültiger Modus.");
    await setGuessSession(callback.from.id, { game_id: null, person_id: null, mode: "idle", game_mode: null, pending_value: null });
    await setPositionSession(callback.from.id,{game_id:null,mode:"awaiting_title",ranking_mode:id,pending_value:null});
    return send(token,chatId,"Sende jetzt einen neutralen Kategorienamen.",{reply_markup:{inline_keyboard:[backButton("newposition:x")]}});
  }
  if (action === "catsposition") {
    let q=supabase.from("position_games").select("id,title,is_active,creator_id").order("created_at",{ascending:false});
    if(role==="creator")q=q.eq("creator_id",callback.from.id);
    const {data}=await q;
    const rows=(data??[]).map((g:any)=>[{text:`${g.is_active?"✅":"⏸"} ${g.title}`,callback_data:`positioncat:${g.id}`}]);
    return send(token,chatId,"<b>📍 Kategorien verwalten</b>",{reply_markup:{inline_keyboard:[...rows,backButton("manageposition:x")]}});
  }
  if (action === "positioncat") {
    const {data:g}=await supabase.from("position_games").select("id,title,question,ranking_mode,send_images,is_active").eq("id",id).maybeSingle();
    if(!g)return send(token,chatId,"Kategorie nicht gefunden.");
    const {count}=await supabase.from("position_items").select("id",{count:"exact",head:true}).eq("game_id",id);
    return send(token,chatId,`<b>⚙️ Kategorie verwalten</b>\n\n<b>${escapeHtml(g.title)}</b>\nModus: <b>${g.ranking_mode==="blind"?"Blind":"Alle sichtbar"}</b>\nInfluencerinnen: <b>${count??0}</b>\nFrage: ${escapeHtml(g.question)}`,{reply_markup:{inline_keyboard:[
      [{text:"▶️ Privat starten",callback_data:`privateplay:p|${id}`}],
      [{text:"📣 In Gruppe starten",callback_data:`grp:p|${id}`}],
      [{text:"🖼 Medien verwalten",callback_data:`positionmedia:${id}`}],
      [{text:"✏️ Kategorie umbenennen",callback_data:`renameposition:${id}`}],
      [{text:"📊 Ergebnisse & Statistiken",callback_data:`positionstats:${id}`}],
      [{text:"⚙️ Ergebnis-Einstellungen",callback_data:`positionresults:${id}`}],
      [{text:"🎮 Spieleinstellungen",callback_data:`positionsettings:${id}`}],
      [{text:"🗑 Kategorie löschen",callback_data:`deleteposition:${id}`}],
      backButton("catsposition:x")
    ]}});
  }
  if (action === "positionmedia") {
    const {data:items}=await supabase.from("position_items").select("id,name,media_url,media_type,sort_order").eq("game_id",id).order("sort_order");
    for(const item of items??[]){const method=item.media_type==="animation"?"sendAnimation":"sendPhoto";const field=item.media_type==="animation"?"animation":"photo";await telegramApi(token,method,{chat_id:chatId,[field]:item.media_url,caption:item.name});}
    return send(token,chatId,"<b>🖼 Medien verwalten</b>",{reply_markup:{inline_keyboard:[[{text:"➕ Influencerin hinzufügen",callback_data:`addposition:${id}`}],backButton(`positioncat:${id}`)]}});
  }
  if (action === "renameposition") {
    await setPositionSession(callback.from.id,{game_id:id,mode:"awaiting_rename"});
    return send(token,chatId,"Sende jetzt den neuen Kategorienamen.",{reply_markup:{inline_keyboard:[backButton(`positioncat:${id}`)]}});
  }
  if (action === "positionstats") {
    const {count}=await supabase.from("position_votes").select("id",{count:"exact",head:true}).eq("game_id",id);
    return send(token,chatId,`<b>📊 Ergebnisse & Statistiken</b>

Abgegebene Rankings: <b>${count??0}</b>`,{reply_markup:{inline_keyboard:[backButton(`positioncat:${id}`)]}});
  }
  if (action === "positionresults") {
    const {data:g}=await supabase.from("position_games").select("send_images,show_own_choice,show_community_result,auto_send_results").eq("id",id).maybeSingle();if(!g)return send(token,chatId,"Kategorie nicht gefunden.");
    return send(token,chatId,"<b>⚙️ Ergebnis-Einstellungen</b>",{reply_markup:{inline_keyboard:[
      [{text:`🖼 Bilder/GIFs senden: ${g.send_images?"✅ Ja":"❌ Nein"}`,callback_data:`togglepositionimages:${id}`}],
      backButton(`positioncat:${id}`)
    ]}});
  }
  if (action === "positionsettings") {
    const {data:g}=await supabase.from("position_games").select("ranking_mode,question,position_labels").eq("id",id).maybeSingle();if(!g)return send(token,chatId,"Kategorie nicht gefunden.");
    const labels=Array.isArray(g.position_labels)?g.position_labels:[];
    return send(token,chatId,`<b>🎮 Spieleinstellungen</b>

Modus: <b>${g.ranking_mode==="blind"?"Blind Ranking":"Alle sichtbar"}</b>
Frage: ${escapeHtml(g.question)}
Positionen: <b>${labels.length?labels.map((label:string)=>escapeHtml(label)).join(" · "):"noch nicht festgelegt"}</b>`,{reply_markup:{inline_keyboard:[
      [{text:g.ranking_mode==="blind"?"👁 Auf alle sichtbar wechseln":"🎲 Auf Blind Ranking wechseln",callback_data:`togglepositionmode:${id}`}],
      [{text:"❓ Frage bearbeiten",callback_data:`editpositionquestion:${id}`}],
      [{text:"🏷 Positionen benennen",callback_data:`editpositionlabels:${id}`}],
      backButton(`positioncat:${id}`)
    ]}});
  }
  if (action === "togglepositionmode") {
    const {data:g}=await supabase.from("position_games").select("ranking_mode").eq("id",id).maybeSingle();if(!g)return send(token,chatId,"Kategorie nicht gefunden.");
    await supabase.from("position_games").update({ranking_mode:g.ranking_mode==="blind"?"open":"blind"}).eq("id",id);
    return send(token,chatId,"✅ Modus geändert.",{reply_markup:{inline_keyboard:[backButton(`positionsettings:${id}`)]}});
  }
  if (action === "editpositionquestion") {
    await setPositionSession(callback.from.id,{game_id:id,mode:"awaiting_question_edit"});
    return send(token,chatId,"Sende jetzt die neue Frage oder Aufgabenstellung.",{reply_markup:{inline_keyboard:[backButton(`positionsettings:${id}`)]}});
  }
  if (action === "editpositionlabels") {
    const {count}=await supabase.from("position_items").select("id",{count:"exact",head:true}).eq("game_id",id);
    if((count??0)<2)return send(token,chatId,"Füge zuerst mindestens zwei Influencerinnen hinzu.",{reply_markup:{inline_keyboard:[backButton(`positioncat:${id}`)]}});
    await setPositionSession(callback.from.id,{game_id:id,mode:"awaiting_labels_edit"});
    return send(token,chatId,`Sende genau <b>${count}</b> Bezeichnungen – je eine pro Zeile oder mit Komma getrennt.

Beispiel:
<code>Unbedingt
Sehr gerne
Vielleicht</code>`,{reply_markup:{inline_keyboard:[[{text:"🔢 Standardplätze verwenden",callback_data:`positionlabelsdefault:${id}`}],backButton(`positionsettings:${id}`)]}});
  }
  if (action === "addposition") {
    await setPositionSession(callback.from.id,{game_id:id,mode:"awaiting_item_media"});
    return send(token,chatId,"Sende ein Bild oder GIF mit dem Namen der Influencerin als Bildunterschrift.",{reply_markup:{inline_keyboard:[backButton(`positioncat:${id}`)]}});
  }
  if (action === "finishposition") {
    const {count}=await supabase.from("position_items").select("id",{count:"exact",head:true}).eq("game_id",id);
    if((count??0)<2)return send(token,chatId,"Füge mindestens zwei Influencerinnen hinzu.");
    await setPositionSession(callback.from.id,{game_id:id,mode:"awaiting_labels"});
    return send(token,chatId,`Benenne jetzt genau <b>${count}</b> Positionen. Sende je eine Bezeichnung pro Zeile oder trenne sie mit Kommas.

Beispiel:
<code>Unbedingt
Sehr gerne
Vielleicht</code>`,{reply_markup:{inline_keyboard:[[{text:"🔢 Standardplätze verwenden",callback_data:`positionlabelsdefault:${id}`}],backButton(`positioncat:${id}`)]}});
  }
  if (action === "positionlabelsdefault") {
    const {count}=await supabase.from("position_items").select("id",{count:"exact",head:true}).eq("game_id",id);
    if((count??0)<2)return send(token,chatId,"Füge zuerst mindestens zwei Influencerinnen hinzu.");
    const labels=Array.from({length:count??0},(_,i)=>`${i+1}. Platz`);
    await supabase.from("position_games").update({is_active:true,position_labels:labels,updated_at:new Date().toISOString()}).eq("id",id);
    await setPositionSession(callback.from.id,{game_id:null,mode:"idle",ranking_mode:null,pending_value:null});
    return send(token,chatId,"✅ Standardplätze wurden gespeichert.",{reply_markup:{inline_keyboard:[[{text:"▶️ Privat starten",callback_data:`privateplay:p|${id}`}],[{text:"📣 In Gruppe starten",callback_data:`grp:p|${id}`}],backButton(`positioncat:${id}`)]}});
  }
  if (action === "togglepositionimages") {
    const {data:g}=await supabase.from("position_games").select("send_images").eq("id",id).maybeSingle();if(!g)return send(token,chatId,"Kategorie nicht gefunden.");
    await supabase.from("position_games").update({send_images:!g.send_images}).eq("id",id);
    return handleCallback(token,{...callback,data:`positioncat:${id}`},ownerId);
  }
  if (action === "deleteposition") {
    await supabase.from("position_games").delete().eq("id",id);
    return send(token,chatId,"✅ Kategorie gelöscht.",{reply_markup:{inline_keyboard:[backButton("catsposition:x")]}});
  }
  if (action === "playposition") {
    let q=supabase.from("position_games").select("id,title").eq("is_active",true).order("created_at",{ascending:false}).limit(1);if(role==="creator")q=q.eq("creator_id",callback.from.id);
    const {data}=await q;const g=data?.[0];if(!g)return send(token,chatId,"Keine aktive Kategorie gefunden.");
    return send(token,chatId,`<b>📍 ${escapeHtml(g.title)}</b>`,{reply_markup:{inline_keyboard:[[{text:"📍 Spiel öffnen",web_app:{url:miniAppUrlFor("p",g.id,chatId)}}],backButton("manageposition:x")]}});
  }
  if (action === "managebudget") {
    if (role === "player") return send(token, chatId, "Nur Owner oder Creator dürfen Budget-Spiele verwalten.");
    return send(token, chatId, "<b>💰 Influencerinnen Budget Challenge</b>\n\nJedes Budget-Spiel ist eine eigene Kategorie.", { reply_markup: { inline_keyboard: [
      [{ text: "➕ Neues Spiel", callback_data: "newbudget:x" }],
      [{ text: "📂 Kategorien verwalten", callback_data: "catsbudget:x" }],
      [{ text: "🎮 Aktives Spiel öffnen", callback_data: "playbudget:x" }],
      backButton("gamesmenu:x")
    ] } });
  }
  if (action === "managebr" || action === "managefmk") {
    const gameType = action === "managefmk" ? "fmk" : "blind_ranking";
    return send(token, chatId, `<b>${gameType === "fmk" ? "🔥 Fuck, Marry, Kill" : "🏆 Blind Ranking"}</b>`, { reply_markup: { inline_keyboard: [
      [{ text: "➕ Neues Spiel", callback_data: `${gameType === "fmk" ? "newfmk" : "newbr"}:x` }],
      [{ text: "📂 Kategorien verwalten", callback_data: `${gameType === "fmk" ? "catsfmk" : "catsbr"}:x` }],
      [{ text: "🎮 Aktives Spiel öffnen", callback_data: `${gameType === "fmk" ? "playfmk" : "playbr"}:x` }],
      backButton("gamesmenu:x")
    ] } });
  }
  if (action === "catsbr" || action === "catsfmk") { if (role === "player") return send(token, chatId, "Nicht erlaubt."); return categoryMenu(token, chatId, callback.from.id, role, action === "catsfmk" ? "fmk" : "blind_ranking"); }
  if (action === "catsbudget") { if (role === "player") return send(token, chatId, "Nicht erlaubt."); return budgetGameMenu(token, chatId, callback.from.id, role); }
  if (action === "budgetcat") { if (role === "player") return send(token, chatId, "Nicht erlaubt."); return showBudgetGameActions(token, chatId, id, callback.from.id, role); }
  if (action === "newbudget") {
    if (role === "player") return send(token, chatId, "Nicht erlaubt.");
    try { await assertCreatorCanCreate(callback.from.id, role); } catch (error) { return send(token, chatId, error instanceof Error ? error.message : "Nicht erlaubt."); }
    await setBudgetSession(callback.from.id, { game_id: null, mode: "awaiting_budget_title", pending_file_id: null });
    return send(token, chatId, "<b>💰 Neue Budget Challenge</b>\n\nWie soll das Spiel heißen?\n\nSende jetzt nur den Titel.", { reply_markup: { inline_keyboard: [[{ text: "✖️ Abbrechen", callback_data: "cancelwizard:x" }], backButton("createmenu:x")] } });
  }
  if (action === "budgetamount") {
    if (role === "player") return send(token, chatId, "Nicht erlaubt.");
    const amount = Number(id);
    const session = await getBudgetSession(callback.from.id);
    const title = session?.pending_file_id?.trim();
    if (!title || !Number.isInteger(amount) || amount <= 0) return send(token, chatId, "Die Eingabe ist nicht mehr gültig. Starte die Erstellung erneut.", { reply_markup: { inline_keyboard: [backButton("createmenu:x")] } });
    const { data: game, error } = await supabase.from("budget_games").insert({ creator_id: callback.from.id, title, budget_amount: amount, currency_label: "€", is_active: false }).select("id,title").single();
    if (error) throw error;
    await incrementCreatorUsage(callback.from.id, role);
    await setBudgetSession(callback.from.id, { game_id: game.id, mode: "awaiting_budget_photo", pending_file_id: null });
    return send(token, chatId, `✅ <b>${escapeHtml(game.title)}</b> wurde mit <b>${amount} €</b> angelegt.\n\nSende jetzt das erste Bild. Schreibe als Bildunterschrift <code>Name | Preis</code>.`, { reply_markup: { inline_keyboard: [[{ text: "✅ Erstellung abschließen", callback_data: `finishbudget:${game.id}` }], [{ text: "✖️ Abbrechen", callback_data: "cancelwizard:x" }], backButton(`budgetcat:${game.id}`)] } });
  }
  if (action === "finishbudget") {
    const { count } = await supabase.from("budget_items").select("id", { count: "exact", head: true }).eq("game_id", id);
    if ((count ?? 0) < 2) return send(token, chatId, "Füge zuerst mindestens zwei Influencerinnen hinzu.", { reply_markup: { inline_keyboard: [backButton(`budgetcat:${id}`)] } });
    await supabase.from("budget_games").update({ is_active: true, updated_at: new Date().toISOString() }).eq("id", id);
    await setBudgetSession(callback.from.id, { game_id: null, mode: "idle", pending_file_id: null });
    return send(token, chatId, "✅ Budget-Spiel ist fertig und aktiv.", { reply_markup: { inline_keyboard: [[{ text: "▶️ Privat starten", callback_data: `privateplay:u|${id}` }], [{ text: "📣 In Gruppe starten", callback_data: `grp:u|${id}` }], backButton("managebudget:x")] } });
  }
  if (action === "cancelwizard") {
    await setSession(callback.from.id, { category_id: null, mode: "idle", pending_file_id: null, pending_item_id: null });
    await setBudgetSession(callback.from.id, { game_id: null, mode: "idle", pending_file_id: null });
    return send(token, chatId, "Erstellung abgebrochen.", { reply_markup: { inline_keyboard: [backButton("menuhelp:x")] } });
  }
  if (action === "addbudget") {
    if (role === "player") return send(token, chatId, "Nicht erlaubt.");
    const { data: game } = await supabase.from("budget_games").select("id,creator_id,title").eq("id", id).maybeSingle();
    if (!game || (role === "creator" && game.creator_id !== callback.from.id)) return send(token, chatId, "Nicht erlaubt.");
    await setBudgetSession(callback.from.id, { game_id: id, mode: "awaiting_budget_photo", pending_file_id: null });
    return send(token, chatId, `Sende jetzt ein weiteres Bild für <b>${escapeHtml(game.title)}</b> mit <code>Name | Preis</code> als Bildunterschrift.`, { reply_markup: { inline_keyboard: [backButton(`budgetcat:${id}`)] } });
  }
  if (action === "menucats") { if (role === "player") return send(token, chatId, "Nicht erlaubt."); return categoryMenu(token, chatId, callback.from.id, role, "blind_ranking"); }
  if (action === "rolemenu") { if (role !== "owner") return send(token, chatId, "Nur Owner."); return showRoleMenu(token, chatId); }
  if (action === "roleusers") { if (role !== "owner") return send(token, chatId, "Nur Owner."); return listRoleUsers(token, chatId, ownerId); }
  if (action === "roleuser") { if (role !== "owner") return send(token, chatId, "Nur Owner."); return showRoleUser(token, chatId, Number(id), ownerId); }
  if (action === "removeauth") {
    if (role !== "owner") return send(token, chatId, "Nur Owner.");
    const targetId = Number(id);
    if (!Number.isSafeInteger(targetId) || targetId <= 0 || targetId === ownerId) return send(token, chatId, "Diese Berechtigung kann nicht entfernt werden.");
    return send(token, chatId, `<b>Berechtigung wirklich entfernen?</b>

Telegram-ID: <code>${targetId}</code>
Der Nutzer wird danach wieder Player.`, { reply_markup: { inline_keyboard: [[{ text: "✅ Entfernen", callback_data: `removeauthconfirm:${targetId}` }], backButton(`roleuser:${targetId}`)] } });
  }
  if (action === "removeauthconfirm") {
    if (role !== "owner") return send(token, chatId, "Nur Owner.");
    const targetId = Number(id);
    if (!Number.isSafeInteger(targetId) || targetId <= 0 || targetId === ownerId) return send(token, chatId, "Diese Berechtigung kann nicht entfernt werden.");
    const { error } = await supabase.from("bot_users").update({ active: false, updated_at: new Date().toISOString() }).eq("user_id", targetId);
    if (error) throw error;
    await send(token, chatId, `✅ Die Owner-/Creator-Berechtigung von <code>${targetId}</code> wurde entfernt.`, { reply_markup: { inline_keyboard: [backButton("roleusers:x")] } });
    return;
  }
  if (action === "roletokens") { if (role !== "owner") return send(token, chatId, "Nur Owner."); return listOpenTokens(token, chatId); }
  if (action === "tokenmenu") {
    if (role !== "owner") return send(token, chatId, "Nur Owner.");
    return send(token, chatId, "<b>🎟 Creator-Token erstellen</b>\n\n1) Wähle zuerst das Kategorienkontingent.\n2) Danach wählst du die Gültigkeitsdauer.\n3) Der Bot generiert den Token automatisch.", { reply_markup: { inline_keyboard: quotaButtons("tokengen", "rolemenu:x") } });
  }
  if (action === "tokengen") {
    if (role !== "owner") return send(token, chatId, "Nur Owner.");
    const categoryLimit = id === "u" ? null : Number(id);
    if (id !== "u" && ![1, 3, 5, 10].includes(categoryLimit as number)) return send(token, chatId, "Ungültiges Kontingent.");
    return send(token, chatId, `<b>⏱ Gültigkeitsdauer wählen</b>\n\nKontingent: <b>${categoryLimit === null ? "unbegrenzt" : `${categoryLimit} Kategorien`}</b>\n\nWie lange darf der Token eingelöst werden?`, {
      reply_markup: { inline_keyboard: tokenDurationButtons(id) }
    });
  }
  if (action === "tokentime") {
    if (role !== "owner") return send(token, chatId, "Nur Owner.");
    const [quotaCode, durationCode] = id.split("_", 2);
    const categoryLimit = quotaCode === "u" ? null : Number(quotaCode);
    if (quotaCode !== "u" && ![1, 3, 5, 10].includes(categoryLimit as number)) return send(token, chatId, "Ungültiges Kontingent.");
    if (!["1h", "24h", "7d", "30d", "never"].includes(durationCode)) return send(token, chatId, "Ungültige Gültigkeitsdauer.");
    const expiresAt = tokenExpiry(durationCode);
    const raw = newInviteToken();
    const { error } = await supabase.from("invite_tokens").insert({
      token_hash: tokenHash(raw),
      token_hint: `${raw.slice(0, 7)}…${raw.slice(-4)}`,
      role: "creator",
      category_limit: categoryLimit,
      created_by: callback.from.id,
      expires_at: expiresAt
    });
    if (error) throw error;
    const validity = expiresAt ? `gültig bis ${new Date(expiresAt).toLocaleString("de-DE")}` : "ohne Ablaufdatum";
    return send(token, chatId, `<b>🎟 Einmaliger Creator-Token</b>\n\n<code>${raw}</code>\n\nKontingent: <b>${categoryLimit === null ? "unbegrenzt" : `${categoryLimit} Kategorien`}</b>\nGültigkeit: <b>${validity}</b>\nEinmal verwendbar.\n\nAktivierung: <code>/aktivieren ${raw}</code>`);
  }
  if (action === "owneraddmenu") {
    if (role !== "owner") return send(token, chatId, "Nur Owner.");
    await setSession(callback.from.id, { category_id: null, mode: "awaiting_authorize_owner_id", pending_file_id: null, pending_item_id: null });
    return send(token, chatId, "<b>👑 Owner per ID hinzufügen</b>\n\nSende jetzt die numerische Telegram-ID des neuen Owners.");
  }
  if (action === "approveowner") {
    if (role !== "owner") return send(token, chatId, "Nur Owner.");
    const targetId = Number(id);
    if (!Number.isSafeInteger(targetId) || targetId <= 0) return send(token, chatId, "Ungültige Telegram-ID.");
    const targetUser = await lookupTelegramUser(token, targetId);
    const { error } = await supabase.from("bot_users").upsert({
      user_id: targetId,
      role: "owner",
      username: targetUser.username ?? null,
      display_name: targetUser.first_name ?? targetUser.username ?? String(targetId),
      active: true,
      approved_by: callback.from.id,
      updated_at: new Date().toISOString()
    }, { onConflict: "user_id" });
    if (error) throw error;
    return send(token, chatId, `✅ <code>${targetId}</code> wurde als <b>Owner</b> hinzugefügt.`, { reply_markup: { inline_keyboard: [backButton("roleusers:x")] } });
  }
  if (action === "approvemenu") {
    if (role !== "owner") return send(token, chatId, "Nur Owner.");
    await setSession(callback.from.id, { category_id: null, mode: "awaiting_authorize_creator_id", pending_file_id: null, pending_item_id: null });
    return send(token, chatId, "<b>➕ Creator per ID genehmigen</b>\n\nSende jetzt zuerst die numerische Telegram-ID des Nutzers.");
  }
  if (action === "approveuser") {
    if (role !== "owner") return send(token, chatId, "Nur Owner.");
    const [target, quotaCode] = id.split("_", 2);
    const targetId = Number(target);
    const categoryLimit = quotaCode === "u" ? null : Number(quotaCode);
    if (!Number.isSafeInteger(targetId) || targetId <= 0 || (quotaCode !== "u" && ![1, 3, 5, 10].includes(categoryLimit as number))) {
      return send(token, chatId, "Ungültige Freigabeauswahl.");
    }
    const targetUser = await lookupTelegramUser(token, targetId);
    await saveCreator(targetUser, callback.from.id, categoryLimit);
    return send(token, chatId, `✅ <code>${targetId}</code> wurde als <b>Creator</b> genehmigt. Kontingent: <b>${categoryLimit === null ? "unbegrenzt" : `${categoryLimit} Kategorien`}</b>.`, { reply_markup: { inline_keyboard: [backButton("roleusers:x")] } });
  }
  if (action === "quotaedit") {
    if (role !== "owner") return send(token, chatId, "Nur Owner.");
    await setSession(callback.from.id, { category_id: null, mode: "awaiting_quota_user", pending_file_id: null, pending_item_id: null });
    return send(token, chatId, "Sende die numerische Telegram-ID des Creators, dessen Kontingent du ändern möchtest.", { reply_markup: { inline_keyboard: [backButton("rolemenu:x")] } });
  }
  if (action === "setquota") {
    if (role !== "owner") return send(token, chatId, "Nur Owner.");
    const [target, quotaCode] = id.split("_", 2);
    const targetId = Number(target);
    const categoryLimit = quotaCode === "u" ? null : Number(quotaCode);
    if (!Number.isSafeInteger(targetId) || targetId <= 0 || (quotaCode !== "u" && ![1, 3, 5, 10].includes(categoryLimit as number))) return send(token, chatId, "Ungültige Auswahl.");
    const { error } = await supabase.from("bot_users").update({ category_limit: categoryLimit, updated_at: new Date().toISOString() }).eq("user_id", targetId).eq("role", "creator");
    if (error) throw error;
    return send(token, chatId, `✅ Kontingent für <code>${targetId}</code>: <b>${categoryLimit === null ? "unbegrenzt" : `${categoryLimit} Kategorien`}</b>.`);
  }
  if (action === "rolerevoke") {
    if (role !== "owner") return send(token, chatId, "Nur Owner.");
    await setSession(callback.from.id, { category_id: null, mode: "awaiting_revoke_user", pending_file_id: null, pending_item_id: null });
    return send(token, chatId, "Sende jetzt die numerische Telegram-ID des zu sperrenden Creators.");
  }
  if (["menunew", "newbr", "newfmk"].includes(action)) {
    try { await assertCreatorCanCreate(callback.from.id, role); } catch (error) { return send(token, chatId, error instanceof Error ? error.message : "Nicht erlaubt."); }
    const gameType = action === "newfmk" ? "fmk" : "blind_ranking";
    await setSession(callback.from.id, { category_id: null, mode: `awaiting_new_category_name_${gameType}`, pending_file_id: null, pending_item_id: null });
    await send(token, chatId, `<b>${gameType === "fmk" ? "🔥 Neues FMK-Spiel" : "🏆 Neues Blind Ranking"}</b>\n\nWie soll das Spiel heißen?\n\nSende jetzt nur den Titel.`, { reply_markup: { inline_keyboard: [[{ text: "✖️ Abbrechen", callback_data: "cancelwizard:x" }], backButton("createmenu:x")] } });
    return;
  }
  if (action === "playbudget" || action === "playbudgetid") {
    let query = supabase.from("budget_games").select("id,title,creator_id").eq("is_active", true).order("created_at", { ascending: false }).limit(1);
    if (action === "playbudgetid") query = supabase.from("budget_games").select("id,title,creator_id").eq("id", id).eq("is_active", true).limit(1);
    if (role === "creator") query = query.eq("creator_id", callback.from.id);
    const { data: game } = await query.maybeSingle();
    if (!game) return send(token, chatId, "Noch kein aktives Budget-Spiel vorhanden.");
    const bot = await telegramApi(token, "getMe", {});
    const deepLink = `https://t.me/${bot.username}?start=budget_${chatId}_${game.id}`;
    return send(token, chatId, `💰 Budget Challenge <b>${escapeHtml(game.title)}</b> öffnen:`, { reply_markup: { inline_keyboard: [[{ text: "💰 Budget-Spiel öffnen", url: deepLink }], backButton("managebudget:x")] } });
  }
  if (action === "menuplay" || action === "playbr" || action === "playfmk") {
    const requestedType = action === "playfmk" ? "fmk" : "blind_ranking";
    let query = supabase.from("categories").select("id,name,game_type").eq("game_type", requestedType).order("created_at", { ascending: false }).limit(1);
    if (role === "creator") query = query.eq("created_by", callback.from.id);
    const { data: category } = await query.maybeSingle();
    if (!category) return send(token, chatId, requestedType === "fmk" ? "Noch kein FMK-Spiel vorhanden." : "Noch kein Blind Ranking vorhanden.");
    const bot = await telegramApi(token, "getMe", {});
    const payload = `${requestedType === "fmk" ? "fmk" : "group"}_${chatId}_${category.id}`;
    const deepLink = `https://t.me/${bot.username}?start=${payload}`;
    await send(token, chatId, requestedType === "fmk" ? "🔥 Aktives Fuck, Marry, Kill öffnen:" : "🏆 Aktives Blind Ranking öffnen:", {
      reply_markup: { inline_keyboard: [[{ text: requestedType === "fmk" ? "🔥 FMK öffnen" : "🏆 Blind Ranking öffnen", url: deepLink }]] }
    });
    return;
  }
  if (action === "cat") { if (!(await canManageCategory(callback.from.id, role, id))) return send(token, chatId, "Du darfst diese Kategorie nicht verwalten."); return showCategoryActions(token, chatId, id); }
  if (["activate","add","items","toggleimages","renamecat","delcatask","delcat"].includes(action) && !(await canManageCategory(callback.from.id, role, id))) return send(token, chatId, "Du darfst diese Kategorie nicht verwalten.");
  if (action === "activate") {
    await supabase.from("app_settings").upsert({ id: 1, active_category_id: id });
    await send(token, chatId, "✅ Kategorie wurde aktiviert.");
    return;
  }
  if (action === "add") {
    await setSession(callback.from.id, { category_id: id, mode: "awaiting_photo", pending_file_id: null, pending_item_id: null });
    await send(token, chatId, "Sende jetzt ein neues Bild. Du kannst den Namen direkt als Bildunterschrift mitsenden.");
    return;
  }
  if (action === "items") return showItems(token, chatId, id);
  if (action === "toggleimages") {
    const { data: category } = await supabase.from("categories").select("send_images").eq("id", id).maybeSingle();
    if (!category) return send(token, chatId, "Kategorie nicht gefunden.");
    const nextValue = category.send_images === false;
    const { error } = await supabase.from("categories").update({ send_images: nextValue }).eq("id", id);
    if (error) throw error;
    await send(token, chatId, nextValue ? "✅ Ergebnisbilder sind aktiviert." : "✅ Ergebnisse werden künftig nur als Text gesendet.");
    return showCategoryActions(token, chatId, id);
  }
  if (action === "renamecat") {
    await setSession(callback.from.id, { category_id: id, mode: "awaiting_category_name", pending_file_id: null, pending_item_id: null });
    await send(token, chatId, "Sende jetzt den neuen Namen der Kategorie.");
    return;
  }
  if (action === "delcatask") {
    await send(token, chatId, "Kategorie wirklich endgültig löschen?", {
      reply_markup: { inline_keyboard: [[{ text: "Ja, löschen", callback_data: `delcat:${id}` }], backButton(`cat:${id}`, "Abbrechen")] }
    });
    return;
  }
  if (action === "delcat") {
    await supabase.from("categories").delete().eq("id", id);
    await send(token, chatId, "🗑 Kategorie gelöscht.");
    return;
  }
  if (["item","renameitem","replace","delitemask","delitem"].includes(action) && !(await canManageItem(callback.from.id, role, id))) return send(token, chatId, "Du darfst diesen Eintrag nicht verwalten.");
  if (action === "item") {
    const { data: item } = await supabase.from("items").select("id,title,category_id").eq("id", id).maybeSingle();
    if (!item) return send(token, chatId, "Eintrag nicht gefunden.");
    await send(token, chatId, `<b>${escapeHtml(item.title)}</b>`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "✏️ Namen ändern", callback_data: `renameitem:${item.id}` }, { text: "📷 Bild ersetzen", callback_data: `replace:${item.id}` }],
          [{ text: "🗑 Eintrag löschen", callback_data: `delitemask:${item.id}` }],
          backButton(`items:${item.category_id}`)
        ]
      }
    });
    return;
  }
  if (action === "renameitem") {
    const { data: item } = await supabase.from("items").select("category_id").eq("id", id).maybeSingle();
    if (!item) return send(token, chatId, "Eintrag nicht gefunden.");
    await setSession(callback.from.id, { category_id: item.category_id, mode: "awaiting_item_name", pending_item_id: id, pending_file_id: null });
    await send(token, chatId, "Sende jetzt den neuen Namen.");
    return;
  }
  if (action === "replace") {
    const { data: item } = await supabase.from("items").select("category_id").eq("id", id).maybeSingle();
    if (!item) return send(token, chatId, "Eintrag nicht gefunden.");
    await setSession(callback.from.id, { category_id: item.category_id, mode: "awaiting_replacement_photo", pending_item_id: id, pending_file_id: null });
    await send(token, chatId, "Sende jetzt das neue Bild.");
    return;
  }
  if (action === "delitemask") {
    await send(token, chatId, "Eintrag wirklich löschen?", {
      reply_markup: { inline_keyboard: [[{ text: "Ja, löschen", callback_data: `delitem:${id}` }, { text: "Abbrechen", callback_data: "noop:x" }]] }
    });
    return;
  }
  if (action === "delitem") {
    const { data: item } = await supabase.from("items").select("category_id,storage_path").eq("id", id).maybeSingle();
    if (!item) return send(token, chatId, "Eintrag nicht gefunden.");
    await supabase.from("items").delete().eq("id", id);
    if (item.storage_path) await supabase.storage.from(IMAGE_BUCKET).remove([item.storage_path]);
    await normalizePositions(item.category_id);
    await send(token, chatId, "🗑 Eintrag gelöscht.");
    return;
  }
}


function relativeTime(value: string) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return "gerade eben";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `vor ${minutes} Min.`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `vor ${hours} Std.`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `vor ${days} ${days === 1 ? "Tag" : "Tagen"}`;
  return new Intl.DateTimeFormat("de-DE", { dateStyle: "medium" }).format(new Date(value));
}

async function sendTopCategories(token: string, chatId: string) {
  const supabase = getSupabaseAdmin();
  const [{ data: votes, error: votesError }, { data: categories, error: categoryError }] = await Promise.all([
    supabase.from("game_votes").select("category_id"),
    supabase.from("categories").select("id,name")
  ]);
  if (votesError) throw votesError;
  if (categoryError) throw categoryError;
  if (!votes?.length) {
    await send(token, chatId, "🏆 Noch keine Kategorien wurden bewertet.");
    return;
  }
  const counts = new Map<string, number>();
  for (const vote of votes) counts.set(vote.category_id, (counts.get(vote.category_id) ?? 0) + 1);
  const names = new Map((categories ?? []).map((category) => [category.id, category.name]));
  const ranking = [...counts.entries()]
    .map(([id, count]) => ({ id, count, name: names.get(id) ?? "Gelöschte Kategorie" }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "de"))
    .slice(0, 10);
  const medals = ["🥇", "🥈", "🥉"];
  const lines = ranking.map((entry, index) => `${medals[index] ?? `${index + 1}.`} <b>${escapeHtml(entry.name)}</b> — ${entry.count} ${entry.count === 1 ? "Vote" : "Votes"}`);
  await send(token, chatId, `<b>🏆 Top Kategorien</b>\n\n${lines.join("\n")}`);
}

async function sendLeaderboard(token: string, chatId: string) {
  const supabase = getSupabaseAdmin();
  const { data: votes, error } = await supabase
    .from("game_votes")
    .select("user_id,player_name")
    .eq("chat_id", chatId);
  if (error) throw error;
  if (!votes?.length) {
    await send(token, chatId, "🏅 In dieser Gruppe gibt es noch keine Abstimmungen.");
    return;
  }
  const players = new Map<number, { name: string; count: number }>();
  for (const vote of votes) {
    const current = players.get(Number(vote.user_id));
    players.set(Number(vote.user_id), { name: vote.player_name || current?.name || "Unbekannt", count: (current?.count ?? 0) + 1 });
  }
  const ranking = [...players.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "de")).slice(0, 15);
  const lines = ranking.map((entry, index) => `${index + 1}. <b>${escapeHtml(entry.name)}</b> — ${entry.count} ${entry.count === 1 ? "Ranking" : "Rankings"}`);
  await send(token, chatId, `<b>🏅 Aktivste Spieler</b>\n\n${lines.join("\n")}`);
}

async function sendHistory(token: string, chatId: string) {
  const supabase = getSupabaseAdmin();
  const { data: votes, error } = await supabase
    .from("game_votes")
    .select("category_id,player_name,created_at")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: false })
    .limit(15);
  if (error) throw error;
  if (!votes?.length) {
    await send(token, chatId, "📜 In dieser Gruppe gibt es noch keine Abstimmungen.");
    return;
  }
  const categoryIds = [...new Set(votes.map((vote) => vote.category_id))];
  const { data: categories, error: categoryError } = await supabase.from("categories").select("id,name").in("id", categoryIds);
  if (categoryError) throw categoryError;
  const names = new Map((categories ?? []).map((category) => [category.id, category.name]));
  const lines = votes.map((vote, index) => `${index + 1}. <b>${escapeHtml(names.get(vote.category_id) ?? "Gelöschte Kategorie")}</b> — ${escapeHtml(vote.player_name)} · ${relativeTime(vote.created_at)}`);
  await send(token, chatId, `<b>📜 Letzte Abstimmungen</b>\n\n${lines.join("\n")}`);
}


async function sendStatistics(token: string, chatId: string, categoryName: string) {
  const category = await findCategoryByName(categoryName);
  if (!category) {
    await send(token, chatId, "Kategorie nicht gefunden. Beispiel: <code>/statistik Test</code>");
    return;
  }

  const supabase = getSupabaseAdmin();
  const [{ data: votes, error: votesError }, { data: items, error: itemsError }] = await Promise.all([
    supabase.from("game_votes").select("id").eq("category_id", category.id).eq("chat_id", chatId),
    supabase.from("items").select("id,title,position").eq("category_id", category.id).order("position", { ascending: true })
  ]);
  if (votesError) throw votesError;
  if (itemsError) throw itemsError;

  const voteIds = (votes ?? []).map((vote) => vote.id);
  if (!voteIds.length) {
    await send(token, chatId, `📊 Für <b>${escapeHtml(category.name)}</b> gibt es in dieser Gruppe noch keine Stimmen.`);
    return;
  }

  const { data: entries, error: entriesError } = await supabase
    .from("vote_entries")
    .select("item_id,position")
    .in("vote_id", voteIds);
  if (entriesError) throw entriesError;

  const itemCount = (items ?? []).length;
  const pointsByItem = new Map<string, number>();
  const positionCounts = new Map<string, Map<number, number>>();
  for (const entry of entries ?? []) {
    const points = Math.max(1, itemCount - entry.position + 1);
    pointsByItem.set(entry.item_id, (pointsByItem.get(entry.item_id) ?? 0) + points);
    const counts = positionCounts.get(entry.item_id) ?? new Map<number, number>();
    counts.set(entry.position, (counts.get(entry.position) ?? 0) + 1);
    positionCounts.set(entry.item_id, counts);
  }

  const maxPoints = itemCount * voteIds.length;
  const rankedItems = (items ?? [])
    .map((item) => ({
      ...item,
      points: pointsByItem.get(item.id) ?? 0,
      firstPlaceCount: positionCounts.get(item.id)?.get(1) ?? 0
    }))
    .sort((a, b) => b.points - a.points || b.firstPlaceCount - a.firstPlaceCount || a.title.localeCompare(b.title, "de"));

  const scoreLines = rankedItems.map((item, index) => {
    const percentage = maxPoints > 0 ? Math.round((item.points / maxPoints) * 100) : 0;
    return `${index + 1}. <b>${escapeHtml(item.title)}</b> — ${item.points}/${maxPoints} Punkte (${percentage}%)`;
  });

  const distributionBlocks = rankedItems.map((item) => {
    const counts = positionCounts.get(item.id) ?? new Map<number, number>();
    const parts: string[] = [];
    for (let position = 1; position <= itemCount; position += 1) {
      const count = counts.get(position) ?? 0;
      if (count > 0) parts.push(`#${position} ${Math.round((count / voteIds.length) * 100)}%`);
    }
    return `<b>${escapeHtml(item.title)}</b>\n${parts.join(" · ") || "Keine Platzierungen"}`;
  });

  const favorite = rankedItems[0];
  const firstPick = [...rankedItems].sort((a, b) => b.firstPlaceCount - a.firstPlaceCount || b.points - a.points)[0];
  const controversial = [...rankedItems]
    .map((item) => {
      const counts = positionCounts.get(item.id) ?? new Map<number, number>();
      const mean = [...counts.entries()].reduce((sum, [position, count]) => sum + position * count, 0) / voteIds.length;
      const variance = [...counts.entries()].reduce((sum, [position, count]) => sum + ((position - mean) ** 2) * count, 0) / voteIds.length;
      return { ...item, variance };
    })
    .sort((a, b) => b.variance - a.variance)[0];
  const surprise = [...rankedItems]
    .map((item, communityIndex) => ({ ...item, gain: item.position - (communityIndex + 1) }))
    .sort((a, b) => b.gain - a.gain || b.points - a.points)[0];

  const badges = [
    favorite ? `👑 <b>Community-Favorit:</b> ${escapeHtml(favorite.title)}` : "",
    firstPick ? `❤️ <b>Häufigster #1 Pick:</b> ${escapeHtml(firstPick.title)} (${Math.round((firstPick.firstPlaceCount / voteIds.length) * 100)}%)` : "",
    controversial ? `😈 <b>Kontrovers:</b> ${escapeHtml(controversial.title)}` : "",
    surprise && surprise.gain > 0 ? `🔥 <b>Überraschung:</b> ${escapeHtml(surprise.title)} (+${surprise.gain} Plätze gegenüber der Ausgangsreihenfolge)` : ""
  ].filter(Boolean).join("\n");

  const sections = [
    `📊 <b>Statistik: ${escapeHtml(category.name)}</b>\n\n👥 ${voteIds.length} ${voteIds.length === 1 ? "Stimme" : "Stimmen"}\n📝 ${itemCount} Einträge\nPlatz 1 erhält ${itemCount} Punkte, der letzte Platz 1 Punkt.\nMaximal ${maxPoints} Punkte je Eintrag.`,
    `🏆 <b>Punktewertung</b>\n\n${scoreLines.join("\n")}`,
    `📈 <b>Platzverteilung</b>\n\n${distributionBlocks.join("\n\n")}`,
    badges ? `🏅 <b>Community-Badges</b>\n\n${badges}` : ""
  ].filter(Boolean);

  for (const section of sections) {
    let remaining = section;
    while (remaining.length > 3900) {
      let splitAt = remaining.lastIndexOf("\n", 3900);
      if (splitAt < 1000) splitAt = 3900;
      await send(token, chatId, remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).replace(/^\n+/, "");
    }
    if (remaining) await send(token, chatId, remaining);
  }
}

async function redeemCreatorToken(token: string, chatId: string | number, user: TelegramUser, rawInput: string, ownerId: number) {
  const raw = rawInput.trim().toUpperCase();
  if (!raw) { await send(token, chatId, "Bitte sende einen vollständigen Token, zum Beispiel <code>BR-XXXX-XXXX-XXXX</code>."); return false; }
  const supabase = getSupabaseAdmin();
  const { data: invite, error } = await supabase.from("invite_tokens").select("id,role,category_limit,expires_at,used_at,revoked_at").eq("token_hash", tokenHash(raw)).maybeSingle();
  if (error) throw error;
  if (!invite || invite.used_at || invite.revoked_at || (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now())) {
    await send(token, chatId, "Dieser Token ist ungültig, abgelaufen oder bereits verwendet.", { reply_markup: { inline_keyboard: [backButton("menuhelp:x")] } });
    return false;
  }
  if (invite.role !== "creator") { await send(token, chatId, "Dieser Token-Typ wird nicht unterstützt."); return false; }
  await saveCreator(user, ownerId, invite.category_limit as number | null);
  const { error: useError } = await supabase.from("invite_tokens").update({ used_by: user.id, used_at: new Date().toISOString() }).eq("id", invite.id).is("used_at", null);
  if (useError) throw useError;
  await send(token, chatId, `✅ Als <b>Creator</b> freigeschaltet. Kontingent: <b>${invite.category_limit === null ? "unbegrenzt" : `${invite.category_limit} Kategorien`}</b>. Nutze <code>/meinkonto</code>.`, { reply_markup: { inline_keyboard: [backButton("menuhelp:x")] } });
  return true;
}

export async function POST(request: NextRequest) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  const secret = process.env.WEBHOOK_SECRET;
  const ownerId = Number(process.env.ADMIN_TELEGRAM_USER_ID);
  const allowedGroupId = Number(process.env.ALLOWED_TELEGRAM_GROUP_ID);

  if (!token || !appUrl || !secret || !ownerId || !Number.isSafeInteger(allowedGroupId) || allowedGroupId >= 0) {
    return NextResponse.json({ ok: false, error: "Server configuration is incomplete." }, { status: 500 });
  }
  if (request.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  try {
    const update = (await request.json()) as TelegramUpdate;
    if (update.callback_query) {
      const callbackChat = update.callback_query.message?.chat;
      if (callbackChat && callbackChat.type !== "private") {
        const callbackRole = await getRole(update.callback_query.from.id, ownerId);
        if (callbackChat.id !== allowedGroupId || callbackRole !== "owner") return NextResponse.json({ ok: true });
      }
      await handleCallback(token, update.callback_query, ownerId);
      return NextResponse.json({ ok: true });
    }

    const message = update.message;
    if (!message?.chat?.id || !message.from?.id) return NextResponse.json({ ok: true });

    const chatId = String(message.chat.id);
    const userId = message.from.id;
    const isPrivate = message.chat.type === "private";
    const text = (message.text ?? "").trim();
    const isCommand = text.startsWith("/");
    const command = isCommand ? text.split(/\s+/)[0].split("@")[0].toLowerCase() : "";
    const supabase = getSupabaseAdmin();
    const role = await getRole(userId, ownerId);
    if (!isPrivate) {
      // Komplett still: falsche Gruppe oder kein Owner -> keinerlei Bot-Antwort.
      if (message.chat.id !== allowedGroupId || role !== "owner") return NextResponse.json({ ok: true });
      await registerKnownGroup(message.chat);
    }

    // Eigenständige Influencerinnen-Budget-Challenge.
    if (command === "/neuesbudget") {
      if (!isPrivate || (role !== "owner" && role !== "creator")) { await send(token, chatId, "Erstelle Budget-Spiele als Owner oder Creator im privaten Bot-Chat."); return NextResponse.json({ ok: true }); }
      try { await assertCreatorCanCreate(userId, role); } catch (error) { await send(token, chatId, error instanceof Error ? error.message : "Nicht erlaubt."); return NextResponse.json({ ok: true }); }
      const parts = commandArg(text).split("|").map((part) => part.trim());
      const budget = Number(parts.at(-1)?.replace(/[^0-9]/g, ""));
      const title = parts.slice(0, -1).join(" | ").trim();
      if (!title || !Number.isInteger(budget) || budget <= 0) { await send(token, chatId, "Bitte so senden: <code>/neuesbudget Meine Favoritinnen | 100</code>"); return NextResponse.json({ ok: true }); }
      const { data: game, error } = await supabase.from("budget_games").insert({ creator_id: userId, title, budget_amount: budget, currency_label: "€", is_active: false }).select("id,title").single();
      if (error) { await send(token, chatId, String(error.message).toLowerCase().includes("duplicate") ? "Du hast bereits ein Budget-Spiel mit diesem Namen." : error.message); return NextResponse.json({ ok: true }); }
      await incrementCreatorUsage(userId, role);
      await setBudgetSession(userId, { game_id: game.id, mode: "awaiting_budget_photo", pending_file_id: null });
      await send(token, chatId, `✅ Budget-Spiel <b>${escapeHtml(game.title)}</b> mit <b>${budget} €</b> erstellt.\n\nSende jetzt ein Bild mit der Bildunterschrift <code>Name | Preis</code>, zum Beispiel <code>Anna | 30</code>.`);
      return NextResponse.json({ ok: true });
    }
    if (["/fertigbudget", "/budgetfertig"].includes(command)) {
      if (!isPrivate || (role !== "owner" && role !== "creator")) return NextResponse.json({ ok: true });
      const session = await getBudgetSession(userId);
      if (!session?.game_id) { await send(token, chatId, "Kein Budget-Spiel in Bearbeitung."); return NextResponse.json({ ok: true }); }
      const { count } = await supabase.from("budget_items").select("id", { count: "exact", head: true }).eq("game_id", session.game_id);
      if ((count ?? 0) < 2) { await send(token, chatId, "Füge mindestens 2 Influencerinnen hinzu."); return NextResponse.json({ ok: true }); }
      await supabase.from("budget_games").update({ is_active: true, updated_at: new Date().toISOString() }).eq("id", session.game_id);
      const { data: game } = await supabase.from("budget_games").select("title").eq("id", session.game_id).single();
      await setBudgetSession(userId, { game_id: null, mode: "idle", pending_file_id: null });
      await send(token, chatId, `✅ <b>${escapeHtml(game?.title ?? "Budget-Spiel")}</b> ist aktiv. Starte es in der Gruppe mit <code>/budget ${escapeHtml(game?.title ?? "")}</code>.`);
      return NextResponse.json({ ok: true });
    }
    if (command === "/abbrechenbudget") { await setBudgetSession(userId, { game_id: null, mode: "idle", pending_file_id: null }); await send(token, chatId, "Budget-Eingabe abgebrochen."); return NextResponse.json({ ok: true }); }
    if (isPrivate && (role === "owner" || role === "creator")) {
      const guessSession = await getGuessSession(userId);
      if (guessSession?.mode === "awaiting_title" && text && !isCommand) {
        const title = text.trim();
        const { data: game, error } = await supabase.from("guess_games").insert({ creator_id: userId, title, game_mode: guessSession.game_mode ?? "collection", answer_mode: ["free_text", "multiple_choice", "mixed"].includes(guessSession.pending_value ?? "") ? guessSession.pending_value : "free_text", hints_enabled: true, send_images: true, is_active: false }).select("id,title").single();
        if (error) throw error;
        await incrementCreatorUsage(userId, role);
        await setGuessSession(userId, { game_id: game.id, person_id: null, mode: "awaiting_person_name", pending_value: null });
        await send(token, chatId, `✅ Kategorie <b>${escapeHtml(game.title)}</b> erstellt.\n\nSende jetzt den Namen der ersten Influencerin. Der Spielname bleibt neutral und verrät die Lösung nicht.`, { reply_markup: { inline_keyboard: [backButton(`guesscat:${game.id}`)] } });
        return NextResponse.json({ ok: true });
      }
      if (guessSession?.mode === "awaiting_game_rename" && guessSession.game_id && text && !isCommand) {
        const title = text.trim();
        if (title.length < 2) { await send(token, chatId, "Der Kategoriename ist zu kurz."); return NextResponse.json({ ok: true }); }
        await supabase.from("guess_games").update({ title, updated_at: new Date().toISOString() }).eq("id", guessSession.game_id);
        await setGuessSession(userId, { mode: "idle" });
        await send(token, chatId, `✅ Kategorie umbenannt in <b>${escapeHtml(title)}</b>.`, { reply_markup: { inline_keyboard: [backButton(`guesscat:${guessSession.game_id}`)] } });
        return NextResponse.json({ ok: true });
      }
      if (guessSession?.mode === "awaiting_alias_edit" && guessSession.person_id && text && !isCommand) {
        const aliases = /^keine$/i.test(text.trim()) ? [] : Array.from(new Set(text.split(",").map(v => v.trim()).filter(Boolean)));
        await supabase.from("guess_people").update({ aliases }).eq("id", guessSession.person_id);
        await setGuessSession(userId, { mode: "idle" });
        await send(token, chatId, "✅ Alternative Namen wurden gespeichert.", { reply_markup: { inline_keyboard: [backButton(`guessperson:${guessSession.person_id}`)] } });
        return NextResponse.json({ ok: true });
      }
      if (guessSession?.mode === "awaiting_distractors_initial" && guessSession.person_id && text && !isCommand) {
        const automatic = /^automatisch$/i.test(text.trim());
        const values = automatic ? [] : Array.from(new Set(text.split(",").map(v => v.trim()).filter(Boolean)));
        const { data: person } = await supabase.from("guess_people").select("display_name").eq("id", guessSession.person_id).maybeSingle();
        const filtered = values.filter(v => normalizedGuessName(v) !== normalizedGuessName(person?.display_name ?? ""));
        await supabase.from("guess_people").update({ distractors: filtered, auto_fill_choices: automatic }).eq("id", guessSession.person_id);
        await setGuessSession(userId, { mode: "awaiting_hint_media" });
        await send(token, chatId, `✅ Antwortauswahl gespeichert.

Sende jetzt den ersten Bildausschnitt oder ein GIF.`);
        return NextResponse.json({ ok: true });
      }
      if (guessSession?.mode === "awaiting_distractors" && guessSession.person_id && text && !isCommand) {
        const values = Array.from(new Set(text.split(",").map(v => v.trim()).filter(Boolean)));
        const { data:person } = await supabase.from("guess_people").select("display_name").eq("id",guessSession.person_id).maybeSingle();
        const filtered = values.filter(v => normalizedGuessName(v) !== normalizedGuessName(person?.display_name ?? ""));
        await supabase.from("guess_people").update({ distractors: filtered }).eq("id", guessSession.person_id);
        await setGuessSession(userId, { mode: "idle" });
        await send(token, chatId, `✅ ${filtered.length} eigene Antwortnamen gespeichert.`, { reply_markup: { inline_keyboard: [backButton(`guesschoices:${guessSession.person_id}`)] } });
        return NextResponse.json({ ok: true });
      }
      if (guessSession?.mode === "awaiting_person_name" && guessSession.game_id && text && !isCommand) {
        const { count } = await supabase.from("guess_people").select("id", {count:"exact",head:true}).eq("game_id",guessSession.game_id);
        const { data: person, error } = await supabase.from("guess_people").insert({ game_id: guessSession.game_id, display_name: text.trim(), aliases: [], sort_order: (count ?? 0)+1 }).select("id,display_name").single();
        if (error) throw error;
        await setGuessSession(userId, { person_id: person.id, mode: "awaiting_aliases", pending_value: null });
        await send(token, chatId, `Welche alternativen Namen, Schreibweisen oder Handles sollen für <b>${escapeHtml(person.display_name)}</b> gelten?\n\nMit Komma trennen oder <code>Keine</code> senden.`);
        return NextResponse.json({ ok: true });
      }
      if (guessSession?.mode === "awaiting_aliases" && guessSession.person_id && text && !isCommand) {
        const aliases = /^keine$/i.test(text.trim()) ? [] : text.split(",").map(v => v.trim()).filter(Boolean);
        await supabase.from("guess_people").update({ aliases }).eq("id", guessSession.person_id);
        const { data: personGame } = await supabase.from("guess_people").select("game_id").eq("id", guessSession.person_id).maybeSingle();
        const { data: guessGame } = personGame?.game_id ? await supabase.from("guess_games").select("answer_mode").eq("id", personGame.game_id).maybeSingle() : { data: null };
        if (guessGame?.answer_mode === "multiple_choice" || guessGame?.answer_mode === "mixed") {
          await setGuessSession(userId, { mode: "awaiting_distractors_initial" });
          await send(token, chatId, `Sende jetzt die falschen Antwortnamen mit Komma getrennt. Beispiel:
<code>Pamela Reif, Lisa Marie Schiffner, Bianca Heinicke</code>

Sende <code>Automatisch</code>, wenn fehlende Namen automatisch ergänzt werden dürfen.`);
        } else {
          await setGuessSession(userId, { mode: "awaiting_hint_media" });
          await send(token, chatId, "Sende jetzt den ersten Bildausschnitt oder ein GIF. Weitere Medien kannst du anschließend direkt hinzufügen.");
        }
        return NextResponse.json({ ok: true });
      }
      const guessPhoto = message.photo?.at(-1);
      const guessAnimation = (message as any).animation as {file_id:string}|undefined;
      if (guessSession?.mode === "awaiting_hint_media" && guessSession.person_id && (guessPhoto || guessAnimation)) {
        const fileId = guessPhoto?.file_id ?? guessAnimation!.file_id;
        const uploaded = await uploadTelegramPhoto(token, fileId, userId);
        const { count } = await supabase.from("guess_media").select("id", {count:"exact",head:true}).eq("person_id",guessSession.person_id);
        await supabase.from("guess_media").insert({ person_id: guessSession.person_id, media_url: uploaded.imageUrl, media_type: guessAnimation ? "animation" : "image", hint_level:(count??0)+1, sort_order:(count??0)+1 });
        const { data:p } = await supabase.from("guess_people").select("game_id,display_name").eq("id",guessSession.person_id).single();
        if (!p) throw new Error("Influencerin nicht gefunden.");
        const { data:game } = await supabase.from("guess_games").select("game_mode").eq("id", p.game_id).maybeSingle();
        const nextRows = [
          [{text:"➕ Weiteren Hinweis hinzufügen",callback_data:`addguessmedia:${guessSession.person_id}`}],
          ...(game?.game_mode === "collection" ? [[{text:"➕ Weitere Influencerin",callback_data:`addguessperson:${p.game_id}`}]] : []),
          [{text:"✅ Kategorie abschließen",callback_data:`finishguess:${p.game_id}`}],
          backButton(`guesspeople:${p.game_id}`)
        ];
        await send(token, chatId, `✅ Hinweis ${(count??0)+1} für <b>${escapeHtml(p.display_name)}</b> gespeichert.`, { reply_markup: { inline_keyboard: nextRows } });
        return NextResponse.json({ ok: true });
      }
      const positionSession = await getPositionSession(userId);
      if (positionSession?.mode === "awaiting_title" && text && !isCommand) {
        const {data:game,error}=await supabase.from("position_games").insert({creator_id:userId,title:text.trim(),ranking_mode:positionSession.ranking_mode??"blind",question:"Ordne deine Favoritinnen.",is_active:false}).select("id,title").single();
        if(error)throw error;
        await incrementCreatorUsage(userId,role);
        await setPositionSession(userId,{game_id:game.id,mode:"awaiting_question"});
        await send(token,chatId,`✅ <b>${escapeHtml(game.title)}</b> wurde erstellt.

Sende jetzt die Frage oder Aufgabenstellung, die Spieler sehen sollen.`,{reply_markup:{inline_keyboard:[backButton(`positioncat:${game.id}`)]}});
        return NextResponse.json({ok:true});
      }
      if (positionSession?.mode === "awaiting_rename" && positionSession.game_id && text && !isCommand) {
        await supabase.from("position_games").update({title:text.trim(),updated_at:new Date().toISOString()}).eq("id",positionSession.game_id);
        await setPositionSession(userId,{mode:"idle"});
        await send(token,chatId,"✅ Kategorie umbenannt.",{reply_markup:{inline_keyboard:[backButton(`positioncat:${positionSession.game_id}`)]}});
        return NextResponse.json({ok:true});
      }
      if (positionSession?.mode === "awaiting_question_edit" && positionSession.game_id && text && !isCommand) {
        await supabase.from("position_games").update({question:text.trim(),updated_at:new Date().toISOString()}).eq("id",positionSession.game_id);
        await setPositionSession(userId,{mode:"idle"});
        await send(token,chatId,"✅ Frage gespeichert.",{reply_markup:{inline_keyboard:[backButton(`positionsettings:${positionSession.game_id}`)]}});
        return NextResponse.json({ok:true});
      }
      if ((positionSession?.mode === "awaiting_labels" || positionSession?.mode === "awaiting_labels_edit") && positionSession.game_id && text && !isCommand) {
        const rawLabels=text.split(/[\n,;]+/).map((value:string)=>value.trim()).filter(Boolean);
        const labels=[...new Set(rawLabels)];
        const {count}=await supabase.from("position_items").select("id",{count:"exact",head:true}).eq("game_id",positionSession.game_id);
        if(labels.length!==(count??0)){
          await send(token,chatId,`Bitte sende genau <b>${count??0}</b> unterschiedliche Bezeichnungen. Aktuell erkannt: <b>${labels.length}</b>.

Je eine Position pro Zeile oder mit Komma getrennt.`);
          return NextResponse.json({ok:true});
        }
        if(labels.some((label:string)=>label.length>40)){
          await send(token,chatId,"Eine Positionsbezeichnung darf höchstens 40 Zeichen lang sein.");
          return NextResponse.json({ok:true});
        }
        await supabase.from("position_games").update({position_labels:labels,is_active:true,updated_at:new Date().toISOString()}).eq("id",positionSession.game_id);
        const edited=positionSession.mode==="awaiting_labels_edit";
        const gameId=positionSession.game_id;
        await setPositionSession(userId,{game_id:null,mode:"idle",ranking_mode:null,pending_value:null});
        await send(token,chatId,edited?"✅ Positionsbezeichnungen wurden aktualisiert.":"✅ Position Ranking ist fertig.",{reply_markup:{inline_keyboard:edited?[backButton(`positionsettings:${gameId}`)]:[[{text:"▶️ Privat starten",callback_data:`privateplay:p|${gameId}`}],[{text:"📣 In Gruppe starten",callback_data:`grp:p|${gameId}`}],backButton(`positioncat:${gameId}`)]}});
        return NextResponse.json({ok:true});
      }
      if (positionSession?.mode === "awaiting_question" && positionSession.game_id && text && !isCommand) {
        await supabase.from("position_games").update({question:text.trim()}).eq("id",positionSession.game_id);
        await setPositionSession(userId,{mode:"awaiting_item_media"});
        await send(token,chatId,"Sende jetzt ein Bild oder GIF mit dem Namen der Influencerin als Bildunterschrift.",{reply_markup:{inline_keyboard:[backButton(`positioncat:${positionSession.game_id}`)]}});
        return NextResponse.json({ok:true});
      }
      const positionPhoto = message.photo?.at(-1);
      const positionAnimation = (message as any).animation as {file_id:string}|undefined;
      if(positionSession?.mode === "awaiting_item_media" && positionSession.game_id && (positionPhoto||positionAnimation)){
        const name=(message.caption??"").trim();
        if(!name){await send(token,chatId,"Bitte sende das Bild oder GIF erneut und schreibe den Namen als Bildunterschrift dazu.");return NextResponse.json({ok:true});}
        const fileId=positionPhoto?.file_id??positionAnimation!.file_id;
        const uploaded=await uploadTelegramPhoto(token,fileId,userId);
        const {count}=await supabase.from("position_items").select("id",{count:"exact",head:true}).eq("game_id",positionSession.game_id);
        await supabase.from("position_items").insert({game_id:positionSession.game_id,name,media_url:uploaded.imageUrl,media_type:positionAnimation?"animation":"image",sort_order:(count??0)+1});
        await send(token,chatId,`✅ <b>${escapeHtml(name)}</b> hinzugefügt.`,{reply_markup:{inline_keyboard:[[{text:"➕ Weitere Influencerin",callback_data:`addposition:${positionSession.game_id}`}],[{text:"✅ Kategorie abschließen",callback_data:`finishposition:${positionSession.game_id}`}],backButton(`positioncat:${positionSession.game_id}`)]}});
        return NextResponse.json({ok:true});
      }
      const budgetSession = await getBudgetSession(userId);
      if (budgetSession?.mode === "awaiting_budget_rename" && budgetSession.game_id && text && !isCommand) {
        const title = text.trim();
        if (title.length < 2) { await send(token, chatId, "Der Kategoriename ist zu kurz."); return NextResponse.json({ ok: true }); }
        await supabase.from("budget_games").update({ title, updated_at: new Date().toISOString() }).eq("id", budgetSession.game_id);
        await setBudgetSession(userId, { mode: "idle" });
        await send(token, chatId, `✅ Kategorie umbenannt in <b>${escapeHtml(title)}</b>.`, { reply_markup: { inline_keyboard: [backButton(`budgetcat:${budgetSession.game_id}`)] } });
        return NextResponse.json({ ok: true });
      }
      if (budgetSession?.mode === "awaiting_budget_title" && text && !isCommand) {
        await setBudgetSession(userId, { game_id: null, mode: "awaiting_budget_amount", pending_file_id: text.trim() });
        await send(token, chatId, `<b>Budget für ${escapeHtml(text.trim())}</b>\n\nWähle einen Betrag:`, { reply_markup: { inline_keyboard: [
          [{ text: "50 €", callback_data: "budgetamount:50" }, { text: "100 €", callback_data: "budgetamount:100" }],
          [{ text: "200 €", callback_data: "budgetamount:200" }, { text: "500 €", callback_data: "budgetamount:500" }],
          [{ text: "1.000 €", callback_data: "budgetamount:1000" }],
          [{ text: "✖️ Abbrechen", callback_data: "cancelwizard:x" }],
          backButton("createmenu:x")
        ] } });
        return NextResponse.json({ ok: true });
      }
      const bestPhoto = message.photo?.at(-1);
      if (budgetSession?.game_id && bestPhoto && ["awaiting_budget_photo", "awaiting_budget_item_label"].includes(budgetSession.mode)) { await addBudgetItem(token, chatId, userId, budgetSession.game_id, bestPhoto.file_id, message.caption ?? ""); return NextResponse.json({ ok: true }); }
      if (budgetSession?.game_id && budgetSession.mode === "awaiting_budget_item_label" && budgetSession.pending_file_id && text && !isCommand) { await addBudgetItem(token, chatId, userId, budgetSession.game_id, budgetSession.pending_file_id, text); return NextResponse.json({ ok: true }); }
    }
    if (command === "/budget" && !isPrivate) {
      if (role === "player") { await send(token, chatId, "Nur Owner oder Creator dürfen ein Budget-Spiel starten.", topicExtra(message.message_thread_id)); return NextResponse.json({ ok: true }); }
      const requested = commandArg(text);
      let query = supabase.from("budget_games").select("id,title,creator_id").eq("is_active", true);
      if (role === "creator") query = query.eq("creator_id", userId);
      if (requested) query = query.ilike("title", requested).limit(1); else query = query.order("created_at", { ascending: false }).limit(1);
      const { data: game } = await query.maybeSingle();
      if (!game) { await send(token, chatId, requested ? "Budget-Spiel nicht gefunden." : "Noch kein aktives Budget-Spiel vorhanden."); return NextResponse.json({ ok: true }); }
      const bot = await telegramApi(token, "getMe", {});
      const deepLink = `https://t.me/${bot.username}?start=budget_${chatId}_${game.id}`;
      const topicSettings = await getGroupTopicSettings(chatId);
      await send(token, chatId, `💰 <b>Influencerinnen Budget Challenge</b>\nSpiel: <b>${escapeHtml(game.title)}</b>\n\nWen findest du am besten – und wen kannst du dir mit deinem Budget leisten?`, { ...topicExtra(topicSettings.poll_thread_id), reply_markup: { inline_keyboard: [[{ text: "💰 Budget-Spiel starten", url: deepLink }]] } });
      return NextResponse.json({ ok: true });
    }

    if (["/token", "/tokenmenu"].includes(command)) {
      if (!isPrivate) { await send(token, chatId, "Öffne das Token-Menü bitte im privaten Chat mit dem Bot."); return NextResponse.json({ ok: true }); }
      if (role !== "player") { await send(token, chatId, "Du bist bereits Owner oder Creator."); return NextResponse.json({ ok: true }); }
      await setSession(userId, { category_id: null, mode: "awaiting_token_redeem", pending_file_id: null, pending_item_id: null });
      await send(token, chatId, `<b>🎟 Creator-Token einlösen</b>

Sende jetzt deinen vollständigen Token, zum Beispiel <code>BR-XXXX-XXXX-XXXX</code>.`, { reply_markup: { inline_keyboard: [backButton("menuhelp:x")] } });
      return NextResponse.json({ ok: true });
    }

    if (command === "/aktivieren") {
      if (role !== "player") { await send(token, chatId, "Du bist bereits Owner oder Creator. Dein Kontingent kann nur ein Owner ändern."); return NextResponse.json({ ok: true }); }
      if (!isPrivate) { await send(token, chatId, "Aktiviere Tokens nur im privaten Chat mit dem Bot."); return NextResponse.json({ ok: true }); }
      await redeemCreatorToken(token, chatId, message.from, commandArg(text), ownerId);
      return NextResponse.json({ ok: true });
    }

    if (["/commands", "/help", "/hilfe"].includes(command)) {
      await sendCommands(token, chatId, role);
      return NextResponse.json({ ok: true });
    }

    if (["/id", "/meineid", "/myid"].includes(command)) {
      if (role === "owner" || role === "creator") {
        await supabase.from("bot_users").update({ username: message.from.username ?? null, display_name: message.from.first_name ?? message.from.username ?? String(userId), updated_at: new Date().toISOString() }).eq("user_id", userId);
      }
      const username = message.from.username ? `@${escapeHtml(message.from.username)}` : "kein öffentlicher Benutzername";
      await send(
        token,
        chatId,
        `<b>🆔 Deine Telegram-ID</b>\n\n<code>${userId}</code>\n\nBenutzername: ${escapeHtml(username)}\nRolle: <b>${role === "owner" ? "Owner" : role === "creator" ? "Creator" : "Player"}</b>\n\nDu kannst diese ID einem Owner schicken, damit er dich direkt als Creator freigibt.`,
        isPrivate ? undefined : topicExtra(message.message_thread_id)
      );
      return NextResponse.json({ ok: true });
    }

    if (["/rollen", "/roles"].includes(command)) {
      if (!isPrivate || role !== "owner") await send(token, chatId, "Dieses Menü ist nur für Owner im privaten Bot-Chat verfügbar.");
      else await showRoleMenu(token, chatId);
      return NextResponse.json({ ok: true });
    }

    if (["/meinkonto", "/myaccount"].includes(command)) {
      if (role !== "creator") {
        await send(token, chatId, role === "owner" ? "Owner haben ein unbegrenztes Kontingent." : "Du bist Player. Zum Erstellen eigener Kategorien brauchst du eine Creator-Freigabe.");
      } else {
        const quota = await getCreatorQuota(userId);
        await send(token, chatId, quota ? `<b>🛠 Creator-Konto</b>

Erstellt: ${quota.used}
Kontingent: ${quota.limit === null ? "unbegrenzt" : quota.limit}
Verfügbar: ${quota.limit === null ? "unbegrenzt" : Math.max(0, quota.limit - quota.used)}` : "Creator-Konto nicht gefunden.");
      }
      return NextResponse.json({ ok: true });
    }

    if (["/themen", "/topics"].includes(command)) {
      if (isPrivate) {
        await send(token, chatId, "Nutze <code>/themen</code> direkt in deiner Telegram-Gruppe.");
      } else {
        const settings = await getGroupTopicSettings(chatId);
        const poll = settings.poll_thread_id ? `Themen-ID <code>${settings.poll_thread_id}</code>` : "Allgemeines Thema";
        const results = settings.results_thread_id ? `Themen-ID <code>${settings.results_thread_id}</code>` : "Allgemeines Thema";
        await send(token, chatId, `<b>📌 Zielthemen dieser Gruppe</b>\n\n🎮 Umfrage-Link: ${poll}\n🏆 Ergebnisse: ${results}\n\nSende <code>/setumfragethema</code> im gewünschten Umfrage-Thema und <code>/setergebnisthema</code> im gewünschten Ergebnis-Thema.`, topicExtra(message.message_thread_id));
      }
      return NextResponse.json({ ok: true });
    }

    if (["/setumfragethema", "/setpolltopic"].includes(command)) {
      if (isPrivate) {
        await send(token, chatId, "Diesen Befehl musst du im gewünschten Thema deiner Gruppe senden.");
      } else if (role !== "owner") {
        await send(token, chatId, "Nur der konfigurierte Bot-Admin darf Zielthemen ändern.", topicExtra(message.message_thread_id));
      } else {
        const threadId = message.message_thread_id ?? null;
        await setGroupTopicSetting(chatId, "poll_thread_id", threadId);
        await send(token, chatId, threadId ? "✅ Dieses Thema ist jetzt das Ziel für Umfrage-Links." : "✅ Umfrage-Links werden jetzt im allgemeinen Thema gesendet.", topicExtra(threadId));
      }
      return NextResponse.json({ ok: true });
    }

    if (["/setergebnisthema", "/setresulttopic"].includes(command)) {
      if (isPrivate) {
        await send(token, chatId, "Diesen Befehl musst du im gewünschten Thema deiner Gruppe senden.");
      } else if (role !== "owner") {
        await send(token, chatId, "Nur der konfigurierte Bot-Admin darf Zielthemen ändern.", topicExtra(message.message_thread_id));
      } else {
        const threadId = message.message_thread_id ?? null;
        await setGroupTopicSetting(chatId, "results_thread_id", threadId);
        await send(token, chatId, threadId ? "✅ Dieses Thema ist jetzt das Ziel für Ergebnisse." : "✅ Ergebnisse werden jetzt im allgemeinen Thema gesendet.", topicExtra(threadId));
      }
      return NextResponse.json({ ok: true });
    }

    if (["/themenreset", "/resettopics"].includes(command)) {
      if (isPrivate) {
        await send(token, chatId, "Diesen Befehl musst du in der Gruppe senden.");
      } else if (role !== "owner") {
        await send(token, chatId, "Nur der konfigurierte Bot-Admin darf Zielthemen ändern.", topicExtra(message.message_thread_id));
      } else {
        const { error } = await supabase.from("group_topic_settings").delete().eq("chat_id", chatId);
        if (error) throw error;
        await send(token, chatId, "✅ Zielthemen zurückgesetzt. Umfrage-Link und Ergebnisse gehen wieder ins allgemeine Thema.", topicExtra(message.message_thread_id));
      }
      return NextResponse.json({ ok: true });
    }

    if (command === "/top") {
      await sendTopCategories(token, chatId);
      return NextResponse.json({ ok: true });
    }

    if (command === "/leaderboard") {
      if (isPrivate) {
        await send(token, chatId, "Nutze <code>/leaderboard</code> direkt in einer Telegram-Gruppe.");
      } else {
        await sendLeaderboard(token, chatId);
      }
      return NextResponse.json({ ok: true });
    }

    if (["/history", "/verlauf"].includes(command)) {
      if (isPrivate) {
        await send(token, chatId, "Nutze <code>/history</code> direkt in einer Telegram-Gruppe.");
      } else {
        await sendHistory(token, chatId);
      }
      return NextResponse.json({ ok: true });
    }

    if (["/statistik", "/statistics"].includes(command)) {
      if (isPrivate) {
        await send(token, chatId, "Nutze <code>/statistik Kategoriename</code> direkt in der Telegram-Gruppe, deren Stimmen du auswerten möchtest.");
        return NextResponse.json({ ok: true });
      }
      const name = commandArg(text);
      if (!name) {
        await send(token, chatId, "Bitte so senden: <code>/statistik Kategoriename</code>");
        return NextResponse.json({ ok: true });
      }
      await sendStatistics(token, chatId, name);
      return NextResponse.json({ ok: true });
    }

    if (isPrivate && role === "player" && text && !isCommand) {
      const playerSession = await getSession(userId);
      if (playerSession?.mode === "awaiting_token_redeem") {
        const redeemed = await redeemCreatorToken(token, chatId, message.from, text, ownerId);
        if (redeemed) await setSession(userId, { category_id: null, mode: "idle", pending_file_id: null, pending_item_id: null });
        return NextResponse.json({ ok: true });
      }
    }

    if (isPrivate && (role === "owner" || role === "creator")) {
      const startPayload = command === "/start" ? commandArg(text) : "";
      if (command === "/admin" || (command === "/start" && !startPayload)) {
        await sendCommands(token, chatId, role);
        return NextResponse.json({ ok: true });
      }

      if (command === "/neuekategorie" || command === "/neuesfmk") {
        try { await assertCreatorCanCreate(userId, role); } catch (error) { await send(token, chatId, error instanceof Error ? error.message : "Nicht erlaubt."); return NextResponse.json({ ok: true }); }
        const gameType: "blind_ranking" | "fmk" = command === "/neuesfmk" ? "fmk" : "blind_ranking";
        const name = commandArg(text);
        if (!name) {
          await send(token, chatId, gameType === "fmk"
            ? "Bitte so senden: <code>/neuesfmk Mein Spiel</code>"
            : "Bitte so senden: <code>/neuekategorie Meine Kategorie</code>");
          return NextResponse.json({ ok: true });
        }
        const { data: category, error } = await supabase.from("categories").insert({ name, created_by: userId, game_type: gameType }).select("id,name,game_type").single();
        if (error) {
          if (String(error.message).toLowerCase().includes("duplicate")) {
            await send(token, chatId, "Eine Kategorie mit diesem Namen existiert bereits.");
            return NextResponse.json({ ok: true });
          }
          throw error;
        }
        await incrementCreatorUsage(userId, role);
        await setSession(userId, { category_id: category.id, mode: "awaiting_photo", pending_file_id: null, pending_item_id: null });
        await send(token, chatId, category.game_type === "fmk"
          ? `✅ FMK-Spiel <b>${escapeHtml(category.name)}</b> erstellt.\n\nSende jetzt genau 3 Bilder. Den Namen kannst du jeweils als Bildunterschrift mitsenden.`
          : `✅ Kategorie <b>${escapeHtml(category.name)}</b> erstellt.\n\nSende jetzt das erste Bild. Danach frage ich nach dem Namen – oder du setzt den Namen direkt als Bildunterschrift.`);
        return NextResponse.json({ ok: true });
      }

      if (command === "/kategorien") {
        await categoryMenu(token, chatId, userId, role);
        return NextResponse.json({ ok: true });
      }

      if (command === "/bearbeiten") {
        const name = commandArg(text);
        if (!name) {
          await categoryMenu(token, chatId, userId, role);
          return NextResponse.json({ ok: true });
        }
        const category = await findCategoryByName(name);
        if (!category) {
          await send(token, chatId, "Kategorie nicht gefunden. Nutze <code>/kategorien</code>.");
          return NextResponse.json({ ok: true });
        }
        if (!(await canManageCategory(userId, role, category.id))) { await send(token, chatId, "Du darfst diese Kategorie nicht verwalten."); return NextResponse.json({ ok: true }); }
        await showCategoryActions(token, chatId, category.id);
        return NextResponse.json({ ok: true });
      }

      if (["/loeschen", "/löschen"].includes(command)) {
        const name = commandArg(text);
        if (!name) {
          await send(token, chatId, "Bitte so senden: <code>/loeschen Kategoriename</code>");
          return NextResponse.json({ ok: true });
        }
        const category = await findCategoryByName(name);
        if (!category) {
          await send(token, chatId, "Kategorie nicht gefunden.");
          return NextResponse.json({ ok: true });
        }
        if (!(await canManageCategory(userId, role, category.id))) { await send(token, chatId, "Du darfst diese Kategorie nicht löschen."); return NextResponse.json({ ok: true }); }
        await send(token, chatId, `Kategorie <b>${escapeHtml(category.name)}</b> wirklich endgültig löschen?`, {
          reply_markup: { inline_keyboard: [[{ text: "Ja, löschen", callback_data: `delcat:${category.id}` }, { text: "Abbrechen", callback_data: "noop:x" }]] }
        });
        return NextResponse.json({ ok: true });
      }

      if (command === "/abbrechen") {
        await supabase.from("admin_sessions").delete().eq("user_id", userId);
        await send(token, chatId, "Aktuelle Bearbeitung wurde abgebrochen.");
        return NextResponse.json({ ok: true });
      }

      if (command === "/fertig") {
        const session = await getSession(userId);
        if (!session?.category_id) {
          await send(token, chatId, "Keine Kategorie in Bearbeitung.");
          return NextResponse.json({ ok: true });
        }
        const count = await categoryCount(session.category_id);
        const { data: finishingCategory } = await supabase.from("categories").select("name,game_type").eq("id", session.category_id).maybeSingle();
        const isFmkCategory = finishingCategory?.game_type === "fmk";
        if ((isFmkCategory && count !== 3) || (!isFmkCategory && (count < 2 || count > 30))) {
          await send(token, chatId, isFmkCategory ? `Das FMK-Spiel hat aktuell ${count} Bilder. Es müssen genau 3 sein.` : `Die Kategorie hat aktuell ${count} Bilder. Erlaubt sind 2 bis 30.`);
          return NextResponse.json({ ok: true });
        }
        if (!isFmkCategory) await supabase.from("app_settings").upsert({ id: 1, active_category_id: session.category_id });
        await supabase.from("admin_sessions").delete().eq("user_id", userId);
        await send(token, chatId, isFmkCategory ? `✅ Fertig. Das FMK-Spiel enthält genau 3 Bilder.` : `✅ Fertig. Die Kategorie mit ${count} Bildern ist jetzt aktiv.`, { reply_markup: { inline_keyboard: [[{ text: "▶️ Privat starten", callback_data: `privateplay:${isFmkCategory ? "f" : "b"}|${session.category_id}` }], [{ text: "📣 In Gruppe starten", callback_data: `grp:${isFmkCategory ? "f" : "b"}|${session.category_id}` }], [{ text: "⚙️ Kategorie verwalten", callback_data: `cat:${session.category_id}` }], backButton("gamesmenu:x")] } });
        return NextResponse.json({ ok: true });
      }

      const session = await getSession(userId);

      if (role === "owner" && text && !isCommand && session?.mode === "awaiting_authorize_owner_id") {
        const targetId = Number(text.trim());
        if (!Number.isSafeInteger(targetId) || targetId <= 0) {
          await send(token, chatId, "Ungültige Telegram-ID. Sende nur die numerische ID, zum Beispiel <code>123456789</code>.");
          return NextResponse.json({ ok: true });
        }
        if (targetId === ownerId) {
          await supabase.from("admin_sessions").delete().eq("user_id", userId);
          await send(token, chatId, "Diese ID ist bereits der Haupt-Owner.");
          return NextResponse.json({ ok: true });
        }
        await supabase.from("admin_sessions").delete().eq("user_id", userId);
        await send(token, chatId, `<b>Owner hinzufügen?</b>\n\nTelegram-ID: <code>${targetId}</code>\n\nDer neue Owner erhält dieselben Verwaltungsrechte wie du.`, {
          reply_markup: { inline_keyboard: [[
            { text: "✅ Als Owner hinzufügen", callback_data: `approveowner:${targetId}` },
            { text: "Abbrechen", callback_data: "noop:x" }
          ]] }
        });
        return NextResponse.json({ ok: true });
      }
      if (role === "owner" && text && !isCommand && session?.mode === "awaiting_authorize_creator_id") {
        const targetId = Number(text.trim());
        if (!Number.isSafeInteger(targetId) || targetId <= 0) {
          await send(token, chatId, "Ungültige Telegram-ID. Sende nur die numerische ID, zum Beispiel <code>123456789</code>.");
          return NextResponse.json({ ok: true });
        }
        const { data: existingCreator } = await supabase
          .from("bot_users")
          .select("user_id,role,active,category_limit,categories_used")
          .eq("user_id", targetId)
          .maybeSingle();
        if (existingCreator?.role === "creator" && existingCreator.active) {
          await supabase.from("admin_sessions").delete().eq("user_id", userId);
          await send(token, chatId, `Dieser Nutzer ist bereits Creator. Aktuell: <b>${quotaLabel(existingCreator.category_limit, Number(existingCreator.categories_used ?? 0))}</b>. Nutze „Kontingent ändern“ im Rollenmenü.`);
          return NextResponse.json({ ok: true });
        }
        await supabase.from("admin_sessions").delete().eq("user_id", userId);
        const rows = quotaButtons("placeholder").map((row) => row.map((button) => {
          const quotaCode = button.callback_data.split(":", 2)[1];
          return { ...button, callback_data: `approveuser:${targetId}_${quotaCode}` };
        }));
        await send(token, chatId, `<b>Creator freigeben</b>\n\nTelegram-ID: <code>${targetId}</code>\n\nWie viele Kategorien darf dieser Creator insgesamt erstellen?`, {
          reply_markup: { inline_keyboard: rows }
        });
        return NextResponse.json({ ok: true });
      }
      if (role === "owner" && text && !isCommand && session?.mode === "awaiting_quota_user") {
        const targetId = Number(text.trim());
        if (!Number.isSafeInteger(targetId) || targetId <= 0) { await send(token, chatId, "Ungültige Telegram-ID."); return NextResponse.json({ ok: true }); }
        const { data: creator } = await supabase.from("bot_users").select("user_id,category_limit,categories_used,active").eq("user_id", targetId).eq("role", "creator").maybeSingle();
        if (!creator) { await send(token, chatId, "Creator nicht gefunden."); return NextResponse.json({ ok: true }); }
        await supabase.from("admin_sessions").delete().eq("user_id", userId);
        await send(token, chatId, `<b>Kontingent ändern</b>
Creator: <code>${targetId}</code>
Aktuell: ${quotaLabel(creator.category_limit, Number(creator.categories_used ?? 0))}

Neues Kontingent wählen:`, {
          reply_markup: { inline_keyboard: quotaButtons(`setquota_${targetId}`).map(row => row.map(button => ({ ...button, callback_data: button.callback_data.replace(`setquota_${targetId}:`, `setquota:${targetId}_`) }))) }
        });
        return NextResponse.json({ ok: true });
      }
      if (role === "owner" && text && !isCommand && session?.mode === "awaiting_revoke_user") {
        const targetId = Number(text.trim());
        if (!Number.isSafeInteger(targetId) || targetId <= 0 || targetId === ownerId) { await send(token, chatId, "Ungültige ID oder Owner kann nicht gesperrt werden."); return NextResponse.json({ ok: true }); }
        const { error } = await supabase.from("bot_users").update({ active: false, updated_at: new Date().toISOString() }).eq("user_id", targetId);
        if (error) throw error;
        await supabase.from("admin_sessions").delete().eq("user_id", userId);
        await send(token, chatId, `🚫 Creator <code>${targetId}</code> wurde gesperrt. Das Konto bleibt als Player nutzbar.`);
        return NextResponse.json({ ok: true });
      }

      if (message.photo?.length) {
        if (!session?.category_id) {
          await send(token, chatId, "Erstelle zuerst eine Kategorie mit <code>/neuekategorie Name</code> oder öffne <code>/kategorien</code>.");
          return NextResponse.json({ ok: true });
        }
        const bestPhoto = message.photo[message.photo.length - 1];

        if (session.mode === "awaiting_replacement_photo" && session.pending_item_id) {
          const uploaded = await uploadTelegramPhoto(token, bestPhoto.file_id, userId);
          const { data: old } = await supabase.from("items").select("storage_path").eq("id", session.pending_item_id).maybeSingle();
          const { error } = await supabase.from("items").update({ image_url: uploaded.imageUrl, storage_path: uploaded.objectPath }).eq("id", session.pending_item_id);
          if (error) throw error;
          if (old?.storage_path) await supabase.storage.from(IMAGE_BUCKET).remove([old.storage_path]);
          await setSession(userId, { mode: "awaiting_photo", pending_item_id: null, pending_file_id: null });
          await send(token, chatId, "✅ Bild wurde ersetzt.");
          return NextResponse.json({ ok: true });
        }

        const count = await categoryCount(session.category_id);
        const { data: uploadCategory } = await supabase.from("categories").select("game_type").eq("id", session.category_id).maybeSingle();
        const maxImages = uploadCategory?.game_type === "fmk" ? 3 : 30;
        if (count >= maxImages) {
          await send(token, chatId, uploadCategory?.game_type === "fmk" ? "Ein FMK-Spiel darf genau 3 Bilder enthalten." : "Maximal 30 Bilder pro Kategorie.");
          return NextResponse.json({ ok: true });
        }

        if (message.caption?.trim()) {
          const uploaded = await uploadTelegramPhoto(token, bestPhoto.file_id, userId);
          const { error } = await supabase.from("items").insert({
            category_id: session.category_id,
            title: message.caption.trim(),
            image_url: uploaded.imageUrl,
            storage_path: uploaded.objectPath,
            position: count + 1
          });
          if (error) throw error;
          await setSession(userId, { mode: "awaiting_photo", pending_file_id: null, pending_item_id: null });
          await send(token, chatId, `✅ <b>${escapeHtml(message.caption.trim())}</b> hinzugefügt (${count + 1}/${maxImages}). ${count + 1 === maxImages ? "Nutze jetzt /fertig." : "Sende das nächste Bild oder /fertig."}`);
        } else {
          await setSession(userId, { mode: "awaiting_title", pending_file_id: bestPhoto.file_id, pending_item_id: null });
          await send(token, chatId, "Wie heißt dieses Bild? Sende jetzt nur den Namen.");
        }
        return NextResponse.json({ ok: true });
      }

      if (text && !isCommand && session) {
        if (session.mode === "awaiting_new_category_name" || session.mode.startsWith("awaiting_new_category_name_")) {
          try { await assertCreatorCanCreate(userId, role); } catch (error) { await send(token, chatId, error instanceof Error ? error.message : "Nicht erlaubt."); return NextResponse.json({ ok: true }); }
          const gameType = session.mode.endsWith("_fmk") ? "fmk" : "blind_ranking";
          const { data: category, error } = await supabase.from("categories").insert({ name: text, created_by: userId, game_type: gameType }).select("id,name,game_type").single();
          if (error) {
            if (String(error.message).toLowerCase().includes("duplicate")) {
              await send(token, chatId, "Eine Kategorie mit diesem Namen existiert bereits.");
              return NextResponse.json({ ok: true });
            }
            throw error;
          }
          await incrementCreatorUsage(userId, role);
          await setSession(userId, { category_id: category.id, mode: "awaiting_photo", pending_file_id: null, pending_item_id: null });
          await send(token, chatId, `✅ ${category.game_type === "fmk" ? "FMK-Spiel" : "Kategorie"} <b>${escapeHtml(category.name)}</b> erstellt. Sende jetzt das erste Bild.${category.game_type === "fmk" ? " FMK benötigt genau 3 Bilder." : ""}`);
          return NextResponse.json({ ok: true });
        }
        if (session.mode === "awaiting_title" && session.pending_file_id && session.category_id) {
          const count = await categoryCount(session.category_id);
          const { data: uploadCategory } = await supabase.from("categories").select("game_type").eq("id", session.category_id).maybeSingle();
          const maxImages = uploadCategory?.game_type === "fmk" ? 3 : 30;
          if (count >= maxImages) {
            await send(token, chatId, uploadCategory?.game_type === "fmk" ? "Ein FMK-Spiel darf genau 3 Bilder enthalten." : "Maximal 30 Bilder pro Kategorie.");
            return NextResponse.json({ ok: true });
          }
          const uploaded = await uploadTelegramPhoto(token, session.pending_file_id, userId);
          const { error } = await supabase.from("items").insert({
            category_id: session.category_id,
            title: text,
            image_url: uploaded.imageUrl,
            storage_path: uploaded.objectPath,
            position: count + 1
          });
          if (error) throw error;
          await setSession(userId, { mode: "awaiting_photo", pending_file_id: null, pending_item_id: null });
          await send(token, chatId, `✅ <b>${escapeHtml(text)}</b> hinzugefügt (${count + 1}/${maxImages}). ${count + 1 === maxImages ? "Nutze jetzt /fertig." : "Sende das nächste Bild oder /fertig."}`);
          return NextResponse.json({ ok: true });
        }
        if (session.mode === "awaiting_category_name" && session.category_id) {
          const { error } = await supabase.from("categories").update({ name: text }).eq("id", session.category_id);
          if (error) throw error;
          await setSession(userId, { mode: "awaiting_photo", pending_item_id: null, pending_file_id: null });
          await send(token, chatId, `✅ Kategorie heißt jetzt <b>${escapeHtml(text)}</b>.`);
          return NextResponse.json({ ok: true });
        }
        if (session.mode === "awaiting_item_name" && session.pending_item_id) {
          const { error } = await supabase.from("items").update({ title: text }).eq("id", session.pending_item_id);
          if (error) throw error;
          await setSession(userId, { mode: "awaiting_photo", pending_item_id: null, pending_file_id: null });
          await send(token, chatId, `✅ Eintrag heißt jetzt <b>${escapeHtml(text)}</b>.`);
          return NextResponse.json({ ok: true });
        }
      }
    }

    if (command !== "/blindranking" && command !== "/fmk" && command !== "/budget" && command !== "/start") return NextResponse.json({ ok: true });
    if (!isPrivate && role === "player") {
      await send(token, chatId, "Nur Owner oder Creator dürfen ein neues Spiel starten.", topicExtra(message.message_thread_id));
      return NextResponse.json({ ok: true });
    }

    if (!isPrivate) {
      const requestedName = command === "/blindranking" || command === "/fmk" ? commandArg(text) : "";
      const requestedType = command === "/fmk" ? "fmk" : "blind_ranking";
      let categoryId: string | null = null;
      let categoryName = "aktive Kategorie";
      if (requestedName) {
        const category = await findCategoryByName(requestedName, requestedType);
        if (!category) {
          await send(token, chatId, requestedType === "fmk" ? "FMK-Spiel nicht gefunden. Nutze /fmk ohne Zusatz für das neueste FMK-Spiel." : "Kategorie nicht gefunden. Nutze /blindranking ohne Zusatz für die aktive Kategorie.");
          return NextResponse.json({ ok: true });
        }
        if (role === "creator" && !(await canManageCategory(userId, role, category.id))) {
          await send(token, chatId, "Creator dürfen nur eigene Kategorien starten.");
          return NextResponse.json({ ok: true });
        }
        categoryId = category.id;
        categoryName = category.name;
      } else {
        if (requestedType === "blind_ranking") {
          const { data: setting } = await supabase.from("app_settings").select("active_category_id").eq("id", 1).maybeSingle();
          if (setting?.active_category_id) {
            let activeQuery = supabase.from("categories")
              .select("id,name,game_type,created_by")
              .eq("id", setting.active_category_id)
              .eq("game_type", "blind_ranking");
            if (role === "creator") activeQuery = activeQuery.eq("created_by", userId);
            const { data: activeCategory } = await activeQuery.maybeSingle();
            if (activeCategory) {
              categoryId = activeCategory.id;
              categoryName = activeCategory.name;
            }
          }
        }

        // FMK hat absichtlich keine gemeinsame globale Aktiv-Kategorie. Ohne Namen
        // wird das neueste passende Spiel gewählt. Für Blind Ranking dient dies als Fallback.
        if (!categoryId) {
          let latestQuery = supabase.from("categories")
            .select("id,name")
            .eq("game_type", requestedType)
            .order("created_at", { ascending: false })
            .limit(1);
          if (role === "creator") latestQuery = latestQuery.eq("created_by", userId);
          const { data: latestCategory } = await latestQuery.maybeSingle();
          if (latestCategory) {
            categoryId = latestCategory.id;
            categoryName = latestCategory.name;
          }
        }
      }
      if (categoryId && role === "creator" && !(await canManageCategory(userId, role, categoryId))) {
        await send(token, chatId, requestedType === "fmk"
          ? "Dieses FMK-Spiel gehört einem anderen Creator. Starte ein eigenes Spiel mit <code>/fmk Spielname</code>."
          : "Die aktive Kategorie gehört einem anderen Creator. Starte eine eigene Kategorie mit <code>/blindranking Kategoriename</code>.");
        return NextResponse.json({ ok: true });
      }
      if (!categoryId) {
        await send(token, chatId, requestedType === "fmk"
          ? "Noch kein fertiges FMK-Spiel vorhanden."
          : "Noch kein fertiges Blind Ranking vorhanden.");
        return NextResponse.json({ ok: true });
      }
      const bot = await telegramApi(token, "getMe", {});
      const { data: selectedCategory } = await supabase.from("categories").select("game_type").eq("id", categoryId).maybeSingle();
      if (!selectedCategory || selectedCategory.game_type !== requestedType) {
        await send(token, chatId, requestedType === "fmk" ? "Dieses Spiel ist kein FMK-Spiel." : "Dieses Spiel ist kein Blind Ranking.");
        return NextResponse.json({ ok: true });
      }
      const deepLink = `https://t.me/${bot.username}?start=${requestedType === "fmk" ? "fmk" : "group"}_${chatId}_${categoryId}`;
      const topicSettings = await getGroupTopicSettings(chatId);
      await send(token, chatId, requestedType === "fmk" ? `🔥 <b>Fuck, Marry, Kill</b>\nSpiel: <b>${escapeHtml(categoryName)}</b>\n\nTippe auf den Button.` : `🎲 <b>Blind Ranking</b>\nKategorie: <b>${escapeHtml(categoryName)}</b>\n\nTippe auf den Button.`, {
        ...topicExtra(topicSettings.poll_thread_id),
        reply_markup: { inline_keyboard: [[{ text: requestedType === "fmk" ? "🔥 FMK starten" : "🎮 Blind Ranking starten", url: deepLink }]] }
      });
      return NextResponse.json({ ok: true });
    }

    const startPayload = command === "/start" ? text.split(/\s+/)[1] ?? "" : "";
    const match = startPayload.match(/^(group|fmk|budget|guess|position)_(-?\d+)_([0-9a-f-]{36})$/i);
    let targetChatId = chatId;
    let categoryId: string | null = null;
    let startGameType: "blind_ranking" | "fmk" | "budget" | "guess" | "position" = "blind_ranking";
    if (match) {
      startGameType = match[1] === "fmk" ? "fmk" : match[1] === "budget" ? "budget" : match[1] === "guess" ? "guess" : match[1] === "position" ? "position" : "blind_ranking";
      targetChatId = match[2];
      if (Number(targetChatId) !== allowedGroupId) {
        await send(token, chatId, "Dieser Gruppenstart ist für diesen Bot nicht freigegeben.");
        return NextResponse.json({ ok: true });
      }
      categoryId = match[3];
    } else {
      const { data: setting } = await supabase.from("app_settings").select("active_category_id").eq("id", 1).maybeSingle();
      categoryId = setting?.active_category_id ?? null;
    }
    if (!categoryId) {
      await send(token, chatId, "Noch keine aktive Kategorie vorhanden.");
      return NextResponse.json({ ok: true });
    }
    const miniPath = startGameType === "fmk" ? "/fmk" : startGameType === "budget" ? "/budget" : startGameType === "guess" ? "/guess" : startGameType === "position" ? "/position" : "";
    const idParam = startGameType === "budget" || startGameType === "guess" || startGameType === "position" ? "game_id" : "category_id";
    const miniAppUrl = `${appUrl.replace(/\/$/, "")}${miniPath}/?chat_id=${encodeURIComponent(targetChatId)}&${idParam}=${encodeURIComponent(categoryId)}`;
    const title = startGameType === "fmk" ? "🔥 <b>Fuck, Marry, Kill</b>" : startGameType === "budget" ? "💰 <b>Influencerinnen Budget Challenge</b>" : startGameType === "guess" ? "🧩 <b>Influencerin erraten</b>" : startGameType === "position" ? "📍 <b>Position Ranking</b>" : "🎲 <b>Blind Ranking</b>";
    const button = startGameType === "fmk" ? "🔥 FMK öffnen" : startGameType === "budget" ? "💰 Budget-Spiel öffnen" : startGameType === "guess" ? "🧩 Ratespiel öffnen" : startGameType === "position" ? "📍 Position Ranking öffnen" : "🎮 Blind Ranking öffnen";
    await send(token, chatId, `${title}\n\nÖffne jetzt das Spiel:`, {
      reply_markup: { inline_keyboard: [[{ text: button, web_app: { url: miniAppUrl } }]] }
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Telegram webhook error:", error);
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
