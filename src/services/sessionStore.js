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
        const tgId = ctx.from?.id;
        return this.getSessionByChatId(tgId);
    }

    getSessionByChatId(chatId) {
        if (!chatId) {
            return { ...this.defaultSession };
        }
        if (!this.sessions[chatId]) {
            this.sessions[chatId] = { ...this.defaultSession };
            this.persist();
        }
        return this.sessions[chatId];
    }

    saveUserJwt(chatId, jwt, { userId, email } = {}) {
        const key = chatId;
        logger.info('session.saveJwt', { key });
        const session = this.getSessionByChatId(chatId);
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

        const existingLoginState = getLoggedIn(chatId) || {};
        const resolvedUserId = userId ?? existingLoginState.userId ?? session.backendUserId;
        const resolvedEmail = email ?? existingLoginState.email ?? session.lastEmail;
        const resolvedJwt = jwt ?? existingLoginState.jwt ?? session.token;

        setLoggedIn(chatId, {
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

    setPendingMagicLink(chatId, email) {
        setPendingMagicLink(chatId, email);
    }

    clearPendingMagicLink(chatId) {
        clearPendingMagicLink(chatId);
    }

    clearSessionAuth(session, chatId) {
        if (!session) return;
        session.token = null;
        session.backendUserId = null;
        this.persist();
        resetLoginState(chatId);
    }
}

export default SessionStore;
