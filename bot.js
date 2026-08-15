import TelegramBot from 'node-telegram-bot-api';
import { db } from './database.js';
import 'dotenv/config';

const TOKEN = process.env.BOT_TOKEN;
let bot = null;

if (TOKEN) {
    // Включаем поллинг безопасно. Ошибки конфликтов просто логируются, не краша сервер
    bot = new TelegramBot(TOKEN, { polling: true });
    
    bot.on('polling_error', (error) => {
        console.error("⚠️ Поллинг:", error.message);
    });

    // Оплата Telegram Stars
    bot.on('pre_checkout_query', (query) => bot.answerPreCheckoutQuery(query.id, true));
    
    bot.on('successful_payment', (msg) => {
        if (msg.successful_payment.currency === 'XTR') {
            const tgId = String(msg.from.id);
            const amount = msg.successful_payment.total_amount;
            if (db.users[tgId]) db.users[tgId].balance += amount;
            bot.sendMessage(msg.chat.id, `✅ Оплата на ${amount} Stars успешно зачислена!`);
        }
    });

    // Создание розыгрыша
    bot.on('message', async (msg) => {
        const text = msg.text || msg.caption;
        if (!text || !text.startsWith('/newgiveaway')) return;
        
        const lines = text.split('\n');
        let title = '', sponsor = '', timer = 'Скоро', image = '';

        lines.forEach(line => {
            if (line.toLowerCase().match(/^(приз|prize):/)) title = line.replace(/^(приз|prize):/i, '').trim();
            if (line.toLowerCase().match(/^(спонсор|sponsor):/)) sponsor = line.replace(/^(спонсор|sponsor):/i, '').trim();
            if (line.toLowerCase().match(/^(таймер|timer):/)) timer = line.replace(/^(таймер|timer):/i, '').trim();
        });

        if (msg.photo && msg.photo.length > 0) {
            try {
                image = await bot.getFileLink(msg.photo[msg.photo.length - 1].file_id);
            } catch (err) { console.error('Ошибка фото:', err.message); }
        }

        if (!title || !sponsor) {
            return bot.sendMessage(msg.chat.id, '❌ Укажите формат:\nПриз: Название\nСпонсор: @канал');
        }

        db.giveaways.push({
            _id: Date.now().toString(), title, sponsor, timer,
            image: image || 'https://community.cloudflare.steamstatic.com/economy/image/-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I56KU0Zwwo4NUX4oFJZEHLbXH5ApeO4YmlhxYQknCRvCo04DEVlxkKgpot7HxfDhjxszJemkV092lnYmOhcj5Nr_Yg2ZU7PFohO_J9o-j2Vfk8hVtNjjwJ9ORfVFvY1-G_wO7x-_u1sS5uJ6ayXswuSM8pGGKYW964g/360fx360f',
            participantsCount: 0, participants: []
        });

        bot.sendMessage(msg.chat.id, `✅ Розыгрыш "${title}" добавлен!`);
    });
} else {
    console.warn("⚠️ BOT_TOKEN не задан, бот не запущен.");
}

export default bot;
