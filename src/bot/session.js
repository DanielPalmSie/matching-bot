export function createSessionHelpers({
    sessionStore,
    logger,
    getNotificationService,
    getTelegramUserIdFromContext,
    getTokenPrefix,
    getLoggedIn,
    setLoggedIn,
}) {
    function getSession(ctx) {
        const telegramUserId = resolveTelegramUserId(ctx, 'session.get');
        return sessionStore.getSessionByTelegramUserId(telegramUserId);
    }

    function getSessionByTelegramUserId(telegramUserId) {
        return sessionStore.getSessionByTelegramUserId(telegramUserId);
    }

    function logSessionContext(action, { telegramUserId, chatId, token } = {}) {
        logger.info(action, {
            telegramUserId,
            chatId,
            tokenPrefix: getTokenPrefix(token),
        });
    }

    function resolveTelegramUserId(ctx, action) {
        const telegramUserId = getTelegramUserIdFromContext(ctx);
        if (!telegramUserId) {
            logger.warn('telegramUserId.missing', {
                action,
                chatId: ctx.chat?.id ?? null,
                updateType: ctx.updateType,
            });
        }
        return telegramUserId;
    }

    function ensureTelegramUserId(ctx, action) {
        const telegramUserId = resolveTelegramUserId(ctx, action);
        if (!telegramUserId && typeof ctx.reply === 'function') {
            ctx.reply('Не удалось определить пользователя Telegram. Попробуйте ещё раз.');
        }
        return telegramUserId;
    }

    function saveUserJwt(telegramUserId, jwt, { userId, email, chatId } = {}) {
        sessionStore.saveUserJwt(telegramUserId, jwt, { userId, email, chatId });

        const notificationService = getNotificationService();
        if (notificationService && chatId && (userId || sessionStore.getSessionByTelegramUserId(telegramUserId).backendUserId)) {
            const resolvedUserId = userId ?? sessionStore.getSessionByTelegramUserId(telegramUserId).backendUserId;
            notificationService.setBackendUserId(chatId, resolvedUserId);
        }
    }

    function resetState(session) {
        sessionStore.resetState(session);
    }

    function isValidEmail(email) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    }

    function clearSessionAuth(session, telegramUserId) {
        sessionStore.clearSessionAuth(session, telegramUserId);
    }

    function leaveChatState(session, telegramChatId) {
        if (!session) return;
        session.state = null;
        session.currentChatId = null;
        session.activeChatId = null;
        sessionStore.persist();
        const notificationService = getNotificationService();
        if (notificationService && telegramChatId) {
            notificationService.leaveChatMode(telegramChatId);
        }
    }

    function enterChatState(session, telegramChatId, chatId) {
        if (!session || !chatId) return;
        session.state = 'chatting';
        session.currentChatId = chatId;
        session.activeChatId = chatId;
        sessionStore.persist();
        const notificationService = getNotificationService();
        if (notificationService && telegramChatId) {
            notificationService.enterChatMode(telegramChatId, session.backendUserId, chatId);
        }
    }

    function ensureLoggedInSession(ctx) {
        const session = getSession(ctx);
        const telegramUserId = resolveTelegramUserId(ctx, 'auth.ensure');
        if (!telegramUserId) {
            ctx.reply('Не удалось определить пользователя Telegram. Попробуйте ещё раз.');
            return null;
        }
        const chatId = ctx.chat?.id;
        const loggedIn = getLoggedIn(telegramUserId);

        if (loggedIn?.jwt) {
            session.token = loggedIn.jwt;
            session.backendUserId = loggedIn.userId;
            sessionStore.persist();
            logSessionContext('auth.check', {
                telegramUserId,
                chatId,
                token: loggedIn.jwt,
            });
            return session;
        }

        if (session.token) {
            setLoggedIn(telegramUserId, {
                userId: session.backendUserId,
                email: session.lastEmail,
                jwt: session.token,
            });
            logSessionContext('auth.check', {
                telegramUserId,
                chatId,
                token: session.token,
            });
            return session;
        }

        ctx.reply('Чтобы продолжить, сначала авторизуйтесь через ссылку из письма.');
        logSessionContext('auth.check', {
            telegramUserId,
            chatId,
            token: session?.token,
        });
        return null;
    }

    return {
        getSession,
        getSessionByTelegramUserId,
        logSessionContext,
        resolveTelegramUserId,
        ensureTelegramUserId,
        saveUserJwt,
        resetState,
        isValidEmail,
        clearSessionAuth,
        leaveChatState,
        enterChatState,
        ensureLoggedInSession,
    };
}
