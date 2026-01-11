import { Telegraf, Markup } from 'telegraf';
import axios from 'axios';
import { API_ROUTES } from './config/apiRoutes.js';
import { createNotificationServiceFromEnv } from './notifications.js';
import LoginMercureSubscriber from './mercure/loginSubscriber.js';
import { getLoggedIn, setLoggedIn } from './auth/loginState.js';
import SessionStore from './services/sessionStore.js';
import ApiClient, { ApiError } from './services/apiClient.js';
import { formatMatchMessage, formatRequestSummary } from './utils/messageFormatter.js';
import { getTelegramUserIdFromContext, getTokenPrefix } from './utils/telegramUserId.js';

const logger = console;

const botToken = process.env.BOT_TOKEN;
const apiUrl = process.env.API_BASE_URL || process.env.BACKEND_API_BASE_URL || process.env.API_URL || 'https://matchinghub.work';
const mercureHubUrl = process.env.MERCURE_HUB_URL || 'https://matchinghub.work/.well-known/mercure';
const mercureJwt = process.env.MERCURE_SUBSCRIBER_JWT || process.env.MERCURE_JWT;

if (!botToken) {
    console.error('BOT_TOKEN is not set');
    process.exit(1);
}

const apiClient = new ApiClient({ baseUrl: apiUrl });
const sessionStore = new SessionStore();
const bot = new Telegraf(botToken);
let notificationService = null;
let loginMercureSubscriber = null;

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

async function apiRequest(method, url, data, token) {
    return apiClient.request(method, url, data, token);
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
    if (notificationService && telegramChatId) {
        notificationService.enterChatMode(telegramChatId, session.backendUserId, chatId);
    }
}

async function handleApiError(ctx, session, error, fallbackMessage) {
    if (error instanceof ApiError && error.isAuthError) {
        const telegramUserId = resolveTelegramUserId(ctx, 'api.error.auth');
        clearSessionAuth(session, telegramUserId);
        await ctx.reply('Ваша сессия истекла. Нажмите кнопку входа, чтобы авторизоваться снова.');
        return;
    }

    await ctx.reply(error.message || fallbackMessage);
}

const SUCCESS_MAGIC_LINK_MESSAGE = 'Мы отправили вам письмо со ссылкой для входа.\nПроверьте вашу почту и нажмите на ссылку, чтобы войти.';

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

async function requireAuth(ctx) {
    await ctx.reply('Сначала перейдите по ссылке из письма для входа через веб-интерфейс.');
    return false;
}

const MAIN_MENU_KEYBOARD = Markup.inlineKeyboard([
    [Markup.button.callback('Создать запрос', 'menu:create')],
    [Markup.button.callback('Установить локацию', 'menu:setlocation')],
    [Markup.button.callback('Мои запросы', 'menu:requests')],
    [Markup.button.callback('Мои чаты', 'menu:chats')],
]);

const REQUEST_TYPES = ['mentorship', 'travel', 'dating', 'help', 'other'];
const NEGATIVE_REASON_OPTIONS = [
    { code: 'not_relevant', label: '❌ Не по смыслу' },
    { code: 'too_far', label: '📍 Слишком далеко' },
    { code: 'old_request', label: '⏳ Старый запрос' },
    { code: 'spam', label: '🚫 Похоже на спам' },
    { code: 'language_mismatch', label: '🌐 Язык не подходит' },
];

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

function resetCreateRequestState(session) {
    sessionStore.resetCreateRequestState(session);
}

function getCreateTemp(session) {
    return sessionStore.getCreateTemp(session);
}

const GEO_SELECTION_TTL_MS = 10 * 60 * 1000;

function ensureGeoTemp(session) {
    if (!session.temp) {
        session.temp = {};
    }
    if (!session.temp.geo) {
        session.temp.geo = {};
    }
    return session.temp.geo;
}

function hasSavedLocation(session) {
    return Boolean(session?.temp?.location?.country && session?.temp?.location?.city);
}

function formatSavedLocationLabel(location) {
    if (!location?.city || !location?.country) {
        return 'сохраненная локация';
    }
    const regionPart = location.city.region ? `, ${location.city.region}` : '';
    return `${location.city.name}${regionPart} (${location.country.code})`;
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

async function promptTypeSelection(ctx) {
    const keyboard = Markup.inlineKeyboard(
        REQUEST_TYPES.map((type) => [Markup.button.callback(type, `create:type:${type}`)])
    );
    await ctx.reply('Выберите тип запроса (это короткий ярлык):', keyboard);
}

async function promptCity(ctx) {
    await ctx.reply('В каком городе это актуально?\nЕсли хотите пропустить, нажмите /skip.');
}

async function promptCountry(ctx) {
    await ctx.reply('Укажите страну (ISO-код, например: DE, ES, RU).\nИли отправьте /skip, чтобы пропустить.');
}

async function promptLocationChoice(ctx, session) {
    const location = session?.temp?.location;
    const label = formatSavedLocationLabel(location);
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback(`Использовать ${label}`, 'create:use_saved_location')],
        [Markup.button.callback('Ввести вручную', 'create:manual_location')],
    ]);
    await ctx.reply('Хотите использовать сохраненную локацию или указать вручную?', keyboard);
}

async function createRequestOnBackend(ctx, session) {
    const telegramUserId = ensureTelegramUserId(ctx, 'request.create');
    if (!telegramUserId) {
        return;
    }
    const data = getCreateTemp(session);
    const payload = {
        rawText: data.rawText,
        type: data.type,
        city: data.city ?? null,
        country: data.country ?? null,
        location: data.location ?? null,
    };

    try {
        const res = await apiRequest('post', API_ROUTES.REQUESTS_CREATE, payload, session.token);
        const successMessage = [
            'Готово! Ваш запрос создан 🎉',
            `ID: ${res.id}`,
            `Тип: ${res.type}`,
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

function buildContactAuthorCallback(targetRequestId, ownerId) {
    const requestPart = targetRequestId ?? 'null';
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

function buildFeedbackCallback(type, match, targetRequestId) {
    const matchId = match?.id ?? match?.matchId ?? 'null';
    const requestId = targetRequestId ?? match?.targetRequestId ?? 'null';
    return `feedback:${type}:${matchId}:${requestId}`;
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

async function startSetLocationFlow(ctx, session) {
    const geoTemp = ensureGeoTemp(session);
    geoTemp.lastCountries = {};
    geoTemp.lastCities = {};
    geoTemp.country = null;
    geoTemp.city = null;
    geoTemp.lastCountriesAt = null;
    geoTemp.lastCitiesAt = null;
    session.state = 'WAIT_COUNTRY_QUERY';
    sessionStore.persist();
    await ctx.reply('Type country name (min 2 chars). Example: ge, ger, fra');
}

function isGeoSelectionExpired(timestamp) {
    if (!timestamp) return true;
    return Date.now() - timestamp > GEO_SELECTION_TTL_MS;
}

function buildGeoCountriesKeyboard(countries) {
    const mapping = {};
    const rows = countries.map((country, index) => {
        const key = String(index + 1);
        mapping[key] = { code: country.code, name: country.name };
        return [Markup.button.callback(`${country.name} (${country.code})`, `geo_country_pick:${key}`)];
    });
    rows.push([Markup.button.callback('Отмена', 'geo_cancel')]);
    return { keyboard: Markup.inlineKeyboard(rows), mapping };
}

function buildGeoCitiesKeyboard(cities) {
    const mapping = {};
    const rows = cities.map((city, index) => {
        const key = String(index + 1);
        mapping[key] = {
            id: city.id,
            name: city.name,
            region: city.region ?? null,
            countryCode: city.countryCode,
            latitude: city.latitude,
            longitude: city.longitude,
        };
        const regionPart = city.region ? `, ${city.region}` : '';
        const label = `${city.name}${regionPart} (${city.countryCode})`;
        return [Markup.button.callback(label, `geo_city_pick:${key}`)];
    });
    rows.push([Markup.button.callback('Отмена', 'geo_cancel')]);
    return { keyboard: Markup.inlineKeyboard(rows), mapping };
}

function isGeoServiceUnavailable(error) {
    return error instanceof ApiError && error.status === 503 && error.message === 'geo_service_unavailable';
}

async function loadMatchesForRequest(ctx, session, requestId) {
    const telegramUserId = ensureTelegramUserId(ctx, 'matches.load');
    if (!telegramUserId) {
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
            if (error.isAuthError) {
                clearSessionAuth(session, telegramUserId);
                await ctx.reply('Ваша сессия истекла. Пожалуйста, войдите снова через ссылку из письма.');
                return;
            }
        }

        await ctx.reply('Не удалось загрузить рекомендации. Попробуйте позже.');
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

async function loadChats(ctx, session) {
    const telegramUserId = ensureTelegramUserId(ctx, 'chats.load');
    if (!telegramUserId) {
        return;
    }
    try {
        const chats = await apiRequest('get', API_ROUTES.CHATS_LIST, null, session.token);
        const chatList = Array.isArray(chats) ? chats : chats?.items || [];
        if (!chatList.length) {
            await ctx.reply('Чатов пока нет.');
            return;
        }
        session.chatCache = chatList;
        sessionStore.persist();
        const keyboard = chatList.map((c) => [Markup.button.callback(c.title || c.name || `Чат ${c.id}`, `chat:open:${c.id}`)]);
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

bot.start((ctx) => {
    const session = getSession(ctx);
    const telegramUserId = ensureTelegramUserId(ctx, 'bot.start');
    if (!telegramUserId) {
        return;
    }
    const loggedIn = getLoggedIn(telegramUserId);
    if (loggedIn) {
        session.token = loggedIn.jwt;
        session.backendUserId = loggedIn.userId;
        sessionStore.persist();
        return sendMainMenu(ctx.chat.id, { email: loggedIn.email });
    }
    if (session.token) {
        setLoggedIn(telegramUserId, {
            userId: session.backendUserId,
            email: session.lastEmail,
            jwt: session.token,
        });
        return sendMainMenu(ctx.chat.id, { email: session.lastEmail });
    }
    session.state = 'awaiting_email';
    session.temp = {};
    sessionStore.persist();
    const hint = session.lastEmail ? `\n(Последний использованный email: ${session.lastEmail})` : '';
    return ctx.reply(`Введите ваш email для входа.${hint}`);
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
            await ctx.reply('Please type at least 2 characters');
            return;
        }
        try {
            const countries = await apiClient.get(API_ROUTES.GEO_COUNTRIES, { params: { q, limit: 10 } });
            const list = Array.isArray(countries) ? countries : [];
            if (!list.length) {
                await ctx.reply('No countries found, try another query');
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
                await ctx.reply('Geo service is temporarily unavailable, please try again.');
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
        if (!geoTemp.country) {
            await ctx.reply('Сначала выберите страну.');
            return;
        }
        if (q.length < 2) {
            await ctx.reply('Please type at least 2 characters');
            return;
        }
        try {
            const cities = await apiClient.get(API_ROUTES.GEO_CITIES, {
                params: { q, country: geoTemp.country.code, limit: 10 },
            });
            const list = Array.isArray(cities) ? cities : [];
            if (!list.length) {
                await ctx.reply('No cities found, try another query');
                return;
            }
            const { keyboard, mapping } = buildGeoCitiesKeyboard(list.slice(0, 10));
            geoTemp.lastCities = mapping;
            geoTemp.lastCitiesAt = Date.now();
            sessionStore.persist();
            await ctx.reply('Выберите город:', keyboard);
        } catch (error) {
            if (isGeoServiceUnavailable(error)) {
                await ctx.reply('Geo service is temporarily unavailable, please try again.');
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
        session.state = 'create:type';
        sessionStore.persist();
        await promptTypeSelection(ctx);
        return;
    }

    if (session.state === 'create:type-custom') {
        if (!text || text.length > 50) {
            await ctx.reply('Название типа должно быть от 1 до 50 символов. Попробуйте снова.');
            return;
        }
        const data = getCreateTemp(session);
        data.type = text.trim();
        if (hasSavedLocation(session)) {
            session.state = 'create:location-choice';
            sessionStore.persist();
            await promptLocationChoice(ctx, session);
            return;
        }
        session.state = 'create:city';
        sessionStore.persist();
        await promptCity(ctx);
        return;
    }

    if (session.state === 'create:city') {
        if (text === '/skip') {
            const data = getCreateTemp(session);
            data.city = null;
            data.location = null;
            session.state = 'create:country';
            sessionStore.persist();
            await promptCountry(ctx);
            return;
        }
        const data = getCreateTemp(session);
        data.location = null;
        data.city = text.trim().slice(0, 255) || null;
        session.state = 'create:country';
        sessionStore.persist();
        await promptCountry(ctx);
        return;
    }

    if (session.state === 'create:country') {
        if (text === '/skip') {
            const data = getCreateTemp(session);
            data.country = null;
            sessionStore.persist();
            await createRequestOnBackend(ctx, session);
            return;
        }
        if (!text.trim() || text.trim().length > 3) {
            await ctx.reply('Введите код страны в формате ISO (2-3 символа), например: DE.');
            return;
        }
        const data = getCreateTemp(session);
        data.country = text.trim().toUpperCase();
        data.location = null;
        sessionStore.persist();
        await createRequestOnBackend(ctx, session);
        return;
    }

    const loggedIn = getLoggedIn(telegramUserId);
    if (!session.state && loggedIn) {
        session.token = loggedIn.jwt;
        session.backendUserId = loggedIn.userId;
        sessionStore.persist();
        await sendMainMenu(ctx.chat.id, { email: loggedIn.email });
        return;
    }
    if (!session.state && session.token) {
        setLoggedIn(telegramUserId, {
            userId: session.backendUserId,
            email: session.lastEmail,
            jwt: session.token,
        });
        await sendMainMenu(ctx.chat.id, { email: session.lastEmail });
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
        await requestMagicLink(ctx, session, text);
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
    await sendMainMenu(ctx.chat.id, { email: loggedIn.email });
});

bot.command('setlocation', async (ctx) => {
    const session = getSession(ctx);
    await startSetLocationFlow(ctx, session);
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
    await sendMainMenu(ctx.chat.id, { email: loggedIn.email });
});

bot.action('menu:setlocation', async (ctx) => {
    await ctx.answerCbQuery();
    const session = getSession(ctx);
    await startSetLocationFlow(ctx, session);
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
        await ctx.reply('Selection expired, please type again');
        return;
    }
    const selected = geoTemp.lastCountries?.[key];
    if (!selected) {
        await ctx.reply('Selection expired, please type again');
        return;
    }
    geoTemp.country = selected;
    session.state = 'WAIT_CITY_QUERY';
    sessionStore.persist();
    await ctx.editMessageText(`Country selected: ${selected.name} (${selected.code}). Now type a city name (min 2 chars).`);
});

bot.action(/^geo_city_pick:(.+)$/, async (ctx) => {
    const session = getSession(ctx);
    const geoTemp = ensureGeoTemp(session);
    const [, key] = ctx.match;
    await ctx.answerCbQuery();
    if (isGeoSelectionExpired(geoTemp.lastCitiesAt)) {
        await ctx.reply('Selection expired, please type again');
        return;
    }
    const selected = geoTemp.lastCities?.[key];
    if (!selected) {
        await ctx.reply('Selection expired, please type again');
        return;
    }
    geoTemp.city = selected;
    session.temp.location = {
        country: geoTemp.country,
        city: selected,
    };
    session.state = null;
    sessionStore.persist();
    const regionPart = selected.region ? `, ${selected.region}` : '';
    await ctx.editMessageText(`Location set: ${selected.name}${regionPart}, ${selected.countryCode} ✅`);
});

bot.action(/^geo_cancel$/, async (ctx) => {
    const session = getSession(ctx);
    await ctx.answerCbQuery();
    if (session?.temp?.geo) {
        session.temp.geo = {};
    }
    session.state = null;
    sessionStore.persist();
    await ctx.editMessageText('Cancelled.');
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

    if (!ownerId) {
        await ctx.reply('Не удалось определить автора заявки.');
        return;
    }

    if (session.backendUserId && Number(ownerId) === Number(session.backendUserId)) {
        await ctx.reply('Это ваша собственная заявка.');
        return;
    }

    try {
        const chat = await apiRequest('post', API_ROUTES.CHATS_START(ownerId), {}, session.token);
        if (!chat?.id) {
            await ctx.reply('Не удалось создать чат, попробуйте позже.');
            return;
        }

        enterChatState(session, ctx.chat?.id, chat.id);

        try {
            await apiRequest(
                'post',
                API_ROUTES.CHAT_SEND_MESSAGE(chat.id),
                { content: 'Привет! Я нашёл твою заявку в матчинге и хотел(а) бы обсудить её 🙂' },
                session.token
            );
        } catch (sendError) {
            console.error('Failed to send intro message to chat', sendError);
        }

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('⬅️ Назад к рекомендациям', 'chat:exit')],
            [Markup.button.callback('⬅️ В меню', 'menu:main')],
        ]);

        await ctx.reply('Чат с автором создан, напиши своё первое сообщение.', keyboard);
    } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
            const telegramUserId = resolveTelegramUserId(ctx, 'chats.start.auth');
            clearSessionAuth(session, telegramUserId);
            await ctx.reply('Ваша сессия истекла. Нажмите кнопку входа, чтобы авторизоваться снова.');
            return;
        }
        if (error instanceof ApiError && error.status === 404) {
            await ctx.reply('Автор заявки не найден.');
            return;
        }
        await ctx.reply('Не удалось создать чат, попробуйте позже.');
    }
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

bot.action(/create:type:(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const session = getSession(ctx);
    if (session.state !== 'create:type') {
        return;
    }
    const [, typeValue] = ctx.match;
    if (!REQUEST_TYPES.includes(typeValue)) {
        await ctx.reply('Неизвестный тип запроса. Попробуйте снова.');
        return;
    }

    const data = getCreateTemp(session);
    if (typeValue === 'other') {
        session.state = 'create:type-custom';
        sessionStore.persist();
        await ctx.reply('Напишите короткое название типа, например: “language_exchange”');
        return;
    }

    data.type = typeValue;
    if (hasSavedLocation(session)) {
        session.state = 'create:location-choice';
        sessionStore.persist();
        await promptLocationChoice(ctx, session);
        return;
    }
    session.state = 'create:city';
    sessionStore.persist();
    await promptCity(ctx);
});

bot.action('create:use_saved_location', async (ctx) => {
    await ctx.answerCbQuery();
    const session = getSession(ctx);
    if (session.state !== 'create:location-choice') {
        return;
    }
    const data = getCreateTemp(session);
    const location = session?.temp?.location;
    data.location = location ?? null;
    data.city = location?.city?.name ?? null;
    data.country = location?.country?.code ?? null;
    sessionStore.persist();
    await createRequestOnBackend(ctx, session);
});

bot.action('create:manual_location', async (ctx) => {
    await ctx.answerCbQuery();
    const session = getSession(ctx);
    if (session.state !== 'create:location-choice') {
        return;
    }
    const data = getCreateTemp(session);
    data.location = null;
    session.state = 'create:city';
    sessionStore.persist();
    await promptCity(ctx);
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

loginMercureSubscriber = new LoginMercureSubscriber({
    hubUrl: mercureHubUrl,
    jwt: mercureJwt,
    onUserLoggedIn: handleUserLoggedInEvent,
});

bot.launch().then(() => {
    console.log('Matching bot started');
    notificationService = createNotificationServiceFromEnv(bot);
});

process.once('SIGINT', () => {
    if (notificationService) notificationService.stop();
    if (loginMercureSubscriber) loginMercureSubscriber.stop();
    bot.stop('SIGINT');
});
process.once('SIGTERM', () => {
    if (notificationService) notificationService.stop();
    if (loginMercureSubscriber) loginMercureSubscriber.stop();
    bot.stop('SIGTERM');
});
//
