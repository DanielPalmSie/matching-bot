import { Markup } from 'telegraf';

export function createRequestHandlers({
    apiRequest,
    sessionStore,
    ApiError,
    API_ROUTES,
    MAIN_MENU_KEYBOARD,
    handleApiError,
    ensureTelegramUserId,
    clearSessionAuth,
    formatRequestSummary,
}) {
    function resetCreateRequestState(session) {
        sessionStore.resetCreateRequestState(session);
    }

    function getCreateTemp(session) {
        return sessionStore.getCreateTemp(session);
    }

    async function startCreateRequestFlow(ctx, session) {
        if (!session?.token) {
            await ctx.reply('Не удалось найти вашу активную сессию. Пожалуйста, войдите заново через ссылку-логин.');
            return;
        }
        session.state = 'create:rawText';
        session.temp.createRequest = {};
        sessionStore.persist();
        await ctx.reply(
            'Опишите ваш запрос одним-двумя предложениями. Например:\n"Ищу наставника по backend на Symfony в Берлине"'
        );
    }

    async function createRequestOnBackend(ctx, session) {
        const telegramUserId = ensureTelegramUserId(ctx, 'request.create');
        if (!telegramUserId) {
            return;
        }
        const data = getCreateTemp(session);
        const payload = {
            rawText: data.rawText,
            city: data.city ?? null,
            country: data.country ?? null,
            location: data.location ?? null,
        };

        try {
            const res = await apiRequest('post', API_ROUTES.REQUESTS_CREATE, payload, session.token);
            const successMessage = [
                'Готово! Ваш запрос создан 🎉',
                `ID: ${res.id}`,
                `Город: ${res.city || 'не указан'}`,
                `Статус: ${res.status}`,
                '',
                'Теперь вы можете вернуться к рекомендациям или чатам.',
            ].join('\n');
            resetCreateRequestState(session);
            await ctx.reply(successMessage, MAIN_MENU_KEYBOARD);
        } catch (error) {
            console.error('Create request error:', error);
            if (error instanceof ApiError && error.status === 400) {
                await ctx.reply(
                    `Не удалось создать запрос: ${error.message}\nПопробуйте ещё раз позже или измените текст запроса.`,
                    MAIN_MENU_KEYBOARD
                );
                resetCreateRequestState(session);
                return;
            }
            if (error instanceof ApiError && error.isAuthError) {
                clearSessionAuth(session, telegramUserId);
                resetCreateRequestState(session);
                await ctx.reply('Ваша сессия истекла. Пожалуйста, войдите заново.', MAIN_MENU_KEYBOARD);
                return;
            }
            await ctx.reply(
                'Произошла техническая ошибка при создании запроса. Попробуйте ещё раз позже.',
                MAIN_MENU_KEYBOARD
            );
            resetCreateRequestState(session);
        }
    }

    async function loadRequests(ctx, session) {
        const telegramUserId = ensureTelegramUserId(ctx, 'requests.load');
        if (!telegramUserId) {
            return;
        }
        try {
            const data = await apiRequest('get', API_ROUTES.REQUESTS_MINE, null, session.token);
            const myRequests = Array.isArray(data) ? data : data?.items || [];

            if (!myRequests.length) {
                await ctx.reply('У вас пока нет запросов.');
                return;
            }

            await ctx.reply('Ваши запросы:');
            for (const req of myRequests) {
                const text = formatRequestSummary(req);
                const kb = Markup.inlineKeyboard([
                    Markup.button.callback('Показать рекомендации', `req:matches:${req.id}`),
                ]);
                await ctx.reply(text, kb);
            }
        } catch (error) {
            await handleApiError(ctx, session, error, 'Не удалось получить список запросов.');
        }
    }

    return {
        resetCreateRequestState,
        getCreateTemp,
        startCreateRequestFlow,
        createRequestOnBackend,
        loadRequests,
    };
}
