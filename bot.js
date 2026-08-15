const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const TOKEN = process.env.BOT_TOKEN || 'YOUR_TELEGRAM_BOT_TOKEN';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || 'YOUR_ADMIN_CHAT_ID';
const CRYPTO_BOT_TOKEN = process.env.CRYPTO_BOT_TOKEN || '';

const bot = new TelegramBot(TOKEN, { polling: true });
const app = express();

app.use(express.json());
app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const dbFile = path.join(__dirname, 'database.json');
let db = { users: {}, marketItems: [], giveaways: [] };

if (fs.existsSync(dbFile)) {
    try {
        const fileData = fs.readFileSync(dbFile, 'utf8');
        db = JSON.parse(fileData);
    } catch (e) {
        console.error("Ошибка чтения базы данных, создана новая:", e.message);
    }
}

let users = db.users || {};
let marketItems = db.marketItems || [];
let giveaways = db.giveaways || [];
let adminStates = {};

function saveData() {
    try {
        fs.writeFileSync(dbFile, JSON.stringify({ users, marketItems, giveaways }, null, 2));
    } catch (e) {
        console.error("Ошибка сохранения базы данных:", e.message);
    }
}

function getOrCreateUser(tgId, username = 'Игрок') {
    if (!users[tgId]) {
        users[tgId] = { 
            tgId, 
            username: username || 'Игрок', 
            balance: 0, 
            rating: 5.0, 
            completedDeals: 0, 
            tradeUrl: '', 
            steamId: '' 
        };
        saveData();
    } else if (username && username !== 'Игрок' && users[tgId].username !== username) {
        users[tgId].username = username;
        saveData();
    }
    return users[tgId];
}

function extractSteamIdFromTradeUrl(url) {
    if (!url) return null;
    const profileMatch = url.match(/\/profiles\/(\d{17})/);
    if (profileMatch && profileMatch[1]) return profileMatch[1];
    const partnerMatch = url.match(/partner=(\d+)/);
    if (partnerMatch && partnerMatch[1]) {
        try {
            return (BigInt(partnerMatch[1]) + 76561197960265728n).toString();
        } catch (e) {
            return null;
        }
    }
    return null;
}

app.get('/api/user/profile', (req, res) => {
    const { tgId, tgUser } = req.query;
    if (!tgId) return res.json({ success: false, error: 'No tgId provided' });
    
    const user = getOrCreateUser(tgId, tgUser);
    res.json({ success: true, ...user });
});

app.post('/api/user/save', (req, res) => {
    const { tgId, tradeUrl } = req.body;
    if (!tgId) return res.json({ success: false, error: 'No tgId provided' });

    const user = getOrCreateUser(tgId);
    user.tradeUrl = tradeUrl || '';
    
    const steamId = extractSteamIdFromTradeUrl(tradeUrl);
    if (steamId) {
        user.steamId = steamId;
    }

    saveData();
    res.json({ success: true, steamId: user.steamId });
});

app.get('/api/market/items', (req, res) => {
    res.json({ success: true, items: marketItems });
});

app.post('/api/market/add', (req, res) => {
    const item = req.body;
    item._id = Date.now().toString();
    marketItems.push(item);
    saveData();
    res.json({ success: true });
});

app.post('/api/market/cancel', (req, res) => {
    const { itemId, tgId } = req.body;
    marketItems = marketItems.filter(i => !(i._id === itemId && String(i.tgId) === String(tgId)));
    saveData();
    res.json({ success: true });
});

app.get('/api/giveaways/list', (req, res) => {
    res.json({ success: true, giveaways });
});

app.post('/api/giveaways/join', async (req, res) => {
    const { tgId, giveawayId } = req.body;
    const giveaway = giveaways.find(g => g._id === giveawayId);
    
    if (!giveaway) {
        return res.json({ success: false, error: 'Розыгрыш не найден' });
    }

    if (giveaway.participants.includes(String(tgId))) {
        return res.json({ success: false, error: 'Вы уже участвуете в этом розыгрыше!' });
    }

    if (giveaway.sponsorUsername) {
        try {
            const chatMember = await bot.getChatMember(giveaway.sponsorUsername, tgId);
            const status = chatMember.status;
            const isMember = ['creator', 'administrator', 'member'].includes(status);
            
            if (!isMember) {
                return res.json({ 
                    success: false, 
                    error: `Для участия необходимо подписаться на канал спонсора: ${giveaway.sponsor}` 
                });
            }
        } catch (err) {
            console.error("Subscription check error:", err.message);
        }
    }

    giveaway.participants.push(String(tgId));
    giveaway.participantsCount = giveaway.participants.length;
    saveData();
    res.json({ success: true });
});

app.post('/api/steam/inventory', async (req, res) => {
    let { steamId, tgId } = req.body;
    
    if (!steamId && tgId && users[tgId]) {
        steamId = users[tgId].steamId;
    }

    if (!steamId) {
        return res.json({ success: false, items: [], descriptions: [] });
    }

    try {
        const invRes = await axios.get(`https://steamcommunity.com/inventory/${steamId}/730/2?l=russian&count=75`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/json, text/javascript, */*; q=0.01',
                'Accept-Language': 'ru-RU,ru;q=0.9',
                'Referer': `https://steamcommunity.com/profiles/${steamId}/inventory/`
            },
            timeout: 10000
        });

        const invData = invRes?.data;
        if (invData && invData.success) {
            res.json({
                success: true,
                items: invData.assets || [],
                descriptions: invData.descriptions || []
            });
        } else {
            res.json({ success: false, items: [], descriptions: [] });
        }
    } catch (e) {
        res.json({ success: false, items: [], descriptions: [] });
    }
});

app.get('/api/steam/price', async (req, res) => {
    const skinName = req.query.name;
    if (!skinName) return res.json({ success: false, price: 100 });

    try {
        const url = `https://steamcommunity.com/market/priceoverview/?appid=730&currency=5&market_hash_name=${encodeURIComponent(skinName)}`;
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept-Language': 'ru-RU,ru;q=0.9'
            },
            timeout: 5000
        });

        if (response.data && response.data.success && response.data.lowest_price) {
            let priceStr = response.data.lowest_price.replace(/[^\d,.]/g, '').replace(/\s/g, '').replace(',', '.');
            let price = parseFloat(priceStr);
            if (!isNaN(price) && price > 0) {
                return res.json({ success: true, price: Math.round(price) });
            }
        }
        res.json({ success: true, price: 150 });
    } catch (e) {
        res.json({ success: true, price: 150 });
    }
});

app.post('/api/deals/buy', (req, res) => {
    res.json({ success: true });
});

app.post('/api/billing/invoice', async (req, res) => {
    const { tgId, amount, currency } = req.body;
    let rubles = currency === 'USDT' ? amount * 80 : (currency === 'Stars' ? amount * 1.5 : amount);

    try {
        if (currency === 'P2P UZ') {
            const sumAmount = Math.round(amount * 175);
            if (ADMIN_CHAT_ID && ADMIN_CHAT_ID !== 'YOUR_ADMIN_CHAT_ID') {
                await bot.sendMessage(ADMIN_CHAT_ID, 
                    `💳 **Запрос на пополнение P2P UZ!**\n\n` +
                    `👤 Пользователь ID: \`${tgId}\`\n` +
                    `💰 Сумма к зачислению: ${amount} ₽\n` +
                    `💵 К оплате клиентом: ${sumAmount} сум (курс 175)\n\n` +
                    `Нажмите кнопку ниже, чтобы отправить номер карты пользователю:`, 
                    {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '💳 Отправить реквизиты карты', callback_data: `p2p_sendcard_${tgId}_${amount}_${sumAmount}` }]
                            ]
                        }
                    }
                );
            }
            await bot.sendMessage(tgId, `💳 **Запрос на пополнение P2P UZ создан**\n\nСумма: ${amount} ₽ (${sumAmount} сум).\nОжидайте реквизиты карты от администратора.`);
        } else if (currency === 'USDT') {
            let payUrl = 'https://t.me/CryptoBot';
            if (CRYPTO_BOT_TOKEN) {
                try {
                    const cryptoRes = await axios.post('https://pay.crypt.bot/api/createInvoice', {
                        asset: 'USDT',
                        amount: amount.toString(),
                        description: `Пополнение баланса на ${Math.round(rubles)} ₽`
                    }, {
                        headers: { 'Crypto-Pay-API-Token': CRYPTO_BOT_TOKEN }
                    });
                    if (cryptoRes.data && cryptoRes.data.ok) {
                        payUrl = cryptoRes.data.result.pay_url;
                    }
                } catch (err) {}
            }

            await bot.sendMessage(tgId, 
                `🧾 **Счет на пополнение баланса**\n\nСумма: **${amount} USDT**\nК зачислению: **${Math.round(rubles)} ₽**\n\nНажмите кнопку ниже для оплаты:`, 
                {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '💎 Оплатить в CryptoBot', url: payUrl }]
                        ]
                    }
                }
            );
        } else if (currency === 'Stars') {
            // Отправка нативного инвойса Telegram Stars (XTR)
            await bot.sendInvoice(
                tgId,
                'Пополнение баланса',
                `Пополнение баланса на ${Math.round(rubles)} ₽`,
                `topup_${tgId}_${amount}_${Math.round(rubles)}`,
                '', // Пустой провайдер токен для Telegram Stars
                'XTR',
                [{ label: `${amount} ⭐ Звёзд`, amount: parseInt(amount) }]
            );
        }
        res.json({ success: true });
    } catch (e) {
        console.error("Invoice Error:", e.message);
        res.json({ success: false, error: 'Не удалось отправить счет. Напишите боту /start в личные сообщения.' });
    }
});

app.post('/api/billing/withdraw', async (req, res) => {
    const { tgId, amount, recipientAccount, username, method } = req.body;
    const user = getOrCreateUser(tgId, username);
    
    if (user.balance < amount) {
        return res.json({ success: false, error: 'Недостаточно средств на балансе' });
    }

    user.balance -= amount;
    saveData();

    try {
        if (ADMIN_CHAT_ID && ADMIN_CHAT_ID !== 'YOUR_ADMIN_CHAT_ID') {
            if (method === 'P2P UZ') {
                const puyoutSum = Math.round(amount * 0.95 * 145);
                await bot.sendMessage(ADMIN_CHAT_ID, 
                    `💸 **Новая заявка на вывод P2P UZ!**\n\n` +
                    `👤 Игрок: @${username || user.username || tgId} (ID: \`${tgId}\`)\n` +
                    `💰 Списано с баланса: ${amount} ₽\n` +
                    `💵 К выплате на карту: ${puyoutSum} сум (курс 145, с учетом комиссии 5%)\n` +
                    `💳 Карты получателя: \`${recipientAccount}\``, 
                    {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '✅ Подтвердить перевод', callback_data: `p2p_withdraw_done_${tgId}_${amount}` }]
                            ]
                        }
                    }
                );
            } else {
                await bot.sendMessage(ADMIN_CHAT_ID, `💸 **Новая заявка на вывод средств (Crypto)!**\n\n👤 Игрок: @${username || tgId}\n🆔 ID: \`${tgId}\`\n💰 Сумма: ${amount} ₽\n💎 Кошелек: \`${recipientAccount}\``, { parse_mode: 'Markdown' });
            }
        }
        res.json({ success: true, newBalance: user.balance });
    } catch (e) {
        user.balance += amount;
        saveData();
        res.json({ success: false, error: 'Ошибка отправки чека администраторам' });
    }
});

// Обязательный ответ на пре-чекаут для Telegram Stars
bot.on('pre_checkout_query', async (query) => {
    try {
        await bot.answerPreCheckoutQuery(query.id, true);
    } catch (e) {}
});

bot.on('callback_query', async (query) => {
    const data = query.data;
    const adminId = query.from.id;

    if (data.startsWith('p2p_sendcard_')) {
        const parts = data.split('_');
        const targetTgId = parts[2];
        const amount = parts[3];
        const sumAmount = parts[4];

        adminStates[adminId] = { action: 'awaiting_card', targetTgId, amount, sumAmount };
        
        await bot.sendMessage(query.message.chat.id, `✍️ Отправьте номер карты (текстом), на который пользователь должен перевести **${sumAmount} сум** для пополнения на **${amount} ₽**:`, { parse_mode: 'Markdown' });
        await bot.answerCallbackQuery(query.id);
    } 
    else if (data.startsWith('p2p_confirm_pay_')) {
        const parts = data.split('_');
        const targetTgId = parts[3];
        const amount = parseFloat(parts[4]);

        const user = getOrCreateUser(targetTgId);
        user.balance += amount;
        saveData();

        await bot.sendMessage(targetTgId, `✅ Ваша оплата на сумму ${amount} ₽ подтверждена! Баланс успешно пополнен.`);
        await bot.editMessageText(`✅ Пополнение на ${amount} ₽ для игрока \`${targetTgId}\` успешно подтверждено!`, {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
            parse_mode: 'Markdown'
        });
        await bot.answerCallbackQuery(query.id, { text: 'Пополнение подтверждено!' });
    }
    else if (data.startsWith('p2p_withdraw_done_')) {
        const parts = data.split('_');
        const targetTgId = parts[3];
        const amount = parts[4];

        await bot.sendMessage(targetTgId, `✅ Ваша заявка на вывод ${amount} ₽ успешно обработана! Деньги отправлены на вашу банковскую карту.`);
        await bot.editMessageText(`✅ Вывод средств на сумму ${amount} ₽ для игрока \`${targetTgId}\` выполнен.`, {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
            parse_mode: 'Markdown'
        });
        await bot.answerCallbackQuery(query.id, { text: 'Вывод подтвержден!' });
    }
    else if (data.startsWith('user_paid_')) {
        const parts = data.split('_');
        const targetTgId = parts[3];
        const amount = parts[4];

        if (ADMIN_CHAT_ID && ADMIN_CHAT_ID !== 'YOUR_ADMIN_CHAT_ID') {
            await bot.sendMessage(ADMIN_CHAT_ID, `🔔 Пользователь \`${targetTgId}\` нажал кнопку **"Я оплатил"** для пополнения на ${amount} ₽! Проверьте поступление денег и нажмите подтверждение.`, { parse_mode: 'Markdown' });
        }
        await bot.answerCallbackQuery(query.id, { text: 'Уведомление отправлено администратору!' });
        await bot.editMessageText(`✅ Вы сообщили об оплате. Ожидайте подтверждения администратора.`, {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id
        });
    }
});

bot.on('message', async (msg) => {
    // Обработка успешной оплаты Telegram Stars
    if (msg.successful_payment) {
        const payload = msg.successful_payment.invoice_payload;
        if (payload && payload.startsWith('topup_')) {
            const parts = payload.split('_');
            const tgId = parts[1];
            const rubles = parseFloat(parts[3]);
            
            const user = getOrCreateUser(tgId);
            user.balance += rubles;
            saveData();

            await bot.sendMessage(tgId, `✅ Оплата через Telegram Stars прошла успешно! Баланс пополнен на ${Math.round(rubles)} ₽.`);
        }
        return;
    }

    const adminId = msg.from.id;
    const text = msg.text;

    if (!text) return;

    if (text.startsWith('/newgiveaway')) {
        const lines = text.split('\n');
        let title = '', sponsor = '', timer = '', image = '';
        lines.forEach(line => {
            if (line.startsWith('Prize:') || line.startsWith('Приз:')) title = line.replace(/^(Prize:|Приз:)/, '').trim();
            if (line.startsWith('Sponsor:') || line.startsWith('Спонсор:')) sponsor = line.replace(/^(Sponsor:|Спонсор:)/, '').trim();
            if (line.startsWith('Timer:') || line.startsWith('Таймер:')) timer = line.replace(/^(Timer:|Таймер:)/, '').trim();
            if (line.startsWith('Image:') || line.startsWith('Картинка:')) image = line.replace(/^(Image:|Картинка:)/, '').trim();
        });
        if (!title || !sponsor) return;
        let sponsorUsername = sponsor.trim();
        if (sponsorUsername.includes('t.me/')) {
            const clean = sponsorUsername.split('t.me/')[1].replace('/', '');
            sponsorUsername = '@' + clean;
        } else if (!sponsorUsername.startsWith('@') && !sponsorUsername.startsWith('http')) {
            sponsorUsername = '@' + sponsorUsername;
        }
        giveaways.push({
            _id: Date.now().toString(),
            title, sponsor, sponsorUsername,
            timer: timer || 'Скоро',
            image: image || 'https://community.cloudflare.steamstatic.com/economy/image/-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I56KU0Zwwo4NUX4oFJZEHLbXH5ApeO4YmlhxYQknCRvCo04DEVlxkKgpot7HxfDhjxszJemkV092lnYmOhcj5Nr_Yg2ZU7PFohO_J9o-j2Vfk8hVtNjjwJ9ORfVFvY1-G_wO7x-_u1sS5uJ6ayXswuSM8pGGKYW964g/360fx360f',
            participantsCount: 0, participants: []
        });
        saveData();
        await bot.sendMessage(msg.chat.id, `✅ Розыгрыш "${title}" добавлен!`);
        return;
    }

    if (adminStates[adminId] && adminStates[adminId].action === 'awaiting_card') {
        const state = adminStates[adminId];
        delete adminStates[adminId];

        const cardNumber = text.trim();
        const targetTgId = state.targetTgId;
        const amount = state.amount;
        const sumAmount = state.sumAmount;

        try {
            await bot.sendMessage(targetTgId, 
                `💳 **Реквизиты для оплаты P2P UZ**\n\n` +
                `Сумма к оплате: **${sumAmount} сум** (${amount} ₽)\n` +
                `Номер карты для перевода:\n\`${cardNumber}\`\n\n` +
                `После перевода нажмите кнопку ниже, чтобы администратор проверил поступление.`, 
                {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '✅ Я оплатил(-а)', callback_data: `user_paid_${adminId}_${targetTgId}_${amount}` }]
                        ]
                    }
                }
            );

            if (ADMIN_CHAT_ID && ADMIN_CHAT_ID !== 'YOUR_ADMIN_CHAT_ID') {
                await bot.sendMessage(ADMIN_CHAT_ID, 
                    `✅ **Номер карты отправлен пользователю.**\n` +
                    `👤 Пользователь ID: \`${targetTgId}\`\n` +
                    `💳 Карта: \`${cardNumber}\`\n` +
                    `⏳ Ожидайте подтверждения оплаты от него.`,
                    {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: `✅ Подтвердить зачисление (${amount} ₽)`, callback_data: `p2p_confirm_pay_${targetTgId}_${amount}` }]
                            ]
                        }
                    }
                );
            }
        } catch (e) {
            await bot.sendMessage(msg.chat.id, `❌ Ошибка отправки: пользователь не запустил бота в личных сообщениях.`);
        }
        return;
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Bot and Server are running on port ${PORT}`);
});
