import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import 'dotenv/config';

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const app = express();
app.use(express.json());
app.use(express.static('public'));

const db = { 
    users: {}, 
    marketItems: [], 
    deals: {}, 
    promos: {}, 
    pendingPayments: {} 
};

// --- API МАРШРУТЫ ---

// 1. Загрузка инвентаря по трейд-ссылке
app.post('/api/steam/inventory', async (req, res) => {
    const { tradeUrl } = req.body;
    try {
        const partnerId = tradeUrl.split('partner=')[1]?.split('&')[0];
        if (!partnerId) return res.json({ success: false, error: 'Неверная трейд-ссылка' });
        
        const url = `https://steamcommunity.com/inventory/${partnerId}/730/2?l=russian&count=75`;
        const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const data = await resp.json();
        
        res.json({ success: true, items: data.assets || [], descriptions: data.descriptions || [] });
    } catch (e) {
        res.json({ success: false, error: 'Профиль закрыт или ошибка Steam' });
    }
});

// 2. Получение цен с учетом провайдеров или Steam
app.get('/api/steam/price', async (req, res) => {
    let { name, provider } = req.query;
    if (!name) return res.json({ success: true, price: 100 });

    try {
        let cleanName = name.replace(/™|★/g, '').trim();
        if (provider === 'csmoney') {
            const resp = await fetch(`https://cs.money/2.0/market/search?limit=1&search=${encodeURIComponent(cleanName)}`);
            const data = await resp.json();
            if (data.items?.length > 0) return res.json({ success: true, price: Math.round(data.items[0].price * 95) });
        }
        if (provider === 'lisskins') {
            const resp = await fetch(`https://lis-skins.ru/api/market/items/?search=${encodeURIComponent(cleanName)}`);
            const data = await resp.json();
            if (data.items?.length > 0) return res.json({ success: true, price: Math.round(data.items[0].price) });
        }
        const response = await fetch(`https://steamcommunity.com/market/priceoverview/?appid=730&currency=5&market_hash_name=${encodeURIComponent(cleanName)}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const data = await response.json();
        if (data.success && data.lowest_price) {
            return res.json({ success: true, price: parseFloat(data.lowest_price.replace(/[^\d,]/g, '').replace(',', '.')) });
        }
    } catch (e) {}
    res.json({ success: true, price: 200 });
});

// 3. Покупка предмета и запуск процесса сделки
app.post('/api/deals/buy', async (req, res) => {
    const { buyerTgId, buyerTradeUrl, itemId } = req.body;
    const itemIndex = db.marketItems.findIndex(i => i._id === itemId);
    if (itemIndex === -1) return res.json({ success: false, error: 'Предмет не найден' });

    const item = db.marketItems[itemIndex];
    db.marketItems.splice(itemIndex, 1); // Удаляем с витрины

    const dealId = Date.now().toString();
    db.deals[dealId] = {
        dealId,
        item,
        buyerTgId,
        buyerTradeUrl,
        sellerTgId: item.tgId,
        sellerTradeUrl: item.tradeUrl,
        status: 'PENDING'
    };

    // Уведомление продавцу с кнопкой и трейд-ссылкой покупателя
    await bot.sendMessage(item.tgId, `🔔 Пользователь (${buyerTgId}) купил ваш предмет: *${item.name}*`, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '📤 Отправить (Трейд-ссылка покупателя)', url: buyerTradeUrl }],
                [
                    { text: '✅ Подтвердить сделку', callback_data: `deal_yes_${dealId}` },
                    { text: '❌ Сделка не прошла', callback_data: `deal_no_${dealId}` }
                ]
            ]
        }
    });

    res.json({ success: true, dealId });
});

// 4. P2P Пополнение (Узбекистан)
app.post('/api/billing/p2p', (req, res) => {
    const { tgId, amount, username } = req.body;
    db.pendingPayments[tgId] = { amount, step: 'WAITING_CARD' };
    bot.sendMessage(process.env.ADMIN_ID, `💸 ЗАПРОС НА P2P ПОПОЛНЕНИЕ\nЮзер: ${username || 'Без имени'} (@${tgId})\nСумма: ${amount} сум\n\nОтправьте номер карты в ответ на это сообщение.`);
    res.json({ success: true, message: 'Запрос отправлен, ожидайте реквизиты' });
});

// 5. Оплата CryptoBot (мин. 3 USDT) и Stars с уведомлением админа
app.post('/api/billing/invoice', async (req, res) => {
    const { tgId, method, amount } = req.body;
    const val = Number(amount);
    
    if (method === 'crypto') {
        if (val < 3) return res.json({ success: false, error: 'Минимальная сумма пополнения: 3 USDT' });
        try {
            const resp = await fetch('https://pay.crypt.bot/api/createInvoice', {
                method: 'POST',
                headers: { 'Crypto-Pay-API-Token': process.env.CRYPTO_BOT_TOKEN, 'Content-Type': 'application/json' },
                body: JSON.stringify({ asset: 'USDT', amount: String(val), description: `Пополнение баланса ${tgId}` })
            });
            const data = await resp.json();
            if (data.ok) {
                bot.sendMessage(process.env.ADMIN_ID, `💰 Новое пополнение (CryptoBot):\nЮзер: ${tgId}\nСумма: ${val} USDT`);
                return res.json({ success: true, url: data.result.pay_url });
            }
        } catch(e) {}
    }
    
    if (method === 'stars') {
        try {
            const link = await bot.createInvoiceLink('Пополнение баланса', 'Steam Sales', JSON.stringify({tgId, val}), '', 'XTR', [{label: 'Stars', amount: val}]);
            bot.sendMessage(process.env.ADMIN_ID, `⭐ Новое пополнение (Telegram Stars):\nЮзер: ${tgId}\nСумма: ${val} Stars`);
            return res.json({ success: true, url: link });
        } catch(e) {}
    }
    res.status(400).json({ success: false, error: 'Ошибка создания счета' });
});

// 6. Запрос на вывод средств
app.post('/api/billing/withdraw', (req, res) => {
    const { tgId, amount, details } = req.body;
    bot.sendMessage(process.env.ADMIN_ID, `📤 ЗАПРОС НА ВЫВОД СРЕДСТВ\nЮзер: ${tgId}\nСумма: ${amount}\nРеквизиты: ${details}`);
    res.json({ success: true, message: 'Запрос на вывод отправлен администратору' });
});

// 7. Промокоды
app.post('/api/promo/apply', (req, res) => {
    const { code } = req.body;
    if (db.promos[code] && db.promos[code].used < db.promos[code].count) {
        db.promos[code].used++;
        return res.json({ success: true, discount: 0.5 });
    }
    res.status(400).json({ success: false, error: 'Промокод недействителен или исчерпан' });
});

// --- CALLBACK QUERY (Кнопки подтверждения сделок) ---

bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;
    const msgId = query.message.message_id;

    if (data.startsWith('deal_')) {
        const [_, status, dealId] = data.split('_');
        const deal = db.deals[dealId];
        if (!deal) return bot.answerCallbackQuery(query.id, { text: 'Сделка не найдена' });

        if (status === 'yes') {
            deal.sellerConfirmed = true;
            bot.answerCallbackQuery(query.id, { text: 'Вы подтвердили сделку' });
            bot.editMessageText(`✅ Вы подтвердили отправку предмета *${deal.item.name}*. Ожидаем подтверждения покупателя.`, {
                chat_id: chatId, message_id: msgId, parse_mode: 'Markdown'
            });

            // Запрашиваем подтверждение у покупателя
            bot.sendMessage(deal.buyerTgId, `📦 Продавец подтвердил отправку предмета *${deal.item.name}*. Вы получили скин?`, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '✅ Да, скин у меня', callback_data: `buyer_yes_${dealId}` },
                            { text: '❌ Нет, сделка не прошла', callback_data: `buyer_no_${dealId}` }
                        ]
                    ]
                }
            });
        } else if (status === 'no') {
            deal.status = 'DISPUTE';
            bot.answerCallbackQuery(query.id, { text: 'Вы отклонили сделку' });
            bot.editMessageText(`❌ Вы сообщили, что сделка не прошла. Средства заморожены, администратор уведомлен.`, {
                chat_id: chatId, message_id: msgId
            });
            notifyAdminDispute(deal, 'Продавец сообщил об отмене сделки');
        }
    }

    if (data.startsWith('buyer_')) {
        const [_, status, dealId] = data.split('_');
        const deal = db.deals[dealId];
        if (!deal) return bot.answerCallbackQuery(query.id, { text: 'Сделка не найдена' });

        if (status === 'yes') {
            deal.status = 'SUCCESS';
            bot.answerCallbackQuery(query.id, { text: 'Сделка успешно завершена!' });
            bot.editMessageText(`🎉 Сделка по предмету *${deal.item.name}* успешно завершена!`, {
                chat_id: chatId, message_id: msgId, parse_mode: 'Markdown'
            });
            // Уведомление обеим сторонам
            bot.sendMessage(deal.sellerTgId, `🎉 Сделка по предмету *${deal.item.name}* успешно завершена! Средства зачислены.`, { parse_mode: 'Markdown' });
            bot.sendMessage(deal.buyerTgId, `🎉 Сделка успешно завершена! Приятной игры.`);
        } else if (status === 'no') {
            deal.status = 'FROZEN';
            bot.answerCallbackQuery(query.id, { text: 'Сделка отменена, средства заморожены' });
            bot.editMessageText(`⚠️ Вы сообщили о проблеме. Средства заморожены, администратор начал проверку.`, {
                chat_id: chatId, message_id: msgId
            });
            bot.sendMessage(deal.sellerTgId, `⚠️ Покупатель сообщил, что не получил скин. Средства заморожены до выяснения обстоятельств.`);
            notifyAdminDispute(deal, 'Покупатель сообщил, что не получил скин');
        }
    }
});

// Функция отправки отчета в админ-чат при проблемах со сделкой
async function notifyAdminDispute(deal, reason) {
    const adminId = process.env.ADMIN_ID;
    if (!adminId) return;

    let inspectionLog = 'Идет проверка API скина...';
    try {
        const partnerId = deal.buyerTradeUrl.split('partner=')[1]?.split('&')[0];
        if (partnerId) {
            const resp = await fetch(`https://steamcommunity.com/inventory/${partnerId}/730/2?l=russian&count=75`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
            const data = await resp.json();
            inspectionLog = data.assets?.length > 0 ? `Инвентарь доступен, предметов: ${data.assets.length}` : 'Инвентарь пуст или закрыт';
        }
    } catch (e) {
        inspectionLog = 'Ошибка запроса к Steam API';
    }

    const report = `🚨 *СПОР ПО СДЕЛКЕ (СРЕДСТВА ЗАМОРОЖЕНЫ)*\n\n` +
                   `📌 *Предмет:* ${deal.item.name}\n` +
                   `🔍 *Причина:* ${reason}\n\n` +
                   `👤 *Продавец (ID):* ${deal.sellerTgId}\n` +
                   `🔗 Трейд продавца: ${deal.sellerTradeUrl}\n\n` +
                   `👤 *Покупатель (ID):* ${deal.buyerTgId}\n` +
                   `🔗 Трейд покупателя: ${deal.buyerTradeUrl}\n\n` +
                   `⚙️ *Статус API проверки:* ${inspectionLog}`;

    bot.sendMessage(adminId, report, { parse_mode: 'Markdown' });
}

// --- ЛОГИКА TELEGRAM БОТА (Сообщения) ---

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text || '';

    // Ответ админа на P2P запрос реплаем
    if (chatId == process.env.ADMIN_ID && msg.reply_to_message) {
        const replyText = msg.reply_to_message.text;
        const targetMatch = replyText.match(/@(\d+)/);
        if (targetMatch && targetMatch[1]) {
            const targetTgId = targetMatch[1];
            bot.sendMessage(targetTgId, `💳 Реквизиты для оплаты: ${text}`);
            bot.sendMessage(chatId, `✅ Реквизиты успешно отправлены пользователю.`);
        }
    }

    // Создание промокода администратором
    if (text.startsWith('/createpromo')) {
        const lines = text.split('\n');
        let code = '', count = 0;
        lines.forEach(line => {
            if (line.toLowerCase().includes('промо:')) code = line.split(':')[1]?.trim();
            if (line.toLowerCase().includes('количество:')) count = parseInt(line.split(':')[1]?.trim());
        });

        if (code && count) {
            db.promos[code] = { count, used: 0 };
            bot.sendMessage(chatId, `✅ Промокод "${code}" успешно создан на ${count} активаций.`);
        } else {
            bot.sendMessage(chatId, `❌ Неверный формат. Пример:\n/createpromo\nПромо: CODE\nКоличество: 5`);
        }
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server fully running on port ${PORT}`));
