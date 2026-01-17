import { Markup } from 'telegraf';

export function createChatHandlers({
    apiRequest,
    ApiError,
    API_ROUTES,
    handleApiError,
    ensureTelegramUserId,
    enterChatState,
    leaveChatState,
    sessionStore,
}) {
    const MAX_CHAT_TITLE_LENGTH = 48;

    function truncateChatTitle(value) {
        if (!value) return value;
        const text = String(value).trim();
        if (text.length <= MAX_CHAT_TITLE_LENGTH) {
            return text;
        }
        return `${text.slice(0, MAX_CHAT_TITLE_LENGTH - 1)}…`;
    }

    function findChatMetadata(session, chatId) {
        const cachedChats = Array.isArray(session.chatCache) ? session.chatCache : [];
        return cachedChats.find((chat) => String(chat?.id) === String(chatId)) || null;
    }

    async function loadChats(ctx, session) {
        const telegramUserId = ensureTelegramUserId(ctx, 'chats.load');
        if (!telegramUserId) {
            return;
        }
        try {
            const response = await apiRequest('get', API_ROUTES.CHATS_LIST, null, session.token);
            const isArrayResponse = Array.isArray(response);
            const responseKeys = response && !isArrayResponse ? Object.keys(response) : [];
            const chatList = isArrayResponse ? response : response?.items || [];
            const sampleChats = chatList.slice(0, 2);
            const safePreview = (value) => {
                if (value === null || value === undefined) return value;
                const text = String(value);
                if (text.length <= 32) return text;
                return `${text.slice(0, 29)}...`;
            };
            const samplePreview = sampleChats.map((chat) => ({
                id: chat?.id ?? null,
                title: safePreview(chat?.title),
                name: safePreview(chat?.name),
                subtitle: safePreview(chat?.subtitle),
                context: chat?.context ? Object.keys(chat.context) : null,
                keys: chat ? Object.keys(chat) : [],
            }));
            console.log('[loadChats] response audit', {
                responseType: typeof response,
                isArrayResponse,
                responseKeys,
                chatCount: chatList.length,
                samplePreview,
                chatIds: chatList.map((chat) => chat?.id),
            });
            if (!chatList.length) {
                await ctx.reply('Чатов пока нет.');
                return;
            }
            session.chatCache = chatList;
            sessionStore.persist();
            await ctx.reply('Чаты по заявкам показывают текст заявки как название.');
            const keyboard = chatList.map((c) => {
                const baseTitle = c.title || c.name || `Чат ${c.id}`;
                return [Markup.button.callback(truncateChatTitle(baseTitle), `chat:open:${c.id}`)];
            });
            await ctx.reply('Ваши чаты:', Markup.inlineKeyboard(keyboard));
        } catch (error) {
            await handleApiError(ctx, session, error, 'Не удалось загрузить чаты.');
        }
    }

    function buildParticipantMapFromChat(chat) {
        const map = new Map();
        const participants = Array.isArray(chat?.participants) ? chat.participants : [];
        for (const participant of participants) {
            const id = participant?.id ?? participant?.userId ?? participant?.participantId;
            if (!id) continue;
            const displayName =
                participant?.displayName ||
                participant?.name ||
                participant?.fullName ||
                participant?.email;
            if (displayName) {
                map.set(String(id), displayName);
            }
        }
        return map;
    }

    async function loadChatParticipantMap(session, chatId) {
        const cachedChatList = Array.isArray(session.chatCache) ? session.chatCache : [];
        const cachedChat = cachedChatList.find((chat) => String(chat?.id) === String(chatId));
        if (cachedChat?.participants?.length) {
            return buildParticipantMapFromChat(cachedChat);
        }

        const chats = await apiRequest('get', API_ROUTES.CHATS_LIST, null, session.token);
        const chatList = Array.isArray(chats) ? chats : chats?.items || [];
        session.chatCache = chatList;
        sessionStore.persist();
        const chat = chatList.find((item) => String(item?.id) === String(chatId));
        return buildParticipantMapFromChat(chat);
    }

    async function showChat(ctx, session, chatId, { showIntro = true } = {}) {
        const telegramUserId = ensureTelegramUserId(ctx, 'chats.show');
        if (!telegramUserId) {
            return;
        }
        try {
            const messages = await apiRequest(
                'get',
                `${API_ROUTES.CHAT_MESSAGES(chatId)}?offset=0&limit=50`,
                null,
                session.token
            );
            const list = Array.isArray(messages) ? messages : messages?.items || [];
            const participantMap = await loadChatParticipantMap(session, chatId);
            const chatMetadata = findChatMetadata(session, chatId);
            if (chatMetadata?.subtitle) {
                await ctx.reply(`📍 ${chatMetadata.subtitle}`);
            } else if (chatMetadata?.context?.type === 'request' && chatMetadata?.context?.id) {
                await ctx.reply(`🧩 По заявке #${chatMetadata.context.id}`);
            }
            if (!list.length) {
                await ctx.reply('Сообщений пока нет. Напишите что-нибудь!');
            } else {
                const lastMessages = list.slice(-50);
                const text = lastMessages
                    .map((m) => {
                        const senderId = m.senderId ?? m.sender?.id;
                        const senderKey = senderId !== undefined ? String(senderId) : null;
                        const displayName = senderKey ? participantMap.get(senderKey) : null;
                        return `${displayName || (senderKey ? `User ${senderKey}` : 'User')} — ${m.content || m.text || ''}`.trim();
                    })
                    .join('\n');
                await ctx.reply(text);
            }
            const unreadMessages = list.filter((message) => {
                if (!message || message.isRead) return false;
                if (session.backendUserId && Number(message.senderId) === Number(session.backendUserId)) {
                    return false;
                }
                return true;
            });
            const unreadToMark = unreadMessages.slice(-20);
            for (const message of unreadToMark) {
                if (!message?.id) {
                    continue;
                }
                try {
                    await apiRequest(
                        'post',
                        API_ROUTES.CHAT_MARK_READ(chatId, message.id),
                        {},
                        session.token
                    );
                } catch (error) {
                    if (error instanceof ApiError && error.status === 400) {
                        continue;
                    }
                    console.error('[showChat] Failed to mark message read', { chatId, messageId: message.id, error });
                }
            }
            enterChatState(session, ctx.chat?.id, chatId);
            if (showIntro) {
                await ctx.reply(
                    'Вы в режиме чата. Напишите сообщение или нажмите кнопку для выхода.',
                    Markup.inlineKeyboard([
                        [Markup.button.callback('⬅️ Назад к чатам', 'menu:chats')],
                        [Markup.button.callback('⬅️ В меню', 'menu:main')],
                    ])
                );
            }
        } catch (error) {
            console.error('[showChat] Failed to open chat', { chatId, error });
            if (error instanceof ApiError && error.status === 404) {
                await ctx.reply('Чат не найден.');
                await loadChats(ctx, session);
                return;
            }
            await handleApiError(ctx, session, error, 'Не удалось открыть чат.');
        }
    }

    async function startChatWithUser(ctx, session, userId) {
        const telegramUserId = ensureTelegramUserId(ctx, 'chats.start');
        if (!telegramUserId) {
            return;
        }
        if (!userId) {
            await ctx.reply('Не удалось определить пользователя для контакта.');
            return;
        }
        try {
            await apiRequest('post', API_ROUTES.CHATS_START(userId), {}, session.token);
            await ctx.reply('Запрос на чат отправлен или чат создан. Показываю список чатов.');
            await loadChats(ctx, session);
        } catch (error) {
            await handleApiError(ctx, session, error, 'Не удалось начать чат.');
        }
    }

    async function sendMessageToChat(ctx, session, text) {
        const telegramUserId = ensureTelegramUserId(ctx, 'chats.message');
        if (!telegramUserId) {
            return;
        }
        try {
            const activeChatId = session.activeChatId || session.currentChatId;
            await apiRequest('post', API_ROUTES.CHAT_SEND_MESSAGE(activeChatId), { content: text }, session.token);
            await showChat(ctx, session, activeChatId, { showIntro: false });
        } catch (error) {
            await handleApiError(ctx, session, error, 'Не удалось отправить сообщение.');
        }
    }

    return {
        loadChats,
        showChat,
        startChatWithUser,
        sendMessageToChat,
    };
}
