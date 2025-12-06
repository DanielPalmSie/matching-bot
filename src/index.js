import { Telegraf, Markup } from 'telegraf';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const botToken = process.env.BOT_TOKEN;
const apiUrl = process.env.API_URL || 'https://matchinghub.work/api';

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
};

const sessionStore = fs.existsSync(sessionFile)
    ? JSON.parse(fs.readFileSync(sessionFile, 'utf8'))
    : {};

const bot = new Telegraf(botToken);

function saveSessions() {
    fs.writeFileSync(sessionFile, JSON.stringify(sessionStore, null, 2));
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

function resetState(session) {
    session.state = null;
    session.temp = {};
    session.currentChatId = null;
}

function getFriendlyError(error) {
    if (error.response) {
        if (error.response.status === 401 || error.response.status === 403) {
            return 'Неверный логин или пароль. Попробуйте ещё раз.';
        }
        if (error.response.data) {
            if (typeof error.response.data === 'string') return error.response.data;
            if (error.response.data.message) return error.response.data.message;
            if (error.response.data.error) return error.response.data.error;
            if (error.response.data.violations) {
                return error.response.data.violations
                    .map((v) => `${v.propertyPath}: ${v.message}`)
                    .join('\n');
            }
        }
        return `Ошибка ${error.response.status}: попробуйте позже.`;
    }
    if (error.request) {
        return 'Не удалось связаться с сервером. Проверьте соединение или попробуйте позже.';
    }
    return 'Сейчас что-то пошло не так. Попробуйте позже.';
}

async function apiRequest(method, url, data, token) {
    try {
        const res = await axios({
            method,
            url: `${apiUrl}${url}`,
            data,
            headers: token ? { Authorization: `Bearer ${token}` } : undefined,
            timeout: 10000,
        });
        return res.data;
    } catch (error) {
        throw new Error(getFriendlyError(error));
    }
}

const mainMenuKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔍 Найти запросы', 'menu:recommendations')],
    [Markup.button.callback('📨 Мои запросы', 'menu:requests')],
    [Markup.button.callback('💬 Мои чаты', 'menu:chats')],
]);

function showAuthMenu(ctx) {
    return ctx.reply(
        'Привет! Я matching-бот 🤝\nВойдите или зарегистрируйтесь, чтобы продолжить.',
        Markup.inlineKeyboard([
            [Markup.button.callback('Войти', 'auth:login')],
            [Markup.button.callback('Зарегистрироваться', 'auth:register')],
        ])
    );
}

function showMainMenu(ctx) {
    const session = getSession(ctx);
    resetState(session);
    saveSessions();
    return ctx.reply('Главное меню', mainMenuKeyboard);
}

async function handleLogin(ctx, session, email, password) {
    try {
        const data = await apiRequest('post', '/login', { email, password }, null);
        session.token = data?.token || data?.jwt || null;
        session.refreshToken = data?.refresh_token || null;
        session.backendUserId = data?.user?.id || data?.id || null;
        resetState(session);
        saveSessions();
        await ctx.reply('✅ Успешный вход.');
        return showMainMenu(ctx);
    } catch (error) {
        resetState(session);
        saveSessions();
        return ctx.reply(error.message || 'Неверный логин или пароль. Попробуйте ещё раз.');
    }
}

async function handleRegister(ctx, session, name, email, password) {
    try {
        const payload = { email, password };
        if (name) payload.name = name;
        await apiRequest('post', '/register', payload, null);
        await ctx.reply('🎉 Регистрация прошла успешно. Выполняю вход...');
        return handleLogin(ctx, session, email, password);
    } catch (error) {
        resetState(session);
        saveSessions();
        return ctx.reply(error.message || 'Не удалось завершить регистрацию.');
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
    const text = [
        `📝 ${item.title || item.name || 'Запрос'}`,
        item.description ? `Описание: ${item.description}` : null,
        item.category ? `Категория: ${item.category}` : null,
        item.city ? `Город: ${item.city}` : null,
    ]
        .filter(Boolean)
        .join('\n');

    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('Хочу связаться', `reco:contact:${item.id}`)],
        [Markup.button.callback('Следующая', 'reco:next')],
        [Markup.button.callback('⬅️ В меню', 'menu:main')],
    ]);

    await ctx.reply(text, keyboard);
}

async function loadRecommendations(ctx, session) {
    try {
        const data = await apiRequest('get', '/requests/recommendations', null, session.token);
        session.temp.recommendations = Array.isArray(data) ? data : data?.items || [];
        session.temp.recommendationIndex = 0;
        saveSessions();
        if (!session.temp.recommendations.length) {
            await ctx.reply('Пока нет рекомендаций. Попробуйте позже.');
            return;
        }
        await sendRecommendation(ctx, session);
    } catch (error) {
        await ctx.reply(error.message || 'Не удалось загрузить рекомендации.');
    }
}

async function createContactRequest(ctx, session, requestId) {
    try {
        await apiRequest('post', `/requests/${requestId}/contact`, {}, session.token);
        await ctx.reply('Запрос отправлен. Теперь автор карточки может принять или отклонить контакт.');
    } catch (error) {
        await ctx.reply(error.message || 'Не удалось отправить запрос на контакт.');
    }
}

async function loadRequests(ctx, session) {
    try {
        const incoming = await apiRequest('get', '/requests/incoming', null, session.token);
        const outgoing = await apiRequest('get', '/requests/outgoing', null, session.token);

        const incomingList = Array.isArray(incoming) ? incoming : incoming?.items || [];
        const outgoingList = Array.isArray(outgoing) ? outgoing : outgoing?.items || [];

        if (!incomingList.length && !outgoingList.length) {
            await ctx.reply('Запросов пока нет.');
            return;
        }

        if (incomingList.length) {
            await ctx.reply('Входящие запросы:');
            for (const req of incomingList) {
                const text = `• ${req.title || req.name || 'Запрос'}${req.from ? ` от ${req.from}` : ''}`;
                const kb = Markup.inlineKeyboard([
                    Markup.button.callback('Принять', `req:accept:${req.id}`),
                    Markup.button.callback('Отклонить', `req:decline:${req.id}`),
                ]);
                await ctx.reply(text, kb);
            }
        }

        if (outgoingList.length) {
            await ctx.reply('Исходящие запросы:');
            for (const req of outgoingList) {
                const status = req.status || 'ожидание';
                const text = `• ${req.title || req.name || 'Запрос'} — статус: ${status}`;
                await ctx.reply(text);
            }
        }
    } catch (error) {
        await ctx.reply(error.message || 'Не удалось получить список запросов.');
    }
}

async function decideRequest(ctx, session, requestId, action) {
    try {
        await apiRequest('post', `/requests/${requestId}/${action}`, {}, session.token);
        await ctx.reply('Решение сохранено. Загружаю обновлённые запросы...');
        await loadRequests(ctx, session);
    } catch (error) {
        await ctx.reply(error.message || 'Не удалось обработать запрос.');
    }
}

async function loadChats(ctx, session) {
    try {
        const chats = await apiRequest('get', '/chats', null, session.token);
        const chatList = Array.isArray(chats) ? chats : chats?.items || [];
        if (!chatList.length) {
            await ctx.reply('Чатов пока нет.');
            return;
        }
        const keyboard = chatList.map((c) => [Markup.button.callback(c.title || c.name || `Чат ${c.id}`, `chat:open:${c.id}`)]);
        await ctx.reply('Ваши чаты:', Markup.inlineKeyboard(keyboard));
    } catch (error) {
        await ctx.reply(error.message || 'Не удалось загрузить чаты.');
    }
}

async function showChat(ctx, session, chatId) {
    try {
        const messages = await apiRequest('get', `/chats/${chatId}/messages`, null, session.token);
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
        await ctx.reply('Вы в режиме чата. Напишите сообщение или нажмите кнопку для выхода.', Markup.inlineKeyboard([
            [Markup.button.callback('⬅️ В меню', 'menu:main')],
        ]));
    } catch (error) {
        await ctx.reply(error.message || 'Не удалось открыть чат.');
    }
}

async function sendMessageToChat(ctx, session, text) {
    try {
        await apiRequest('post', `/chats/${session.currentChatId}/messages`, { content: text }, session.token);
        await ctx.reply('Сообщение отправлено.');
    } catch (error) {
        await ctx.reply(error.message || 'Не удалось отправить сообщение.');
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

bot.command('ping', async (ctx) => {
    try {
        const res = await axios.get(`${apiUrl}/docs`, { timeout: 5000 }).catch(() => null);
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
    await ctx.reply('Введите email для входа:');
});

bot.action('auth:register', async (ctx) => {
    const session = getSession(ctx);
    session.state = 'register_name';
    session.temp = {};
    saveSessions();
    await ctx.answerCbQuery();
    await ctx.reply('Введите ваше имя (можете пропустить и отправить пустое сообщение):');
});

bot.action('menu:main', async (ctx) => {
    await ctx.answerCbQuery();
    return showMainMenu(ctx);
});

bot.action('menu:recommendations', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const session = getSession(ctx);
    await ctx.answerCbQuery();
    await loadRecommendations(ctx, session);
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
    const requestId = ctx.match[1];
    await ctx.answerCbQuery();
    await createContactRequest(ctx, session, requestId);
});

bot.action('menu:requests', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const session = getSession(ctx);
    await ctx.answerCbQuery();
    await loadRequests(ctx, session);
});

bot.action(/req:(accept|decline):(.+)/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const action = ctx.match[1];
    const id = ctx.match[2];
    const session = getSession(ctx);
    await ctx.answerCbQuery();
    await decideRequest(ctx, session, id, action === 'accept' ? 'accept' : 'decline');
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
        session.temp.email = text.trim();
        session.state = 'login_password';
        saveSessions();
        await ctx.reply('Введите пароль:');
        return;
    }

    if (session.state === 'login_password') {
        const email = session.temp.email;
        const password = text.trim();
        await handleLogin(ctx, session, email, password);
        return;
    }

    if (session.state === 'register_name') {
        session.temp.name = text.trim();
        session.state = 'register_email';
        saveSessions();
        await ctx.reply('Введите email:');
        return;
    }

    if (session.state === 'register_email') {
        session.temp.email = text.trim();
        session.state = 'register_password';
        saveSessions();
        await ctx.reply('Введите пароль:');
        return;
    }

    if (session.state === 'register_password') {
        const { name, email } = session.temp;
        const password = text.trim();
        await handleRegister(ctx, session, name, email, password);
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
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
