const loggedInByTelegramUserId = new Map();
const pendingMagicLinkByTelegramUserId = new Map();

export function setPendingMagicLink(telegramUserId, email) {
    if (!telegramUserId) return;
    pendingMagicLinkByTelegramUserId.set(String(telegramUserId), { email });
}

export function clearPendingMagicLink(telegramUserId) {
    if (!telegramUserId) return;
    pendingMagicLinkByTelegramUserId.delete(String(telegramUserId));
}

export function setLoggedIn(telegramUserId, data) {
    if (!telegramUserId) return;
    loggedInByTelegramUserId.set(String(telegramUserId), data);
    clearPendingMagicLink(telegramUserId);
}

export function getLoggedIn(telegramUserId) {
    if (!telegramUserId) return null;
    return loggedInByTelegramUserId.get(String(telegramUserId)) || null;
}

export function hasPendingMagicLink(telegramUserId) {
    if (!telegramUserId) return false;
    return pendingMagicLinkByTelegramUserId.has(String(telegramUserId));
}

export function resetLoginState(telegramUserId) {
    if (!telegramUserId) return;
    loggedInByTelegramUserId.delete(String(telegramUserId));
    clearPendingMagicLink(telegramUserId);
}

export function listLoginState() {
    return { loggedInByTelegramUserId, pendingMagicLinkByTelegramUserId };
}

export default {
    setPendingMagicLink,
    clearPendingMagicLink,
    setLoggedIn,
    getLoggedIn,
    hasPendingMagicLink,
    resetLoginState,
    listLoginState,
};
