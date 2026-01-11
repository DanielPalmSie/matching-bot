export function createLoginHandler({
    logger,
    apiRequest,
    API_ROUTES,
    getTokenPrefix,
    getSessionByTelegramUserId,
    saveUserJwt,
    resetState,
    sessionStore,
    bot,
    MAIN_MENU_KEYBOARD,
}) {
    async function handleUserLoggedInEvent({ telegramUserId, chatId, userId, email, jwt }) {
        logger.info('login.handle', {
            telegramUserId,
            chatId,
            hasJwt: !!jwt,
            jwtLength: jwt?.length,
            tokenPrefix: getTokenPrefix(jwt),
        });
        console.log('[Auth] Received login event', {
            telegramUserId,
            chatId,
            userId,
            email,
        });
        if (!telegramUserId) {
            logger.warn('login.handle.missingTelegramUserId', {
                chatId,
                tokenPrefix: getTokenPrefix(jwt),
            });
            return;
        }
        const session = getSessionByTelegramUserId(telegramUserId);
        const effectiveEmail = email || session.lastEmail;
        let resolvedUserId = userId;

        if (!resolvedUserId && jwt) {
            try {
                const profile = await apiRequest('get', API_ROUTES.ME, null, jwt);
                resolvedUserId = profile?.id;
            } catch (error) {
                console.error('Failed to resolve userId after login event', {
                    telegramUserId,
                    chatId,
                    error,
                });
            }
        }

        console.log('BOT LOGIN STATE UPDATE', {
            telegramUserId,
            chatId,
            jwtLength: jwt?.length || 0,
            tokenPrefix: getTokenPrefix(jwt),
            backendUserId: resolvedUserId || null,
            timestamp: new Date().toISOString(),
        });
        saveUserJwt(telegramUserId, jwt, { userId: resolvedUserId, email: effectiveEmail, chatId });
        resetState(session);
        sessionStore.persist();
        sessionStore.clearPendingMagicLink(telegramUserId);

        const loginMessage = 'Вы успешно вошли! Вот ваше меню:';
        console.log('BOT SEND MENU START', {
            telegramUserId,
            chatId,
            timestamp: new Date().toISOString(),
        });
        try {
            logger.info('menu.sending', {
                chatId: String(chatId),
            });
            const message = await bot.telegram.sendMessage(chatId, loginMessage, MAIN_MENU_KEYBOARD);
            logger.info('menu.sent', {
                chatId: String(chatId),
                messageId: String(message?.message_id),
                ts: new Date().toISOString(),
            });
            console.log('BOT SEND MENU DONE', {
                telegramUserId,
                chatId,
                messageId: message?.message_id ?? null,
                timestamp: new Date().toISOString(),
            });
        } catch (error) {
            console.log('BOT SEND MENU DONE', {
                telegramUserId,
                chatId,
                error: error?.message || error,
                timestamp: new Date().toISOString(),
            });
            throw error;
        }
    }

    return { handleUserLoggedInEvent };
}
