import MercureSseClient from './mercureSseClient.js';

export class LoginMercureSubscriber {
    constructor({ hubUrl, jwt, onUserLoggedIn }) {
        this.mercureClient = new MercureSseClient({ hubUrl, jwt });
        this.onUserLoggedIn = onUserLoggedIn;
        this.subscriptions = new Map(); // chatId -> unsubscribe
    }

    ensureSubscription(chatId) {
        if (!chatId) return;
        const key = String(chatId);
        if (this.subscriptions.has(key)) {
            console.log('[Mercure] Already subscribed for chatId', key);
            return;
        }

        const topic = `/tg/login/${key}`;
        console.log('BOT SUBSCRIBED', { topics: [topic], timestamp: new Date().toISOString() });

        const unsubscribe = this.mercureClient.subscribe(topic, (payload) => {
            console.log('[Mercure] Received raw payload for topic', topic, payload);
            this.handlePayload(key, payload, topic);
        });

        this.subscriptions.set(key, unsubscribe);
        console.log('[Mercure] Subscription stored for chatId', key);
    }


    handlePayload(chatId, payload, topic) {
        console.log('[Mercure] handlePayload called for chatId', chatId, 'payload:', payload);

        if (!payload || !payload.type) {
            console.log('[Mercure] Invalid payload, skipping');
            return;
        }

        const payloadChatId = payload.chat_id ?? payload.chatId ?? payload.telegram_chat_id;

        if (payloadChatId && String(payloadChatId) !== String(chatId)) {
            console.log('[Mercure] ChatId mismatch for payload; expected', chatId, 'got', payloadChatId, 'skipping');
            return;
        }

        if (payload.type === 'login_success') {
            console.log('[Mercure] BOT LOGIN EVENT', { chatId: String(chatId), topic, hasJwt: !!payload.jwt });

            if (!payload.jwt) {
                console.warn('[Mercure] login_success event without jwt, skipping');
                return;
            }

            console.log('[Mercure] BOT LOGIN STATE UPDATE', { chatId: String(chatId) });

            if (typeof this.onUserLoggedIn === 'function') {
                this.onUserLoggedIn({
                    chatId: String(chatId),
                    jwt: payload.jwt,
                    email: payload.email,
                    userId: payload.user_id ?? payload.userId,
                });
            }

            console.log('[Mercure] BOT SEND MENU DONE', { chatId: String(chatId) });
            return;
        }

        if (payload.type === 'user_logged_in') {
            console.log('[Mercure] user_logged_in event received for chatId', chatId);
            console.log('BOT LOGIN EVENT', {
                chatId: String(payloadChatId || chatId),
                backendUserId: payload.user_id ?? payload.userId ?? null,
                email: payload.email ?? null,
                timestamp: new Date().toISOString(),
            });

            if (typeof this.onUserLoggedIn === 'function') {
                this.onUserLoggedIn({
                    chatId: String(payloadChatId || chatId),
                    userId: payload.user_id ?? payload.userId,
                    email: payload.email,
                    jwt: payload.jwt,
                });
            }
        }
    }

    stop() {
        this.subscriptions.forEach((unsubscribe) => unsubscribe());
        this.subscriptions.clear();
        this.mercureClient.stop();
    }
}

export default LoginMercureSubscriber;
//