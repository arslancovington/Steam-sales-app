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

bot.on('polling_error', (error) => {
    console.error('⚠️ Ошибка Telegram (возможно неверный BOT_TOKEN):', error.code, error.message);
});

bot.on('error', (error) => {
    console.error('⚠️ Общая ошибка бота:', error.code, error.message);
});

app.use(express.json());
app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Настройка путей для постоянного диска /data на Render с fallback на локальную директорию
const dataDir = '/data';
if (!fs.existsSync(dataDir)) {
    try {
        fs.mkdirSync(dataDir, { recursive: true });
    } catch (e) {
        console.error("Не удалось создать папку /data, используется локальная директория:", e.message);
    }
}

const dbFile = fs.existsSync(dataDir) ? path.join(dataDir, 'database.json') : path.join(__dirname, 'database.json');
const cardsFile = fs.existsSync(dataDir) ? path.join(dataDir, 'cards.json') : path.join(__dirname, 'cards.json');
const pricesFile = fs.existsSync(dataDir) ? path.join(dataDir, 'pricesCache.json') : path.join(__dirname, 'pricesCache.json');

let db = { users: {}, marketItems: [], giveaways: [], battles: [], battleWinnersHistory: [] };
let cards = [];
let pricesCache = {}; 

if (fs.existsSync(dbFile)) {
    try { 
        db = JSON.parse(fs.readFileSync(dbFile, 'utf8')); 
        if (!db.battles) db.battles = [];
        if (!db.battleWinnersHistory) db.battleWinnersHistory = [];
    } catch (e) {}
}

if (fs.existsSync(cardsFile)) {
    try { 
        cards = JSON.parse(fs.readFileSync(cardsFile, 'utf8'));
        cards = cards.map(c => ({ ...c, type: c.type || 'UZ' }));
    } catch (e) {}
}

if (fs.existsSync(pricesFile)) {
    try { pricesCache = JSON.parse(fs.readFileSync(pricesFile, 'utf8')); } catch (e) {}
}

let users = db.users || {};
let marketItems = db.marketItems || [];
let giveaways = db.giveaways || [];
let battles = db.battles.length > 0 ? db.battles : [
    { 
        _id: 'b1', 
        title: 'M4A1-S | Уединение (Minimal Wear)', 
        image: 'https://community.cloudflare.steamstatic.com/economy/image/-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I56KU0Zwwo4NUX4oFJZEHLbXH5ApeO4YmlhxYQknCRvCo04DEVlxkKgpbuMljxlFf0Ob3czxG7c-JmJW0m_7zO6_umntd8-l-j--Y8Nug3QTisxI-Z23yLdfGcAdvZwnS81O5w7jt08a6ucvJn3JmvXRzsHvUcx2wgg/360fx360f', 
        price: 200, 
        slots: 2, 
        participants: [], 
        finished: false, 
        winner: null 
    }
];
let battleWinnersHistory = db.battleWinnersHistory || [];

let cardIndexRu = 0;
let cardIndexUz = 0;

function saveData() {
    try { 
        fs.writeFileSync(dbFile, JSON.stringify({ users, marketItems, giveaways, battles, battleWinnersHistory }, null, 2)); 
    } catch (e) {}
}

function saveCards() {
    try { fs.writeFileSync(cardsFile, JSON.stringify(cards, null, 2)); } catch (e) {}
}

function savePricesCache() {
    try { fs.writeFileSync(pricesFile, JSON.stringify(pricesCache, null, 2)); } catch (e) {}
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

// ================= USER & PROFILE API =================
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

// ================= MARKETPLACE API =================
app.get('/api/market/items', (req, res) => {
    res.json({ success: true, items: marketItems });
});

app.post('/api/market/add', (req, res) => {
    const item = req.body;
    const user = getOrCreateUser(item.tgId);

    if (item.isVip) {
        if (user.balance < 245) {
            return res.json({ success: false, error: 'Недостаточно средств для VIP (требуется 245 ₽)' });
        }
        user.balance -= 245;
    }

    item._id = Date.now().toString();
    marketItems.push(item);
    saveData();
    res.json({ success: true, newBalance: user.balance });
});

app.post('/api/market/cancel', (req, res) => {
    const { itemId, tgId } = req.body;
    marketItems = marketItems.filter(i => !(i._id === itemId && String(i.tgId) === String(tgId)));
    saveData();
    res.json({ success: true });
});

// ИСПРАВЛЕНО: Полноценная логика покупки скина (списание у покупателя, начисление продавцу, удаление с маркета)
app.post('/api/deals/buy', async (req, res) => {
    const { itemId, buyerTgId, buyerTradeUrl, buyerName } = req.body;
    const itemIndex = marketItems.findIndex(i => i._id === itemId);
    if (itemIndex === -1) return res.json({ success: false, error: 'Лот не найден' });

    const item = marketItems[itemIndex];
    const buyer = getOrCreateUser(buyerTgId, buyerName);

    if (buyer.balance < item.price) {
        return res.json({ success: false, error: 'Недостаточно средств на балансе' });
    }

    // Списываем баланс у покупателя и увеличиваем счетчик сделок
    buyer.balance -= item.price;
    buyer.completedDeals = (buyer.completedDeals || 0) + 1;

    // Начисляем баланс продавцу
    const seller = getOrCreateUser(item.tgId);
    seller.balance += item.price;
    seller.completedDeals = (seller.completedDeals || 0) + 1;

    // Удаляем проданный лот с маркета
    marketItems.splice(itemIndex, 1);
    saveData();

    // Отправляем уведомление продавцу в личку Telegram
    try {
        await bot.sendMessage(item.tgId, `🎉 Ваш скин <b>${item.name}</b> успешно куплен за ${item.price} ₽! Средства зачислены на баланс.`, { parse_mode: 'HTML' });
    } catch (e) {}

    res.json({ success: true, newBalance: buyer.balance });
});

// ================= GIVEAWAYS API + NOTIFICATIONS =================
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
                return res.json({ success: false, error: `Для участия необходимо подписаться на канал спонсора: ${giveaway.sponsor}` });
            }
        } catch (err) {}
    }

    giveaway.participants.push(String(tgId));
    giveaway.participantsCount = giveaway.participants.length;
    saveData();
    res.json({ success: true });
});

function createNewGiveaway(title, image, timer, sponsor, sponsorUsername) {
    const newG = { _id: Date.now().toString(), title, image, timer, sponsor, sponsorUsername, participants: [], participantsCount: 0 };
    giveaways.push(newG);
    saveData();
    if (ADMIN_CHAT_ID && ADMIN_CHAT_ID !== 'YOUR_ADMIN_CHAT_ID') {
        bot.sendMessage(ADMIN_CHAT_ID, `🎁 <b>Новый розыгрыш скина!</b>\n\nПриз: <b>${title}</b>\nУспейте принять участие в мини-приложении!`, { parse_mode: 'HTML' }).catch(e => {});
    }
}

// ================= KOROLEVSKAYA BITTVA (BATTLES) API + NOTIFICATIONS =================
app.get('/api/battles/list', (req, res) => {
    res.json({ success: true, battles });
});

app.post('/api/battles/join', async (req, res) => {
    const { tgId, battleId, username } = req.body;
    const battle = battles.find(b => b._id === battleId);
    if (!battle || battle.finished) return res.json({ success: false, error: 'Битва недоступна или уже завершена' });

    const user = getOrCreateUser(tgId, username);
    if (user.balance < battle.price) {
        return res.json({ success: false, error: 'Недостаточно средств на балансе' });
    }

    if (battle.participants.some(p => String(p.tgId) === String(tgId))) {
        return res.json({ success: false, error: 'Вы уже участвуете в этой битве' });
    }

    user.balance -= battle.price;
    saveData();

    const participantData = {
        tgId,
        username: username || user.username || `User_${tgId}`,
        photo: user.photo || null
    };

    battle.participants.push(participantData);
    saveData();

    if (battle.participants.length >= battle.slots) {
        battle.finished = true;
        const winnerObj = battle.participants[Math.floor(Math.random() * battle.participants.length)];
        battle.winner = winnerObj;

        battleWinnersHistory.push({ tgId: winnerObj.tgId, username: winnerObj.username });
        saveData();

        try {
            await bot.sendMessage(winnerObj.tgId, `🏆 Поздравляем! Вы победили в Королевской Битве и забрали скин <b>${battle.title}</b>!`, { parse_mode: 'HTML' });
        } catch (e) {}

        if (ADMIN_CHAT_ID && ADMIN_CHAT_ID !== 'YOUR_ADMIN_CHAT_ID') {
            try {
                await bot.sendMessage(ADMIN_CHAT_ID, `⚔️ <b>Королевская Битва завершена!</b>\n\nСкин: ${battle.title}\n👑 Победитель: @${winnerObj.username}`, { parse_mode: 'HTML' });
            } catch (e) {}
        }

        setTimeout(() => createNewBattleRound(), 60000);

        return res.json({
            success: true,
            newBalance: user.balance,
            finished: true,
            battleTitle: battle.title,
            participants: battle.participants,
            winner: winnerObj
        });
    }

    saveData();
    res.json({ success: true, newBalance: user.balance, finished: false });
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

function createNewBattleRound() {
    const skinsPool = [
        { title: 'AK-47 | Красная линия (Field-Tested)', image: 'https://community.cloudflare.steamstatic.com/economy/image/-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I56KU0Zwwo4NUX4oFJZEHLbXH5ApeO4YmlhxYQknCRvCo04DEVlxkKgpot7HxfDhjxszJemkV0925m5S0k8jnN77ummJW4NE_3u2W9Iqt3QO38kBua2unIJfDcwU9aVyErVjqx7jrh8K_uZjMy3U36yk8pCuK23s2j7w/360fx360f', price: 350 },
        { title: 'AWP | Неоновая мошка (Field-Tested)', image: 'https://community.cloudflare.steamstatic.com/economy/image/-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I56KU0Zwwo4NUX4oFJZEHLbXH5ApeO4YmlhxYQknCRvCo04DEVlxkKgpot621FBRw7P7NYghF_u-1n5O0m_7zO6_umntd8-l-j--Y8d6m2wft8kVlY2ilcNTBcw83NQ2FqFC-w-u6gpO8uM7BzHZquCch4nfehAHzhg/360fx360f', price: 500 }
    ];
    const randomSkin = skinsPool[Math.floor(Math.random() * skinsPool.length)];

    battles = [{
        _id: 'b_' + Date.now(),
        title: randomSkin.title,
        image: randomSkin.image,
        price: randomSkin.price,
        slots: 2,
        participants: [],
        finished: false,
        winner: null
    }];
    saveData();

    if (ADMIN_CHAT_ID && ADMIN_CHAT_ID !== 'YOUR_ADMIN_CHAT_ID') {
        bot.sendMessage(ADMIN_CHAT_ID, `⚔️ <b>Начался новый раунд Королевской Битвы!</b>\n\nСкин: <b>${randomSkin.title}</b>\nЦена входа: ${randomSkin.price} ₽. Залетайте в мини-приложение!`, { parse_mode: 'HTML' }).catch(e => {});
    }
}

// ================= STEAM API =================
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

app.get('/api/steam/price', async (req, res) => {
    let skinName = req.query.name;
    if (!skinName) return res.json({ success: false, price: 100 });

    const now = Date.now();
    const twelveHoursMs = 12 * 60 * 60 * 1000;

    if (pricesCache[skinName] && (now - pricesCache[skinName].updatedAt < twelveHoursMs)) {
        return res.json({ success: true, price: pricesCache[skinName].price });
    }

    async function fetchPriceFromSteam(name) {
        const url = `https://steamcommunity.com/market/priceoverview/?appid=730&currency=5&market_hash_name=${encodeURIComponent(name)}`;
        const response = await axios.get(url, { 
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.9'
            }, 
            timeout: 6000 
        });

        if (response.data && response.data.success && response.data.lowest_price) {
            let priceStr = response.data.lowest_price.replace(/[^\d,.]/g, '').replace(/\s/g, '').replace(',', '.');
            let price = parseFloat(priceStr);
            if (!isNaN(price) && price > 0) {
                return Math.round(price);
            }
        }
        return null;
    }

    try {
        let finalPrice = await fetchPriceFromSteam(skinName);

        if (!finalPrice) {
            let cleanName = skinName.replace(/★\s*/g, '').replace(/StatTrak™\s*/g, '').trim();
            if (cleanName !== skinName) {
                finalPrice = await fetchPriceFromSteam(cleanName);
            }
        }

        if (finalPrice) {
            pricesCache[skinName] = { price: finalPrice, updatedAt: now };
            savePricesCache();
            return res.json({ success: true, price: finalPrice });
        }

        if (pricesCache[skinName]) {
            return res.json({ success: true, price: pricesCache[skinName].price });
        }

        res.json({ success: true, price: 150 });
    } catch (e) {
        if (pricesCache[skinName]) {
            return res.json({ success: true, price: pricesCache[skinName].price });
        }
        res.json({ success: true, price: 150 });
    }
});

// ================= BILLING & PAYMENTS API =================
app.post('/api/billing/invoice', async (req, res) => {
    const { tgId, amount, currency } = req.body;
    let rubles = currency === 'crypto' ? amount * 80 : (currency === 'stars' ? amount * 1.5 : amount);

    try {
        if (currency === 'p2pru' || currency === 'p2puz') {
            const isRu = (currency === 'p2pru');
            const targetType = isRu ? 'RU' : 'UZ';
            const filteredCards = cards.filter(c => (c.type || 'UZ') === targetType);
            
            if (filteredCards.length === 0) {
                return res.json({ success: false, error: `У администратора не добавлены карты для приема ${currency.toUpperCase()}.` });
            }

            let activeCard;
            if (isRu) {
                activeCard = filteredCards[cardIndexRu % filteredCards.length];
                cardIndexRu = (cardIndexRu + 1) % filteredCards.length;
            } else {
                activeCard = filteredCards[cardIndexUz % filteredCards.length];
                cardIndexUz = (cardIndexUz + 1) % filteredCards.length;
            }

            if (isRu) {
                await bot.sendMessage(tgId, 
                    `💳 Реквизиты для оплаты P2P RU\n\n` +
                    `Сумма к оплате: **${amount} ₽**\n` +
                    `Карта для перевода (${activeCard.holder}):\n\`${activeCard.number}\`\n\n` +
                    `После перевода нажмите кнопку ниже, чтобы отправить отчет администратору.`, 
                    {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '✅ Я оплатил(-а)', callback_data: `user_paid_${tgId}_${amount}_${amount}` }]
                            ]
                        }
                    }
                );

                if (ADMIN_CHAT_ID && ADMIN_CHAT_ID !== 'YOUR_ADMIN_CHAT_ID') {
                    await bot.sendMessage(ADMIN_CHAT_ID, 
                        `💳 Новый авто-запрос P2P RU!\n\n` +
                        `👤 Пользователь ID: \`${tgId}\`\n` +
                        `💰 Сумма зачисления: ${amount} ₽\n` +
                        `🏦 Выданная карта: \`${activeCard.number}\` (${activeCard.holder})`, 
                        {
                            parse_mode: 'Markdown',
                            reply_markup: {
                                inline_keyboard: [
                                    [
                                        { text: `✅ Подтвердить (${amount} ₽)`, callback_data: `p2p_confirm_pay_${tgId}_${amount}` },
                                        { text: `❌ Отклонить`, callback_data: `p2p_cancel_${tgId}_${amount}` }
                                    ]
                                ]
                            }
                        }
                    );
                }
            } else {
                const sumAmount = Math.round(amount * 175);
                await bot.sendMessage(tgId, 
                    `💳 Реквизиты для оплаты P2P UZ\n\n` +
                    `Сумма к оплате: **${sumAmount.toLocaleString()} сум** (${amount} ₽)\n` +
                    `Карта для перевода (${activeCard.holder}):\n\`${activeCard.number}\`\n\n` +
                    `После перевода нажмите кнопку ниже, чтобы отправить отчет администратору.`, 
                    {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '✅ Я оплатил(-а)', callback_data: `user_paid_${tgId}_${amount}_${sumAmount}` }]
                            ]
                        }
                    }
                );

                if (ADMIN_CHAT_ID && ADMIN_CHAT_ID !== 'YOUR_ADMIN_CHAT_ID') {
                    await bot.sendMessage(ADMIN_CHAT_ID, 
                        `💳 Новый авто-запрос P2P UZ!\n\n` +
                        `👤 Пользователь ID: \`${tgId}\`\n` +
                        `💰 Сумма зачисления: ${amount} ₽ (${sumAmount.toLocaleString()} сум)\n` +
                        `🏦 Выданная карта: \`${activeCard.number}\` (${activeCard.holder})`, 
                        {
                            parse_mode: 'Markdown',
                            reply_markup: {
                                inline_keyboard: [
                                    [
                                        { text: `✅ Подтвердить (${amount} ₽)`, callback_data: `p2p_confirm_pay_${tgId}_${amount}` },
                                        { text: `❌ Отклонить`, callback_data: `p2p_cancel_${tgId}_${amount}` }
                                    ]
                                ]
                            }
                        }
                    );
                }
            }
        } else if (currency === 'crypto') {
            let payUrl = 'https://t.me/CryptoBot';
            if (CRYPTO_BOT_TOKEN) {
                try {
                    const cryptoRes = await axios.post('https://pay.crypt.bot/api/createInvoice', {
                        asset: 'USDT',
                        amount: amount.toString(),
                        description: `Пополнение баланса на ${Math.round(rubles)} ₽`
                    }, { headers: { 'Crypto-Pay-API-Token': CRYPTO_BOT_TOKEN } });
                    if (cryptoRes.data?.ok) payUrl = cryptoRes.data.result.pay_url;
                } catch (err) {}
            }

            await bot.sendMessage(tgId, 
                `🧾 Счет на пополнение баланса\n\nСумма: ${amount} USDT\nК зачислению: ${Math.round(rubles)} ₽\n\nНажмите кнопку ниже для оплаты:`, 
                { reply_markup: { inline_keyboard: [[{ text: '💎 Оплатить в CryptoBot', url: payUrl }]] } }
            );
        } else if (currency === 'stars') {
            await bot.sendInvoice(
                tgId, 'Пополнение баланса', `Пополнение баланса на ${Math.round(rubles)} ₽`,
                `topup_${tgId}_${amount}_${Math.round(rubles)}`, '', 'XTR',
                [{ label: `${amount} ⭐ Звёзд`, amount: parseInt(amount) }]
            );
        }
        res.json({ success: true });
    } catch (e) {
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
            const currentUsername = username || user.username || String(tgId);
            let adminMessage = '';
            
            if (method === 'p2puz') {
                const puyoutSum = Math.round(amount * 0.95 * 145);
                adminMessage = `💸 Новая заявка на вывод P2P UZ!\n\n` +
                    `👤 Игрок: @${currentUsername} (ID: ${tgId})\n` +
                    `💰 Списано с баланса: ${amount} ₽\n` +
                    `💵 К выплате на карту: ${puyoutSum} сум (курс 145, комиссия 5%)\n` +
                    `💳 Карта получателя: ${recipientAccount}`;
            } else {
                adminMessage = `💸 Новая заявка на вывод средств (Crypto)!\n\n` +
                    `👤 Игрок: @${currentUsername} (ID: ${tgId})\n` +
                    `💰 Сумма: ${amount} ₽\n` +
                    `💎 Кошелек: ${recipientAccount}`;
            }

            await bot.sendMessage(ADMIN_CHAT_ID, adminMessage, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '✅ Подтвердить перевод', callback_data: `p2p_withdraw_done_${tgId}_${amount}` },
                            { text: '❌ Отменить / Ошибка', callback_data: `p2p_cancel_${tgId}_${amount}` }
                        ]
                    ]
                }
            });
        }
        res.json({ success: true, newBalance: user.balance });
    } catch (e) {
        user.balance += amount;
        saveData();
        res.json({ success: false, error: 'Ошибка отправки чека администраторам: возможно бот не добавлен в админ-чат.' });
    }
});

bot.on('pre_checkout_query', async (query) => {
    try { await bot.answerPreCheckoutQuery(query.id, true); } catch (e) {}
});

// ================= TELEGRAM BOT CALLBACKS =================
bot.on('callback_query', async (query) => {
    const data = query.data;

    if (data.startsWith('p2p_confirm_pay_')) {
        const parts = data.split('_');
        const targetTgId = parts[3];
        const amount = parseFloat(parts[4]);

        const user = getOrCreateUser(targetTgId);
        user.balance += amount;
        saveData();

        await bot.sendMessage(targetTgId, `✅ Ваша оплата на сумму ${amount} ₽ подтверждена! Баланс успешно пополнен.`);
        await bot.editMessageText(`✅ Пополнение на ${amount} ₽ для игрока ${targetTgId} успешно подтверждено!`, {
            chat_id: query.message.chat.id, message_id: query.message.message_id
        });
        await bot.answerCallbackQuery(query.id, { text: 'Пополнение подтверждено!' });
    }
    else if (data.startsWith('p2p_withdraw_done_')) {
        const parts = data.split('_');
        const targetTgId = parts[3];
        const amount = parts[4];

        await bot.sendMessage(targetTgId, `✅ Ваша заявка на вывод ${amount} ₽ успешно обработана! Деньги отправлены на банковскую карту.`);
        await bot.editMessageText(`✅ Вывод средств на сумму ${amount} ₽ для игрока ${targetTgId} выполнен.`, {
            chat_id: query.message.chat.id, message_id: query.message.message_id
        });
        await bot.answerCallbackQuery(query.id, { text: 'Вывод подтвержден!' });
    }
    else if (data.startsWith('p2p_cancel_')) {
        const parts = data.split('_');
        const targetTgId = parts[2];
        const amount = parts[3];

        await bot.sendMessage(targetTgId, `❌ Ваша операция на сумму ${amount} ₽ была отклонена / отменена администратором.`);
        await bot.editMessageText(`❌ Заявка / платеж на сумму ${amount} ₽ для игрока ${targetTgId} отклонена.`, {
            chat_id: query.message.chat.id, message_id: query.message.message_id
        });
        await bot.answerCallbackQuery(query.id, { text: 'Операция отклонена.' });
    }
});

// ================= START SERVER =================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
