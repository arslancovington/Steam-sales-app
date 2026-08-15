import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const app = express();
app.use(express.json());

app.use(express.static(__dirname));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const db = { 
    users: {}, 
    marketItems: [], 
    deals: {}, 
    promos: {}, 
    pendingPayments: {} 
};

function calculateRating(successfulDeals) {
    if (!successfulDeals || successfulDeals === 0) return 5.0;
    let rating = 5.0 + (successfulDeals * 0.1);
    return Math.min(rating, 5.0).toFixed(1);
}

// --- API МАРШРУТЫ ---

// Надежная загрузка инвентаря через открытый прокси
app.post('/api/steam/inventory', async (req, res) => {
    const { tradeUrl } = req.body;
    try {
        const partnerId = tradeUrl.split('partner=')[1]?.split('&')[0];
        if (!partnerId) return res.json({ success: false, error: 'Неверная трейд-ссылка' });
        
        const url = `https://steamcommunity.com/inventory/${partnerId}/730/2?l=russian&count=75`;
        const resp = await fetch(url, { 
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Accept': 'application/json, text/plain, */*'
            } 
        });
        const data = await resp.json();
        
        if (data && data.assets) {
            res.json({ success: true, items: data.assets, descriptions: data.descriptions || [] });
        } else {
            res.json({ success: false, error: 'Инвентарь пуст или профиль скрыт приватностью' });
        }
    } catch (e) {
        res.json({ success: false, error: 'Ошибка соединения со Steam' });
    }
});

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

app.get('/api/market/items', (req, res) => {
    res.json({ success: true, items: db.marketItems });
});

app.post('/api/market/add', (req, res) => {
    const item = { ...req.body, _id: Date.now().toString() };
    db.marketItems.push(item);
    res.json({ success: true, item });
});

app.post('/api/market/cancel', (req, res) => {
    const { itemId, tgId } = req.body;
    db.marketItems = db.marketItems.filter(i => !(i._id === itemId && String(i.tgId) === String(tgId)));
    res.json({ success: true });
});

app.get('/api/user/profile', (req, res) => {
    const { tgId } = req.query;
    if (!db.users[tgId]) {
        db.users[tgId] = { balance: 0, successfulDeals: 0, history: [] };
    }
    const user = db.users[tgId];
    const rating = calculateRating(user.successfulDeals);
    res.json({ success: true, balance: user.balance, successfulDeals: user.successfulDeals, rating, history: user.history });
});

app.post('/api/deals/buy', async (req, res) => {
    const { buyerTgId, buyerTradeUrl, itemId } = req.body;
    const itemIndex = db.marketItems.findIndex(i => i._id === itemId);
    if (itemIndex === -1) return res.json({ success: false, error: 'Предмет не найден' });

    const item = db.marketItems[itemIndex];
    db.marketItems.splice(itemIndex, 1);

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

// P2P Запрос с гарантированной отправкой админу
app.post('/api/billing/p2p', async (req, res) => {
    const { tgId, amountRub, username } = req.body;
    const rub = Number(amountRub);
    if (!rub || rub < 200) return res.json({ success: false, error: 'Минимальная сумма пополнения P2P UZ: 200 рублей' });

    db.pendingPayments[tgId] = { amountRub: rub };
    
    try {
        await bot.sendMessage(process.env.ADMIN_ID, `💸 ЗАПРОС НА P2P UZ ПОПОЛНЕНИЕ\nЮзер: ${username || 'Без имени'} (@${tgId})\nID: ${tgId}\nСумма: ${rub} ₽\n\nОтправьте номер карты в ответ на это сообщение.`);
        res.json({ success: true, message: 'Запрос отправлен, ожидайте реквизиты' });
    } catch (e) {
        res.json({ success: false, error: 'Ошибка отправки запроса администратору' });
    }
});

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

app.post('/api/billing/withdraw', (req, res) => {
    const { tgId, amount, details } = req.body;
    bot.sendMessage(process.env.ADMIN_ID, `📤 ЗАПРОС НА ВЫВОД СРЕДСТВ\nЮзер: ${tgId}\nСумма: ${amount}\nРеквизиты: ${details}`);
    res.json({ success: true, message: 'Запрос на вывод отправлен администратору' });
});

app.post('/api/promo/apply', (req, res) => {
    const { code } = req.body;
    if (db.promos[code] && db.promos[code].used < db.promos[code].count) {
        db.promos[code].used++;
        return res.json({ success: true, discount: 0.5 });
    }
    res.status(400).json({ success: false, error: 'Промокод недействителен или исчерпан' });
});

// --- CALLBACK QUERY ---

bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;
    const msgId = query.message.message_id;

    if (data.startsWith('p2p_approve_')) {
        const [_, __, targetTgId, rubStr] = data.split('_');
        const rub = Number(rubStr);

        if (!db.users[targetTgId]) {
            db.users[targetTgId] = { balance: 0, successfulDeals: 0, history: [] };
        }
        db.users[targetTgId].balance += rub;
        db.users[targetTgId].history.push(`Пополнение P2P UZ: +${rub} ₽`);

        bot.answerCallbackQuery(query.id, { text: 'Платеж подтвержден!' });
        bot.editMessageText(query.message.text + `\n\n✅ *СТАТУС: Оплачено и зачислено (${rub} ₽)*`, {
            chat_id: chatId, message_id: msgId, parse_mode: 'Markdown'
        });

        bot.sendMessage(targetTgId, `🎉 Ваш платеж на сумму *${rub} ₽* подтвержден! Баланс пополнен.`, { parse_mode: 'Markdown' });
        return;
    }

    if (data.startsWith('deal_')) {
        const [_, status, dealId] = data.split('_');
        const deal = db.deals[dealId];
        if (!deal) return bot.answerCallbackQuery(query.id, { text: 'Сделка не найдена' });

        if (status === 'yes') {
            deal.sellerConfirmed = true;
            bot.answerCallbackQuery(query.id, { text: 'Вы подтвердили сделку' });
            bot.editMessageText(`✅ Вы подтвердили отправку предмета *${deal.item.name}*. Ожидаем покупателя.`, {
                chat_id: chatId, message_id: msgId, parse_mode: 'Markdown'
            });

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
            bot.answerCallbackQuery(query.id, { text: 'Сделка отклонена' });
            bot.editMessageText(`❌ Вы сообщили, что сделка не прошла. Средства заморожены.`, {
                chat_id: chatId, message_id: msgId
            });
            notifyAdminDispute(deal, 'Продавец отменил сделку');
        }
    }

    if (data.startsWith('buyer_')) {
        const [_, status, dealId] = data.split('_');
        const deal = db.deals[dealId];
        if (!deal) return bot.answerCallbackQuery(query.id, { text: 'Сделка не найдена' });

        if (status === 'yes') {
            deal.status = 'SUCCESS';
            
            [deal.sellerTgId, deal.buyerTgId].forEach(id => {
                if (!db.users[id]) db.users[id] = { balance: 0, successfulDeals: 0, history: [] };
                db.users[id].successfulDeals++;
                db.users[id].history.push(`Успешная сделка: ${deal.item.name}`);
            });

            db.users[deal.sellerTgId].balance += deal.item.price;

            bot.answerCallbackQuery(query.id, { text: 'Сделка завершена!' });
            bot.editMessageText(`🎉 Сделка по предмету *${deal.item.name}* завершена!`, {
                chat_id: chatId, message_id: msgId, parse_mode: 'Markdown'
            });
            bot.sendMessage(deal.sellerTgId, `🎉 Сделка по предмету *${deal.item.name}* завершена! Зачислено: ${deal.item.price} ₽`, { parse_mode: 'Markdown' });
            bot.sendMessage(deal.buyerTgId, `🎉 Сделка успешно завершена!`);
        } else if (status === 'no') {
            deal.status = 'FROZEN';
            bot.answerCallbackQuery(query.id, { text: 'Средства заморожены' });
            bot.editMessageText(`⚠️ Средства заморожены, администратор уведомлен.`, {
                chat_id: chatId, message_id: msgId
            });
            bot.sendMessage(deal.sellerTgId, `⚠️ Покупатель не получил скин. Средства заморожены.`);
            notifyAdminDispute(deal, 'Покупатель не получил скин');
        }
    }
});

async function notifyAdminDispute(deal, reason) {
    const adminId = process.env.ADMIN_ID;
    if (!adminId) return;
    bot.sendMessage(adminId, `🚨 СПОР ПО СДЕЛКЕ\nПредмет: ${deal.item.name}\nПричина: ${reason}`, { parse_mode: 'Markdown' });
}

// --- TELEGRAM BOT MESSAGES ---

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text || '';

    // Обработка ответа администратора (универсальный поиск ID пользователя)
    if (chatId == process.env.ADMIN_ID && msg.reply_to_message) {
        const replyText = msg.reply_to_message.text;
        const targetMatch = replyText.match(/ID:\s*(\d+)/) || replyText.match(/@(\d+)/);
        
        if (targetMatch && targetMatch[1]) {
            const targetTgId = targetMatch[1];
            const paymentInfo = db.pendingPayments[targetTgId];

            if (paymentInfo && paymentInfo.amountRub) {
                const rub = paymentInfo.amountRub;
                const uzs = Math.round(rub * 175).toLocaleString();

                bot.sendMessage(targetTgId, `💳 Реквизиты для оплаты P2P UZ:\n\n🏦 Карта: ${text}\n💵 Сумма: *${uzs} сўм* (${rub} ₽)`, { parse_mode: 'Markdown' });
                bot.sendMessage(chatId, `✅ Реквизиты отправлены пользователю. Сумма: ${uzs} сўм (${rub} ₽).\n\nНажмите для зачисления:`, {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: `✅ Подтвердить зачисление (${rub} ₽)`, callback_data: `p2p_approve_${targetTgId}_${rub}` }]
                        ]
                    }
                });
                delete db.pendingPayments[targetTgId];
            } else {
                bot.sendMessage(targetTgId, `💳 Реквизиты для оплаты: ${text}`);
                bot.sendMessage(chatId, `✅ Реквизиты отправлены (сумма не найдена в базе).`);
            }
        }
    }

    if (text.startsWith('/createpromo')) {
        const lines = text.split('\n');
        let code = '', count = 0;
        lines.forEach(line => {
            if (line.toLowerCase().includes('промо:')) code = line.split(':')[1]?.trim();
            if (line.toLowerCase().includes('количество:')) count = parseInt(line.split(':')[1]?.trim());
        });

        if (code && count) {
            db.promos[code] = { count, used: 0 };
            bot.sendMessage(chatId, `✅ Промокод "${code}" на ${count} активаций создан.`);
        }
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server fully running on port ${PORT}`));
