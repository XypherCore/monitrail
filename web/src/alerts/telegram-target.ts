export function isTelegramChatId(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{0,15}$/u.test(value) &&
    Number.isSafeInteger(Number(value));
}

export function isTelegramBotToken(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]{1,16}:[A-Za-z0-9_-]{1,128}$/u.test(value);
}
