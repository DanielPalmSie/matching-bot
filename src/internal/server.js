import express from 'express';
import { sendNewMessageNotification } from '../notifications.js';

const DEFAULT_INTERNAL_PORT = 3001;

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;
const isValidId = (value) => typeof value === 'string' || typeof value === 'number';

const validatePayload = (payload) => {
    if (!payload || typeof payload !== 'object') {
        return 'Payload must be an object';
    }

    if (payload.telegramChatId === undefined || payload.telegramChatId === null) {
        return 'telegramChatId is required';
    }

    if (!isValidId(payload.chatId)) {
        return 'chatId is required';
    }

    if (!isNonEmptyString(payload.senderDisplayName)) {
        return 'senderDisplayName is required';
    }

    if (!isNonEmptyString(payload.textPreview)) {
        return 'textPreview is required';
    }

    return null;
};

export function startInternalServer({ bot, logger = console }) {
    const app = express();
    const expectedToken = process.env.INTERNAL_API_TOKEN;

    app.use(express.json());

    app.use((req, res, next) => {
        const providedToken = req.get('X-Internal-Token');
        if (!expectedToken || providedToken !== expectedToken) {
            logger.warn(`Unauthorized internal request to ${req.method} ${req.originalUrl}`);
            return res.status(401).json({ error: 'Unauthorized' });
        }
        return next();
    });

    app.post('/internal/telegram/notify-new-message', async (req, res) => {
        const payload = req.body;
        const validationError = validatePayload(payload);
        if (validationError) {
            return res.status(400).json({ error: validationError });
        }

        if (!isValidId(payload.telegramChatId)) {
            logger.warn('Invalid telegramChatId received for notify-new-message');
            return res.status(200).json({ status: 'skipped' });
        }

        try {
            await sendNewMessageNotification({ bot, payload, logger });
        } catch (error) {
            logger.error('Unexpected error while sending new message notification', error);
        }

        return res.status(200).json({ status: 'ok' });
    });

    const port = Number(process.env.INTERNAL_HTTP_PORT) || DEFAULT_INTERNAL_PORT;
    const server = app.listen(port, () => {
        logger.log(`Internal server listening on ${port}`);
    });

    return server;
}
