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
            this.handlePayload(key, payload);
        });

        this.subscriptions.set(key, unsubscribe);
        console.log('[Mercure] Subscription stored for chatId', key);
    }


    handlePayload(chatId, payload) {
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
            if (!payloadChatId) {
                console.log('[Mercure] login_success event missing chat id, skipping');
                return;
            }

            console.log('[Mercure] login_success event received for chatId', chatId);
            console.log('BOT LOGIN EVENT', {
                chatId: String(payloadChatId),
                backendUserId: payload.user_id ?? payload.userId ?? null,
                email: payload.email ?? null,
                timestamp: new Date().toISOString(),
            });

            if (typeof this.onUserLoggedIn === 'function') {
                this.onUserLoggedIn({
                    chatId: String(payloadChatId),
                    jwt: payload.jwt,
                    email: payload.email,
                    userId: payload.user_id ?? payload.userId,
                });
            }
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