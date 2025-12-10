import { Telegraf, Markup } from 'telegraf';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { API_ROUTES } from './config/apiRoutes.js';
import { createNotificationServiceFromEnv } from './notifications.js';
import LoginMercureSubscriber from './mercure/loginSubscriber.js';
import {
    clearPendingMagicLink,
    getLoggedIn,
    resetLoginState,
    setLoggedIn,
    setPendingMagicLink,
} from './auth/loginState.js';

const botToken = process.env.BOT_TOKEN;
const apiUrl = process.env.API_BASE_URL || process.env.BACKEND_API_BASE_URL || process.env.API_URL || 'https://matchinghub.work';
const mercureHubUrl = process.env.MERCURE_HUB_URL || 'https://matchinghub.work/.well-known/mercure';
const mercureJwt = process.env.MERCURE_SUBSCRIBER_JWT || process.env.MERCURE_JWT;

if (!botToken) {
    console.error('BOT_TOKEN is not set');
    process.exit(1);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.join(__dirname, '..', 'data');
const sessionFile = path.join(dataDir, 'sessions.json');

if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const defaultSession = {
    state: null,
    temp: {},
    lastEmail: null,
};

const sessionStore = fs.existsSync(sessionFile)
    ? JSON.parse(fs.readFileSync(sessionFile, 'utf8'))
    : {};

const bot = new Telegraf(botToken);
let notificationService = null;
let loginMercureSubscriber = null;

function saveSessions() {
    fs.writeFileSync(sessionFile, JSON.stringify(sessionStore, null, 2));
}

class ApiError extends Error {
    constructor(message, status = null, isAuthError = false) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.isAuthError = isAuthError;
    }
}

function getSession(ctx) {
    const tgId = ctx.from?.id;
    if (!tgId) {
        return { ...defaultSession };
    }
    if (!sessionStore[tgId]) {
        sessionStore[tgId] = { ...defaultSession };
        saveSessions();
    }
    return sessionStore[tgId];
}

function getSessionByChatId(chatId) {
    if (!chatId) {
        return { ...defaultSession };
    }
    if (!sessionStore[chatId]) {
        sessionStore[chatId] = { ...defaultSession };
        saveSessions();
    }
    return sessionStore[chatId];
}

function saveUserJwt(chatId, jwt, { userId, email } = {}) {
    const session = getSessionByChatId(chatId);
    if (jwt) {
        session.token = jwt;
    }
    if (userId) {
        session.backendUserId = userId;
    }
    if (email) {
        session.lastEmail = email;
    }
    saveSessions();

    const existingLoginState = getLoggedIn(chatId) || {};
    const resolvedUserId = userId ?? existingLoginState.userId ?? session.backendUserId;
    const resolvedEmail = email ?? existingLoginState.email ?? session.lastEmail;
    const resolvedJwt = jwt ?? existingLoginState.jwt ?? session.token;

    setLoggedIn(chatId, {
        userId: resolvedUserId,
        email: resolvedEmail,
        jwt: resolvedJwt,
    });

    if (notificationService && chatId && resolvedUserId) {
        notificationService.setBackendUserId(chatId, resolvedUserId);
    }
}

function resetState(session) {
    session.state = null;
    session.temp = {};
}

function buildApiUrl(pathname) {
    const base = apiUrl.replace(/\/+$/, '');
    if (!pathname) return base;
    const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
    if (base.endsWith('/api') && normalizedPath.startsWith('/api')) {
        return `${base}${normalizedPath.replace(/^\/api/, '')}`;
    }
    return `${base}${normalizedPath}`;
}

function normalizeApiError(error) {
    if (error.response) {
        const status = error.response.status;

        if (typeof error.response.data === 'string') {
            const isHtml = error.response.data.toLowerCase().includes('<html');
            return {
                message: isHtml ? '❌ Произошла ошибка на сервере. Попробуйте позже.' : error.response.data,
                status,
                isAuthError: status === 401 || status === 403,
            };
        }

        if (error.response.data?.violations) {
            return {
                message: error.response.data.violations
                    .map((v) => `${v.propertyPath}: ${v.message}`)
                    .join('\n'),
                status,
                isAuthError: status === 401 || status === 403,
            };
        }

        return {
            message: error.response.data?.message ||
                     error.response.data?.error ||
                     `Ошибка ${status}: попробуйте позже.`,
            status,
            isAuthError: status === 401 || status === 403,
        };
    }

    if (error.request) {
        return {
            message: 'Не удалось связаться с сервером. Проверьте соединение или попробуйте позже.',
            status: null,
            isAuthError: false,
        };
    }

    return {
        message: '❌ Произошла ошибка на сервере. Попробуйте позже.',
        status: null,
        isAuthError: false,
    };
}

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function buildAuthHeaders(token) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) {
        headers.Authorization = `Bearer ${token}`;
    }
    return headers;
}

async function apiRequest(method, url, data, token) {
    try {
        const res = await axios({
            method,
            url: buildApiUrl(url),
            data,
            headers: buildAuthHeaders(token),
            timeout: 10000,
        });
        return res.data;
    } catch (err) {
        const norm = normalizeApiError(err);
        throw new ApiError(norm.message, norm.status, norm.isAuthError);
    }
}

function clearSessionAuth(session, chatId) {
    if (!session) return;
    session.token = null;
    session.backendUserId = null;
    saveSessions();
    resetLoginState(chatId);
}

async function handleApiError(ctx, session, error, fallbackMessage) {
    if (error instanceof ApiError && error.isAuthError) {
        clearSessionAuth(session, ctx.chat?.id);
        await ctx.reply('Ваша сессия истекла. Нажмите кнопку входа, чтобы авторизоваться снова.');
        return;
    }

    await ctx.reply(error.message || fallbackMessage);
}

const SUCCESS_MAGIC_LINK_MESSAGE = 'Мы отправили вам письмо со ссылкой для входа.\nПроверьте вашу почту и нажмите на ссылку, чтобы войти.';

async function requestMagicLink(ctx, session, email) {
    const name = ctx.from?.first_name || ctx.from?.username || undefined;
    const chatId = ctx.chat?.id;
    try {
        const payload = {
            email,
            name,
            telegram_chat_id: chatId !== undefined ? String(chatId) : undefined,
        };

        await apiRequest('post', API_ROUTES.MAGIC_LINK_REQUEST, payload, null);
        session.lastEmail = email;
        resetState(session);
        saveSessions();
        setPendingMagicLink(chatId, email);
        if (chatId && loginMercureSubscriber) {
            loginMercureSubscriber.ensureSubscription(chatId);
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
    [Markup.button.callback('Мои запросы', 'menu:requests')],
    [Markup.button.callback('Мои чаты', 'menu:chats')],
]);

const REQUEST_TYPES = ['mentorship', 'travel', 'dating', 'help', 'other'];

async function sendMainMenu(chatId, userInfo = {}) {
    if (!chatId) return;
    const greetingName = userInfo.name || userInfo.email || 'друг';
    const message = `Добро пожаловать, ${greetingName}!`;
    await bot.telegram.sendMessage(chatId, message, MAIN_MENU_KEYBOARD);
}

function ensureLoggedInSession(ctx) {
    const session = getSession(ctx);
    const chatId = ctx.chat?.id;
    const loggedIn = getLoggedIn(chatId);

    if (loggedIn?.jwt) {
        session.token = loggedIn.jwt;
        session.backendUserId = loggedIn.userId;
        saveSessions();
        return session;
    }

    if (session.token) {
        setLoggedIn(chatId, {
            userId: session.backendUserId,
            email: session.lastEmail,
            jwt: session.token,
        });
        return session;
    }

    ctx.reply('Чтобы продолжить, сначала авторизуйтесь через ссылку из письма.');
    return null;
}

function resetCreateRequestState(session) {
    if (!session) return;
    session.state = null;
    if (session.temp) {
        delete session.temp.createRequest;
    }
    session.currentChatId = null;
    saveSessions();
}

function getCreateTemp(session) {
    if (!session.temp) {
        session.temp = {};
    }
    if (!session.temp.createRequest) {
        session.temp.createRequest = {};
    }
    return session.temp.createRequest;
}

async function startCreateRequestFlow(ctx, session) {
    if (!session?.token) {
        await ctx.reply('Не удалось найти вашу активную сессию. Пожалуйста, войдите заново через ссылку-логин.');
        return;
    }
    session.state = 'create:rawText';
    session.temp.createRequest = {};
    saveSessions();
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

async function createRequestOnBackend(ctx, session) {
    const data = getCreateTemp(session);
    const payload = {
        rawText: data.rawText,
        type: data.type,
        city: data.city ?? null,
        country: data.country ?? null,
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
            clearSessionAuth(session, ctx.chat?.id);
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

function formatSimilarity(similarity) {
    if (similarity === null || similarity === undefined) return '—';
    const percent = Number(similarity) * 100;
    return `${percent.toFixed(1)}%`;
}

function formatCreatedAt(createdAt) {
    if (!createdAt) return '—';
    const date = new Date(createdAt);
    if (Number.isNaN(date.getTime())) return createdAt;
    return date.toLocaleString('ru-RU');
}

function formatMatchMessage(match) {
    const lines = [
        '🔎 Рекомендация:',
        `• Тип: ${match.type ?? '—'}`,
        `• Город/страна: ${match.city ?? '—'}, ${match.country ?? '—'}`,
        `• Статус: ${match.status ?? '—'}`,
        `• Похожесть: ${formatSimilarity(match.similarity)}`,
        `• Создано: ${formatCreatedAt(match.createdAt)}`,
    ];

    return lines.join('\n');
}

async function sendRecommendation(ctx, match) {
    const keyboard = Markup.inlineKeyboard([[Markup.button.callback('⬅️ В меню', 'menu:main')]]);
    await ctx.reply(formatMatchMessage(match), keyboard);
}

async function loadMatchesForRequest(ctx, session, requestId) {
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

        const limitedMatches = items.slice(0, 5);
        for (const match of limitedMatches) {
            await sendRecommendation(ctx, match);
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
                clearSessionAuth(session, ctx.chat?.id);
                await ctx.reply('Ваша сессия истекла. Пожалуйста, войдите снова через ссылку из письма.');
                return;
            }
        }

        await ctx.reply('Не удалось загрузить рекомендации. Попробуйте позже.');
    }
}

async function chooseRequestForMatches(ctx, session) {
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
    try {
        const data = await apiRequest('get', API_ROUTES.REQUESTS_MINE, null, session.token);
        const myRequests = Array.isArray(data) ? data : data?.items || [];

        if (!myRequests.length) {
            await ctx.reply('У вас пока нет запросов.');
            return;
        }

        await ctx.reply('Ваши запросы:');
        for (const req of myRequests) {
            const text = [
                `• ${req.title || req.name || 'Запрос'}`,
                req.description ? `Описание: ${req.description}` : null,
                req.city ? `Город: ${req.city}` : null,
            ]
                .filter(Boolean)
                .join('\n');
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
    try {
        const chats = await apiRequest('get', API_ROUTES.CHATS_LIST, null, session.token);
        const chatList = Array.isArray(chats) ? chats : chats?.items || [];
        if (!chatList.length) {
            await ctx.reply('Чатов пока нет.');
            return;
        }
        const keyboard = chatList.map((c) => [Markup.button.callback(c.title || c.name || `Чат ${c.id}`, `chat:open:${c.id}`)]);
        await ctx.reply('Ваши чаты:', Markup.inlineKeyboard(keyboard));
    } catch (error) {
        await handleApiError(ctx, session, error, 'Не удалось загрузить чаты.');
    }
}

async function showChat(ctx, session, chatId) {
    try {
        const messages = await apiRequest('get', API_ROUTES.CHAT_MESSAGES(chatId), null, session.token);
        const list = Array.isArray(messages) ? messages : messages?.items || [];
        if (!list.length) {
            await ctx.reply('Сообщений пока нет. Напишите что-нибудь!');
        } else {
            const lastMessages = list.slice(-10);
            const text = lastMessages
                .map((m) => `${m.sender?.name || m.sender?.id || 'Собеседник'}: ${m.content || m.text}`)
                .join('\n');
            await ctx.reply(text);
        }
        session.state = 'chatting';
        session.currentChatId = chatId;
        saveSessions();
        if (notificationService && ctx.chat?.id) {
            notificationService.enterChatMode(ctx.chat.id, session.backendUserId, chatId);
        }
        await ctx.reply('Вы в режиме чата. Напишите сообщение или нажмите кнопку для выхода.', Markup.inlineKeyboard([
            [Markup.button.callback('⬅️ В меню', 'menu:main')],
        ]));
    } catch (error) {
        await handleApiError(ctx, session, error, 'Не удалось открыть чат.');
    }
}

async function startChatWithUser(ctx, session, userId) {
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
    try {
        await apiRequest('post', API_ROUTES.CHAT_SEND_MESSAGE(session.currentChatId), { content: text }, session.token);
        await ctx.reply('Сообщение отправлено.');
    } catch (error) {
        await handleApiError(ctx, session, error, 'Не удалось отправить сообщение.');
    }
}

async function handleUserLoggedInEvent({ chatId, userId, email, jwt }) {
    const session = getSessionByChatId(chatId);
    const effectiveEmail = email || session.lastEmail;

    saveUserJwt(chatId, jwt, { userId, email: effectiveEmail });
    resetState(session);
    saveSessions();
    clearPendingMagicLink(chatId);

    const loginMessage = 'Вы успешно вошли! Вот ваше меню:';
    await bot.telegram.sendMessage(chatId, loginMessage, MAIN_MENU_KEYBOARD);
}

bot.start((ctx) => {
    const session = getSession(ctx);
    const loggedIn = getLoggedIn(ctx.chat?.id);
    if (loggedIn) {
        session.token = loggedIn.jwt;
        session.backendUserId = loggedIn.userId;
        saveSessions();
        return sendMainMenu(ctx.chat.id, { email: loggedIn.email });
    }
    if (session.token) {
        setLoggedIn(ctx.chat?.id, {
            userId: session.backendUserId,
            email: session.lastEmail,
            jwt: session.token,
        });
        return sendMainMenu(ctx.chat.id, { email: session.lastEmail });
    }
    session.state = 'awaiting_email';
    session.temp = {};
    saveSessions();
    const hint = session.lastEmail ? `\n(Последний использованный email: ${session.lastEmail})` : '';
    return ctx.reply(`Введите ваш email для входа.${hint}`);
});

bot.command('ping', async (ctx) => {
    try {
        const res = await axios.get(buildApiUrl('/api/docs'), { timeout: 5000 }).catch(() => null);
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
    const text = ctx.message.text.trim();

    if (text === '/cancel' && session.state?.startsWith('create:')) {
        resetCreateRequestState(session);
        await ctx.reply('Создание запроса отменено.', MAIN_MENU_KEYBOARD);
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
        saveSessions();
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
        session.state = 'create:city';
        saveSessions();
        await promptCity(ctx);
        return;
    }

    if (session.state === 'create:city') {
        if (text === '/skip') {
            const data = getCreateTemp(session);
            data.city = null;
            session.state = 'create:country';
            saveSessions();
            await promptCountry(ctx);
            return;
        }
        const data = getCreateTemp(session);
        data.city = text.trim().slice(0, 255) || null;
        session.state = 'create:country';
        saveSessions();
        await promptCountry(ctx);
        return;
    }

    if (session.state === 'create:country') {
        if (text === '/skip') {
            const data = getCreateTemp(session);
            data.country = null;
            saveSessions();
            await createRequestOnBackend(ctx, session);
            return;
        }
        if (!text.trim() || text.trim().length > 3) {
            await ctx.reply('Введите код страны в формате ISO (2-3 символа), например: DE.');
            return;
        }
        const data = getCreateTemp(session);
        data.country = text.trim().toUpperCase();
        saveSessions();
        await createRequestOnBackend(ctx, session);
        return;
    }

    const loggedIn = getLoggedIn(ctx.chat?.id);
    if (!session.state && loggedIn) {
        session.token = loggedIn.jwt;
        session.backendUserId = loggedIn.userId;
        saveSessions();
        await sendMainMenu(ctx.chat.id, { email: loggedIn.email });
        return;
    }
    if (!session.state && session.token) {
        setLoggedIn(ctx.chat?.id, {
            userId: session.backendUserId,
            email: session.lastEmail,
            jwt: session.token,
        });
        await sendMainMenu(ctx.chat.id, { email: session.lastEmail });
        return;
    }

    if (!session.state) {
        session.state = 'awaiting_email';
        saveSessions();
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
    const loggedIn = getLoggedIn(ctx.chat?.id);
    if (!loggedIn) {
        await ctx.reply('Чтобы открыть меню, сначала авторизуйтесь через ссылку из письма.');
        return;
    }
    await sendMainMenu(ctx.chat.id, { email: loggedIn.email });
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
    session.state = null;
    session.currentChatId = null;
    saveSessions();
    if (notificationService && ctx.chat?.id) {
        notificationService.leaveChatMode(ctx.chat.id);
    }
    const loggedIn = getLoggedIn(ctx.chat?.id);
    if (!loggedIn) {
        await ctx.reply('Чтобы открыть меню, сначала авторизуйтесь через ссылку из письма.');
        return;
    }
    await ctx.answerCbQuery();
    await sendMainMenu(ctx.chat.id, { email: loggedIn.email });
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

bot.action('menu:chats', async (ctx) => {
    await ctx.answerCbQuery();
    const session = ensureLoggedInSession(ctx);
    if (!session) return;
    await loadChats(ctx, session);
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
        saveSessions();
        await ctx.reply('Напишите короткое название типа, например: “language_exchange”');
        return;
    }

    data.type = typeValue;
    session.state = 'create:city';
    saveSessions();
    await promptCity(ctx);
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