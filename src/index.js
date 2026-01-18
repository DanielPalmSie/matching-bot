import { Telegraf } from 'telegraf';
import { API_ROUTES } from './config/apiRoutes.js';
import { createNotificationServiceFromEnv } from './notifications.js';
import { startInternalServer } from './internal/server.js';
import LoginMercureSubscriber from './mercure/loginSubscriber.js';
import { getLoggedIn, setLoggedIn } from './auth/loginState.js';
import SessionStore from './services/sessionStore.js';
import ApiClient, { ApiError } from './services/apiClient.js';
import GeoClient from './services/geoClient.js';
import { formatMatchMessage, formatRequestSummary } from './utils/messageFormatter.js';
import { getTelegramUserIdFromContext, getTokenPrefix } from './utils/telegramUserId.js';
import { MAIN_MENU_KEYBOARD, NEGATIVE_REASON_OPTIONS, GEO_SELECTION_TTL_MS } from './bot/constants.js';
import { createSessionHelpers } from './bot/session.js';
import { createErrorHandlers } from './bot/errors.js';
import { createAuthHandlers } from './bot/auth.js';
import { createMenu } from './bot/menu.js';
import { createGeoHelpers } from './bot/geo.js';
import { createRequestHandlers } from './bot/requests.js';
import { createMatchHandlers } from './bot/matches.js';
import { createChatHandlers } from './bot/chats.js';
import { createLoginHandler } from './bot/login.js';
import { createStartFlow } from './bot/startFlow.js';
import { registerBotHandlers } from './bot/handlers.js';

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
const geoClient = new GeoClient({ apiClient, logger });
const sessionStore = new SessionStore();
const bot = new Telegraf(botToken);
let notificationService = null;
let loginMercureSubscriber = null;
let internalServer = null;

const getNotificationService = () => notificationService;
const getLoginMercureSubscriber = () => loginMercureSubscriber;

const sessionHelpers = createSessionHelpers({
    sessionStore,
    logger,
    getNotificationService,
    getTelegramUserIdFromContext,
    getTokenPrefix,
    getLoggedIn,
    setLoggedIn,
});

const { handleApiError } = createErrorHandlers({
    ApiError,
    resolveTelegramUserId: sessionHelpers.resolveTelegramUserId,
    clearSessionAuth: sessionHelpers.clearSessionAuth,
});

const menu = createMenu({ bot, logger, MAIN_MENU_KEYBOARD });
const startFlow = createStartFlow({
    sessionStore,
    getLoggedIn,
    setLoggedIn,
    menu,
    logger,
});

const authHandlers = createAuthHandlers({
    apiRequest: (method, url, data, token) => apiClient.request(method, url, data, token),
    sessionStore,
    logSessionContext: sessionHelpers.logSessionContext,
    resetState: sessionHelpers.resetState,
    resolveTelegramUserId: sessionHelpers.resolveTelegramUserId,
    getLoginMercureSubscriber,
    logger,
    ApiError,
    API_ROUTES,
});

const geoHelpers = createGeoHelpers({ sessionStore, ApiError, GEO_SELECTION_TTL_MS });

const requestHandlers = createRequestHandlers({
    apiRequest: (method, url, data, token) => apiClient.request(method, url, data, token),
    sessionStore,
    ApiError,
    API_ROUTES,
    MAIN_MENU_KEYBOARD,
    handleApiError,
    ensureTelegramUserId: sessionHelpers.ensureTelegramUserId,
    formatRequestSummary,
});

const chatHandlers = createChatHandlers({
    apiRequest: (method, url, data, token) => apiClient.request(method, url, data, token),
    ApiError,
    API_ROUTES,
    handleApiError,
    ensureTelegramUserId: sessionHelpers.ensureTelegramUserId,
    enterChatState: sessionHelpers.enterChatState,
    leaveChatState: sessionHelpers.leaveChatState,
    sessionStore,
});

const matchHandlers = createMatchHandlers({
    apiRequest: (method, url, data, token) => apiClient.request(method, url, data, token),
    ApiError,
    API_ROUTES,
    NEGATIVE_REASON_OPTIONS,
    handleApiError,
    ensureTelegramUserId: sessionHelpers.ensureTelegramUserId,
    formatMatchMessage,
    sessionStore,
    enterChatState: sessionHelpers.enterChatState,
});

const { handleUserLoggedInEvent } = createLoginHandler({
    logger,
    apiRequest: (method, url, data, token) => apiClient.request(method, url, data, token),
    API_ROUTES,
    getTokenPrefix,
    getSessionByTelegramUserId: sessionHelpers.getSessionByTelegramUserId,
    saveUserJwt: sessionHelpers.saveUserJwt,
    resetState: sessionHelpers.resetState,
    sessionStore,
    bot,
    MAIN_MENU_KEYBOARD,
});

registerBotHandlers({
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
});

loginMercureSubscriber = new LoginMercureSubscriber({
    hubUrl: mercureHubUrl,
    jwt: mercureJwt,
    onUserLoggedIn: handleUserLoggedInEvent,
});

bot.launch().then(() => {
    console.log('Matching bot started');
    notificationService = createNotificationServiceFromEnv(bot);
    internalServer = startInternalServer({ bot, logger });
});

process.once('SIGINT', () => {
    if (notificationService) notificationService.stop();
    if (loginMercureSubscriber) loginMercureSubscriber.stop();
    if (internalServer) internalServer.close();
    bot.stop('SIGINT');
});
process.once('SIGTERM', () => {
    if (notificationService) notificationService.stop();
    if (loginMercureSubscriber) loginMercureSubscriber.stop();
    if (internalServer) internalServer.close();
    bot.stop('SIGTERM');
});
//