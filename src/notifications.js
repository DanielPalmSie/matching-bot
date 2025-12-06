import axios from 'axios';
import { API_ROUTES } from './config/apiRoutes.js';

const DEFAULT_MERCURE_TOPICS = ['/chats/*'];
const DEFAULT_HUB_URL = 'https://matchinghub.work/.well-known/mercure';
const PARTICIPANT_CACHE_TTL_MS = 5 * 60 * 1000;

function buildApiUrl(apiUrl, pathname) {
    const base = apiUrl.replace(/\/+$/, '');
    if (!pathname) return base;
    const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
    if (base.endsWith('/api') && normalizedPath.startsWith('/api')) {
        return `${base}${normalizedPath.replace(/^\/api/, '')}`;
    }
    return `${base}${normalizedPath}`;
}

class ParticipantsCache {
    constructor(ttlMs = PARTICIPANT_CACHE_TTL_MS) {
        this.ttlMs = ttlMs;
        this.cache = new Map();
    }

    get(chatId) {
        const entry = this.cache.get(chatId);
        if (entry && entry.expiresAt > Date.now()) {
            return entry.participants;
        }
        this.cache.delete(chatId);
        return null;
    }

    set(chatId, participants) {
        this.cache.set(chatId, {
            participants,
            expiresAt: Date.now() + this.ttlMs,
        });
    }
}

export class MercureNotificationService {
    constructor(options) {
        this.bot = options.bot;
        this.apiUrl = options.apiUrl;
        this.apiToken = options.apiToken;
        this.mercureJwt = options.mercureJwt;
        this.hubUrl = options.hubUrl || DEFAULT_HUB_URL;
        this.topics = options.topics?.length ? options.topics : DEFAULT_MERCURE_TOPICS;
        this.resolveTelegramChatId = options.resolveTelegramChatId;
        this.participantsCache = new ParticipantsCache();
        this.running = false;
        this.reconnectDelayMs = 3000;
    }

    async start() {
        if (!this.mercureJwt) {
            console.warn('MERCURE_JWT is not set. Real-time notifications are disabled.');
            return;
        }
        if (!globalThis.fetch) {
            console.warn('Global fetch is not available. Real-time notifications are disabled.');
            return;
        }
        this.running = true;
        this.subscribe();
    }

    stop() {
        this.running = false;
        if (this.abortController) {
            this.abortController.abort();
        }
    }

    buildHubUrl() {
        const params = new URLSearchParams();
        this.topics.forEach((topic) => params.append('topic', topic));
        const separator = this.hubUrl.includes('?') ? '&' : '?';
        return `${this.hubUrl}${separator}${params.toString()}`;
    }

    async subscribe() {
        if (!this.running) return;

        const hubUrl = this.buildHubUrl();
        this.abortController = new AbortController();

        try {
            const response = await fetch(hubUrl, {
                method: 'GET',
                headers: {
                    Accept: 'text/event-stream',
                    Authorization: `Bearer ${this.mercureJwt}`,
                },
                signal: this.abortController.signal,
            });

            if (!response.ok || !response.body) {
                throw new Error(`Failed to connect to Mercure hub: ${response.status} ${response.statusText}`);
            }

            await this.consumeStream(response.body.getReader());
        } catch (error) {
            if (!this.running) return;
            console.error('Mercure connection error. Reconnecting...', error.message || error);
            setTimeout(() => this.subscribe(), this.reconnectDelayMs);
        }
    }

    async consumeStream(reader) {
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        while (this.running) {
            const { done, value } = await reader.read();
            if (done) {
                throw new Error('Mercure stream closed');
            }

            buffer += decoder.decode(value, { stream: true });
            let separatorIndex;

            while ((separatorIndex = buffer.indexOf('\n\n')) !== -1) {
                const rawEvent = buffer.slice(0, separatorIndex);
                buffer = buffer.slice(separatorIndex + 2);
                this.handleRawEvent(rawEvent);
            }
        }
    }

    handleRawEvent(rawEvent) {
        const dataLines = [];
        rawEvent.split('\n').forEach((line) => {
            const trimmed = line.trim();
            if (trimmed.startsWith('data:')) {
                dataLines.push(trimmed.slice(5).trimStart());
            }
        });

        if (!dataLines.length) {
            return;
        }

        const dataString = dataLines.join('\n');
        try {
            const payload = JSON.parse(dataString);
            this.dispatchEvent(payload);
        } catch (error) {
            console.warn('Failed to parse Mercure event payload', error, dataString);
        }
    }

    async dispatchEvent(payload) {
        if (!payload) return;

        if (payload.type === 'read') {
            await this.handleReadEvent(payload);
            return;
        }

        if (payload.id && payload.chatId) {
            await this.handleMessageEvent(payload);
        }
    }

    async handleMessageEvent(message) {
        const chatId = message.chatId;
        const senderId = message.senderId;
        const participants = await this.getParticipants(chatId);
        if (!participants) return;

        const recipients = participants
            .map((p) => p.id)
            .filter((id) => Number(id) !== Number(senderId));

        const text = `New message in chat ${chatId} from user ${senderId}: ${message.content}`;
        await Promise.all(recipients.map((userId) => this.notifyUser(userId, text)));
    }

    async handleReadEvent(readEvent) {
        const chatId = readEvent.chatId;
        if (!chatId) {
            console.warn('Read event received without chatId', readEvent);
            return;
        }

        const participants = await this.getParticipants(chatId);
        if (!participants) return;

        const recipients = participants
            .map((p) => p.id)
            .filter((id) => Number(id) !== Number(readEvent.userId));

        const text = `User ${readEvent.userId} marked message ${readEvent.messageId} as read in chat ${chatId}.`;
        await Promise.all(recipients.map((userId) => this.notifyUser(userId, text)));
    }

    async getParticipants(chatId) {
        const cached = this.participantsCache.get(chatId);
        if (cached) return cached;

        try {
            const response = await axios.get(buildApiUrl(this.apiUrl, API_ROUTES.CHAT_PARTICIPANTS(chatId)), {
                headers: this.apiToken
                    ? {
                          Authorization: `Bearer ${this.apiToken}`,
                      }
                    : undefined,
                timeout: 10000,
            });

            const participants = Array.isArray(response.data)
                ? response.data
                : response.data?.items || response.data?.participants || [];

            this.participantsCache.set(chatId, participants);
            return participants;
        } catch (error) {
            console.error('Failed to load chat participants', chatId, error.message || error);
            return null;
        }
    }

    async notifyUser(userId, text) {
        if (!this.bot || !this.resolveTelegramChatId) return false;
        const tgChatId = this.resolveTelegramChatId(userId);
        if (!tgChatId) {
            return false;
        }
        try {
            await this.bot.telegram.sendMessage(tgChatId, text);
            return true;
        } catch (error) {
            console.error(`Failed to notify Telegram user ${tgChatId} for backend user ${userId}`, error);
            return false;
        }
    }
}

export function initMercureNotifications(options) {
    const service = new MercureNotificationService(options);
    service.start();
    return service;
}

export function createNotificationServiceFromEnv(bot, resolveTelegramChatId) {
    const topics = process.env.MERCURE_TOPICS
        ? process.env.MERCURE_TOPICS.split(',').map((t) => t.trim()).filter(Boolean)
        : DEFAULT_MERCURE_TOPICS;

    return initMercureNotifications({
        bot,
        apiUrl: process.env.API_URL || 'https://matchinghub.work',
        apiToken: process.env.SERVICE_API_TOKEN || process.env.BOT_SERVICE_TOKEN,
        mercureJwt: process.env.MERCURE_JWT,
        hubUrl: process.env.MERCURE_HUB_URL || DEFAULT_HUB_URL,
        topics,
        resolveTelegramChatId,
    });
}
