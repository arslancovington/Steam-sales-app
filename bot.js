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
    status: 'waiting',
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

// Локальный фоллбек-расчет цены, если Steam API временно недоступен
function estimatePriceLocally(name) {
    const lower = name.toLowerCase();
    if (lower.includes('кейс') || lower.includes('case')) return Math.floor(Math.random() * 40) + 15;
    if (lower.includes('наклейка') || lower.includes('sticker') || lower.includes('граффити')) return Math.floor(Math.random() * 80) + 20;
    if (lower.includes('нож') || lower.includes('knife') || lower.includes('керамбит') || lower.includes('штык') || lower.includes('коготь') || lower.includes('бабочка')) return 6500;
    if (lower.includes('перчатки') || lower.includes('gloves') || lower.includes('обмотки')) return 5000;
    let base = 150;
    if (lower.includes('stattrak™') || lower.includes('stattrak')) base = 350;
    return base;
}

// Таймер джекпота
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

            setTimeout(() => {
                currentBattle.status = 'finished';
            }, 13000);

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

// Telegram Bot
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

// API Эндпоинты
app.get('/api/steam/price', async (req, res) => {
    const itemName = req.query.name;
    if (!itemName) return res.json({ success: false, error: 'Name required' });
    
    try {
        const url = `https://steamcommunity.com/market/priceoverview/?appid=730&currency=5&market_hash_name=${encodeURIComponent(itemName)}`;
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
                'Cookie': 'steamCountry=RU|1a2b3c'
            }
        });
        
        if (response.status === 429 || response.status === 403) {
            return res.json({ success: true, price: estimatePriceLocally(itemName) });
        }

        const data = await response.json();
        if (data && data.success && (data.lowest_price || data.median_price)) {
            const rawPrice = data.lowest_price || data.median_price;
            const cleanPrice = parseFloat(rawPrice.replace(/[^\d,.]/g, '').replace(',', '.'));
            return res.json({ success: true, price: isNaN(cleanPrice) ? estimatePriceLocally(itemName) : cleanPrice });
        } else {
            return res.json({ success: true, price: estimatePriceLocally(itemName) });
        }
    } catch (err) {
        return res.json({ success: true, price: estimatePriceLocally(itemName) });
    }
});

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

    if (item.isVip) {
        if (user.balance < 120) {
            return res.json({ success: false, error: 'Недостаточно средств для VIP-объявления (нужно 120 ₽)' });
        }
        user.balance -= 120;
    }

    item._id = Date.now().toString();
    marketItems.unshift(item);
    saveData();
    res.json({ success: true, newBalance: user.balance });
});

app.post('/api/external/sell', (req, res) => {
    const { tgId, price } = req.body;
    const user = getOrCreateUser(tgId);
    const sellPrice = parseFloat(price);
    if (!sellPrice || sellPrice <= 0) return res.json({ success: false, error: 'Неверная цена' });

    user.balance += sellPrice;
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

// Jackpot API
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

// Отдача единой HTML страницы со встроенной динамической загрузкой цен Стим
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="ru">
<head> 
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>CS2 Cash & Skins — Marketplace</title>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>

    <style>
        :root {
            --bg-color: #0b1110;
            --neon-green: #7cfc00;
            --neon-cyan: #00ffff;
            --neon-purple: #bf00ff;
            --neon-pink: #ff007f;
            --card-bg: rgba(20, 30, 25, 0.7);
            --text-main: #ffffff;
            --text-muted: #889988;
            --danger-red: #ff4d4d;
            --vip-gold: #ffd700;
        }

        * { box-sizing: border-box; }
        body { background-color: var(--bg-color); color: var(--text-main); font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; font-size: 14px; margin: 0; padding: 0; overflow-x: hidden; }

        h2 { font-size: 18px; margin: 0 0 12px 0; }
        h3 { font-size: 16px; margin: 0; }
        h4 { font-size: 12px; margin: 0; }

        .top-bar { display: flex; justify-content: space-between; align-items: center; padding: 10px 15px; background: rgba(11, 17, 16, 0.95); position: sticky; top: 0; z-index: 100; border-bottom: 1px solid rgba(255,255,255,0.05); }
        .bot-profile { display: flex; align-items: center; gap: 8px; }
        .bot-name { font-weight: bold; font-size: 13px; }
        .bot-status { color: var(--neon-green); font-size: 10px; font-weight: bold; }

        .balance-widget { display: flex; align-items: center; gap: 8px; padding: 4px 8px; border-radius: 6px; border: 1px solid var(--neon-green); font-size: 13px; background: rgba(124, 252, 0, 0.05); }
        .add-funds-btn { background: transparent; color: var(--neon-green); border: none; font-size: 18px; cursor: pointer; padding: 0; line-height: 1; }

        .tab { display: none; padding: 12px 15px; padding-bottom: 85px; }
        .tab.active { display: block; }
        .neon-text { color: var(--text-main); text-shadow: 0 0 5px var(--neon-green); }
        
        .section-title { margin-top: 18px; border-bottom: 1px solid #333; padding-bottom: 4px; font-size: 14px; }
        .hint-text { font-size: 11px; color: var(--text-muted); margin: 6px 0 0 0; }

        .steam-login-btn { display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; padding: 10px; background: #171a21; border: 1px solid #66c0f4; color: white; border-radius: 8px; font-weight: bold; cursor: pointer; margin-bottom: 12px; font-size: 12px; }
        .trade-url-box { display: flex; gap: 8px; margin-bottom: 12px; padding: 8px; border-radius: 8px; background: var(--card-bg); border: 1px solid #222; }
        .trade-url-box input { flex: 1; padding: 8px; background: #111; border: 1px solid #333; color: white; border-radius: 6px; font-size: 11px; }
        .btn-cyan { background: transparent; color: var(--neon-cyan); border: 1px solid var(--neon-cyan); padding: 8px 12px; border-radius: 6px; cursor: pointer; font-size: 11px; }

        .grid-layout { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
        .card { background: var(--card-bg); padding: 10px; border-radius: 10px; border: 1px solid rgba(255, 255, 255, 0.08); display: flex; flex-direction: column; justify-content: space-between; position: relative; overflow: hidden; }
        .card.vip-card { border: 1px solid var(--vip-gold); box-shadow: 0 0 10px rgba(255, 215, 0, 0.25); background: linear-gradient(135deg, rgba(30, 30, 20, 0.8), rgba(20, 30, 25, 0.7)); }
        .vip-badge { position: absolute; top: 4px; right: 6px; font-size: 9px; background: var(--vip-gold); color: #000; font-weight: bold; padding: 1px 4px; border-radius: 4px; text-transform: uppercase; }

        .skin-image { width: 100%; height: 90px; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.3); border-radius: 8px; margin-bottom: 6px; }
        .skin-img { width: 100%; height: 100%; object-fit: contain; padding: 4px; }
        .card-title { font-size: 11px; font-weight: bold; margin: 4px 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; width: 100%; color: #fff; }
        
        .btn-green-glow { width: 100%; background: var(--neon-green); border: none; color: #000; font-weight: bold; padding: 8px; border-radius: 6px; cursor: pointer; font-size: 11px; margin-top: 6px; text-transform: uppercase; box-shadow: 0 0 8px rgba(124,252,0,0.3); }

        .jackpot-header-box { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
        .jackpot-bank-title { font-size: 11px; color: var(--text-muted); text-transform: uppercase; }
        .jackpot-bank-val { font-size: 20px; font-weight: bold; color: var(--neon-green); text-shadow: 0 0 8px rgba(124,252,0,0.4); }
        .jackpot-timer-val { font-size: 18px; font-weight: bold; color: #fff; background: rgba(255,255,255,0.06); padding: 4px 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.1); }

        .jackpot-arena { width: 100%; height: 180px; background: #141e19; border-radius: 10px; border: 1px solid rgba(255,0,127,0.3); display: flex; overflow: hidden; position: relative; margin-bottom: 12px; box-shadow: 0 0 12px rgba(255,0,127,0.15); }
        .jackpot-column { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; position: relative; transition: width 0.4s ease; border-right: 1px solid rgba(0,0,0,0.3); padding: 8px; text-align: center; overflow: hidden; }
        .jackpot-col-avatar { width: 50px; height: 50px; border-radius: 50%; border: 2px solid #fff; object-fit: cover; background: #222; display: flex; align-items: center; justify-content: center; font-size: 16px; font-weight: bold; color: #fff; margin-bottom: 6px; box-shadow: 0 0 8px rgba(0,0,0,0.5); overflow: hidden; flex-shrink: 0; }
        .jackpot-col-chance { font-size: 12px; font-weight: bold; color: #fff; text-shadow: 0 0 4px rgba(0,0,0,0.8); }
        .jackpot-col-name { font-size: 10px; color: #fff; text-shadow: 0 0 3px rgba(0,0,0,0.8); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; margin-top: 2px; }

        .bets-feed-title { font-size: 11px; color: var(--text-muted); text-transform: uppercase; margin: 12px 0 6px 0; }
        .bets-feed-list { display: flex; flex-direction: column; gap: 5px; max-height: 140px; overflow-y: auto; margin-bottom: 15px; }
        .bet-feed-item { display: flex; align-items: center; justify-content: space-between; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.04); border-radius: 6px; padding: 6px 10px; font-size: 11px; }
        .bet-feed-user { display: flex; align-items: center; gap: 6px; }
        .bet-feed-av { width: 24px; height: 24px; border-radius: 50%; object-fit: cover; background: #333; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: bold; overflow: hidden; flex-shrink: 0; }
        .bet-feed-sum { font-weight: bold; color: var(--neon-green); font-size: 12px; }

        .roulette-window { position: relative; width: 100%; height: 180px; background: #000; overflow: hidden; border-radius: 10px; border: 1px solid var(--neon-pink); display: flex; align-items: center; }
        .roulette-pointer { position: absolute; top: 0; bottom: 0; left: 50%; transform: translateX(-50%); width: 3px; background: var(--neon-green); z-index: 20; box-shadow: 0 0 8px var(--neon-green); }
        .roulette-strip { display: flex; position: absolute; left: 0; height: 100%; will-change: transform; transition: transform 13s cubic-bezier(0.08, 0.82, 0.17, 1); align-items: center; }
        .roulette-item { flex: 0 0 90px; width: 90px; height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; background: rgba(255,255,255,0.03); border-right: 1px solid rgba(255,255,255,0.08); padding: 10px; }
        .roulette-item img { width: 50px; height: 50px; border-radius: 50%; object-fit: cover; border: 2px solid var(--neon-pink); margin-bottom: 6px; }
        .roulette-item span { font-size: 11px; color: #fff; width: 85px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: center; }

        .giveaway-card { background: linear-gradient(135deg, rgba(20, 30, 25, 0.9), rgba(11, 17, 16, 0.95)); border: 1px solid var(--neon-purple); border-radius: 10px; padding: 12px; margin-bottom: 10px; display: flex; flex-direction: column; gap: 6px; box-shadow: 0 0 8px rgba(191,0,255,0.15); }
        .giveaway-header { display: flex; justify-content: space-between; align-items: center; font-size: 11px; }
        .giveaway-timer { font-size: 10px; color: var(--text-muted); background: rgba(0,0,0,0.4); padding: 2px 5px; border-radius: 4px; }
        .giveaway-title { font-size: 13px; font-weight: bold; color: var(--text-main); margin: 0; }

        .modal-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.85); z-index: 1000; justify-content: center; align-items: center; }
        .modal-overlay.active { display: flex; }
        .modal-content { background: var(--bg-color); padding: 20px; border-radius: 12px; width: 90%; max-width: 360px; text-align: center; border: 1px solid var(--neon-green); box-shadow: 0 0 15px rgba(124,252,0,0.2); font-size: 12px; }
        .price-input-container { position: relative; margin: 12px 0; }
        .currency-symbol { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: var(--neon-cyan); font-weight: bold; }
        .topup-input { width: 100%; padding: 10px 10px 10px 30px; background: #111; border: 1px solid var(--neon-cyan); color: white; border-radius: 6px; font-size: 12px; }

        .fullscreen-winner-overlay { position: fixed; inset: 0; background: rgba(11, 17, 16, 0.96); z-index: 9999; display: none; flex-direction: column; align-items: center; justify-content: center; padding: 20px; text-align: center; }
        .fullscreen-winner-overlay.active { display: flex; }

        .leaderboard-table { width: 100%; border-collapse: collapse; margin-top: 8px; background: var(--card-bg); border-radius: 8px; overflow: hidden; border: 1px solid rgba(255,255,255,0.05); }
        .leaderboard-table th, .leaderboard-table td { padding: 8px 10px; text-align: left; font-size: 11px; }
        .leaderboard-table th { background: rgba(255, 0, 127, 0.15); color: var(--neon-pink); font-weight: bold; }
        .leaderboard-table tr:not(:last-child) td { border-bottom: 1px solid rgba(255,255,255,0.05); }

        .bottom-nav { position: fixed; bottom: 0; width: 100%; background: rgba(11, 17, 16, 0.95); display: flex; justify-content: space-around; padding: 10px 0; border-top: 1px solid rgba(124, 252, 0, 0.3); z-index: 100; }
        .nav-item { background: none; border: none; cursor: pointer; display: flex; flex-direction: column; align-items: center; opacity: 0.4; transition: 0.2s; }
        .nav-item svg { width: 22px; height: 22px; fill: var(--text-muted); transition: 0.2s; }
        .active-nav { opacity: 1; transform: scale(1.05); }
        .active-nav svg { fill: var(--neon-cyan); filter: drop-shadow(0 0 6px var(--neon-cyan)); }

        .cs16-modal { position: fixed; inset: 0; background: rgba(0,0,0,0.85); z-index: 9999; display: none; align-items: center; justify-content: center; font-family: 'Courier New', Courier, monospace; }
        .cs16-modal.active { display: flex; }
        .cs16-dialog { background: #2b332e; border: 2px solid #5a6b60; border-top-color: #7c9484; border-left-color: #7c9484; box-shadow: 4px 4px 12px rgba(0,0,0,0.9); width: 300px; padding: 3px; color: #d0ded4; }
        .cs16-title { background: #19201c; padding: 4px 6px; font-weight: bold; font-size: 11px; border-bottom: 1px solid #3e4a42; color: #ffffff; }
        .cs16-body { padding: 10px; font-size: 10px; }
        .cs16-progress-container { background: #111513; border: 1px solid #455249; border-bottom-color: #7c9484; border-right-color: #7c9484; height: 14px; margin: 5px 0 10px 0; padding: 1px; }
        .cs16-progress-bar { background: linear-gradient(90deg, #2e7d32, #4caf50); height: 100%; width: 0%; transition: width 0.2s ease; }
    </style>
</head>
<body>

    <div class="cs16-modal active" id="cs16-loading-modal">
        <div class="cs16-dialog">
            <div class="cs16-title">Загрузка приложения...</div>
            <div class="cs16-body">
                <p id="cs16-status-text">Connecting to P2P Server...</p>
                <div class="cs16-progress-container"><div class="cs16-progress-bar" id="cs16-bar-1" style="width: 75%;"></div></div>
                <p id="cs16-sub-text">Loading Marketplace & Jackpot...</p>
                <div class="cs16-progress-container"><div class="cs16-progress-bar" id="cs16-bar-2" style="width: 90%;"></div></div>
            </div>
        </div>
    </div>

    <div class="modal-overlay" id="modal-sell-skin">
        <div class="modal-content">
            <h3 class="neon-text" style="color:var(--neon-green)">Выставить скин</h3>
            <p class="hint-text" id="sell-modal-desc" style="margin: 6px 0 12px 0;">Загрузка актуальной цены со Steam...</p>
            
            <div style="display:flex; flex-direction:column; gap:6px; margin-bottom:12px;">
                <button class="btn-cyan" id="btn-plat-p2p" onclick="selectPlatform('p2p')" style="border-color:var(--neon-green); color:var(--neon-green);">Наш P2P Маркет</button>
                <button class="btn-cyan" id="btn-plat-lisskins" onclick="selectPlatform('lisskins')" style="border-color:#ff9900; color:#ff9900;">Lis-Skins (Мгновенная продажа)</button>
                <button class="btn-cyan" id="btn-plat-csmoney" onclick="selectPlatform('csmoney')" style="border-color:var(--neon-cyan); color:var(--neon-cyan);">CS.MONEY (Трейд-бот)</button>
            </div>

            <div class="price-input-container">
                <span class="currency-symbol">₽</span>
                <input type="number" id="sell-price-input" class="topup-input" placeholder="Цена" min="10">
            </div>

            <div id="vip-option-container" style="display:flex; align-items:center; gap:8px; margin: 10px 0; font-size:11px; text-align:left; background:rgba(255,215,0,0.05); padding:8px; border-radius:6px; border:1px solid rgba(255,215,0,0.3);">
                <input type="checkbox" id="vip-checkbox" style="accent-color: var(--neon-green);">
                <label for="vip-checkbox" style="color: var(--vip-gold); cursor:pointer; font-weight:bold;">⚡ Сделать VIP-объявлением (120 ₽)</label>
            </div>
            
            <div style="display:flex; gap:8px; margin-top:12px;">
                <button class="btn-cyan" onclick="closeModal('modal-sell-skin')" style="flex:1;">Отмена</button>
                <button class="btn-green-glow" onclick="executeSkinSale()" style="width:auto; flex:1; margin-top:0;">Подтвердить</button>
            </div>
        </div>
    </div>

    <div class="fullscreen-winner-overlay" id="fullscreen-winner-modal">
        <div style="font-size: 24px; font-weight: bold; color: var(--neon-pink); text-shadow: 0 0 12px var(--neon-pink); margin-bottom: 15px;">🏆 ПОБЕДИТЕЛЬ БИТВЫ! 🏆</div>
        <div style="width: 80px; height: 80px; border-radius: 50%; background: var(--neon-green); margin: 0 auto 12px auto; display: flex; align-items: center; justify-content: center; overflow: hidden; border: 2px solid #fff; box-shadow: 0 0 20px var(--neon-green);" id="fs-winner-avatar">👑</div>
        <div id="fs-winner-name" style="font-size: 18px; font-weight: bold; color: #fff; margin-bottom: 6px;">@Username</div>
        <div id="fs-winner-prize" style="font-size: 14px; color: var(--neon-green); font-weight: bold; margin-bottom: 15px;">Забрал банк!</div>
        <div id="fs-winner-timer" style="font-size: 11px; color: var(--text-muted);">Новый раунд через: 5 сек</div>
    </div>

    <div class="modal-overlay" id="modal-bet">
        <div class="modal-content">
            <h3 class="neon-text">Сделать ставку</h3>
            <p class="hint-text">Мин. ставка: 10 ₽</p>
            <div class="price-input-container">
                <span class="currency-symbol">₽</span>
                <input type="number" id="bet-amount-input" class="topup-input" placeholder="100" min="10" value="100">
            </div>
            <div style="display:flex; gap:8px; margin-top:12px;">
                <button class="btn-cyan" onclick="closeModal('modal-bet')" style="flex:1;">Отмена</button>
                <button class="btn-green-glow" onclick="confirmBet()" style="width:auto; flex:1; margin-top:0;">Поставить</button>
            </div>
        </div>
    </div>

    <header class="top-bar">
        <div class="bot-profile">
            <div style="width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; background: radial-gradient(circle, rgba(124,252,0,0.25) 0%, rgba(0,255,255,0.05) 100%); border: 1px solid var(--neon-green); box-shadow: 0 0 8px rgba(124,252,0,0.4); flex-shrink: 0; overflow:hidden;" id="user-avatar-box">
                <svg viewBox="0 0 24 24" style="width: 18px; height: 18px; fill: var(--neon-green);"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
            </div>
            <div class="bot-info">
                <span class="bot-name">P2P SKIN SALES ✔️</span>
                <span class="bot-status">Активен</span>
            </div>
        </div>
        <div class="balance-widget">
            <span id="user-balance" style="font-weight:bold;">0 ₽</span>
            <button class="add-funds-btn" onclick="openTopUpModal()">+</button>
        </div>
    </header>

    <main class="content-area">
        <section id="tab-market" class="tab active">
            <h2 class="neon-text">Маркетплейс скинов</h2>
            <div id="market-listings" class="grid-layout"></div>
        </section>

        <section id="tab-inventory" class="tab">
            <h2 class="neon-text">Твой Steam инвентарь</h2>
            <div id="auth-section">
                <button class="steam-login-btn" onclick="loginWithSteam()">Войти через Steam</button>
            </div>
            <div class="trade-url-box">
                <input type="text" id="trade-url-input" placeholder="Trade URL...">
                <button class="btn-cyan" onclick="saveTradeUrl()">Сохранить</button>
            </div>
            <div id="steam-inventory-grid" class="grid-layout">
                <div class="empty-state" style="grid-column: span 2; text-align: center; color: var(--text-muted); padding: 15px;">Войдите через Steam или укажите Trade URL</div>
            </div>
        </section>

        <section id="tab-deals" class="tab">
            <h2 class="neon-text" style="color: var(--neon-pink); text-shadow: 0 0 6px var(--neon-pink); margin-bottom: 10px;">👑 Королевская Битва</h2>
            
            <div class="jackpot-header-box">
                <div>
                    <div class="jackpot-bank-title">Банк раунда</div>
                    <div class="jackpot-bank-val" id="jackpot-bank-text">0 ₽</div>
                </div>
                <div>
                    <div class="jackpot-bank-title" style="text-align: right;">Таймер</div>
                    <div class="jackpot-timer-val" id="jackpot-timer-text">00:15</div>
                </div>
            </div>

            <div class="jackpot-arena" id="jackpot-arena-view">
                <div style="width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: var(--text-muted); font-size: 12px; text-align:center; padding:10px;">
                    Ожидание второго игрока для старта таймера (мин. 10 ₽)...
                </div>
            </div>

            <button class="btn-green-glow" onclick="openBetModal()">Сделать ставку</button>

            <div class="bets-feed-title">Лента ставок</div>
            <div class="bets-feed-list" id="bets-feed-container">
                <div style="text-align: center; color: var(--text-muted); font-size: 11px; padding: 8px;">Ставок еще нет</div>
            </div>

            <h3 class="section-title" style="color: var(--neon-pink); border-color: rgba(255,0,127,0.3); margin-top: 20px;">🏆 Рейтинг победителей</h3>
            <div id="leaderboard-container" style="margin-top: 8px;">
                <table class="leaderboard-table">
                    <thead>
                        <tr>
                            <th>Место</th>
                            <th>Ник</th>
                            <th>Побед</th>
                        </tr>
                    </thead>
                    <tbody id="leaderboard-tbody">
                        <tr><td colspan="3" style="text-align: center; color: var(--text-muted); padding: 12px;">Загрузка рейтинга...</td></tr>
                    </tbody>
                </table>
            </div>
        </section>

        <section id="tab-giveaways" class="tab">
            <h2 class="neon-text">🎁 Активные розыгрыши</h2>
            <div id="giveaways-container"><div class="empty-state" style="text-align:center; color:var(--text-muted); padding:15px;">Нет активных розыгрышей</div></div>
        </section>

        <section id="tab-profile" class="tab">
            <h2 class="neon-text">Твой профиль</h2>
            <div class="card" style="border:1px solid var(--neon-green); padding:12px; margin-bottom:12px;">
                <div style="font-weight: bold; font-size: 13px;" id="my-nick">Игрок</div>
                <div style="font-size: 11px; color: var(--text-muted); margin-top: 3px;">Баланс: <span id="profile-balance" style="color:var(--neon-green); font-weight:bold;">0 ₽</span></div>
            </div>
            <button class="btn-green-glow" onclick="openTopUpModal()">Пополнить баланс</button>
            
            <h3 class="section-title" style="margin-top: 20px;">Вывод средств</h3>
            <div class="trade-url-box" style="flex-direction: column; gap: 8px; margin-top: 8px;">
                <input type="text" id="withdraw-account" placeholder="Номер карты или кошелька..." style="width:100%;">
                <input type="number" id="withdraw-amount" placeholder="Сумма вывода (₽)" style="width:100%; padding:8px; background:#111; border:1px solid #333; color:white; border-radius:6px; font-size:11px;">
                <button class="btn-green-glow" onclick="requestWithdraw()" style="margin-top: 4px;">Запросить вывод</button>
            </div>
        </section>
    </main>

    <nav class="bottom-nav">
        <button class="nav-item active-nav" onclick="switchTab('market', this)"><svg viewBox="0 0 24 24"><path d="M7 18c-1.1 0-1.99.9-1.99 2S5.9 22 7 22s2-.9 2-2-.9-2-2-2zM1 2v2h2l3.6 7.59-1.35 2.45c-.16.28-.25.61-.25.96 0 1.1.9 2 2 2h12v-2H7.42c-.14 0-.25-.11-.25-.25l.03-.12.9-1.63h7.45c.75 0 1.41-.41 1.75-1.03l3.58-6.49c.08-.14.12-.31.12-.48 0-.55-.45-1-1-1H5.21l-.94-2H1zm16 16c-1.1 0-1.99.9-1.99 2s.89 2 1.99 2 2-.9 2-2-.9-2-2-2z"/></svg></button>
        <button class="nav-item" onclick="switchTab('inventory', this)"><svg viewBox="0 0 24 24"><path d="M20 6h-4V4c0-1.1-.9-2-2-2h-4c-1.1 0-2 .9-2 2v2H4c-1.1 0-2 .9-2 2v11c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zM10 4h4v2h-4V4zm10 15H4V8h16v11z"/></svg></button>
        <button class="nav-item" onclick="switchTab('deals', this)"><svg viewBox="0 0 24 24"><path d="M19.98 2.52c-.19-.04-.39 0-.54.12l-3.32 2.66-2.09-1.05c-.24-.12-.52-.1-.74.05L9.62 6.9 6.8 4.08C6.6 3.88 6.3 3.82 6.04 3.93 5.79 4.04 5.62 4.3 5.62 4.58v4.24l-3.5 3.5c-.39.39-.39 1.02 0 1.41l4.95 4.95c.39.39 1.02.39 1.41 0l3.5-3.5h4.24c.28 0 .54-.17.65-.42.11-.25.05-.55-.15-.75l-2.82-2.82 2.6-3.68c.15-.22.17-.5.05-.74l-1.05-2.09 2.66-3.32c.12-.15.16-.35.12-.54-.04-.19-.18-.33-.37-.37zM12 17.5l-4-4 2.5-2.5 4 4-2.5 2.5z"/></svg></button>
        <button class="nav-item" onclick="switchTab('giveaways', this)"><svg viewBox="0 0 24 24"><path d="M20 6h-2.18c.11-.31.18-.65.18-1 0-1.66-1.34-3-3-3-1.05 0-1.96.54-2.5 1.35l-.5.67-.5-.68C10.96 2.54 10.05 2 9 2 7.34 2 6 3.34 6 5c0 .35.07.69.18 1H4c-1.11 0-1.99.89-1.99 2L2 19c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.11-.9-2-2-2zm-5-2c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zM9 4c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1mouseX11 15H4v-2h16v2zm0-5H4V8h5.08L7.1 10.86l1.62 1.18L12 8l3.28 4.04 1.62-1.18L14.92 8H20v6z"/></svg></button>
        <button class="nav-item" onclick="switchTab('profile', this)"><svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zM7.07 18.28c.43-.9 3.05-1.78 4.93-1.78s4.5.88 4.93 1.78C15.57 19.36 13.86 20 12 20s-3.57-.64-4.93-1.72zm11.29-1.45c-1.43-1.74-4.9-2.33-6.36-2.33s-4.93.59-6.36 2.33C4.62 15.49 4 13.82 4 12c0-4.41 3.59-8 8-8s8 3.59 8 8c0 1.82-.62 3.49-1.64 4.83zM12 6c-1.94 0-3.5 1.56-3.5 3.5S10.06 13 12 13s3.5-1.56 3.5-3.5S13.94 6 12 6zm0 5c-.83 0-1.5-.67-1.5-1.5S11.17 8 12 8s1.5.67 1.5 1.5S12.83 11 12 11z"/></svg></button>
    </nav>

    <div class="modal-overlay" id="modal-topup">
        <div class="modal-content">
            <h3 class="neon-text">Пополнить баланс</h3>
            <div class="price-input-container">
                <span class="currency-symbol">₽</span>
                <input type="number" id="topup-amount-input" class="topup-input" placeholder="500" value="500">
            </div>
            <div style="display:flex; flex-direction: column; gap:6px; margin-top:12px;">
                <button class="btn-green-glow" onclick="processTopUp('crypto')" style="margin-top:0;">Оплатить USDT (Crypto Bot)</button>
                <button class="btn-cyan" onclick="processTopUp('p2pru')">Оплатить картой РФ (P2P)</button>
                <button class="btn-cyan" onclick="processTopUp('p2puz')" style="color:var(--neon-purple); border-color:var(--neon-purple);">Оплатить UZ картой (P2P)</button>
                <button class="btn-cyan" onclick="closeModal('modal-topup')">Отмена</button>
            </div>
        </div>
    </div>

    <script>
        let userBalance = 0;
        let marketItems = [];
        let isSpinningHandled = false;
        let battleEndTime = null;
        let currentBattleStatus = 'waiting';

        let selectedSkinToSell = null;
        let selectedSellingPlatform = 'p2p';

        const tgUser = window.Telegram?.WebApp?.initDataUnsafe?.user;
        const myTgId = tgUser?.id || 123456789;
        const myUsername = tgUser?.username || tgUser?.first_name || \`User_\${myTgId}\`;
        const myPhotoUrl = tgUser?.photo_url || null;

        window.addEventListener('DOMContentLoaded', async () => {
            const safetyTimeout = setTimeout(() => { hideCs16Loading(); }, 3000);
            try {
                document.getElementById('my-nick').innerText = myUsername;
                if (myPhotoUrl) {
                    document.getElementById('user-avatar-box').innerHTML = \`<img src="\${myPhotoUrl}" style="width:100%; height:100%; object-fit:cover;" onerror="this.onerror=null; this.parentNode.innerHTML='<span>\${myUsername.charAt(0).toUpperCase()}</span>';">\`;
                }
                await Promise.allSettled([syncUserProfile(), fetchMarketItems(), fetchGiveaways(), fetchLeaderboard(), fetchJackpotState()]);
            } catch (err) {} finally {
                clearTimeout(safetyTimeout);
                hideCs16Loading();
            }
        });

        setInterval(() => {
            if (currentBattleStatus === 'active' && battleEndTime) {
                const remaining = Math.ceil((battleEndTime - Date.now()) / 1000);
                const timerVal = remaining > 0 ? remaining : 0;
                let m = Math.floor(timerVal / 60).toString().padStart(2, '0');
                let s = (timerVal % 60).toString().padStart(2, '0');
                const timerEl = document.getElementById('jackpot-timer-text');
                if (timerEl) timerEl.innerText = \`\${m}:\${s}\`;
            }
        }, 1000);

        function hideCs16Loading() {
            const modal = document.getElementById('cs16-loading-modal');
            if (modal) {
                document.getElementById('cs16-bar-1').style.width = '100%';
                document.getElementById('cs16-bar-2').style.width = '100%';
                setTimeout(() => { modal.classList.remove('active'); }, 100);
            }
        }

        async function syncUserProfile() {
            try {
                const res = await fetch(\`/api/user/profile?tgId=\${myTgId}&tgUser=\${encodeURIComponent(myUsername)}\`);
                const data = await res.json();
                if (data.success) {
                    userBalance = data.balance;
                    document.getElementById('user-balance').innerText = userBalance + ' ₽';
                    document.getElementById('profile-balance').innerText = userBalance + ' ₽';
                    if (data.tradeUrl) {
                        document.getElementById('trade-url-input').value = data.tradeUrl;
                        loadSteamInventory(data.steamId);
                    }
                }
            } catch (e) {}
        }

        async function fetchMarketItems() {
            try {
                const res = await fetch('/api/market/items');
                const data = await res.json();
                if (data.success) {
                    marketItems = data.items;
                    document.getElementById('market-listings').innerHTML = marketItems.length === 0 ? '<div class="empty-state" style="grid-column: span 2; text-align:center; color:var(--text-muted); padding:15px;">Нет лотов на маркете</div>' : marketItems.map(i => \`
                        <div class="card \${i.isVip ? 'vip-card' : ''}">
                            \${i.isVip ? '<div class="vip-badge">VIP</div>' : ''}
                            <div class="skin-image"><img src="\${i.image}" class="skin-img" onerror="this.src='https://via.placeholder.com/80'"></div>
                            <div class="card-title">\${i.name}</div>
                            <div style="display:flex; justify-content:space-between; align-items:center; margin-top:2px;">
                                <span style="font-weight:bold; color:var(--neon-green); font-size:12px;">\${i.price} ₽</span>
                                <button class="btn-cyan" style="padding:4px 8px; font-size:10px;" onclick="buyItem('\${i._id}')">Купить</button>
                            </div>
                        </div>
                    \`).join('');
                }
            } catch(e) {}
        }

        async function buyItem(itemId) {
            const tradeUrlInput = document.getElementById('trade-url-input').value;
            if (!tradeUrlInput) {
                alert('Пожалуйста, укажите ваш Trade URL в инвентаре перед покупкой!');
                return switchTab('inventory', document.querySelectorAll('.nav-item')[1]);
            }

            try {
                const res = await fetch('/api/deals/buy', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ itemId, buyerTgId: myTgId, buyerTradeUrl: tradeUrlInput, buyerName: myUsername })
                });
                const data = await res.json();
                if (data.success) {
                    alert('✅ Покупка успешна! Продавцу отправлены ваши реквизиты, ожидайте отправки предмета.');
                    userBalance = data.newBalance;
                    document.getElementById('user-balance').innerText = userBalance + ' ₽';
                    document.getElementById('profile-balance').innerText = userBalance + ' ₽';
                    fetchMarketItems();
                } else {
                    alert(data.error || 'Ошибка покупки');
                }
            } catch (e) { alert('Ошибка соединения'); }
        }

        async function saveTradeUrl() {
            const tradeUrl = document.getElementById('trade-url-input').value;
            if (!tradeUrl) return alert('Введите Trade URL');
            try {
                const res = await fetch('/api/user/save', {
                    method: 'POST', headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ tgId: myTgId, tradeUrl })
                });
                const data = await res.json();
                if (data.success) {
                    alert('✅ Trade URL сохранен!');
                    loadSteamInventory(data.steamId);
                }
            } catch(e) {}
        }

        function loginWithSteam() {
            alert('Перенаправление на авторизацию Steam OpenID...');
            window.location.href = \`https://steamcommunity.com/login/ckey/?redir=/?tgId=\${myTgId}\`;
        }

        async function loadSteamInventory(steamId) {
            const grid = document.getElementById('steam-inventory-grid');
            if (!steamId) {
                grid.innerHTML = '<div class="empty-state" style="grid-column: span 2; text-align: center; color: var(--text-muted); padding: 15px;">Укажите Trade URL для загрузки инвентаря</div>';
                return;
            }
            grid.innerHTML = '<div style="grid-column: span 2; text-align:center; color:var(--text-muted);">Загрузка инвентаря Steam...</div>';
            try {
                const res = await fetch('/api/steam/inventory', {
                    method: 'POST', headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ steamId, tgId: myTgId })
                });
                const data = await res.json();
                if (data.success && data.items && data.items.length > 0) {
                    let descriptionsMap = {};
                    (data.descriptions || []).forEach(d => { descriptionsMap[d.classid + '_' + d.instanceid] = d; });

                    grid.innerHTML = data.items.map(item => {
                        let desc = descriptionsMap[item.classid + '_' + item.instanceid] || {};
                        let iconUrl = desc.icon_url ? \`https://steamcommunity-a.akamaihd.net/economy/image/\${desc.icon_url}\` : 'https://via.placeholder.com/80';
                        let name = desc.name || 'CS2 Item';
                        return \`
                            <div class="card">
                                <div class="skin-image"><img src="\${iconUrl}" class="skin-img"></div>
                                <div class="card-title">\${name}</div>
                                <button class="btn-green-glow" onclick="openSellModal('\${name.replace(/'/g, "\\\\'")}', '\${iconUrl}')">Продать / Выставить</button>
                            </div>
                        \`;
                    }).join('');
                } else {
                    grid.innerHTML = '<div class="empty-state" style="grid-column: span 2; text-align: center; color: var(--text-muted); padding: 15px;">Инвентарь пуст или скрыт настройками приватности Steam</div>';
                }
            } catch(e) {
                grid.innerHTML = '<div class="empty-state" style="grid-column: span 2; text-align: center; color: var(--danger-red); padding: 15px;">Ошибка загрузки инвентаря Steam</div>';
            }
        }

        async function openSellModal(name, image) {
            selectedSkinToSell = { name, image };
            selectedSellingPlatform = 'p2p';
            document.getElementById('vip-checkbox').checked = false;
            updatePlatformSelectionUI();

            document.getElementById('sell-modal-desc').innerText = \`Скин: \${name} (Загрузка цены со Steam...)\`;
            const priceInput = document.getElementById('sell-price-input');
            priceInput.value = '...';
            document.getElementById('modal-sell-skin').classList.add('active');

            try {
                const res = await fetch(\`/api/steam/price?name=\${encodeURIComponent(name)}\`);
                const data = await res.json();
                if (data.success && data.price) {
                    priceInput.value = data.price;
                    document.getElementById('sell-modal-desc').innerText = \`Скин: \${name}\`;
                } else {
                    priceInput.value = 150;
                    document.getElementById('sell-modal-desc').innerText = \`Скин: \${name}\`;
                }
            } catch (e) {
                priceInput.value = 150;
                document.getElementById('sell-modal-desc').innerText = \`Скин: \${name}\`;
            }
        }

        function selectPlatform(plat) {
            selectedSellingPlatform = plat;
            updatePlatformSelectionUI();
            const vipContainer = document.getElementById('vip-option-container');
            if (plat === 'p2p') {
                vipContainer.style.display = 'flex';
            } else {
                vipContainer.style.display = 'none';
            }
        }

        function updatePlatformSelectionUI() {
            document.getElementById('btn-plat-p2p').style.background = selectedSellingPlatform === 'p2p' ? 'rgba(124,252,0,0.15)' : 'transparent';
            document.getElementById('btn-plat-lisskins').style.background = selectedSellingPlatform === 'lisskins' ? 'rgba(255,153,0,0.15)' : 'transparent';
            document.getElementById('btn-plat-csmoney').style.background = selectedSellingPlatform === 'csmoney' ? 'rgba(0,255,255,0.15)' : 'transparent';
        }

        async function executeSkinSale() {
            const priceVal = parseFloat(document.getElementById('sell-price-input').value);
            if (!priceVal || isNaN(priceVal) || priceVal <= 0) return alert('Введите корректную цену!');
            if (!selectedSkinToSell) return;

            const isVip = selectedSellingPlatform === 'p2p' && document.getElementById('vip-checkbox').checked;

            if (isVip && userBalance < 120) {
                alert('❌ Недостаточно средств для VIP-объявления (нужно 120 ₽ на балансе). Пополните баланс!');
                return;
            }

            if (selectedSellingPlatform === 'p2p') {
                try {
                    const res = await fetch('/api/market/add', {
                        method: 'POST', headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ tgId: myTgId, name: selectedSkinToSell.name, image: selectedSkinToSell.image, price: priceVal, isVip })
                    });
                    const data = await res.json();
                    if (data.success) {
                        alert(isVip ? '✅ Скин успешно выставлен как VIP-объявление!' : '✅ Скин успешно выставлен на маркетплейс!');
                        closeModal('modal-sell-skin');
                        syncUserProfile();
                        fetchMarketItems();
                        switchTab('market', document.querySelectorAll('.nav-item')[0]);
                    } else {
                        alert(data.error || 'Ошибка');
                    }
                } catch(e) {}
            } else {
                const platName = selectedSellingPlatform === 'lisskins' ? 'Lis-Skins' : 'CS.MONEY';
                const confirmed = confirm(\`Вы подтверждаете продажу скина "\${selectedSkinToSell.name}" на платформе \${platName} за \${priceVal} ₽?\`);
                if (!confirmed) return;

                try {
                    const res = await fetch('/api/external/sell', {
                        method: 'POST', headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ tgId: myTgId, price: priceVal })
                    });
                    const data = await res.json();
                    if (data.success) {
                        alert(\`✅ Скин успешно продан на \${platName}! Средства зачислены на ваш баланс.\`);
                        userBalance = data.newBalance;
                        document.getElementById('user-balance').innerText = userBalance + ' ₽';
                        document.getElementById('profile-balance').innerText = userBalance + ' ₽';
                        closeModal('modal-sell-skin');
                    } else {
                        alert(data.error || 'Ошибка продажи');
                    }
                } catch(e) {}
            }
        }

        async function fetchGiveaways() {
            try {
                const res = await fetch('/api/giveaways/list');
                const data = await res.json();
                if (data.success && data.giveaways) {
                    const container = document.getElementById('giveaways-container');
                    if (data.giveaways.length === 0) {
                        container.innerHTML = '<div class="empty-state" style="text-align:center; color:var(--text-muted); padding:15px;">Нет активных розыгрышей</div>';
                        return;
                    }
                    container.innerHTML = data.giveaways.map(g => {
                        let sponsorLink = g.sponsorUsername ? (g.sponsorUsername.startsWith('http') ? g.sponsorUsername : \`https://t.me/\${g.sponsorUsername.replace('@','')}\`) : '#';
                        return \`
                            <div class="giveaway-card">
                                <div class="giveaway-header"><span style="color:var(--neon-purple); font-weight:bold;">🎁 Розыгрыш</span><span class="giveaway-timer">⏳ \${g.timer}</span></div>
                                <div style="display: flex; gap: 8px; align-items: center;">
                                    <div class="skin-image" style="width: 60px; height: 60px; margin-bottom:0;"><img src="\${g.image}" class="skin-img" onerror="this.src='https://via.placeholder.com/60'"></div>
                                    <div style="flex:1; overflow:hidden;">
                                        <p class="giveaway-title" style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">\${g.title}</p>
                                        <div style="font-size: 10px; color: var(--text-muted);">Спонсор: \${g.sponsorUsername}</div>
                                        <div style="font-size: 10px; color: var(--text-muted);">Участников: \${g.participantsCount || 0}</div>
                                    </div>
                                </div>
                                \${g.sponsorUsername ? \`<a href="\${sponsorLink}" target="_blank" class="btn-cyan" style="text-align:center; text-decoration:none; display:block; padding:6px; font-size:10px; margin-top:4px;">📢 Подписаться на спонсора</a>\` : ''}
                                <button class="btn-green-glow" style="margin-top: 4px; padding:6px; font-size:11px;" onclick="joinGiveaway('\${g._id}')">Участвовать</button>
                            </div>
                        \`;
                    }).join('');
                }
            } catch(e) {}
        }

        async function joinGiveaway(giveawayId) {
            try {
                const res = await fetch('/api/giveaways/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tgId: myTgId, giveawayId }) });
                const data = await res.json();
                if (data.success) {
                    alert('✅ Вы успешно участвуете в розыгрыше!');
                    fetchGiveaways();
                } else {
                    alert(data.error || 'Ошибка участия');
                }
            } catch(e) {}
        }

        async function fetchJackpotState() {
            try {
                const res = await fetch('/api/battles/current');
                const data = await res.json();
                if (data.success && data.battle) {
                    const b = data.battle;
                    currentBattleStatus = b.status;
                    if (b.endTime) {
                        battleEndTime = b.endTime;
                    }

                    renderJackpot(b);

                    if (b.status === 'spinning') {
                        if (!isSpinningHandled && b.winner) {
                            isSpinningHandled = true;
                            playRouletteAnimation(b.participants, b.winner, b.bank);
                        }
                    } else if (b.status === 'finished') {
                        const fsModal = document.getElementById('fullscreen-winner-modal');
                        if (!fsModal.classList.contains('active') && b.winner) {
                            showFullscreenWinnerModal(b.winner, b.bank);
                        }
                    } else {
                        isSpinningHandled = false;
                    }
                }
            } catch(e) {}
        }

        function renderJackpot(b) {
            document.getElementById('jackpot-bank-text').innerText = b.bank + ' ₽';
            
            if (b.status === 'waiting') {
                document.getElementById('jackpot-timer-text').innerText = '00:15';
            }

            const arena = document.getElementById('jackpot-arena-view');
            
            if (b.status === 'spinning') return;

            if (!b.participants || b.participants.length === 0) {
                arena.innerHTML = \`<div style="width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: var(--text-muted); font-size: 12px; text-align:center; padding:10px;">Ожидание ставок (мин. 10 ₽)...</div>\`;
            } else if (b.participants.length === 1) {
                arena.innerHTML = \`<div style="width: 100%; height: 100%; display: flex; flex-direction:column; align-items: center; justify-content: center; color: var(--text-muted); font-size: 12px; text-align:center; padding:10px;">
                    <div style="font-size:14px; color:var(--neon-green); font-weight:bold; margin-bottom:6px;">Ожидание 2-го игрока для старта таймера!</div>
                    <div>Участник: @\${b.participants[0].username}</div>
                </div>\`;
            } else {
                arena.innerHTML = b.participants.map(p => \`
                    <div class="jackpot-column" style="width: \${p.chance}%; background-color: \${p.color};">
                        <div class="jackpot-col-avatar">
                            \${p.photo ? \`<img src="\${p.photo}" style="width:100%; height:100%; object-fit:cover;" onerror="this.onerror=null; this.parentNode.innerHTML='<span>\${p.username.charAt(0).toUpperCase()}</span>';">\` : p.username.charAt(0).toUpperCase()}
                        </div>
                        <div class="jackpot-col-chance">\${p.chance}%</div>
                        <div class="jackpot-col-name">@\${p.username}</div>
                    </div>
                \`).join('');
            }

            const feed = document.getElementById('bets-feed-container');
            if (!b.betsFeed || b.betsFeed.length === 0) {
                feed.innerHTML = \`<div style="text-align: center; color: var(--text-muted); font-size: 11px; padding: 8px;">Ставок еще нет</div>\`;
            } else {
                feed.innerHTML = b.betsFeed.map(bet => \`
                    <div class="bet-feed-item">
                        <div class="bet-feed-user">
                            <div class="bet-feed-av" style="border: 2px solid \${bet.color};">
                                \${bet.photo ? \`<img src="\${bet.photo}" style="width:100%; height:100%; object-fit:cover;" onerror="this.onerror=null; this.parentNode.innerHTML='<span>\${bet.username.charAt(0).toUpperCase()}</span>';">\` : bet.username.charAt(0).toUpperCase()}
                            </div>
                            <span>@\${bet.username}</span>
                        </div>
                        <div class="bet-feed-sum">+\${bet.amount} ₽</div>
                    </div>
                \`).join('');
            }
        }

        function openBetModal() {
            document.getElementById('modal-bet').classList.add('active');
        }

        async function confirmBet() {
            const amount = parseFloat(document.getElementById('bet-amount-input').value);
            if (!amount || amount < 10) return alert('Минимальная ставка 10 ₽!');
            if (userBalance < amount) { alert('Недостаточно средств!'); return openTopUpModal(); }

            try {
                const res = await fetch('/api/battles/bet', {
                    method: 'POST', headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ tgId: myTgId, username: myUsername, photo: myPhotoUrl, amount })
                });
                const data = await res.json();
                if (data.success) {
                    userBalance = data.newBalance;
                    document.getElementById('user-balance').innerText = userBalance + ' ₽';
                    document.getElementById('profile-balance').innerText = userBalance + ' ₽';
                    closeModal('modal-bet');
                    fetchJackpotState();
                } else {
                    alert(data.error || 'Ошибка');
                }
            } catch(e) { alert('Ошибка соединения'); }
        }

        function playRouletteAnimation(participants, winner, bank) {
            const arena = document.getElementById('jackpot-arena-view');
            let stripItems = [];
            
            for (let i = 0; i < 80; i++) {
                let p = participants[Math.floor(Math.random() * participants.length)];
                stripItems.push(p);
            }
            const winnerIndex = 65;
            stripItems[winnerIndex] = winner;

            arena.innerHTML = \`
                <div class="roulette-window">
                    <div class="roulette-pointer"></div>
                    <div class="roulette-strip" id="jackpot-roulette-strip">
                        \${stripItems.map(p => \`
                            <div class="roulette-item" style="border-color:\${p.color};">
                                <img src="\${p.photo || 'https://via.placeholder.com/50'}" onerror="this.onerror=null; this.parentNode.innerHTML='<span>\${p.username.charAt(0).toUpperCase()}</span>';">
                                <span>@\${p.username}</span>
                            </div>
                        \`).join('')}
                    </div>
                </div>
            \`;

            setTimeout(() => {
                const strip = document.getElementById('jackpot-roulette-strip');
                if (!strip) return;
                const itemWidth = 90;
                const arenaWidth = arena.offsetWidth || 350;
                const targetOffset = (winnerIndex * itemWidth) - (arenaWidth / 2) + (itemWidth / 2);
                strip.style.transform = \`translateX(-\${targetOffset}px)\`;

                setTimeout(() => {
                    showFullscreenWinnerModal(winner, bank);
                }, 13100);
            }, 60);
        }

        function showFullscreenWinnerModal(winner, bank) {
            const fsModal = document.getElementById('fullscreen-winner-modal');
            const avatarBox = document.getElementById('fs-winner-avatar');
            const nameEl = document.getElementById('fs-winner-name');
            const prizeEl = document.getElementById('fs-winner-prize');
            const timerEl = document.getElementById('fs-winner-timer');

            avatarBox.innerHTML = winner.photo ? \`<img src="\${winner.photo}" style="width:100%; height:100%; object-fit:cover;" onerror="this.onerror=null; this.parentNode.innerHTML='<span>👑</span>';">\` : '👑';
            nameEl.innerText = \`@\${winner.username}\`;
            const prizeWithCommission = Math.round(bank * 0.8);
            prizeEl.innerText = \`Забрал банк: \${prizeWithCommission} ₽ (с учетом 20% комиссии)\`;

            fsModal.classList.add('active');

            let fsTimeLeft = 5;
            const fsInterval = setInterval(() => {
                fsTimeLeft--;
                timerEl.innerText = \`Новый раунд через: \${fsTimeLeft} сек\`;
                if (fsTimeLeft <= 0) {
                    clearInterval(fsInterval);
                    fsModal.classList.remove('active');
                    fetchLeaderboard();
                    syncUserProfile();
                }
            }, 1000);
        }

        async function fetchLeaderboard() {
            try {
                const res = await fetch('/api/battles/leaderboard');
                const data = await res.json();
                if (data.success && data.leaderboard) {
                    const tbody = document.getElementById('leaderboard-tbody');
                    if (data.leaderboard.length === 0) {
                        tbody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: var(--text-muted); padding: 12px;">Пока нет победителей</td></tr>';
                        return;
                    }
                    tbody.innerHTML = data.leaderboard.map((item, index) => \`
                        <tr>
                            <td style="font-weight: bold; color: \${index === 0 ? 'var(--neon-green)' : (index === 1 ? 'var(--neon-cyan)' : (index === 2 ? 'var(--neon-purple)' : '#fff'))}">#\${index + 1}</td>
                            <td style="font-weight: bold;">@\${item.username}</td>
                            <td style="color: var(--neon-pink); font-weight: bold;">\${item.wins}</td>
                        </tr>
                    \`).join('');
                }
            } catch(e) {}
        }

        setInterval(() => {
            if (document.getElementById('tab-deals') && document.getElementById('tab-deals').classList.contains('active')) {
                fetchJackpotState();
            }
        }, 1500);

        async function processTopUp(currency) {
            const amount = parseFloat(document.getElementById('topup-amount-input').value);
            if (!amount || amount <= 0) return alert('Введите сумму пополнения');
            try {
                const res = await fetch('/api/billing/invoice', { 
                    method: 'POST', 
                    headers: { 'Content-Type': 'application/json' }, 
                    body: JSON.stringify({ tgId: myTgId, amount, currency }) 
                });
                const data = await res.json();
                if (data.success) {
                    alert('✅ Счет на оплату отправлен вам в чат бота!');
                    closeModal('modal-topup');
                } else {
                    alert(data.error || 'Ошибка формирования счета');
                }
            } catch (e) { alert('Ошибка соединения'); }
        }

        async function requestWithdraw() {
            const recipientAccount = document.getElementById('withdraw-account').value;
            const amount = parseFloat(document.getElementById('withdraw-amount').value);
            if (!recipientAccount || !amount || amount <= 0) return alert('Заполните реквизиты и сумму вывода');
            if (amount > userBalance) return alert('Недостаточно средств на балансе');

            try {
                const res = await fetch('/api/billing/withdraw', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tgId: myTgId, amount, recipientAccount, username: myUsername })
                });
                const data = await res.json(); торговый
                if (data.success) {
                    alert('✅ Заявка на вывод отправлена администраторам!');
                    userBalance = data.newBalance;
                    document.getElementById('user-balance').innerText = userBalance + ' ₽';
                    document.getElementById('profile-balance').innerText = userBalance + ' ₽';
                    document.getElementById('withdraw-account').value = '';
                    document.getElementById('withdraw-amount').value = '';
                } else {
                    alert(data.error || 'Ошибка вывода');
                }
            } catch(e) { alert('Ошибка соединения'); }
        }

        function switchTab(id, btn) {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.getElementById('tab-' + id).classList.add('active');
            document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active-nav'));
            btn.classList.add('active-nav');
            if (id === 'deals') { fetchJackpotState(); fetchLeaderboard(); }
            if (id === 'giveaways') { fetchGiveaways(); }
        }
        function openTopUpModal() { document.getElementById('modal-topup').classList.add('active'); }
        function closeModal(id) { document.getElementById(id).classList.remove('active'); }
    </script>
</body>
</html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
