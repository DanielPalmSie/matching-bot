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
        console.log('[Mercure] Subscribing to topic:', topic);

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

        if (payload.type === 'login_success') {
            console.log('[Mercure] login_success event received for chatId', chatId);

            if (typeof this.onUserLoggedIn === 'function') {
                this.onUserLoggedIn({
                    chatId: String(chatId),
                    jwt: payload.jwt,
                    email: payload.email,
                    userId: payload.user_id ?? payload.userId,
                });
            }
            return;
        }

        if (payload.type === 'user_logged_in') {
            console.log('[Mercure] user_logged_in event received for chatId', chatId);

            const payloadChatId = payload.chat_id ?? payload.chatId;
            if (String(payloadChatId) !== String(chatId)) {
                console.log('[Mercure] ChatId mismatch, skipping');
                return;
            }

            if (typeof this.onUserLoggedIn === 'function') {
                this.onUserLoggedIn({
                    chatId: String(chatId),
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