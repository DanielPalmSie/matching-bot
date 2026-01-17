export function createStartFlow({
    sessionStore,
    getLoggedIn,
    setLoggedIn,
    menu,
    logger = console,
}) {
    return async function startFlow(ctx, { forceRestart = false } = {}) {
        const rawTelegramUserId = ctx?.from?.id;
        if (!rawTelegramUserId) {
            logger.warn('startFlow.missingTelegramUserId', {
                updateType: ctx?.updateType,
                chatId: ctx?.chat?.id ?? null,
            });
            return;
        }

        const telegramUserId = String(rawTelegramUserId);
        const session = sessionStore.getSessionByTelegramUserId(telegramUserId);

        if (forceRestart) {
            sessionStore.clearSessionAuth(session, telegramUserId);
            sessionStore.resetState(session);
        }

        const loggedIn = getLoggedIn(telegramUserId);
        if (loggedIn) {
            session.token = loggedIn.jwt;
            session.backendUserId = loggedIn.userId;
            sessionStore.persist();
            await menu.sendMainMenu(ctx.chat?.id, { email: loggedIn.email });
            return;
        }

        if (session.token) {
            setLoggedIn(telegramUserId, {
                userId: session.backendUserId,
                email: session.lastEmail,
                jwt: session.token,
            });
            await menu.sendMainMenu(ctx.chat?.id, { email: session.lastEmail });
            return;
        }

        session.state = 'awaiting_email';
        session.temp = {};
        sessionStore.persist();
        const hint = session.lastEmail ? `\n(Последний использованный email: ${session.lastEmail})` : '';
        await ctx.reply(`Введите ваш email для входа.${hint}`);
    };
}
