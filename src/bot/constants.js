import { Markup } from 'telegraf';

export const MAIN_MENU_KEYBOARD = Markup.inlineKeyboard([
    [Markup.button.callback('Создать запрос', 'menu:create')],
    [Markup.button.callback('Мои запросы', 'menu:requests')],
    [Markup.button.callback('Мои чаты', 'menu:chats')],
]);

export const REQUEST_TYPES = ['mentorship', 'travel', 'dating', 'help', 'other'];

export const NEGATIVE_REASON_OPTIONS = [
    { code: 'not_relevant', label: '❌ Не по смыслу' },
    { code: 'too_far', label: '📍 Слишком далеко' },
    { code: 'old_request', label: '⏳ Старый запрос' },
    { code: 'spam', label: '🚫 Похоже на спам' },
    { code: 'language_mismatch', label: '🌐 Язык не подходит' },
];

export const GEO_SELECTION_TTL_MS = 10 * 60 * 1000;
