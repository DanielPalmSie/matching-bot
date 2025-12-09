const loggedInByChatId = new Map();
const pendingMagicLinkByChatId = new Map();

export function setPendingMagicLink(chatId, email) {
    if (!chatId) return;
    pendingMagicLinkByChatId.set(String(chatId), { email });
}

export function clearPendingMagicLink(chatId) {
    if (!chatId) return;
    pendingMagicLinkByChatId.delete(String(chatId));
}

export function setLoggedIn(chatId, data) {
    if (!chatId) return;
    loggedInByChatId.set(String(chatId), data);
    clearPendingMagicLink(chatId);
}

export function getLoggedIn(chatId) {
    if (!chatId) return null;
    return loggedInByChatId.get(String(chatId)) || null;
}

export function hasPendingMagicLink(chatId) {
    if (!chatId) return false;
    return pendingMagicLinkByChatId.has(String(chatId));
}

export function resetLoginState(chatId) {
    if (!chatId) return;
    loggedInByChatId.delete(String(chatId));
    clearPendingMagicLink(chatId);
}

export function listLoginState() {
    return { loggedInByChatId, pendingMagicLinkByChatId };
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
