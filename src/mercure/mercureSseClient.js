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

        this.ensureConnection();

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
        }
    }

    stop() {
        this.connectionActive = false;
        if (this.abortController) {
            this.abortController.abort();
        }
        this.reader = null;
    }

    ensureConnection() {
        if (this.connectionActive || this.topics.size === 0) {
            return;
        }
        this.startStream();
    }

    async startStream() {
        if (!this.jwt) {
            console.warn('Mercure subscriber JWT not provided; SSE is disabled.');
            return;
        }
        if (this.topics.size === 0) {
            return;
        }

        this.connectionActive = true;
        const hubUrl = buildHubUrl(this.hubUrl, Array.from(this.topics.keys()));
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
            await this.consumeStream();
        } catch (error) {
            if (!this.connectionActive) {
                return;
            }
            console.error('Mercure SSE connection error', error);
            this.scheduleReconnect();
        }
    }

    scheduleReconnect() {
        if (!this.connectionActive) {
            return;
        }
        const delay = Math.min(this.currentBackoff, this.maxBackoffMs);
        this.currentBackoff = Math.min(this.currentBackoff * 2, this.maxBackoffMs);
        setTimeout(() => {
            this.connectionActive = false;
            this.startStream();
        }, delay);
    }

    async consumeStream() {
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        while (this.connectionActive && this.reader) {
            const { done, value } = await this.reader.read();
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
            this.dispatchEvent({ payload, topics, eventId, eventType });
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
        if (payload?.chatId) {
            return [`/chats/${payload.chatId}`];
        }
        return [];
    }
}

export default MercureSseClient;
//