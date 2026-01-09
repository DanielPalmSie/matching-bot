export function getTelegramUserIdFromContext(ctx) {
    const rawId = ctx?.from?.id;
    if (rawId === null || rawId === undefined || rawId === '') {
        return null;
    }
    return String(rawId);
}

export function getTelegramUserIdFromPayload(payload) {
    const rawId = payload?.telegramUserId ?? payload?.telegram_user_id ?? payload?.telegram_userId;
    if (rawId === null || rawId === undefined || rawId === '') {
        return null;
    }
    return String(rawId);
}

export function getTokenPrefix(token) {
    return token ? String(token).slice(0, 6) : null;
}
