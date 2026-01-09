import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    clearPendingMagicLink,
    getLoggedIn,
    resetLoginState,
    setLoggedIn,
    setPendingMagicLink,
} from '../auth/loginState.js';
import { getTelegramUserIdFromContext, getTokenPrefix } from '../utils/telegramUserId.js';

const logger = console;

export class SessionStore {
    constructor({ dataDir = '../../data', fileName = 'sessions.json' } = {}) {
        this.filePath = this.resolveFilePath(dataDir, fileName);
        this.defaultSession = {
            state: null,
            temp: {},
            lastEmail: null,
        };
        this.sessions = this.loadSessions();
    }

    resolveFilePath(dataDir, fileName) {
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        const dir = path.resolve(__dirname, dataDir);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        return path.join(dir, fileName);
    }

    loadSessions() {
        if (!fs.existsSync(this.filePath)) {
            return {};
        }
        try {
            const raw = fs.readFileSync(this.filePath, 'utf8');
            return JSON.parse(raw);
        } catch (error) {
            console.warn('Failed to parse sessions file, starting fresh', error);
            return {};
        }
    }

    persist() {
        fs.writeFileSync(this.filePath, JSON.stringify(this.sessions, null, 2));
    }

    getSession(ctx) {
        const telegramUserId = getTelegramUserIdFromContext(ctx);
        return this.getSessionByTelegramUserId(telegramUserId);
    }

    getSessionByTelegramUserId(telegramUserId) {
        if (!telegramUserId) {
            return { ...this.defaultSession };
        }
        if (!this.sessions[telegramUserId]) {
            this.sessions[telegramUserId] = { ...this.defaultSession };
            this.persist();
        }
        return this.sessions[telegramUserId];
    }

    saveUserJwt(telegramUserId, jwt, { userId, email, chatId } = {}) {
        logger.info('session.saveJwt', {
            telegramUserId,
            chatId,
            tokenPrefix: getTokenPrefix(jwt),
        });
        const session = this.getSessionByTelegramUserId(telegramUserId);
        if (jwt) {
            session.token = jwt;
        }
        if (userId) {
            session.backendUserId = userId;
        }
        if (email) {
            session.lastEmail = email;
        }
        this.persist();

        const existingLoginState = getLoggedIn(telegramUserId) || {};
        const resolvedUserId = userId ?? existingLoginState.userId ?? session.backendUserId;
        const resolvedEmail = email ?? existingLoginState.email ?? session.lastEmail;
        const resolvedJwt = jwt ?? existingLoginState.jwt ?? session.token;

        setLoggedIn(telegramUserId, {
            userId: resolvedUserId,
            email: resolvedEmail,
            jwt: resolvedJwt,
        });
    }

    resetState(session) {
        session.state = null;
        session.temp = {};
        this.persist();
    }

    resetCreateRequestState(session) {
        if (!session) return;
        session.state = null;
        if (session.temp) {
            delete session.temp.createRequest;
        }
        session.currentChatId = null;
        this.persist();
    }

    getCreateTemp(session) {
        if (!session.temp) {
            session.temp = {};
        }
        if (!session.temp.createRequest) {
            session.temp.createRequest = {};
        }
        return session.temp.createRequest;
    }

    setPendingMagicLink(telegramUserId, email) {
        setPendingMagicLink(telegramUserId, email);
    }

    clearPendingMagicLink(telegramUserId) {
        clearPendingMagicLink(telegramUserId);
    }

    clearSessionAuth(session, telegramUserId) {
        if (!session) return;
        session.token = null;
        session.backendUserId = null;
        this.persist();
        resetLoginState(telegramUserId);
    }
}

export default SessionStore;
