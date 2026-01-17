import { Markup } from 'telegraf';

export function createErrorHandlers({ ApiError, resolveTelegramUserId, clearSessionAuth }) {
    async function handleApiError(ctx, session, error, fallbackMessage) {
        if (error instanceof ApiError && error.isAuthError) {
            const telegramUserId = resolveTelegramUserId(ctx, 'api.error.auth');
            clearSessionAuth(session, telegramUserId);
            await ctx.reply(
                'Ваша сессия истекла. Нажмите «Старт», чтобы войти снова.',
                Markup.inlineKeyboard([
                    [Markup.button.callback('Старт', 'START_SESSION')],
                ])
            );
            return;
        }

        await ctx.reply(error.message || fallbackMessage);
    }

    return { handleApiError };
}
