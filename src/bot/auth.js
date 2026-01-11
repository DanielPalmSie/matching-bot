const SUCCESS_MAGIC_LINK_MESSAGE = 'Мы отправили вам письмо со ссылкой для входа.\nПроверьте вашу почту и нажмите на ссылку, чтобы войти.';

export function createAuthHandlers({
    apiRequest,
    sessionStore,
    logSessionContext,
    resetState,
    resolveTelegramUserId,
    getLoginMercureSubscriber,
    logger,
    ApiError,
    API_ROUTES,
}) {
    async function requestMagicLink(ctx, session, email) {
        const telegramUserId = resolveTelegramUserId(ctx, 'magicLink.request');
        if (!telegramUserId) {
            await ctx.reply('Не удалось определить пользователя Telegram. Попробуйте ещё раз.');
            return;
        }
        const chatId = ctx.chat?.id;
        logSessionContext('magicLink.request', {
            telegramUserId,
            chatId,
            token: session?.token,
        });
        logger.info('magicLink.request', {
            chatId: String(chatId),
            fromId: String(telegramUserId),
        });
        const name = ctx.from?.first_name || ctx.from?.username || undefined;
        try {
            const payload = {
                email,
                name,
                telegram_chat_id: chatId !== undefined ? String(chatId) : undefined,
                telegram_user_id: telegramUserId,
            };

            await apiRequest('post', API_ROUTES.MAGIC_LINK_REQUEST, payload, null);
            session.lastEmail = email;
            resetState(session);
            sessionStore.persist();
            sessionStore.setPendingMagicLink(telegramUserId, email);
            const loginMercureSubscriber = getLoginMercureSubscriber();
            if (telegramUserId && loginMercureSubscriber) {
                loginMercureSubscriber.ensureSubscription(telegramUserId);
            }
            await ctx.reply(SUCCESS_MAGIC_LINK_MESSAGE);
        } catch (error) {
            if (
                error instanceof ApiError &&
                error.status === 400 &&
                (error.message || '').toLowerCase().includes('invalid telegram_chat_id')
            ) {
                await ctx.reply('Произошла ошибка при связывании с Telegram. Попробуйте ещё раз или обратитесь в поддержку.');
                return;
            }
            if (error instanceof ApiError && error.status === 400) {
                await ctx.reply('Введите корректный email.');
                return;
            }
            if (error instanceof ApiError && error.status === 500) {
                await ctx.reply('Сервер временно недоступен, попробуйте позже.');
                return;
            }
            await ctx.reply('Сервер временно недоступен, попробуйте позже.');
        }
    }

    return { requestMagicLink };
}
