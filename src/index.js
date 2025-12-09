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

async function apiRequest(method, url, data, token) {
    try {
        const res = await axios({
            method,
            url: buildApiUrl(url),
            data,
            headers: token ? { Authorization: `Bearer ${token}` } : undefined,
            timeout: 10000,
        });
        return res.data;
    } catch (err) {
        const norm = normalizeApiError(err);
        throw new ApiError(norm.message, norm.status, norm.isAuthError);
    }
}

async function handleApiError(ctx, session, error, fallbackMessage) {
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
    if (!loggedIn) {
        ctx.reply('Чтобы продолжить, сначала авторизуйтесь через ссылку из письма.');
        return null;
    }
    session.token = loggedIn.jwt;
    session.backendUserId = loggedIn.userId;
    saveSessions();
    return session;
}

async function sendRecommendation(ctx, session) {
    if (!session.temp.recommendations || session.temp.recommendations.length === 0) {
        await ctx.reply('Рекомендации закончились. Попробуйте позже.');
        return;
    }
    const idx = session.temp.recommendationIndex || 0;
    const item = session.temp.recommendations[idx];
    if (!item) {
        await ctx.reply('Рекомендации закончились.');
        return;
    }
    const contactUserId = item.userId || item.user?.id || item.ownerId || item.owner?.id;
    const text = [
        `📝 ${item.title || item.name || 'Запрос'}`,
        item.description ? `Описание: ${item.description}` : null,
        item.category ? `Категория: ${item.category}` : null,
        item.city ? `Город: ${item.city}` : null,
    ]
        .filter(Boolean)
        .join('\n');

    const buttons = [[Markup.button.callback('Следующая', 'reco:next')], [Markup.button.callback('⬅️ В меню', 'menu:main')]];
    if (contactUserId) {
        buttons.unshift([Markup.button.callback('Хочу связаться', `reco:contact:${contactUserId}`)]);
    }

    const keyboard = Markup.inlineKeyboard(buttons);

    await ctx.reply(text, keyboard);
}

async function loadMatchesForRequest(ctx, session, requestId) {
    try {
        const data = await apiRequest('get', API_ROUTES.REQUESTS_MATCHES(requestId), null, session.token);
        session.temp.recommendations = Array.isArray(data) ? data : data?.items || [];
        session.temp.recommendationIndex = 0;
        session.temp.selectedRequestId = requestId;
        saveSessions();
        if (!session.temp.recommendations.length) {
            await ctx.reply('Пока нет рекомендаций для этого запроса. Попробуйте позже.');
            return;
        }
        await sendRecommendation(ctx, session);
    } catch (error) {
        await handleApiError(ctx, session, error, 'Не удалось загрузить рекомендации.');
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

    const loggedIn = getLoggedIn(ctx.chat?.id);
    if (!session.state && loggedIn) {
        session.token = loggedIn.jwt;
        session.backendUserId = loggedIn.userId;
        saveSessions();
        await sendMainMenu(ctx.chat.id, { email: loggedIn.email });
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

bot.action('menu:chats', async (ctx) => {
    await ctx.answerCbQuery();
    const session = ensureLoggedInSession(ctx);
    if (!session) return;
    await loadChats(ctx, session);
});

bot.action('menu:create', async (ctx) => {
    await ctx.answerCbQuery();
    const loggedIn = getLoggedIn(ctx.chat?.id);
    if (!loggedIn) {
        await ctx.reply('Авторизуйтесь через ссылку из письма, чтобы создавать запросы.');
        return;
    }
    await ctx.reply('Создание запросов доступно в веб-приложении. Воспользуйтесь сайтом, затем вернитесь сюда за рекомендациями или чатами.');
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