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
            return;
        }

        const topic = `/tg/login/${key}`;
        const unsubscribe = this.mercureClient.subscribe(topic, (payload) => {
            this.handlePayload(key, payload);
        });
        this.subscriptions.set(key, unsubscribe);
    }

    handlePayload(chatId, payload) {
        if (!payload || !payload.type) return;

        if (payload.type === 'login_success') {
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
            const payloadChatId = payload.chat_id ?? payload.chatId;
            if (String(payloadChatId) !== String(chatId)) {
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