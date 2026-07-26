import crypto from "crypto";

export type TelegramAuthFailure =
  | "missing_init_data"
  | "missing_hash"
  | "missing_auth_date"
  | "expired"
  | "future_auth_date"
  | "invalid_hash";

export type TelegramAuthResult =
  | { ok: true; params: URLSearchParams; ageSeconds: number }
  | { ok: false; reason: TelegramAuthFailure; ageSeconds?: number };

const MAX_AUTH_AGE_SECONDS = 24 * 60 * 60;
const MAX_CLOCK_SKEW_SECONDS = 120;

export function validateTelegramInitData(initData: string, botToken: string): TelegramAuthResult {
  if (!initData?.trim()) return { ok: false, reason: "missing_init_data" };

  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  if (!receivedHash) return { ok: false, reason: "missing_hash" };

  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate) || authDate <= 0) {
    return { ok: false, reason: "missing_auth_date" };
  }

  const ageSeconds = Math.floor(Date.now() / 1000) - authDate;
  if (ageSeconds < -MAX_CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: "future_auth_date", ageSeconds };
  }
  if (ageSeconds > MAX_AUTH_AGE_SECONDS) {
    return { ok: false, reason: "expired", ageSeconds };
  }

  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const calculatedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  if (!/^[a-f0-9]{64}$/i.test(receivedHash)) {
    return { ok: false, reason: "invalid_hash", ageSeconds };
  }

  const valid = crypto.timingSafeEqual(
    Buffer.from(calculatedHash, "hex"),
    Buffer.from(receivedHash, "hex")
  );

  return valid
    ? { ok: true, params, ageSeconds }
    : { ok: false, reason: "invalid_hash", ageSeconds };
}

export function telegramAuthErrorMessage(reason: TelegramAuthFailure): string {
  switch (reason) {
    case "missing_init_data":
      return "Telegram-Anmeldedaten wurden nicht geladen. Bitte die Mini App schließen und erneut über den aktuellen Spiel-Button öffnen.";
    case "expired":
      return "Die Telegram-Anmeldung ist abgelaufen. Bitte die Mini App schließen und den aktuellen Spiel-Button erneut öffnen.";
    default:
      return "Telegram-Anmeldung konnte nicht bestätigt werden. Bitte die Mini App schließen und erneut öffnen.";
  }
}
