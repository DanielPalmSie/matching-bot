export function createMenu({ bot, logger, MAIN_MENU_KEYBOARD }) {
    async function sendMainMenu(chatId, userInfo = {}) {
        if (!chatId) return;
        const greetingName = userInfo.name || userInfo.email || 'друг';
        const message = `Добро пожаловать, ${greetingName}!`;
        logger.info('menu.sending', {
            chatId: String(chatId),
        });
        const sent = await bot.telegram.sendMessage(chatId, message, MAIN_MENU_KEYBOARD);
        logger.info('menu.sent', {
            chatId: String(chatId),
            messageId: String(sent?.message_id),
            ts: new Date().toISOString(),
        });
    }

    return { sendMainMenu };
}
