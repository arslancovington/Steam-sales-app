const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const TOKEN = process.env.BOT_TOKEN || 'YOUR_TELEGRAM_BOT_TOKEN';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || 'YOUR_ADMIN_CHAT_ID';
const CRYPTO_BOT_TOKEN = process.env.CRYPTO_BOT_TOKEN || ''; 
const WEB_APP_URL = process.env.WEB_APP_URL || 'https://your-domain.com';

const bot = new TelegramBot(TOKEN, { polling: true });
const app = express();

bot.on('polling_error', (error) => {
    console.error('⚠️ Ошибка Telegram:', error.code, error.message);
});

bot.on('error', (error) => {
    console.error('⚠️ Общая ошибка бота:', error.code, error.message);
});

app.use(express.json());
app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const dataDir = '/data';
if (!fs.existsSync(dataDir)) {
    try { fs.mkdirSync(dataDir, { recursive: true }); } catch (e) {}
}

const dbFile = fs.existsSync(dataDir) ? path.join(dataDir, 'database.json') : path.join(__dirname, 'database.json');
const cardsFile = fs.existsSync(dataDir) ? path.join(dataDir, 'cards.json') : path.join(__dirname, 'cards.json');

let db = { users: {}, marketItems: [], giveaways: [], activeDeals: [], battleWinnersHistory: [] };
let cards = [];

if (fs.existsSync(dbFile)) {
    try { 
        db = JSON.parse(fs.readFileSync(dbFile, 'utf8')); 
        if (!db.activeDeals) db.activeDeals = [];
        if (!db.battleWinnersHistory) db.battleWinnersHistory = [];
    } catch (e) {}
}

if (fs.existsSync(cardsFile)) {
    try { 
        cards = JSON.parse(fs.readFileSync(cardsFile, 'utf8'));
        cards = cards.map(c => ({ ...c, type: c.type || 'UZ' }));
    } catch (e) {}
}

let users = db.users || {};
let marketItems = db.marketItems || [];
let giveaways = db.giveaways || [];
let activeDeals = db.activeDeals || [];
let battleWinnersHistory = db.battleWinnersHistory || [];

let currentBattle = {
    _id: 'b_' + Date.now(),
    bank: 0,
    status: 'waiting', // waiting, active, spinning, finished
    timer: 15,
    participants: [], 
    betsFeed: [],     
    winner: null,
    endTime: null
};

let cardIndexRu = 0;
let cardIndexUz = 0;

function saveData() {
    try { 
        fs.writeFileSync(dbFile, JSON.stringify({ users, marketItems, giveaways, activeDeals, battleWinnersHistory }, null, 2)); 
    } catch (e) {}
}

function getOrCreateUser(tgId, username = 'Игрок') {
    const now = Date.now();
    if (!users[tgId]) {
        users[tgId] = { 
            tgId, 
            username: username || 'Игрок', 
            balance: 0, 
            rating: 5.0, 
            completedDeals: 0, 
            tradeUrl: '', 
            steamId: '',
            lastActive: now
        };
        saveData();
    } else {
        users[tgId].lastActive = now;
        if (username && username !== 'Игрок' && users[tgId].username !== username) {
            users[tgId].username = username;
        }
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

// Точный серверный таймер
setInterval(() => {
    if (currentBattle.status === 'active' && currentBattle.endTime) {
        if (currentBattle.participants.length < 2) {
            currentBattle.timer = 15;
            currentBattle.endTime = null;
            currentBattle.status = 'waiting';
            return;
        }

        const remaining = Math.ceil((currentBattle.endTime - Date.now()) / 1000);
        currentBattle.timer = remaining > 0 ? remaining : 0;
        
        if (currentBattle.timer <= 0 && currentBattle.status === 'active') {
            currentBattle.status = 'spinning';
            
            let total = currentBattle.bank;
            let randomTicket = Math.random() * total;
            let currentSum = 0;
            let winnerObj = currentBattle.participants[0];
            
            for (let p of currentBattle.participants) {
                currentSum += p.amount;
                if (randomTicket <= currentSum) {
                    winnerObj = p;
                    break;
                }
            }
            
            const totalBank = currentBattle.bank;
            const prize = Math.round(totalBank * 0.8);
            
            currentBattle.winner = winnerObj;
            
            if (users[winnerObj.tgId]) {
                users[winnerObj.tgId].balance += prize;
                users[winnerObj.tgId].completedDeals = (users[winnerObj.tgId].completedDeals || 0) + 1;
            }
            
            battleWinnersHistory.push({
                tgId: winnerObj.tgId,
                username: winnerObj.username,
                prize: prize
            });
            saveData();
            
            bot.sendMessage(winnerObj.tgId, `🏆 Поздравляем! Вы выиграли в Королевской Битве банк <b>${totalBank} ₽</b>.\n💰 С учетом комиссии 20% на ваш баланс зачислено: <b>${prize} ₽</b>!`, { parse_mode: 'HTML' }).catch(()=>{});

            // 13 секунд анимации рулетки
            setTimeout(() => {
                currentBattle.status = 'finished';
            }, 13000);

            // Сброс раунда
            setTimeout(() => {
                currentBattle = {
                    _id: 'b_' + Date.now(),
                    bank: 0,
                    status: 'waiting',
                    timer: 15,
                    participants: [],
                    betsFeed: [],
                    winner: null,
                    endTime: null
                };
            }, 18500);
        }
    }
}, 1000);

// ================= TELEGRAM BOT COMMANDS =================
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const user = getOrCreateUser(chatId, msg.from.username || msg.from.first_name);

    bot.sendMessage(chatId, `👋 Привет, <b>${user.username}</b>!\n\nДобро пожаловать в официальный P2P маркетплейс CS2 скинов и Королевской Битвы.`, {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [{ text: '🎮 Открыть P2P Маркетплейс', web_app: { url: WEB_APP_URL } }],
                [{ text: '💬 Поддержка', url: 'https://t.me/your_support' }]
            ]
        }
    });
});

bot.onText(/\/giveaway\s+(.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (ADMIN_CHAT_ID && ADMIN_CHAT_ID !== 'YOUR_ADMIN_CHAT_ID' && String(chatId) !== String(ADMIN_CHAT_ID)) {
        return bot.sendMessage(chatId, '❌ У вас нет прав для создания розыгрышей.');
    }

    const parts = match[1].split('|').map(p => p.trim());
    if (parts.length < 4) {
        return bot.sendMessage(chatId, '❌ Неверный формат!\nИспользуйте: `/giveaway Название | @channel | URL_картинки | 24 часа`', { parse_mode: 'Markdown' });
    }

    const [title, sponsorUsername, image, timer] = parts;

    const newGiveaway = {
        _id: 'g_' + Date.now(),
        title,
        sponsorUsername,
        image,
        timer,
        participants: [],
        participantsCount: 0
    };

    giveaways.push(newGiveaway);
    saveData();

    bot.sendMessage(chatId, `✅ Розыгрыш успешно создан!\n\n🎁 <b>${title}</b>\n📢 Спонсор: ${sponsorUsername}\n⏳ Время: ${timer}`, { parse_mode: 'HTML' });
});

// ================= API =================
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
    if (steamId) user.steamId = steamId;

    saveData();
    res.json({ success: true, steamId: user.steamId });
});

app.get('/api/market/items', (req, res) => {
    res.json({ success: true, items: marketItems });
});

app.post('/api/market/add', (req, res) => {
    const item = req.body;
    const user = getOrCreateUser(item.tgId);
    item._id = Date.now().toString();
    marketItems.push(item);
    saveData();
    res.json({ success: true, newBalance: user.balance });
});

app.post('/api/deals/buy', async (req, res) => {
    const { itemId, buyerTgId, buyerTradeUrl, buyerName } = req.body;
    const itemIndex = marketItems.findIndex(i => i._id === itemId);
    if (itemIndex === -1) return res.json({ success: false, error: 'Лот не найден' });

    const item = marketItems[itemIndex];
    const buyer = getOrCreateUser(buyerTgId, buyerName);

    if (buyer.balance < item.price) {
        return res.json({ success: false, error: 'Недостаточно средств на балансе' });
    }

    buyer.balance -= item.price;
    marketItems.splice(itemIndex, 1);

    const dealId = 'deal_' + Date.now();
    const deal = {
        _id: dealId,
        itemId: item._id,
        name: item.name,
        price: item.price,
        image: item.image,
        sellerTgId: item.tgId,
        buyerTgId,
        buyerUsername: buyerName,
        buyerTradeUrl,
        status: 'waiting_send'
    };
    activeDeals.push(deal);
    saveData();

    try {
        await bot.sendMessage(item.tgId, 
            `📦 <b>Куплен ваш скин: ${item.name}</b>\n\n` +
            `💰 Сумма: <b>${item.price} ₽</b>\n` +
            `👤 Покупатель: @${buyerName}\n` +
            `🔗 Trade URL покупателя: <code>${buyerTradeUrl || 'Не указана'}</code>\n\n` +
            `⚠️ Передайте предмет в Steam по трейд-ссылке покупателя, после чего нажмите кнопку ниже:`,
            {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '📦 Я отправил предмет', callback_data: `deal_sent_${dealId}` }]
                    ]
                }
            }
        );
    } catch (e) {}

    res.json({ success: true, newBalance: buyer.balance });
});

app.get('/api/giveaways/list', (req, res) => {
    res.json({ success: true, giveaways });
});

app.post('/api/giveaways/join', async (req, res) => {
    const { tgId, giveawayId } = req.body;
    const giveaway = giveaways.find(g => g._id === giveawayId);
    
    if (!giveaway) return res.json({ success: false, error: 'Розыгрыш не найден' });
    if (giveaway.participants.includes(String(tgId))) return res.json({ success: false, error: 'Вы уже участвуете в этом розыгрыше!' });

    if (giveaway.sponsorUsername) {
        try {
            const chatMember = await bot.getChatMember(giveaway.sponsorUsername, tgId);
            const isMember = ['creator', 'administrator', 'member'].includes(chatMember.status);
            if (!isMember) {
                return res.json({ success: false, error: `Для участия необходимо подписаться на спонсора: ${giveaway.sponsorUsername}` });
            }
        } catch (err) {
            return res.json({ success: false, error: `Подпишитесь на канал спонсора: ${giveaway.sponsorUsername}` });
        }
    }

    giveaway.participants.push(String(tgId));
    giveaway.participantsCount = giveaway.participants.length;
    saveData();
    res.json({ success: true });
});

// ================= JACKPOT API =================
app.get('/api/battles/current', (req, res) => {
    let battleCopy = JSON.parse(JSON.stringify(currentBattle));
    if (battleCopy.bank > 0) {
        battleCopy.participants.forEach(p => {
            p.chance = ((p.amount / battleCopy.bank) * 100).toFixed(2);
        });
    }
    res.json({ success: true, battle: battleCopy });
});

app.post('/api/battles/bet', (req, res) => {
    const { tgId, username, photo, amount } = req.body;
    const betAmount = parseFloat(amount);

    if (!betAmount || betAmount < 10) {
        return res.json({ success: false, error: 'Минимальная ставка 10 ₽' });
    }

    if (currentBattle.status === 'finished' || currentBattle.status === 'spinning') {
        return res.json({ success: false, error: 'Раунд завершается, дождитесь нового' });
    }

    const user = getOrCreateUser(tgId, username);
    if (user.balance < betAmount) {
        return res.json({ success: false, error: 'Недостаточно средств на балансе' });
    }

    user.balance -= betAmount;
    currentBattle.bank += betAmount;

    const colors = ['#ff007f', '#00ffff', '#7cfc00', '#bf00ff', '#ffa500', '#ff4d4d', '#ffff00', '#1e90ff'];
    let existing = currentBattle.participants.find(p => String(p.tgId) === String(tgId));

    let participantColor = '';
    if (existing) {
        existing.amount += betAmount;
        participantColor = existing.color;
    } else {
        participantColor = colors[currentBattle.participants.length % colors.length];
        currentBattle.participants.push({
            tgId,
            username: username || user.username || `User_${tgId}`,
            photo: photo || user.photo || null,
            amount: betAmount,
            color: participantColor
        });
    }

    if (currentBattle.participants.length >= 2 && currentBattle.status === 'waiting') {
        currentBattle.status = 'active';
        currentBattle.endTime = Date.now() + 15000;
        currentBattle.timer = 15;
    }

    currentBattle.betsFeed.unshift({
        username: username || user.username || `User_${tgId}`,
        photo: photo || user.photo || null,
        amount: betAmount,
        color: participantColor
    });
    if (currentBattle.betsFeed.length > 10) currentBattle.betsFeed.pop();

    saveData();
    res.json({ success: true, newBalance: user.balance, battle: currentBattle });
});

app.get('/api/battles/leaderboard', (req, res) => {
    let winsCount = {};
    battleWinnersHistory.forEach(w => {
        winsCount[w.username] = (winsCount[w.username] || 0) + 1;
    });

    let leaderboard = Object.keys(winsCount).map(username => ({
        username,
        wins: winsCount[username]
    })).sort((a, b) => b.wins - a.wins).slice(0, 10);

    res.json({ success: true, leaderboard });
});

app.post('/api/steam/inventory', async (req, res) => {
    let { steamId, tgId } = req.body;
    if (!steamId && tgId && users[tgId]) steamId = users[tgId].steamId;
    if (!steamId) return res.json({ success: false, items: [], descriptions: [] });

    try {
        const invRes = await axios.get(`https://steamcommunity.com/inventory/${steamId}/730/2?l=russian&count=75`, {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'ru-RU,ru;q=0.9' },
            timeout: 10000
        });
        if (invRes?.data?.success) {
            res.json({ success: true, items: invRes.data.assets || [], descriptions: invRes.data.descriptions || [] });
        } else {
            res.json({ success: false, items: [], descriptions: [] });
        }
    } catch (e) {
        res.json({ success: false, items: [], descriptions: [] });
    }
});

app.post('/api/billing/invoice', async (req, res) => {
    const { tgId, amount, currency } = req.body;
    try {
        if (currency === 'crypto' && CRYPTO_BOT_TOKEN) {
            const cryptoRes = await axios.post('https://pay.crypt.bot/api/createInvoice', {
                asset: 'USDT',
                amount: String(amount),
                description: `Пополнение баланса на ${amount} USDT`
            }, {
                headers: { 'Crypto-Pay-API-Token': CRYPTO_BOT_TOKEN }
            });

            if (cryptoRes.data && cryptoRes.data.ok) {
                const invoice = cryptoRes.data.result;
                await bot.sendMessage(tgId, `💎 <b>Счет на оплату через Crypto Bot</b>\n\nСумма: <b>${amount} USDT</b>`, {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [[{ text: '💳 Оплатить счет', url: invoice.pay_url }]]
                    }
                });
                return res.json({ success: true });
            }
        }

        if (currency === 'p2pru' || currency === 'p2puz') {
            const isRu = (currency === 'p2pru');
            const targetType = isRu ? 'RU' : 'UZ';
            const filteredCards = cards.filter(c => (c.type || 'UZ') === targetType);
            
            if (filteredCards.length === 0) {
                return res.json({ success: false, error: `Карты не найдены.` });
            }

            let activeCard = isRu ? filteredCards[cardIndexRu % filteredCards.length] : filteredCards[cardIndexUz % filteredCards.length];
            if (isRu) cardIndexRu = (cardIndexRu + 1) % filteredCards.length;
            else cardIndexUz = (cardIndexUz + 1) % filteredCards.length;

            const paySum = isRu ? `${amount} ₽` : `${Math.round(amount * 175).toLocaleString()} сум`;
            await bot.sendMessage(tgId, 
                `💳 <b>Реквизиты для оплаты ${currency.toUpperCase()}</b>\n\n` +
                `Сумма: <b>${paySum}</b>\n` +
                `Карта (${activeCard.holder}):\n<code>${activeCard.number}</code>`, 
                {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [[{ text: '✅ Я оплатил(-а)', callback_data: `user_paid_${tgId}_${amount}` }]]
                    }
                }
            );

            if (ADMIN_CHAT_ID && ADMIN_CHAT_ID !== 'YOUR_ADMIN_CHAT_ID') {
                await bot.sendMessage(ADMIN_CHAT_ID, 
                    `🔔 <b>Запрос на пополнение!</b>\nПользователь ID: <code>${tgId}</code>\nСумма: <b>${amount} ₽</b>`, 
                    {
                        parse_mode: 'HTML',
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    { text: `✅ Подтвердить`, callback_data: `p2p_confirm_pay_${tgId}_${amount}` },
                                    { text: `❌ Отклонить`, callback_data: `p2p_cancel_${tgId}_${amount}` }
                                ]
                            ]
                        }
                    }
                );
            }
        }
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, error: 'Не удалось отправить счет.' });
    }
});

app.post('/api/billing/withdraw', async (req, res) => {
    const { tgId, amount, recipientAccount, username } = req.body;
    const user = getOrCreateUser(tgId, username);
    
    if (user.balance < amount) return res.json({ success: false, error: 'Недостаточно средств' });

    user.balance -= amount;
    saveData();

    try {
        if (ADMIN_CHAT_ID && ADMIN_CHAT_ID !== 'YOUR_ADMIN_CHAT_ID') {
            await bot.sendMessage(ADMIN_CHAT_ID, 
                `💸 <b>Заявка на вывод средств!</b>\n\nИгрок: @${username || tgId}\nСумма: <b>${amount} ₽</b>\nРеквизиты: <code>${recipientAccount}</code>`, 
                {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '✅ Выполнено', callback_data: `p2p_withdraw_done_${tgId}_${amount}` },
                                { text: '❌ Возврат', callback_data: `p2p_cancel_${tgId}_${amount}` }
                            ]
                        ]
                    }
                }
            );
        }
        res.json({ success: true, newBalance: user.balance });
    } catch (e) {
        user.balance += amount;
        saveData();
        res.json({ success: false, error: 'Ошибка отправки админу.' });
    }
});

bot.on('callback_query', async (query) => {
    const data = query.data;

    if (data.startsWith('deal_sent_')) {
        const dealId = data.replace('deal_sent_', '');
        const deal = activeDeals.find(d => d._id === dealId);
        if (!deal) return bot.answerCallbackQuery(query.id, { text: 'Сделка не найдена' });

        deal.status = 'waiting_receive';
        saveData();

        await bot.editMessageText(`📦 Вы подтвердили отправку предмета <b>${deal.name}</b>. Ожидаем подтверждения от покупателя.`, {
            chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: 'HTML'
        });

        try {
            await bot.sendMessage(deal.buyerTgId,
                `📦 <b>Продавец отправил предмет: ${deal.name}</b>\n\nПроверьте свой инвентарь Steam и подтвердите получение.`,
                {
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: '✅ Я получил предмет', callback_data: `deal_recv_${dealId}` }]] }
                }
            );
        } catch(e) {}

        await bot.answerCallbackQuery(query.id, { text: 'Статус обновлен!' });
    }
    else if (data.startsWith('deal_recv_')) {
        const dealId = data.replace('deal_recv_', '');
        const deal = activeDeals.find(d => d._id === dealId);
        if (!deal) return bot.answerCallbackQuery(query.id, { text: 'Сделка не найдена' });

        deal.status = 'completed';
        const seller = getOrCreateUser(deal.sellerTgId);
        seller.balance += deal.price;
        seller.completedDeals = (seller.completedDeals || 0) + 1;
        saveData();

        await bot.editMessageText(`✅ Вы подтвердили получение предмета <b>${deal.name}</b>. Сделка успешно завершена!`, {
            chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: 'HTML'
        });

        try {
            await bot.sendMessage(deal.sellerTgId, `🎉 Покупатель подтвердил получение предмета <b>${deal.name}</b>! Средства <b>${deal.price} ₽</b> зачислены на баланс.`, { parse_mode: 'HTML' });
        } catch(e) {}

        await bot.answerCallbackQuery(query.id, { text: 'Сделка завершена!' });
    }
    else if (data.startsWith('p2p_confirm_pay_')) {
        const parts = data.split('_');
        const targetTgId = parts[3];
        const amount = parseFloat(parts[4]);

        const user = getOrCreateUser(targetTgId);
        user.balance += amount;
        saveData();

        await bot.sendMessage(targetTgId, `✅ Оплата на сумму <b>${amount} ₽</b> подтверждена! Баланс пополнен.`, { parse_mode: 'HTML' });
        await bot.editMessageText(`✅ Пополнение на ${amount} ₽ подтверждено.`, { chat_id: query.message.chat.id, message_id: query.message.message_id });
        await bot.answerCallbackQuery(query.id, { text: 'Подтверждено!' });
    }
    else if (data.startsWith('p2p_withdraw_done_')) {
        const parts = data.split('_');
        const targetTgId = parts[3];
        const amount = parts[4];

        await bot.sendMessage(targetTgId, `✅ Вывод <b>${amount} ₽</b> успешно выполнен!`, { parse_mode: 'HTML' });
        await bot.editMessageText(`✅ Вывод выполнен.`, { chat_id: query.message.chat.id, message_id: query.message.message_id });
        await bot.answerCallbackQuery(query.id, { text: 'Вывод подтвержден!' });
    }
    else if (data.startsWith('p2p_cancel_')) {
        const parts = data.split('_');
        const targetTgId = parts[2];
        const amount = parts[3];

        const user = getOrCreateUser(targetTgId);
        user.balance += parseFloat(amount);
        saveData();

        await bot.sendMessage(targetTgId, `❌ Операция на сумму <b>${amount} ₽</b> отклонена (средства возвращены на баланс).`, { parse_mode: 'HTML' });
        await bot.editMessageText(`❌ Отклонено.`, { chat_id: query.message.chat.id, message_id: query.message.message_id });
        await bot.answerCallbackQuery(query.id, { text: 'Отменено.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
