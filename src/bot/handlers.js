import axios from 'axios';
import { Markup } from 'telegraf';

export function registerBotHandlers({
    bot,
    apiClient,
    API_ROUTES,
    MAIN_MENU_KEYBOARD,
    NEGATIVE_REASON_OPTIONS,
    sessionStore,
    getLoggedIn,
    setLoggedIn,
    sessionHelpers,
    menu,
    startFlow,
    authHandlers,
    geoHelpers,
    requestHandlers,
    matchHandlers,
    chatHandlers,
}) {
    const {
        getSession,
        ensureTelegramUserId,
        ensureLoggedInSession,
        leaveChatState,
        isValidEmail,
    } = sessionHelpers;

    const {
        promptCountryQuery,
        promptCityQuery,
        ensureGeoTemp,
        startLocationSelection,
        isGeoSelectionExpired,
        buildGeoCountriesKeyboard,
        buildGeoCitiesKeyboard,
        isGeoServiceUnavailable,
    } = geoHelpers;

    const {
        resetCreateRequestState,
        getCreateTemp,
        startCreateRequestFlow,
        createRequestOnBackend,
        loadRequests,
    } = requestHandlers;

    const {
        parseNullableId,
        buildReasonKeyboard,
        setPendingFeedbackComment,
        clearPendingFeedbackComment,
        getPendingFeedbackComment,
        buildFeedbackPayload,
        submitMatchFeedback,
        loadMatchesForRequest,
        startChatWithAuthor,
        toNumberOrNull,
    } = matchHandlers;

    const { loadChats, showChat, sendMessageToChat } = chatHandlers;

    bot.start((ctx) => startFlow(ctx));

    bot.action('START_SESSION', async (ctx) => {
        await ctx.answerCbQuery();
        await startFlow(ctx, { forceRestart: true });
    });

    bot.hears(/^Старт$/i, async (ctx) => {
        await startFlow(ctx, { forceRestart: true });
    });

    bot.command('ping', async (ctx) => {
        const telegramUserId = ensureTelegramUserId(ctx, 'bot.ping');
        if (!telegramUserId) {
            return;
        }
        try {
            const res = await axios.get(apiClient.buildUrl('/api/docs'), { timeout: 5000 }).catch(() => null);
            if (res && res.status === 200) {
                await ctx.reply('✅ Бэкенд отвечает! (GET /api/docs)');
            } else {
                await ctx.reply('⚠️ Не удалось получить ответ от бекенда');
            }
        } catch (e) {
            console.error(e);
            await ctx.reply('❌ Ошибка при обращении к бекенду');
        }
    });

    bot.on('text', async (ctx) => {
        const session = getSession(ctx);
        const telegramUserId = ensureTelegramUserId(ctx, 'bot.text');
        if (!telegramUserId) {
            return;
        }
        const text = ctx.message.text.trim();

        const activeChatId = session.activeChatId || session.currentChatId;
        if (session.state === 'chatting' && activeChatId) {
            if (text === '/exit') {
                leaveChatState(session, ctx.chat?.id);
                await ctx.reply('Вы вышли из режима чата.', MAIN_MENU_KEYBOARD);
                return;
            }

            const authedSession = ensureLoggedInSession(ctx);
            if (!authedSession) {
                return;
            }

            await sendMessageToChat(ctx, session, text);
            return;
        }

        if (session.state === 'feedback:comment') {
            const pending = getPendingFeedbackComment(session);
            if (!pending) {
                clearPendingFeedbackComment(session);
                return;
            }
            if (text === '/cancel') {
                clearPendingFeedbackComment(session);
                await ctx.reply('Отправка отзыва отменена.', MAIN_MENU_KEYBOARD);
                return;
            }

            const authedSession = ensureLoggedInSession(ctx);
            if (!authedSession) {
                clearPendingFeedbackComment(session);
                return;
            }

            if (!session.backendUserId) {
                await ctx.reply('Чтобы оставить отзыв, сначала войдите через ссылку из письма.');
                clearPendingFeedbackComment(session);
                return;
            }

            const payload = buildFeedbackPayload(session, {
                ...pending,
                relevanceScore: -1,
                comment: text,
                reasonCode: null,
            });

            try {
                await submitMatchFeedback(session, payload);
                await ctx.reply('Спасибо, это помогает нам сделать сервис лучше 🙌');
            } catch (error) {
                console.error('Failed to send comment feedback', error);
                await ctx.reply('Не удалось сохранить отзыв, попробуй позже 🙈');
            }

            clearPendingFeedbackComment(session);
            return;
        }

        if (text === '/cancel' && session.state?.startsWith('create:')) {
            resetCreateRequestState(session);
            await ctx.reply('Создание запроса отменено.', MAIN_MENU_KEYBOARD);
            return;
        }

        if (session.state === 'WAIT_COUNTRY_QUERY') {
            const q = text.trim();
            if (q.length < 2) {
                await ctx.reply('Введите минимум 2 буквы.');
                return;
            }
            try {
                const countries = await apiClient.get(API_ROUTES.GEO_COUNTRIES, { params: { q, limit: 10 } });
                const list = Array.isArray(countries) ? countries : [];
                if (!list.length) {
                    await ctx.reply('Страны не найдены. Пример: ge, fra, ukr.');
                    return;
                }
                const geoTemp = ensureGeoTemp(session);
                const { keyboard, mapping } = buildGeoCountriesKeyboard(list.slice(0, 10));
                geoTemp.lastCountries = mapping;
                geoTemp.lastCountriesAt = Date.now();
                sessionStore.persist();
                await ctx.reply('Выберите страну:', keyboard);
            } catch (error) {
                if (isGeoServiceUnavailable(error)) {
                    await ctx.reply('Сервис геолокации временно недоступен, попробуйте позже.');
                    return;
                }
                console.error('Failed to load countries', error);
                await ctx.reply('Не удалось получить список стран. Попробуйте позже.');
            }
            return;
        }

        if (session.state === 'WAIT_CITY_QUERY') {
            const q = text.trim();
            const geoTemp = ensureGeoTemp(session);
            if (!geoTemp.country?.code) {
                session.state = 'WAIT_COUNTRY_QUERY';
                sessionStore.persist();
                await promptCountryQuery(ctx);
                return;
            }
            if (q.length < 2) {
                await ctx.reply('Введите минимум 2 буквы.');
                return;
            }
            geoTemp.q = q;
            geoTemp.limit = 10;
            geoTemp.offset = 0;
            sessionStore.persist();
            try {
                const limit = 10;
                const offset = 0;
                const params = { q, limit, offset, country: geoTemp.country.code };
                const payload = await apiClient.get(API_ROUTES.GEO_CITIES, { params });
                const list = Array.isArray(payload?.items) ? payload.items : [];
                const hasMore = payload?.hasMore === true;
                const resolvedOffset = Number.isInteger(payload?.offset) ? payload.offset : offset;
                const resolvedLimit = Number.isInteger(payload?.limit) ? payload.limit : limit;
                if (!list.length) {
                    await ctx.reply('Города не найдены. Попробуйте другие буквы (латиницей), например: ber, mun, par.');
                    return;
                }
                const { keyboard, mapping } = buildGeoCitiesKeyboard(list, { offset: resolvedOffset, hasMore });
                geoTemp.q = q;
                geoTemp.limit = resolvedLimit;
                geoTemp.offset = resolvedOffset;
                geoTemp.lastCities = mapping;
                geoTemp.lastCitiesAt = Date.now();
                sessionStore.persist();
                await ctx.reply('Выберите город:', keyboard);
            } catch (error) {
                if (isGeoServiceUnavailable(error)) {
                    await ctx.reply('Сервис геолокации временно недоступен, попробуйте позже.');
                    return;
                }
                console.error('Failed to load cities', error);
                await ctx.reply('Не удалось получить список городов. Попробуйте позже.');
            }
            return;
        }

        if (session.state === 'create:rawText') {
            if (!text.trim()) {
                await ctx.reply('Пожалуйста, опишите ваш запрос хотя бы одним словом.');
                return;
            }
            const data = getCreateTemp(session);
            data.rawText = text;
            startLocationSelection(session);
            await promptCountryQuery(ctx);
            return;
        }

        const loggedIn = getLoggedIn(telegramUserId);
        if (!session.state && loggedIn) {
            session.token = loggedIn.jwt;
            session.backendUserId = loggedIn.userId;
            sessionStore.persist();
            await menu.sendMainMenu(ctx.chat.id, { email: loggedIn.email });
            return;
        }
        if (!session.state && session.token) {
            setLoggedIn(telegramUserId, {
                userId: session.backendUserId,
                email: session.lastEmail,
                jwt: session.token,
            });
            await menu.sendMainMenu(ctx.chat.id, { email: session.lastEmail });
            return;
        }

        if (!session.state) {
            session.state = 'awaiting_email';
            sessionStore.persist();
        }

        if (session.state === 'awaiting_email') {
            if (!isValidEmail(text)) {
                await ctx.reply('Пожалуйста, введите корректный email.');
                return;
            }
            await authHandlers.requestMagicLink(ctx, session, text);
            return;
        }

        await ctx.reply('Отправьте ваш email, чтобы получить ссылку для входа.');
    });

    bot.command('menu', async (ctx) => {
        const telegramUserId = ensureTelegramUserId(ctx, 'menu.command');
        if (!telegramUserId) {
            return;
        }
        const loggedIn = getLoggedIn(telegramUserId);
        if (!loggedIn) {
            await ctx.reply('Чтобы открыть меню, сначала авторизуйтесь через ссылку из письма.');
            return;
        }
        await menu.sendMainMenu(ctx.chat.id, { email: loggedIn.email });
    });

    bot.command('create_request', async (ctx) => {
        const session = ensureLoggedInSession(ctx);
        if (!session) {
            await ctx.reply('Не удалось найти вашу активную сессию. Пожалуйста, войдите заново через ссылку-логин.');
            return;
        }
        await startCreateRequestFlow(ctx, session);
    });

    bot.action('menu:main', async (ctx) => {
        const session = getSession(ctx);
        leaveChatState(session, ctx.chat?.id);
        const telegramUserId = ensureTelegramUserId(ctx, 'menu.main');
        if (!telegramUserId) {
            return;
        }
        const loggedIn = getLoggedIn(telegramUserId);
        if (!loggedIn) {
            await ctx.reply('Чтобы открыть меню, сначала авторизуйтесь через ссылку из письма.');
            return;
        }
        await ctx.answerCbQuery();
        await menu.sendMainMenu(ctx.chat.id, { email: loggedIn.email });
    });

    bot.action('chat:exit', async (ctx) => {
        await ctx.answerCbQuery();
        const session = getSession(ctx);
        leaveChatState(session, ctx.chat?.id);
        await ctx.reply('Вы вышли из режима чата. Вернитесь к рекомендациям или в меню.', MAIN_MENU_KEYBOARD);
    });

    bot.action(/^geo_country_pick:(.+)$/, async (ctx) => {
        const session = getSession(ctx);
        const geoTemp = ensureGeoTemp(session);
        const [, key] = ctx.match;
        await ctx.answerCbQuery();
        if (isGeoSelectionExpired(geoTemp.lastCountriesAt)) {
            await ctx.reply('Выбор устарел, введите запрос ещё раз.');
            return;
        }
        const selected = geoTemp.lastCountries?.[key];
        if (!selected) {
            await ctx.reply('Выбор устарел, введите запрос ещё раз.');
            return;
        }
        geoTemp.country = selected;
        geoTemp.q = null;
        geoTemp.limit = 10;
        geoTemp.offset = 0;
        geoTemp.lastCities = {};
        geoTemp.lastCitiesAt = null;
        session.state = 'WAIT_CITY_QUERY';
        sessionStore.persist();
        await ctx.editMessageText(
            `Страна выбрана: ${selected.name} (${selected.code}).`
        );
        await promptCityQuery(ctx, selected.name);
    });

    bot.action(/^geo_city_page:(prev|next)$/, async (ctx) => {
        const session = getSession(ctx);
        const geoTemp = ensureGeoTemp(session);
        const [, direction] = ctx.match;
        if (!geoTemp.country?.code || !geoTemp.q) {
            await ctx.answerCbQuery('Сначала введите запрос.');
            return;
        }
        if (isGeoSelectionExpired(geoTemp.lastCitiesAt)) {
            await ctx.answerCbQuery('Выбор устарел, введите запрос ещё раз.');
            return;
        }
        const limit = Math.min(Math.max(geoTemp.limit ?? 10, 1), 10);
        const currentOffset = Math.max(geoTemp.offset ?? 0, 0);
        const newOffset = direction === 'prev' ? Math.max(0, currentOffset - limit) : currentOffset + limit;
        try {
            const params = { q: geoTemp.q, limit, offset: newOffset, country: geoTemp.country.code };
            const payload = await apiClient.get(API_ROUTES.GEO_CITIES, { params });
            const list = Array.isArray(payload?.items) ? payload.items : [];
            const hasMore = payload?.hasMore === true;
            const resolvedOffset = Number.isInteger(payload?.offset) ? payload.offset : newOffset;
            const resolvedLimit = Number.isInteger(payload?.limit) ? payload.limit : limit;
            if (!list.length) {
                await ctx.answerCbQuery('Больше результатов нет');
                return;
            }
            const { keyboard, mapping } = buildGeoCitiesKeyboard(list, { offset: resolvedOffset, hasMore });
            geoTemp.lastCities = mapping;
            geoTemp.lastCitiesAt = Date.now();
            geoTemp.offset = resolvedOffset;
            geoTemp.limit = resolvedLimit;
            sessionStore.persist();
            await ctx.answerCbQuery();
            await ctx.editMessageText('Выберите город:', keyboard);
        } catch (error) {
            if (isGeoServiceUnavailable(error)) {
                await ctx.answerCbQuery('Сервис геолокации временно недоступен');
                return;
            }
            console.error('Failed to load cities page', error);
            await ctx.answerCbQuery('Не удалось получить список городов');
        }
    });

    bot.action(/^geo_city_pick:(.+)$/, async (ctx) => {
        const session = getSession(ctx);
        const geoTemp = ensureGeoTemp(session);
        const [, key] = ctx.match;
        await ctx.answerCbQuery();
        if (isGeoSelectionExpired(geoTemp.lastCitiesAt)) {
            await ctx.reply('Выбор устарел, введите запрос ещё раз.');
            return;
        }
        const selected = geoTemp.lastCities?.[key];
        if (!selected) {
            await ctx.reply('Выбор устарел, введите запрос ещё раз.');
            return;
        }
        geoTemp.city = selected;
        const regionPart = selected.region ? `, ${selected.region}` : '';
        if (!geoTemp.country?.code) {
            session.state = 'WAIT_COUNTRY_QUERY';
            sessionStore.persist();
            await ctx.reply('Сначала выберите страну.');
            await promptCountryQuery(ctx);
            return;
        }
        const resolvedCountry = geoTemp.country;
        session.temp.location = {
            country: resolvedCountry,
            city: selected,
        };
        const data = session?.temp?.createRequest;
        if (data) {
            data.city = selected.name;
            data.country = resolvedCountry.code ?? selected.countryCode ?? null;
            data.location = session.temp.location;
            sessionStore.persist();
            await ctx.editMessageText(`Город выбран: ${selected.name}${regionPart} (${selected.countryCode}) ✅`);
            await createRequestOnBackend(ctx, session);
            return;
        }
        session.state = null;
        sessionStore.persist();
        await ctx.editMessageText(`Локация выбрана: ${selected.name}${regionPart} (${selected.countryCode}) ✅`);
    });

    bot.action(/^geo_cancel$/, async (ctx) => {
        const session = getSession(ctx);
        await ctx.answerCbQuery();
        if (session?.temp?.geo) {
            session.temp.geo = {};
        }
        session.state = null;
        sessionStore.persist();
        await ctx.editMessageText('Отменено.');
    });

    bot.action('menu:requests', async (ctx) => {
        await ctx.answerCbQuery();
        const session = ensureLoggedInSession(ctx);
        if (!session) return;
        await loadRequests(ctx, session);
    });

    bot.action(/^req:matches:(\d+)$/, async (ctx) => {
        await ctx.answerCbQuery();
        const [, requestId] = ctx.match;
        const session = ensureLoggedInSession(ctx);
        if (!session || !session.token) {
            await ctx.reply(
                'Не удалось найти вашу активную сессию. Пожалуйста, войдите заново через ссылку для входа.'
            );
            return;
        }

        await loadMatchesForRequest(ctx, session, requestId);
    });

    bot.action(/^contact_author:([^:]+):([^:]+)$/, async (ctx) => {
        await ctx.answerCbQuery();
        const [, , ownerIdRaw] = ctx.match;
        const ownerId = toNumberOrNull(ownerIdRaw);
        const session = ensureLoggedInSession(ctx);
        if (!session) return;

        await startChatWithAuthor(ctx, session, ownerId, null);
    });

    bot.action('menu:chats', async (ctx) => {
        await ctx.answerCbQuery();
        const session = ensureLoggedInSession(ctx);
        if (!session) return;
        leaveChatState(session, ctx.chat?.id);
        await loadChats(ctx, session);
    });

    bot.action(/^chat:open:(.+)$/, async (ctx) => {
        console.log('[chat:open] data=', ctx.callbackQuery?.data);
        await ctx.answerCbQuery();
        const [, chatId] = ctx.match;
        const session = ensureLoggedInSession(ctx);
        if (!session) return;
        await showChat(ctx, session, chatId);
    });

    bot.action('menu:create', async (ctx) => {
        await ctx.answerCbQuery();
        const session = ensureLoggedInSession(ctx);
        if (!session) {
            await ctx.reply('Не удалось найти вашу активную сессию. Пожалуйста, войдите заново через ссылку-логин.');
            return;
        }
        await startCreateRequestFlow(ctx, session);
    });

    bot.action(/^feedback:like:([^:]+):([^:]+)$/, async (ctx) => {
        await ctx.answerCbQuery();
        const session = ensureLoggedInSession(ctx);
        if (!session) return;

        if (!session.backendUserId) {
            await ctx.reply('Чтобы оставить отзыв, сначала войдите через ссылку из письма.');
            return;
        }

        const [, matchIdRaw, targetRequestIdRaw] = ctx.match;
        const matchId = parseNullableId(matchIdRaw);
        const targetRequestId = parseNullableId(targetRequestIdRaw);
        const payload = buildFeedbackPayload(session, {
            matchId,
            targetRequestId,
            relevanceScore: 2,
            reasonCode: null,
            comment: null,
        });

        try {
            await submitMatchFeedback(session, payload);
            await ctx.reply('Спасибо за обратную связь! 🙌');
        } catch (error) {
            console.error('Failed to send positive feedback', { error, matchId, targetRequestId });
            await ctx.reply('Не удалось сохранить отзыв, попробуй позже 🙈');
        }
    });

    bot.action(/^feedback:dislike:([^:]+):([^:]+)$/, async (ctx) => {
        await ctx.answerCbQuery();
        const session = ensureLoggedInSession(ctx);
        if (!session) return;

        const [, matchIdRaw, targetRequestIdRaw] = ctx.match;
        const matchId = parseNullableId(matchIdRaw);
        const targetRequestId = parseNullableId(targetRequestIdRaw);
        const questionText = '🧩 Почему рекомендация не подошла?\n(выбери один вариант)';
        const keyboard = buildReasonKeyboard(matchId, targetRequestId);

        try {
            const baseText = ctx.callbackQuery?.message?.text || '';
            const newText = baseText ? `${baseText}\n\n${questionText}` : questionText;
            await ctx.editMessageText(newText, keyboard);
        } catch (error) {
            console.error('Failed to edit message for feedback reasons', error);
            await ctx.reply(questionText, keyboard);
        }
    });

    bot.action(/^feedback:reason:([^:]+):([^:]+):([a-z_]+)$/, async (ctx) => {
        await ctx.answerCbQuery();
        const session = ensureLoggedInSession(ctx);
        if (!session) return;

        if (!session.backendUserId) {
            await ctx.reply('Чтобы оставить отзыв, сначала войдите через ссылку из письма.');
            return;
        }

        const [, matchIdRaw, targetRequestIdRaw, reasonCode] = ctx.match;
        const allowedCodes = NEGATIVE_REASON_OPTIONS.map((option) => option.code);
        if (!allowedCodes.includes(reasonCode)) {
            await ctx.reply('Неизвестная причина. Попробуйте снова.');
            return;
        }

        const matchId = parseNullableId(matchIdRaw);
        const targetRequestId = parseNullableId(targetRequestIdRaw);
        const payload = buildFeedbackPayload(session, {
            matchId,
            targetRequestId,
            relevanceScore: -1,
            reasonCode,
            comment: null,
        });

        try {
            await submitMatchFeedback(session, payload);
            await ctx.reply('Спасибо, мы учтём это и улучшим рекомендации 🙌');
        } catch (error) {
            console.error('Failed to send negative feedback', { error, matchId, targetRequestId, reasonCode });
            await ctx.reply('Не удалось сохранить отзыв, попробуй позже 🙈');
        }

        try {
            await ctx.editMessageReplyMarkup(
                Markup.inlineKeyboard([[Markup.button.callback('⬅️ В меню', 'menu:main')]]).reply_markup
            );
        } catch (error) {
            console.error('Failed to trim feedback keyboard', error);
        }
    });

    bot.action(/^feedback:reason_other:([^:]+):([^:]+)$/, async (ctx) => {
        await ctx.answerCbQuery();
        const session = ensureLoggedInSession(ctx);
        if (!session) return;

        const [, matchIdRaw, targetRequestIdRaw] = ctx.match;
        const matchId = parseNullableId(matchIdRaw);
        const targetRequestId = parseNullableId(targetRequestIdRaw);

        setPendingFeedbackComment(session, { matchId, targetRequestId });
        await ctx.reply('Напиши коротко, что именно не так с рекомендацией.');

        try {
            await ctx.editMessageReplyMarkup(
                Markup.inlineKeyboard([[Markup.button.callback('⬅️ В меню', 'menu:main')]]).reply_markup
            );
        } catch (error) {
            console.error('Failed to trim keyboard after selecting other reason', error);
        }
    });

    bot.catch((err, ctx) => {
        console.error(`Bot error for ${ctx.updateType}`, err);
    });
}
