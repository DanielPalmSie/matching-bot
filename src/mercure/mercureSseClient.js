import EventEmitter from 'events';

const DEFAULT_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 20000;

function buildHubUrl(baseUrl, topics) {
    const url = new URL(baseUrl);
    topics.forEach((topic) => url.searchParams.append('topic', topic));
    return url.toString();
}

/**
 * MercureSseClient maintains a single SSE connection to the Mercure hub
 * and dispatches events to topic subscribers. It reconnects automatically
 * with exponential backoff when the stream is interrupted.
 */
export class MercureSseClient extends EventEmitter {
    constructor({ hubUrl, jwt, backoffMs = DEFAULT_BACKOFF_MS, maxBackoffMs = MAX_BACKOFF_MS } = {}) {
        super();
        this.hubUrl = hubUrl;
        this.jwt = jwt;
        this.backoffMs = backoffMs;
        this.maxBackoffMs = maxBackoffMs;
        this.topics = new Map(); // topic -> Set<subscriptionId>
        this.subscriptionHandlers = new Map(); // subscriptionId -> handler
        this.subscriptionTopics = new Map(); // subscriptionId -> topic
        this.connectionActive = false;
        this.currentBackoff = backoffMs;
        this.abortController = null;
        this.reader = null;
        this.subscriptionCounter = 0;
        this.streamGeneration = 0;
        this.activeGeneration = null;
        this.restartTimer = null;
        this.pendingRestartReason = null;
        this.restartDelayMs = 200;
    }

    subscribe(topic, handler) {
        if (!topic || typeof handler !== 'function') {
            throw new Error('topic and handler are required for Mercure subscription');
        }

        const subscriptionId = `sub-${++this.subscriptionCounter}`;
        if (!this.topics.has(topic)) {
            this.topics.set(topic, new Set());
        }
        this.topics.get(topic).add(subscriptionId);
        this.subscriptionHandlers.set(subscriptionId, handler);
        this.subscriptionTopics.set(subscriptionId, topic);

        console.log('TOPIC_ADDED', {
            topic,
            totalTopics: this.topics.size,
            reason: 'subscribe',
            subscriptionId,
            timestamp: new Date().toISOString(),
        });

        if (this.connectionActive) {
            this.scheduleRestart('topic_added');
        } else {
            this.ensureConnection();
        }

        return () => {
            this.unsubscribe(subscriptionId);
        };
    }

    unsubscribe(subscriptionId) {
        const topic = this.subscriptionTopics.get(subscriptionId);
        if (topic && this.topics.has(topic)) {
            this.topics.get(topic).delete(subscriptionId);
            if (this.topics.get(topic).size === 0) {
                this.topics.delete(topic);
            }
        }
        this.subscriptionHandlers.delete(subscriptionId);
        this.subscriptionTopics.delete(subscriptionId);

        if (this.topics.size === 0) {
            this.stop();
            return;
        }

        if (this.connectionActive) {
            this.scheduleRestart('topic_removed');
        }
    }

    stop() {
        this.clearScheduledRestart();
        this.connectionActive = false;
        if (this.abortController) {
            this.abortController.abort();
        }
        this.reader = null;
        this.activeGeneration = null;
    }

    ensureConnection() {
        if (this.connectionActive || this.topics.size === 0) {
            return;
        }
        this.restartStream('initial_connect');
    }

    clearScheduledRestart() {
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
            this.pendingRestartReason = null;
        }
    }

    scheduleRestart(reason) {
        if (this.restartTimer) {
            this.pendingRestartReason = reason;
            return;
        }
        const delayMs = this.restartDelayMs;
        const generation = this.streamGeneration + 1;
        this.pendingRestartReason = reason;
        console.log('SSE_RESTART_SCHEDULED', {
            reason,
            delayMs,
            totalTopics: this.topics.size,
            generation,
            timestamp: new Date().toISOString(),
        });
        this.restartTimer = setTimeout(() => {
            const pendingReason = this.pendingRestartReason || reason;
            this.restartTimer = null;
            this.pendingRestartReason = null;
            this.restartStream(pendingReason);
        }, delayMs);
    }

    closeStream(reason, generation) {
        if (this.abortController) {
            console.log('SSE_STREAM_CLOSING', {
                generation: generation ?? this.activeGeneration,
                reason,
                timestamp: new Date().toISOString(),
            });
            this.abortController.abort();
        }
        this.reader = null;
        this.abortController = null;
    }

    restartStream(reason) {
        if (!this.jwt) {
            console.warn('Mercure subscriber JWT not provided; SSE is disabled.');
            return;
        }
        const topicsSnapshot = Array.from(this.topics.keys());
        if (topicsSnapshot.length === 0) {
            this.stop();
            return;
        }

        this.connectionActive = true;
        this.clearScheduledRestart();
        this.closeStream(reason, this.activeGeneration);
        const nextGeneration = this.streamGeneration + 1;
        this.streamGeneration = nextGeneration;
        this.activeGeneration = nextGeneration;
        this.startStream(nextGeneration, topicsSnapshot);
    }

    async startStream(generation, topicsSnapshot) {
        if (!this.jwt) {
            console.warn('Mercure subscriber JWT not provided; SSE is disabled.');
            return;
        }
        if (!this.connectionActive || topicsSnapshot.length === 0) {
            return;
        }

        const hubUrl = buildHubUrl(this.hubUrl, topicsSnapshot);
        this.abortController = new AbortController();

        try {
            const response = await fetch(hubUrl, {
                method: 'GET',
                headers: {
                    Accept: 'text/event-stream',
                    Authorization: `Bearer ${this.jwt}`,
                },
                signal: this.abortController.signal,
            });

            if (!response.ok || !response.body) {
                throw new Error(`Mercure connection failed: ${response.status} ${response.statusText}`);
            }

            this.currentBackoff = this.backoffMs;
            this.reader = response.body.getReader();
            console.log('SSE_STREAM_STARTED', {
                generation,
                hubUrl,
                topics: topicsSnapshot,
                timestamp: new Date().toISOString(),
            });
            await this.consumeStream(generation);
        } catch (error) {
            if (!this.connectionActive || this.activeGeneration !== generation) {
                return;
            }
            console.error('SSE_STREAM_ERROR', {
                generation,
                error: error?.message ?? String(error),
                timestamp: new Date().toISOString(),
            });
            this.scheduleReconnect(generation);
        }
    }

    scheduleReconnect(generation) {
        if (!this.connectionActive || this.activeGeneration !== generation) {
            return;
        }
        const delay = Math.min(this.currentBackoff, this.maxBackoffMs);
        this.currentBackoff = Math.min(this.currentBackoff * 2, this.maxBackoffMs);
        console.log('SSE_STREAM_RECONNECTING', {
            generation,
            delayMs: delay,
            nextBackoffMs: this.currentBackoff,
            topics: Array.from(this.topics.keys()),
            timestamp: new Date().toISOString(),
        });
        setTimeout(() => {
            if (!this.connectionActive || this.activeGeneration !== generation) {
                return;
            }
            this.restartStream('reconnect');
        }, delay);
    }

    async consumeStream(generation) {
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        while (this.connectionActive && this.reader && this.activeGeneration === generation) {
            const { done, value } = await this.reader.read();
            if (done) {
                throw new Error('Mercure stream closed');
            }
            buffer += decoder.decode(value, { stream: true });

            let separatorIndex;
            while ((separatorIndex = buffer.indexOf('\n\n')) !== -1) {
                const rawEvent = buffer.slice(0, separatorIndex);
                buffer = buffer.slice(separatorIndex + 2);
                this.handleRawEvent(rawEvent, generation);
            }
        }
    }

    handleRawEvent(rawEvent, generation) {
        const dataLines = [];
        const topics = [];
        let eventId = null;
        let eventType = null;

        rawEvent.split('\n').forEach((line) => {
            const trimmed = line.trim();
            if (trimmed.startsWith('data:')) {
                dataLines.push(trimmed.slice(5).trimStart());
            } else if (trimmed.startsWith('id:')) {
                eventId = trimmed.slice(3).trim();
            } else if (trimmed.startsWith('event:')) {
                eventType = trimmed.slice(6).trim();
            } else if (trimmed.startsWith('topic:')) {
                topics.push(trimmed.slice(6).trim());
            }
        });

        if (!dataLines.length) {
            return;
        }

        const dataString = dataLines.join('\n');
        try {
            const payload = JSON.parse(dataString);
            const derivedTopics = topics && topics.length ? topics : this.deriveTopicsFromPayload(payload);
            const derivedTopic = derivedTopics && derivedTopics.length ? derivedTopics[0] : null;
            const payloadTelegramUserId =
                payload?.telegramUserId || payload?.telegram_user_id || payload?.telegram_userId || null;
            const payloadChatId = payload?.chatId || payload?.chat_id || payload?.telegram_chat_id || null;
            console.log('SSE_EVENT_RECEIVED', {
                generation,
                eventType: eventType || null,
                derivedTopic,
                payloadTelegramUserId,
                payloadChatId,
                timestamp: new Date().toISOString(),
            });
            this.dispatchEvent({ payload, topics: derivedTopics, eventId, eventType });
        } catch (error) {
            console.warn('Failed to parse Mercure payload', error, dataString);
        }
    }

    dispatchEvent({ payload, topics }) {
        let topicList = topics && topics.length ? topics : this.deriveTopicsFromPayload(payload);

        if (!topicList || topicList.length === 0) {
            topicList = Array.from(this.topics.keys());
        }

        if (!topicList || topicList.length === 0) {
            return;
        }

        topicList.forEach((topic) => {
            const subscriptionIds = this.topics.get(topic);
            if (!subscriptionIds) return;
            subscriptionIds.forEach((subscriptionId) => {
                const handler = this.subscriptionHandlers.get(subscriptionId);
                if (handler) {
                    handler(payload, topic);
                }
            });
        });
    }

    deriveTopicsFromPayload(payload) {
        const telegramUserId =
            payload?.telegramUserId || payload?.telegram_user_id || payload?.telegram_userId;
        const chatId = payload?.chatId || payload?.chat_id || payload?.telegram_chat_id;
        const topicKey = telegramUserId || chatId;
        if (topicKey) {
            return [`/tg/login/${topicKey}`];
        }
        return [];
    }
}

export default MercureSseClient;
