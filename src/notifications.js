import MercureSseClient from './mercure/mercureSseClient.js';

const DEFAULT_HUB_URL = 'https://matchinghub.work/.well-known/mercure';

class ChatLiveNotificationService {
    constructor({ bot, mercureClient }) {
        this.bot = bot;
        this.mercureClient = mercureClient;
        this.telegramState = new Map(); // telegramChatId -> { backendUserId, activeChatId, subscriptions: Map<chatId, unsubscribe> }
    }

    stop() {
        this.telegramState.forEach((state) => {
            state.subscriptions.forEach((unsubscribe) => unsubscribe());
        });
        this.telegramState.clear();
        this.mercureClient.stop();
    }

    setBackendUserId(telegramChatId, backendUserId) {
        const state = this.ensureTelegramState(telegramChatId);
        state.backendUserId = backendUserId || null;
    }

    clearTelegramChat(telegramChatId) {
        const state = this.telegramState.get(telegramChatId);
        if (!state) return;
        state.subscriptions.forEach((unsubscribe) => unsubscribe());
        this.telegramState.delete(telegramChatId);
    }

    enterChatMode(telegramChatId, backendUserId, chatId) {
        if (!telegramChatId || !chatId) return;
        this.setBackendUserId(telegramChatId, backendUserId);
        const state = this.ensureTelegramState(telegramChatId);
        state.activeChatId = chatId;
        this.ensureChatSubscription(state, telegramChatId, chatId);
    }

    leaveChatMode(telegramChatId) {
        const state = this.telegramState.get(telegramChatId);
        if (!state) return;
        state.activeChatId = null;
    }

    ensureChatSubscription(state, telegramChatId, chatId) {
        if (state.subscriptions.has(chatId)) {
            return;
        }
        const topic = `/chats/${chatId}`;
        const unsubscribe = this.mercureClient.subscribe(topic, (payload) => {
            this.handleChatPayload(telegramChatId, chatId, payload);
        });
        state.subscriptions.set(chatId, unsubscribe);
    }

    ensureTelegramState(telegramChatId) {
        if (!this.telegramState.has(telegramChatId)) {
            this.telegramState.set(telegramChatId, {
                backendUserId: null,
                activeChatId: null,
                subscriptions: new Map(),
            });
        }
        return this.telegramState.get(telegramChatId);
    }

    async handleChatPayload(telegramChatId, chatId, payload) {
        const state = this.telegramState.get(telegramChatId) || this.ensureTelegramState(telegramChatId);
        if (!payload) return;

        if (Number(payload.senderId) === Number(state.backendUserId)) {
            // Do not echo the sender's own messages back to them.
            return;
        }

        if (!payload.content) {
            return;
        }

        const prefix = 'Собеседник: ';
        const messageText = `${prefix}${payload.content}`;
        try {
            await this.bot.telegram.sendMessage(telegramChatId, messageText);
        } catch (error) {
            console.error(`Failed to deliver Mercure message to Telegram chat ${telegramChatId} for chat ${chatId}`, error);
        }
    }
}

export function createNotificationServiceFromEnv(bot) {
    const hubUrl = process.env.MERCURE_HUB_URL || DEFAULT_HUB_URL;
    const mercureJwt = process.env.MERCURE_SUBSCRIBER_JWT || process.env.MERCURE_JWT;

    const mercureClient = new MercureSseClient({ hubUrl, jwt: mercureJwt });

    return new ChatLiveNotificationService({ bot, mercureClient });
}

export async function sendNewMessageNotification({ bot, payload, logger = console }) {
    const { telegramChatId, chatId, senderDisplayName, textPreview, messageId } = payload || {};
    if (!bot) {
        logger.warn('[telegram] new-message notify skipped', {
            reason: 'bot_not_initialized',
            telegramChatId,
            chatId,
            messageId,
        });
        return;
    }

    if (!telegramChatId) {
        logger.warn('[telegram] new-message notify skipped', {
            reason: 'missing_telegramChatId',
            telegramChatId,
            chatId,
            messageId,
        });
        return;
    }

    const messageText = `📩 Новое сообщение от ${senderDisplayName}\n\n${textPreview}`;
    const callbackData = `chat:open:${chatId}`;

    try {
        logger.info('[telegram] new-message notify attempt', {
            telegramChatId,
            chatId,
            messageId,
        });
        const result = await bot.telegram.sendMessage(telegramChatId, messageText, {
            reply_markup: {
                inline_keyboard: [[{ text: 'Открыть чат', callback_data: callbackData }]],
            },
        });
        logger.info('[telegram] new-message notify sent', {
            telegramChatId,
            chatId,
            messageId,
            telegramMessageId: result?.message_id,
        });
    } catch (error) {
        const response = error?.response;
        logger.error('[telegram] new-message notify failed', {
            telegramChatId,
            chatId,
            messageId,
            httpStatus: response?.status || response?.statusCode,
            telegramErrorCode: response?.error_code || response?.errorCode || response?.body?.error_code,
            error: { message: error?.message },
        });
    }
}

export { ChatLiveNotificationService };