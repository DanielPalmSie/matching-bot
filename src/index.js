import { Telegraf, Markup } from 'telegraf';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { API_ROUTES } from './config/apiRoutes.js';
import { createNotificationServiceFromEnv } from './notifications.js';

const botToken = process.env.BOT_TOKEN;
const apiUrl = process.env.API_BASE_URL || process.env.BACKEND_API_BASE_URL || process.env.API_URL || 'https://matchinghub.work';

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
    token: null,
    refreshToken: null,
    backendUserId: null,
    state: null,
    temp: {},
    currentChatId: null,
    lastEmail: null,
};

const sessionStore = fs.existsSync(sessionFile)
    ? JSON.parse(fs.readFileSync(sessionFile, 'utf8'))
    : {};

const bot = new Telegraf(botToken);
let notificationService = null;

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

function resetState(session, telegramChatId = null) {
    session.state = null;
    session.temp = {};
    session.currentChatId = null;
    if (telegramChatId && notificationService) {
        notificationService.leaveChatMode(telegramChatId);
    }
}

function clearAuth(session, telegramChatId = null) {
    session.token = null;
    session.refreshToken = null;
    session.backendUserId = null;
    resetState(session, telegramChatId);
    saveSessions();
    if (telegramChatId && notificationService) {
        notificationService.clearTelegramChat(telegramChatId);
    }
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
    if (error instanceof ApiError && error.isAuthError) {
        clearAuth(session, ctx.chat?.id);
        await ctx.reply('⚠️ Сессия истекла или недействительна. Пожалуйста, войдите ещё раз через кнопку «Войти» или команду /start.');
        return;
    }
    await ctx.reply(error.message || fallbackMessage);
}

const mainMenuKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔍 Найти запросы', 'menu:recommendations')],
    [Markup.button.callback('📨 Мои запросы', 'menu:requests')],
    [Markup.button.callback('💬 Мои чаты', 'menu:chats')],
]);

function showAuthMenu(ctx) {
    return ctx.reply(
        'Привет! Я matching-бот 🤝\nВыберите действие, чтобы продолжить: войти или зарегистрироваться.',
        Markup.inlineKeyboard([
            [Markup.button.callback('Войти', 'auth:login')],
            [Markup.button.callback('Зарегистрироваться', 'auth:register')],
        ])
    );
}

function showMainMenu(ctx) {
    const session = getSession(ctx);
    resetState(session, ctx.chat?.id);
    saveSessions();
    return ctx.reply('Главное меню', mainMenuKeyboard);
}

async function registerUser(ctx, session, { email, password }) {
    try {
        const payload = { email, password };
        const guessedName = ctx.from?.first_name || ctx.from?.username;
        if (guessedName) {
            payload.name = guessedName;
        }

        await apiRequest('post', API_ROUTES.REGISTER, payload, null);

        session.lastEmail = email;
        session.state = 'await_confirmation';
        session.temp = {};
        saveSessions();

        const confirmationKeyboard = Markup.inlineKeyboard([
            [Markup.button.callback('Я подтвердил почту', 'auth:confirmed')],
        ]);

        await ctx.reply(
            '✅ Мы отправили письмо с подтверждением на указанную почту.\n' +
            'Пожалуйста, перейдите по ссылке из письма, чтобы активировать аккаунт.\n' +
            'После этого вернитесь в Telegram и нажмите «Я подтвердил почту», чтобы войти.',
            confirmationKeyboard
        );
    } catch (error) {
        const safeMessage = error.message || 'Не удалось завершить регистрацию. Попробуйте ещё раз позже.';
        console.error('Registration failed', { status: error.status, message: safeMessage });
        await ctx.reply(`❌ ${safeMessage}`);
    }
}

async function fetchCurrentUser(session, chatId) {
    if (!session.token) return;
    try {
        const me = await apiRequest('get', API_ROUTES.ME, null, session.token);
        session.backendUserId = me?.id || me?.userId || session.backendUserId;
        saveSessions();
        if (chatId && notificationService) {
            notificationService.setBackendUserId(chatId, session.backendUserId);
        }
    } catch (error) {
        console.error('Failed to load profile after login', { status: error.status, message: error.message });
    }
}

async function loginUser(ctx, session, email, password) {
    try {
        const data = await apiRequest('post', API_ROUTES.LOGIN, { email, password }, null);
        const token = data?.token || data?.accessToken || data?.token?.token;
        const refreshToken = data?.refreshToken || data?.refresh_token || data?.token?.refreshToken || null;
        const backendUserId = data?.user?.id || data?.userId || null;

        if (!token) {
            throw new ApiError('Не удалось получить токен. Попробуйте позже.');
        }

        session.token = token;
        session.refreshToken = refreshToken;
        session.backendUserId = backendUserId;
        session.lastEmail = email;
        resetState(session, ctx.chat?.id);
        saveSessions();

        if (ctx.chat?.id && notificationService) {
            notificationService.setBackendUserId(ctx.chat.id, session.backendUserId);
        }

        await fetchCurrentUser(session, ctx.chat?.id);

        await ctx.reply('✅ Вход выполнен. Добро пожаловать!');
        await showMainMenu(ctx);
    } catch (error) {
        if (error instanceof ApiError && (error.status === 400 || error.status === 401)) {
            const messageLower = (error.message || '').toLowerCase();
            if (messageLower.includes('confirm') || messageLower.includes('verify') || messageLower.includes('подтверд')) {
                await ctx.reply('Ваш email ещё не подтверждён. Пожалуйста, перейдите по ссылке в письме и попробуйте снова.');
                return;
            }
            await ctx.reply('Неверный email или пароль. Попробуйте снова.');
            return;
        }

        const fallback = 'Сервис временно недоступен. Попробуйте позже.';
        console.error('Login failed', { status: error.status, message: error.message });
        await handleApiError(ctx, session, error, fallback);
    }
}

async function requireAuth(ctx) {
    const session = getSession(ctx);
    if (!session.token) {
        await ctx.reply('Сначала войдите или зарегистрируйтесь.');
        return false;
    }
    return true;
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

bot.start((ctx) => {
    const session = getSession(ctx);
    if (session.token) {
        return showMainMenu(ctx);
    }
    return showAuthMenu(ctx);
});

bot.command('menu', (ctx) => showMainMenu(ctx));

bot.command('confirmed', async (ctx) => {
    const session = getSession(ctx);
    session.state = 'login_email';
    session.temp = {};
    saveSessions();
    const hint = session.lastEmail ? `\n(Используйте тот же email: ${session.lastEmail})` : '';
    await ctx.reply(`Отлично! Введите email для входа:${hint}`);
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

bot.action('auth:login', async (ctx) => {
    const session = getSession(ctx);
    session.state = 'login_email';
    session.temp = {};
    saveSessions();
    await ctx.answerCbQuery();
    const hint = session.lastEmail ? `\n(Последний использованный email: ${session.lastEmail})` : '';
    await ctx.reply(`Введите email для входа:${hint}`);
});

bot.action('auth:register', async (ctx) => {
    const session = getSession(ctx);
    session.state = 'register_email';
    session.temp = {};
    saveSessions();
    await ctx.answerCbQuery();
    await ctx.reply('Введите email для регистрации:');
});

bot.action('auth:confirmed', async (ctx) => {
    const session = getSession(ctx);
    session.state = 'login_email';
    session.temp = {};
    saveSessions();
    await ctx.answerCbQuery();
    const hint = session.lastEmail ? `\n(Используйте тот же email: ${session.lastEmail})` : '';
    await ctx.reply(`Отлично! Давайте войдём. Введите email:${hint}`);
});

bot.action('menu:main', async (ctx) => {
    await ctx.answerCbQuery();
    return showMainMenu(ctx);
});

bot.action('menu:recommendations', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const session = getSession(ctx);
    await ctx.answerCbQuery();
    await chooseRequestForMatches(ctx, session);
});

bot.action(/reco:choose:(.+)/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const session = getSession(ctx);
    const requestId = ctx.match[1];
    await ctx.answerCbQuery();
    await loadMatchesForRequest(ctx, session, requestId);
});

bot.action('reco:next', async (ctx) => {
    const session = getSession(ctx);
    session.temp.recommendationIndex = (session.temp.recommendationIndex || 0) + 1;
    saveSessions();
    await ctx.answerCbQuery();
    await sendRecommendation(ctx, session);
});

bot.action(/reco:contact:(.+)/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const session = getSession(ctx);
    const userId = ctx.match[1];
    await ctx.answerCbQuery();
    await startChatWithUser(ctx, session, userId);
});

bot.action('menu:requests', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const session = getSession(ctx);
    await ctx.answerCbQuery();
    await loadRequests(ctx, session);
});

bot.action(/req:matches:(.+)/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const requestId = ctx.match[1];
    const session = getSession(ctx);
    await ctx.answerCbQuery();
    await loadMatchesForRequest(ctx, session, requestId);
});

bot.action('menu:chats', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const session = getSession(ctx);
    await ctx.answerCbQuery();
    await loadChats(ctx, session);
});

bot.action(/chat:open:(.+)/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const chatId = ctx.match[1];
    const session = getSession(ctx);
    await ctx.answerCbQuery();
    await showChat(ctx, session, chatId);
});

bot.on('text', async (ctx) => {
    const session = getSession(ctx);
    const text = ctx.message.text;

    if (session.state === 'login_email') {
        const email = text.trim();
        if (!isValidEmail(email)) {
            await ctx.reply('Пожалуйста, введите корректный email.');
            return;
        }
        session.temp.email = email;
        session.lastEmail = email;
        session.state = 'login_password';
        saveSessions();
        await ctx.reply('Введите пароль:');
        return;
    }

    if (session.state === 'login_password') {
        const password = text.trim();
        const email = session.temp.email;
        if (!email) {
            session.state = 'login_email';
            saveSessions();
            await ctx.reply('Сначала введите email.');
            return;
        }
        if (password.length < 6) {
            await ctx.reply('Пароль должен содержать не менее 6 символов.');
            return;
        }
        await loginUser(ctx, session, email, password);
        return;
    }

    if (session.state === 'register_email' || session.state === 'register_name') {
        const email = text.trim();
        if (!isValidEmail(email)) {
            await ctx.reply('Пожалуйста, введите корректный email.');
            return;
        }
        session.temp.email = email;
        session.lastEmail = email;
        session.state = 'register_password';
        saveSessions();
        await ctx.reply('Введите пароль для регистрации (минимум 6 символов):');
        return;
    }

    if (session.state === 'register_password') {
        const password = text.trim();
        const email = session.temp.email;
        if (!email) {
            session.state = 'register_email';
            saveSessions();
            await ctx.reply('Сначала укажите email.');
            return;
        }
        if (password.length < 6) {
            await ctx.reply('Пароль должен содержать не менее 6 символов.');
            return;
        }
        await registerUser(ctx, session, { email, password });
        return;
    }

    if (session.state === 'await_confirmation') {
        await ctx.reply('После подтверждения email нажмите кнопку «Я подтвердил почту» или команду /confirmed.');
        return;
    }

    if (session.state === 'chatting' && session.currentChatId) {
        await sendMessageToChat(ctx, session, text);
        return;
    }

    await ctx.reply('Я не понял команду. Используйте /menu для возврата в главное меню.');
});

bot.catch((err, ctx) => {
    console.error(`Bot error for ${ctx.updateType}`, err);
});

bot.launch().then(() => {
    console.log('Matching bot started');
    notificationService = createNotificationServiceFromEnv(bot);
});

process.once('SIGINT', () => {
    if (notificationService) notificationService.stop();
    bot.stop('SIGINT');
});
process.once('SIGTERM', () => {
    if (notificationService) notificationService.stop();
    bot.stop('SIGTERM');
});
//