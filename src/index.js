import { Telegraf } from 'telegraf';
import axios from 'axios';

const botToken = process.env.BOT_TOKEN;
const apiUrl = process.env.API_URL || 'https://matchinghub.work/api';

if (!botToken) {
    console.error('BOT_TOKEN is not set');
    process.exit(1);
}

const bot = new Telegraf(botToken);

bot.start((ctx) => {
    ctx.reply('Привет! Я matching-бот 🤝\nНапиши /ping, чтобы проверить связь с бэкендом.');
});

bot.command('ping', async (ctx) => {
    try {
        const res = await axios
            .get(`${apiUrl}/docs`, { timeout: 5000 })
            .catch(() => null);

        if (res && res.status === 200) {
            await ctx.reply('✅ Бэкенд отвечает! (GET /api/docs)');
        } else {
            await ctx.reply('⚠️ Не удалось получить ответ от бекенда');
        }
    } catch (e) {
        console.error(e);
        await ctx.reply('❌ Ошибка при обращении к бекенду');
    }
});

bot.launch().then(() => {
    console.log('Matching bot started');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
