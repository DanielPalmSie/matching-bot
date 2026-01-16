import MercureSseClient from './mercureSseClient.js';
import { getTelegramUserIdFromPayload, getTokenPrefix } from '../utils/telegramUserId.js';

const logger = console;

export class LoginMercureSubscriber {
    constructor({ hubUrl, jwt, onUserLoggedIn }) {
        this.mercureClient = new MercureSseClient({ hubUrl, jwt });
        this.onUserLoggedIn = onUserLoggedIn;
        this.subscriptions = new Map(); // telegramUserId -> unsubscribe
    }

    ensureSubscription(telegramUserId) {
        if (!telegramUserId) return;
        const key = String(telegramUserId);
        if (this.subscriptions.has(key)) {
            console.log('[Mercure] Already subscribed for telegramUserId', key);
            return;
        }

        const topic = `/tg/login/${key}`;
        console.log('BOT SUBSCRIBED', { topics: [topic], timestamp: new Date().toISOString() });

        const unsubscribe = this.mercureClient.subscribe(topic, (payload) => {
            console.log('[Mercure] Received raw payload for topic', topic, payload);
            this.handlePayload(key, payload, topic);
        });

        this.subscriptions.set(key, unsubscribe);
        console.log('[Mercure] Subscription stored for telegramUserId', key);
    }


    handlePayload(subscriptionKey, payload, topic) {
        const telegramUserId = getTelegramUserIdFromPayload(payload);
        const payloadChatId = payload.chat_id ?? payload.chatId ?? payload.telegram_chat_id;
        const resolvedTelegramUserId = telegramUserId ?? (payloadChatId ? String(payloadChatId) : null);
        if (!telegramUserId && payloadChatId) {
            console.warn('[Mercure] Missing telegramUserId in payload; using chatId fallback', {
                subscriptionKey,
                payloadChatId,
            });
        }
        logger.info('mercure.login.event', {
            telegramUserId: resolvedTelegramUserId,
            chatId: payloadChatId ?? null,
            hasJwt: !!payload?.jwt,
            jwtPrefix: getTokenPrefix(payload?.jwt),
        });
        console.log('[Mercure] handlePayload called for subscription', subscriptionKey, 'payload:', payload);

        if (!payload) {
            console.log('[Mercure] Invalid payload, skipping');
            return;
        }

        if (resolvedTelegramUserId && String(resolvedTelegramUserId) !== String(subscriptionKey)) {
            console.log('[Mercure] TelegramUserId mismatch for payload; expected', subscriptionKey, 'got', resolvedTelegramUserId, 'skipping');
            return;
        }

        console.log('[Mercure] BOT LOGIN EVENT', {
            telegramUserId: String(resolvedTelegramUserId || subscriptionKey),
            chatId: String(payloadChatId || ''),
            backendUserId: payload.user_id ?? payload.userId ?? null,
            email: payload.email ?? null,
            timestamp: new Date().toISOString(),
        });

        if (!payload.jwt) {
            console.warn('[Mercure] login event without jwt, skipping');
            return;
        }

        console.log('[Mercure] BOT LOGIN STATE UPDATE', { telegramUserId: String(subscriptionKey) });

        if (typeof this.onUserLoggedIn === 'function') {
            this.onUserLoggedIn({
                telegramUserId: String(resolvedTelegramUserId || subscriptionKey),
                chatId: payloadChatId ? String(payloadChatId) : null,
                jwt: payload.jwt,
                email: payload.email,
                userId: payload.user_id ?? payload.userId,
            });
        }

        console.log('[Mercure] BOT SEND MENU DONE', { telegramUserId: String(subscriptionKey) });
    }

    stop() {
        this.subscriptions.forEach((unsubscribe) => unsubscribe());
        this.subscriptions.clear();
        this.mercureClient.stop();
    }
}

export default LoginMercureSubscriber;
