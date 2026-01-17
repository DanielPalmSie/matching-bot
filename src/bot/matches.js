import { Markup } from 'telegraf';

export function createMatchHandlers({
    apiRequest,
    ApiError,
    API_ROUTES,
    NEGATIVE_REASON_OPTIONS,
    handleApiError,
    ensureTelegramUserId,
    formatMatchMessage,
    sessionStore,
    enterChatState,
}) {
    function extractOwnerId(match) {
        return (
            match?.ownerId ||
            match?.requestOwnerId ||
            match?.owner?.id ||
            match?.request?.ownerId ||
            match?.request?.owner?.id ||
            null
        );
    }

    function buildFeedbackCallback(type, match, targetRequestId) {
        const matchId = match?.id ?? match?.matchId ?? 'null';
        const requestId = targetRequestId ?? match?.targetRequestId ?? 'null';
        return `feedback:${type}:${matchId}:${requestId}`;
    }

    function buildContactAuthorCallback(targetRequestId, ownerId) {
        const requestPart =
            typeof targetRequestId === 'number' && targetRequestId > 0 ? String(targetRequestId) : 'null';
        const ownerPart = ownerId ?? 'null';
        return `contact_author:${requestPart}:${ownerPart}`;
    }

    async function sendRecommendation(ctx, match, targetRequestId, session) {
        const ownerId = extractOwnerId(match);
        const isOwnRequest = ownerId && session?.backendUserId && Number(ownerId) === Number(session.backendUserId);
        const showContactButton = !!ownerId && !isOwnRequest;

        const rows = [
            [
                Markup.button.callback('👍 Подходит', buildFeedbackCallback('like', match, targetRequestId)),
                Markup.button.callback('👎 Не подходит', buildFeedbackCallback('dislike', match, targetRequestId)),
            ],
        ];

        if (showContactButton) {
            rows.push([Markup.button.callback('✉️ Связаться с автором', buildContactAuthorCallback(targetRequestId, ownerId))]);
        }

        rows.push([Markup.button.callback('⬅️ В меню', 'menu:main')]);

        const keyboard = Markup.inlineKeyboard(rows);

        await ctx.reply(formatMatchMessage(match), keyboard);
    }

    function parseNullableId(value) {
        return value === 'null' || value === undefined || value === '' || value === null ? null : value;
    }

    function toNumberOrNull(value) {
        if (value === null || value === undefined || value === '' || value === 'null') {
            return null;
        }

        const numericValue = Number(value);
        return Number.isNaN(numericValue) ? null : numericValue;
    }

    function buildReasonKeyboard(matchId, targetRequestId) {
        const rows = NEGATIVE_REASON_OPTIONS.map((option) => [
            Markup.button.callback(
                option.label,
                `feedback:reason:${matchId ?? 'null'}:${targetRequestId ?? 'null'}:${option.code}`
            ),
        ]);
        rows.push([Markup.button.callback('📝 Другое', `feedback:reason_other:${matchId ?? 'null'}:${targetRequestId ?? 'null'}`)]);
        return Markup.inlineKeyboard(rows);
    }

    function ensureFeedbackTemp(session) {
        if (!session.temp) {
            session.temp = {};
        }
        if (!session.temp.feedback) {
            session.temp.feedback = {};
        }
        return session.temp.feedback;
    }

    function setPendingFeedbackComment(session, payload) {
        const feedbackTemp = ensureFeedbackTemp(session);
        feedbackTemp.awaitingComment = payload;
        session.state = 'feedback:comment';
        sessionStore.persist();
    }

    function clearPendingFeedbackComment(session) {
        if (session?.temp?.feedback?.awaitingComment) {
            delete session.temp.feedback.awaitingComment;
        }
        if (session?.state === 'feedback:comment') {
            session.state = null;
        }
        sessionStore.persist();
    }

    function getPendingFeedbackComment(session) {
        return session?.temp?.feedback?.awaitingComment;
    }

    function buildFeedbackPayload(session, { matchId = null, targetRequestId = null, relevanceScore, reasonCode = null, comment = null }) {
        return {
            userId: toNumberOrNull(session.backendUserId),
            matchId: toNumberOrNull(matchId),
            targetRequestId: toNumberOrNull(targetRequestId),
            relevanceScore: Number(relevanceScore),
            reasonCode: reasonCode ?? null,
            comment: comment ?? null,
            mainIssue: null,
        };
    }

    async function submitMatchFeedback(session, payload) {
        return apiRequest('post', API_ROUTES.FEEDBACK_MATCH, payload, session.token);
    }

    async function loadMatchesForRequest(ctx, session, requestId) {
        if (!ensureTelegramUserId(ctx, 'matches.load')) {
            return;
        }
        try {
            const matches = await apiRequest(
                'get',
                `${API_ROUTES.REQUESTS_MATCHES(requestId)}?limit=10`,
                null,
                session.token
            );

            const items = Array.isArray(matches) ? matches : matches?.items || [];
            if (!items.length) {
                await ctx.reply('Для этого запроса пока нет подходящих рекомендаций.');
                return;
            }

            const limitedMatches = items.slice(0, 5).map((match) => ({ ...match, targetRequestId: requestId }));
            for (const match of limitedMatches) {
                await sendRecommendation(ctx, match, requestId, session);
            }

            if (items.length > limitedMatches.length) {
                await ctx.reply('Показаны первые рекомендации. Скоро добавим просмотр следующей партии.');
            }
        } catch (error) {
            console.error('Failed to load matches', {
                requestId,
                status: error?.status,
                message: error?.message,
            });

            if (error instanceof ApiError) {
                if (error.status === 404) {
                    await ctx.reply('Запрос не найден или более не существует.');
                    return;
                }
            }
            await handleApiError(ctx, session, error, 'Не удалось загрузить рекомендации. Попробуйте позже.');
        }
    }

    async function chooseRequestForMatches(ctx, session) {
        const telegramUserId = ensureTelegramUserId(ctx, 'requests.choose');
        if (!telegramUserId) {
            return;
        }
        try {
            const data = await apiRequest('get', API_ROUTES.REQUESTS_MINE, null, session.token);
            const myRequests = Array.isArray(data) ? data : data?.items || [];
            if (!myRequests.length) {
                await ctx.reply('У вас пока нет запросов. Создайте запрос в приложении и попробуйте снова.');
                return;
            }
            const keyboard = myRequests.map((req) => [
                Markup.button.callback(req.title || req.name || `Запрос ${req.id}`, `reco:choose:${req.id}`),
            ]);
            await ctx.reply('Выберите запрос, для которого хотите посмотреть рекомендации:', Markup.inlineKeyboard(keyboard));
        } catch (error) {
            await handleApiError(ctx, session, error, 'Не удалось получить ваши запросы.');
        }
    }

    async function startChatWithAuthor(ctx, session, ownerId, targetRequestId) {
        if (!ownerId) {
            await ctx.reply('Не удалось определить автора заявки.');
            return;
        }

        if (session.backendUserId && Number(ownerId) === Number(session.backendUserId)) {
            await ctx.reply('Это ваша собственная заявка.');
            return;
        }

        try {
            const body =
                typeof targetRequestId === 'number' && !Number.isNaN(targetRequestId)
                    ? { originType: 'request', originId: targetRequestId }
                    : {};
            const chat = await apiRequest('post', API_ROUTES.CHATS_START(ownerId), body, session.token);
            if (!chat?.id) {
                await ctx.reply('Не удалось создать чат, попробуйте позже.');
                return;
            }

            enterChatState(session, ctx.chat?.id, chat.id);

            if (!session.sentIntroByChatId) {
                session.sentIntroByChatId = {};
            }
            if (!session.sentIntroByChatId[chat.id]) {
                try {
                    await apiRequest(
                        'post',
                        API_ROUTES.CHAT_SEND_MESSAGE(chat.id),
                        { content: 'Привет! Я нашёл твою заявку в матчинге и хотел(а) бы обсудить её 🙂' },
                        session.token
                    );
                    session.sentIntroByChatId[chat.id] = true;
                    sessionStore.persist();
                } catch (sendError) {
                    console.error('Failed to send intro message to chat', sendError);
                }
            }

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('⬅️ Назад к рекомендациям', 'chat:exit')],
                [Markup.button.callback('⬅️ В меню', 'menu:main')],
            ]);

            await ctx.reply('Чат с автором создан, напиши своё первое сообщение.', keyboard);
        } catch (error) {
            if (error instanceof ApiError && error.status === 404) {
                await ctx.reply('Автор заявки не найден.');
                return;
            }
            await handleApiError(ctx, session, error, 'Не удалось создать чат, попробуйте позже.');
        }
    }

    return {
        buildFeedbackCallback,
        buildContactAuthorCallback,
        parseNullableId,
        toNumberOrNull,
        buildReasonKeyboard,
        setPendingFeedbackComment,
        clearPendingFeedbackComment,
        getPendingFeedbackComment,
        buildFeedbackPayload,
        submitMatchFeedback,
        loadMatchesForRequest,
        chooseRequestForMatches,
        startChatWithAuthor,
    };
}
