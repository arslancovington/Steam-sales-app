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

// Настройка путей для постоянного диска /data на Render
const dataDir = '/data';
if (!fs.existsSync(dataDir)) {
    try { fs.mkdirSync(dataDir, { recursive: true }); } catch (e) { console.error(e.message); }
}

const dbFile = fs.existsSync(dataDir) ? path.join(dataDir, 'database.json') : path.join(__dirname, 'database.json');
const cardsFile = fs.existsSync(dataDir) ? path.join(dataDir, 'cards.json') : path.join(__dirname, 'cards.json');
const pricesFile = fs.existsSync(dataDir) ? path.join(dataDir, 'pricesCache.json') : path.join(__dirname, 'pricesCache.json');

let db = { users: {}, marketItems: [], giveaways: [] };
let cards = [];
let pricesCache = {}; 

if (fs.existsSync(dbFile)) { try { db = JSON.parse(fs.readFileSync(dbFile, 'utf8')); } catch (e) {} }
if (fs.existsSync(cardsFile)) { try { cards = JSON.parse(fs.readFileSync(cardsFile, 'utf8')).map(c => ({ ...c, type: c.type || 'UZ' })); } catch (e) {} }
if (fs.existsSync(pricesFile)) { try { pricesCache = JSON.parse(fs.readFileSync(pricesFile, 'utf8')); } catch (e) {} }

let users = db.users || {};
let marketItems = db.marketItems || [];
let giveaways = db.giveaways || [];
let cardIndexRu = 0;
let cardIndexUz = 0;

function saveData() { try { fs.writeFileSync(dbFile, JSON.stringify({ users, marketItems, giveaways }, null, 2)); } catch (e) {} }
function saveCards() { try { fs.writeFileSync(cardsFile, JSON.stringify(cards, null, 2)); } catch (e) {} }
function savePricesCache() { try { fs.writeFileSync(pricesFile, JSON.stringify(pricesCache, null, 2)); } catch (e) {} }

function getOrCreateUser(tgId, username = 'Игрок', photoUrl = null) {
    const now = Date.now();
    if (!users[tgId]) {
        users[tgId] = { 
            tgId, 
            username: username || 'Игрок', 
            photoUrl,
            balance: 0, 
            rating: 5.0, 
            completedDeals: 0, 
            tradeUrl: '', 
            steamId: '',
            lastActive: now
        };
    } else {
        users[tgId].lastActive = now;
        if (username && username !== 'Игрок') users[tgId].username = username;
        if (photoUrl) users[tgId].photoUrl = photoUrl;
    }
    saveData();
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
        } catch (e) { return null; }
    }
    return null;
}

/* =========================================
   ЛОГИКА КОРОЛЕВСКОЙ БИТВЫ (ДЖЕКПОТ)
========================================= */
const BATTLE_COLORS = ['#ff4d4d', '#00ffff', '#bf00ff', '#7cfc00', '#ffaa00', '#ff0055'];
let battleState = resetBattleState();

function resetBattleState() {
    return {
        id: Date.now().toString(),
        status: 'waiting',
        participants: [], 
        bank: 0,
        startTime: null,
        rollEndTime: null,
        winnerTgId: null,
        winnerPrize: 0
    };
}

setInterval(async () => {
    const now = Date.now();
    if (battleState.status === 'countdown' && now >= battleState.startTime) {
        battleState.status = 'rolling';
        battleState.rollEndTime = now + 13000; 
        
        let rand = Math.random() * battleState.bank;
        let current = 0;
        for (let p of battleState.participants) {
            current += p.bet;
            if (rand <= current) {
                battleState.winnerTgId = p.tgId;
                break;
            }
        }
    } else if (battleState.status === 'rolling' && now >= battleState.rollEndTime) {
        battleState.status = 'finished';
        if (battleState.winnerTgId) {
            const winner = users[battleState.winnerTgId];
            battleState.winnerPrize = Math.round(battleState.bank * 0.8); // 80% победителю
            if (winner) {
                winner.balance += battleState.winnerPrize;
                saveData();
                try {
                    await bot.sendMessage(battleState.winnerTgId, `🏆 Поздравляем! Вы выиграли Королевскую битву и сорвали куш: ${battleState.winnerPrize} ₽!`);
                } catch (e) {}
            }
        }
        
        setTimeout(() => { battleState = resetBattleState(); }, 7000);
    }
}, 1000);

app.get('/api/battle/state', (req, res) => res.json({ success: true, state: battleState }));

app.post('/api/battle/bet', (req, res) => {
    const { tgId, username, photoUrl, amount } = req.body;
    const bet = parseFloat(amount);
    
    if (isNaN(bet) || bet < 10) return res.json({ success: false, error: 'Минимальная ставка 10 ₽' });
    if (battleState.status !== 'waiting' && battleState.status !== 'countdown') {
        return res.json({ success: false, error: 'Ставки закрыты, идет рулетка!' });
    }

    const user = getOrCreateUser(tgId, username, photoUrl);
    if (user.balance < bet) return res.json({ success: false, error: 'Недостаточно средств!' });

    user.balance -= bet;
    saveData();

    let existingParticipant = battleState.participants.find(p => p.tgId === tgId);
    if (existingParticipant) {
        existingParticipant.bet += bet;
    } else {
        const color = BATTLE_COLORS[battleState.participants.length % BATTLE_COLORS.length];
        battleState.participants.push({ tgId, username, avatar: photoUrl || '🧑‍🚀', bet, color });
    }
    battleState.bank += bet;

    if (battleState.status === 'waiting' && battleState.participants.length >= 2) {
        battleState.status = 'countdown';
        battleState.startTime = Date.now() + 25000;
    }

    res.json({ success: true, newBalance: user.balance });
});


/* =========================================
   API ПОЛЬЗОВАТЕЛЯ И МАРКЕТПЛЕЙСА
========================================= */
app.get('/api/user/profile', (req, res) => {
    const { tgId, tgUser, photoUrl } = req.query;
    if (!tgId) return res.json({ success: false, error: 'No tgId provided' });
    const user = getOrCreateUser(tgId, tgUser, photoUrl);
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
        if (user.balance < 245) return res.json({ success: false, error: 'Недостаточно средств для VIP (245 ₽)' });
        user.balance -= 245;
    }

    // Добавляем комиссию 4% для покупателя
    item.buyerPrice = Math.round(item.price * 1.04);
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

app.post('/api/deals/buy', async (req, res) => {
    const { itemId, buyerTgId } = req.body;
    const buyer = getOrCreateUser(buyerTgId);
    
    const itemIndex = marketItems.findIndex(i => i._id === itemId);
    if (itemIndex === -1) return res.json({ success: false, error: 'Предмет не найден или уже продан' });
    
    const item = marketItems[itemIndex];
    if (String(item.tgId) === String(buyerTgId)) return res.json({ success: false, error: 'Нельзя купить свой лот' });
    if (buyer.balance < item.buyerPrice) return res.json({ success: false, error: 'Недостаточно средств на балансе!' });

    buyer.balance -= item.buyerPrice;
    
    const seller = getOrCreateUser(item.tgId, item.seller);
    seller.balance += item.price;
    seller.completedDeals = (seller.completedDeals || 0) + 1;

    marketItems.splice(itemIndex, 1);
    saveData();

    try {
        await bot.sendMessage(item.tgId, `🎉 Ваш предмет "${item.name}" был куплен за ${item.price} ₽! Средства зачислены на баланс.`);
    } catch (e) {}

    res.json({ success: true, newBalance: buyer.balance });
});

/* =========================================
   РОЗЫГРЫШИ И STEAM API
========================================= */
app.get('/api/giveaways/list', (req, res) => res.json({ success: true, giveaways }));

app.post('/api/giveaways/join', async (req, res) => {
    const { tgId, giveawayId } = req.body;
    const giveaway = giveaways.find(g => g._id === giveawayId);
    
    if (!giveaway) return res.json({ success: false, error: 'Розыгрыш не найден' });
    if (giveaway.participants.includes(String(tgId))) return res.json({ success: false, error: 'Вы уже участвуете!' });

    if (giveaway.sponsorUsername) {
        try {
            const chatMember = await bot.getChatMember(giveaway.sponsorUsername, tgId);
            const isMember = ['creator', 'administrator', 'member'].includes(chatMember.status);
            if (!isMember) return res.json({ success: false, error: `Для участия необходимо подписаться на канал спонсора: ${giveaway.sponsor}` });
        } catch (err) {}
    }

    giveaway.participants.push(String(tgId));
    giveaway.participantsCount = giveaway.participants.length;
    saveData();
    res.json({ success: true });
});

app.post('/api/steam/inventory', async (req, res) => {
    let { steamId, tgId } = req.body;
    if (!steamId && tgId && users[tgId]) steamId = users[tgId].steamId;
    if (!steamId) return res.json({ success: false, items: [], descriptions: [] });

    try {
        const invRes = await axios.get(`https://steamcommunity.com/inventory/${steamId}/730/2?l=russian&count=75`, {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'ru-RU,ru;q=0.9' }, timeout: 10000
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
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'ru-RU,ru;q=0.9' }, timeout: 6000 
        });

        if (response.data && response.data.success && response.data.lowest_price) {
            let priceStr = response.data.lowest_price.replace(/[^\d,.]/g, '').replace(/\s/g, '').replace(',', '.');
            let price = parseFloat(priceStr);
            if (!isNaN(price) && price > 0) return Math.round(price);
        }
        return null;
    }

    try {
        let finalPrice = await fetchPriceFromSteam(skinName);
        if (!finalPrice) {
            let cleanName = skinName.replace(/★\s*/g, '').replace(/StatTrak™\s*/g, '').trim();
            if (cleanName !== skinName) finalPrice = await fetchPriceFromSteam(cleanName);
        }

        if (finalPrice) {
            pricesCache[skinName] = { price: finalPrice, updatedAt: now };
            savePricesCache();
            return res.json({ success: true, price: finalPrice });
        }
        if (pricesCache[skinName]) return res.json({ success: true, price: pricesCache[skinName].price });
        res.json({ success: true, price: 150 });
    } catch (e) {
        if (pricesCache[skinName]) return res.json({ success: true, price: pricesCache[skinName].price });
        res.json({ success: true, price: 150 });
    }
});

/* =========================================
   ПОПОЛНЕНИЯ, ВЫВОДЫ И УВЕДОМЛЕНИЯ АДМИНА
========================================= */
app.post('/api/billing/invoice', async (req, res) => {
    const { tgId, amount, currency } = req.body;
    let rubles = currency === 'USDT' ? amount * 80 : (currency === 'Stars' ? amount * 1.5 : amount);

    try {
        if (currency === 'P2P RU' || currency === 'P2P UZ') {
            const isRu = (currency === 'P2P RU');
            const targetType = isRu ? 'RU' : 'UZ';
            const filteredCards = cards.filter(c => (c.type || 'UZ') === targetType);
            
            if (filteredCards.length === 0) {
                return res.json({ success: false, error: `У администратора не добавлены карты для приема ${currency}.` });
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
                    `💳 Реквизиты для оплаты P2P RU\n\nСумма к оплате: **${amount} ₽**\nКарта для перевода (${activeCard.holder}):\n\`${activeCard.number}\`\n\nПосле перевода нажмите кнопку ниже.`, 
                    {
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [[{ text: '✅ Я оплатил(-а)', callback_data: `user_paid_${tgId}_${amount}_${amount}` }]] }
                    }
                );

                if (ADMIN_CHAT_ID && ADMIN_CHAT_ID !== 'YOUR_ADMIN_CHAT_ID') {
                    await bot.sendMessage(ADMIN_CHAT_ID, 
                        `💳 Новый авто-запрос P2P RU!\n\n👤 Пользователь ID: \`${tgId}\`\n💰 Сумма зачисления: ${amount} ₽\n🏦 Выданная карта: \`${activeCard.number}\` (${activeCard.holder})`, 
                        {
                            parse_mode: 'Markdown',
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: `✅ Подтвердить (${amount} ₽)`, callback_data: `p2p_confirm_pay_${tgId}_${amount}` }, { text: `❌ Отклонить`, callback_data: `p2p_cancel_${tgId}_${amount}` }]
                                ]
                            }
                        }
                    );
                }
            } else {
                const sumAmount = Math.round(amount * 175);
                await bot.sendMessage(tgId, 
                    `💳 Реквизиты для оплаты P2P UZ\n\nСумма к оплате: **${sumAmount.toLocaleString()} сум** (${amount} ₽)\nКарта для перевода (${activeCard.holder}):\n\`${activeCard.number}\`\n\nПосле перевода нажмите кнопку ниже.`, 
                    {
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [[{ text: '✅ Я оплатил(-а)', callback_data: `user_paid_${tgId}_${amount}_${sumAmount}` }]] }
                    }
                );

                if (ADMIN_CHAT_ID && ADMIN_CHAT_ID !== 'YOUR_ADMIN_CHAT_ID') {
                    await bot.sendMessage(ADMIN_CHAT_ID, 
                        `💳 Новый авто-запрос P2P UZ!\n\n👤 Пользователь ID: \`${tgId}\`\n💰 Сумма зачисления: ${amount} ₽ (${sumAmount.toLocaleString()} сум)\n🏦 Выданная карта: \`${activeCard.number}\` (${activeCard.holder})`, 
                        {
                            parse_mode: 'Markdown',
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: `✅ Подтвердить (${amount} ₽)`, callback_data: `p2p_confirm_pay_${tgId}_${amount}` }, { text: `❌ Отклонить`, callback_data: `p2p_cancel_${tgId}_${amount}` }]
                                ]
                            }
                        }
                    );
                }
            }
        } else if (currency === 'USDT') {
            let payUrl = 'https://t.me/CryptoBot';
            if (CRYPTO_BOT_TOKEN) {
                try {
                    const cryptoRes = await axios.post('https://pay.crypt.bot/api/createInvoice', {
                        asset: 'USDT', amount: amount.toString(), description: `Пополнение на ${Math.round(rubles)} ₽`
                    }, { headers: { 'Crypto-Pay-API-Token': CRYPTO_BOT_TOKEN } });
                    if (cryptoRes.data?.ok) payUrl = cryptoRes.data.result.pay_url;
                } catch (err) {}
            }
            await bot.sendMessage(tgId, 
                `🧾 Счет на пополнение\n\nСумма: ${amount} USDT\nК зачислению: ${Math.round(rubles)} ₽\n\nНажмите кнопку ниже:`, 
                { reply_markup: { inline_keyboard: [[{ text: '💎 Оплатить в CryptoBot', url: payUrl }]] } }
            );
        } else if (currency === 'Stars') {
            await bot.sendInvoice(
                tgId, 'Пополнение баланса', `Пополнение баланса на ${Math.round(rubles)} ₽`,
                `topup_${tgId}_${amount}_${Math.round(rubles)}`, '', 'XTR',
                [{ label: `${amount} ⭐ Звёзд`, amount: parseInt(amount) }]
            );
        }
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, error: 'Ошибка сервера. Напишите боту /start в личные сообщения.' });
    }
});

app.post('/api/billing/withdraw', async (req, res) => {
    const { tgId, amount, recipientAccount, username, method } = req.body;
    const user = getOrCreateUser(tgId, username);
    
    if (user.balance < amount) return res.json({ success: false, error: 'Недостаточно средств на балансе' });

    user.balance -= amount;
    saveData();

    try {
        if (ADMIN_CHAT_ID && ADMIN_CHAT_ID !== 'YOUR_ADMIN_CHAT_ID') {
            const currentUsername = username || user.username || String(tgId);
            let adminMessage = '';
            
            if (method === 'P2P UZ') {
                const puyoutSum = Math.round(amount * 0.95 * 145);
                adminMessage = `💸 Новая заявка на вывод P2P UZ!\n\n👤 Игрок: @${currentUsername} (ID: ${tgId})\n💰 Списано с баланса: ${amount} ₽\n💵 К выплате на карту: ${puyoutSum} сум\n💳 Карта получателя: ${recipientAccount}`;
            } else {
                adminMessage = `💸 Новая заявка на вывод средств (Crypto)!\n\n👤 Игрок: @${currentUsername} (ID: ${tgId})\n💰 Сумма: ${amount} ₽\n💎 Кошелек: ${recipientAccount}`;
            }

            await bot.sendMessage(ADMIN_CHAT_ID, adminMessage, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '✅ Подтвердить перевод', callback_data: `p2p_withdraw_done_${tgId}_${amount}` }, { text: '❌ Отменить / Ошибка', callback_data: `p2p_cancel_${tgId}_${amount}` }]
                    ]
                }
            });
        }
        res.json({ success: true, newBalance: user.balance });
    } catch (e) {
        user.balance += amount;
        saveData();
        res.json({ success: false, error: 'Ошибка отправки чека администраторам.' });
    }
});

/* =========================================
   TELEGRAM BOT СОБЫТИЯ
========================================= */
bot.on('pre_checkout_query', async (query) => {
    try { await bot.answerPreCheckoutQuery(query.id, true); } catch (e) {}
});

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

        await bot.sendMessage(targetTgId, `✅ Ваша заявка на вывод ${amount} ₽ успешно обработана! Деньги отправлены.`);
        await bot.editMessageText(`✅ Вывод средств на сумму ${amount} ₽ для игрока ${targetTgId} выполнен.`, {
            chat_id: query.message.chat.id, message_id: query.message.message_id
        });
        await bot.answerCallbackQuery(query.id, { text: 'Вывод подтвержден!' });
    }
    else if (data.startsWith('p2p_cancel_')) {
        const parts = data.split('_');
        const targetTgId = parts[2];
        const amount = parts[3];

        await bot.sendMessage(targetTgId, `❌ Ваша операция на сумму ${amount} ₽ была отклонена администратором.`);
        await bot.editMessageText(`❌ Заявка / платеж на сумму ${amount} ₽ для игрока ${targetTgId} отклонена.`, {
            chat_id: query.message.chat.id, message_id: query.message.message_id
        });
        await bot.answerCallbackQuery(query.id, { text: 'Отменено' });
    }
    else if (data.startsWith('user_paid_')) {
        const parts = data.split('_');
        const targetTgId = parts[2];
        const amount = parts[3];

        if (ADMIN_CHAT_ID && ADMIN_CHAT_ID !== 'YOUR_ADMIN_CHAT_ID') {
            await bot.sendMessage(ADMIN_CHAT_ID, 
                `🔔 Пользователь ${targetTgId} нажал кнопку "Я оплатил" для пополнения на ${amount} ₽!`, 
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: `✅ Подтвердить (${amount} ₽)`, callback_data: `p2p_confirm_pay_${targetTgId}_${amount}` }, { text: `❌ Оплата не пришла`, callback_data: `p2p_cancel_${targetTgId}_${amount}` }]
                        ]
                    }
                }
            );
        }
        await bot.answerCallbackQuery(query.id, { text: 'Уведомление отправлено администратору!' });
        await bot.editMessageText(`✅ Вы сообщили об оплате. Ожидайте подтверждения.`, {
            chat_id: query.message.chat.id, message_id: query.message.message_id
        });
    }
});

bot.on('message', async (msg) => {
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

    const text = msg.text || msg.caption;
    if (!text) return;

    if (text.startsWith('/online')) {
        const now = Date.now();
        const fifteenMinutesMs = 15 * 60 * 1000;
        let total = Object.keys(users).length;
        let online = 0;

        Object.values(users).forEach(u => {
            if (u.lastActive && (now - u.lastActive < fifteenMinutesMs)) online++;
        });
        await bot.sendMessage(msg.chat.id, `👥 Онлайн / Всего: <b>${online} / ${total}</b>`, { parse_mode: 'HTML' });
        return;
    }

    if (text.startsWith('/newbattle')) {
        const parts = text.replace('/newbattle', '').split('|').map(p => p.trim());
        if (parts.length < 3) {
            await bot.sendMessage(msg.chat.id, '❌ Формат: `/newbattle [Название] | [Цена входа ₽] | [Макс игроков]`', { parse_mode: 'Markdown' });
            return;
        }

        const title = parts[0];
        const entryFee = parseFloat(parts[1]);
        const maxPlayers = parseInt(parts[2]);

        if (isNaN(entryFee) || isNaN(maxPlayers)) {
            await bot.sendMessage(msg.chat.id, '❌ Цена входа и количество игроков должны быть числами.');
            return;
        }

        battleState = {
            id: Date.now().toString(),
            title,
            entryFee,
            maxPlayers,
            status: 'waiting',
            participants: [],
            bank: 0,
            winnerTgId: null,
            winnerPrize: 0
        };
        saveData();

        await bot.sendMessage(msg.chat.id, `✅ Королевская битва "${title}" создана!\n💰 Вход: ${entryFee} ₽\n👥 Макс. игроков: ${maxPlayers}`);
        return;
    }

    if (text.startsWith('/addcard')) {
        const parts = text.split(' ');
        if (parts.length < 3) {
            await bot.sendMessage(msg.chat.id, '❌ Формат:\n`/addcard ru [номер] [владелец]`\nили\n`/addcard uz [номер] [владелец]`', { parse_mode: 'Markdown' });
            return;
        }

        let type = 'UZ';
        let startIndex = 1;
        if (parts[1].toLowerCase() === 'ru' || parts[1].toLowerCase() === 'uz') {
            type = parts[1].toUpperCase();
            startIndex = 2;
        }

        const number = parts[startIndex];
        const holder = parts.slice(startIndex + 1).join(' ');
        if (!number || !holder) return;

        cards.push({ number, holder, type });
        saveCards();
        await bot.sendMessage(msg.chat.id, `✅ [${type}] Карта ${number} (${holder}) добавлена! Всего карт: ${cards.length}`);
        return;
    }

    if (text.startsWith('/cards')) {
        if (cards.length === 0) return await bot.sendMessage(msg.chat.id, '📭 Список карт пуст.');
        let list = '💳 **Список доступных карт:**\n\n';
        cards.forEach((c, idx) => { list += `${idx + 1}. [**${c.type || 'UZ'}**] \`${c.number}\` — ${c.holder}\n`; });
        list += '\nДля удаления: `/delcard [номер]`';
        await bot.sendMessage(msg.chat.id, list, { parse_mode: 'Markdown' });
        return;
    }

    if (text.startsWith('/delcard')) {
        const index = parseInt(text.split(' ')[1]) - 1;
        if (isNaN(index) || !cards[index]) return await bot.sendMessage(msg.chat.id, '❌ Неверный номер.');
        const removed = cards.splice(index, 1);
        saveCards();
        await bot.sendMessage(msg.chat.id, `🗑 Карта [${removed[0].type}] \`${removed[0].number}\` удалена.`);
        return;
    }

    if (text.startsWith('/newgiveaway')) {
        const lines = text.split('\n');
        let title = '', sponsor = '', timer = '';
        lines.forEach(line => {
            if (line.toLowerCase().startsWith('prize:') || line.toLowerCase().startsWith('приз:')) title = line.replace(/^(prize:|приз:)/i, '').trim();
            if (line.toLowerCase().startsWith('sponsor:') || line.toLowerCase().startsWith('спонсор:')) sponsor = line.replace(/^(sponsor:|спонсор:)/i, '').trim();
            if (line.toLowerCase().startsWith('timer:') || line.toLowerCase().startsWith('таймер:')) timer = line.replace(/^(timer:|таймер:)/i, '').trim();
        });

        if (!title || !sponsor) return await bot.sendMessage(msg.chat.id, '❌ Ошибка! Не удалось распознать "Приз:" или "Спонсор:".');

        let sponsorUsername = sponsor.trim();
        if (sponsorUsername.includes('t.me/')) sponsorUsername = '@' + sponsorUsername.split('t.me/')[1].replace('/', '');
        else if (!sponsorUsername.startsWith('@') && !sponsorUsername.startsWith('http')) sponsorUsername = '@' + sponsorUsername;

        let imageUrl = 'https://community.cloudflare.steamstatic.com/economy/image/-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I56KU0Zwwo4NUX4oFJZEHLbXH5ApeO4YmlhxYQknCRvCo04DEVlxkKgpot7HxfDhjxszJemkV092lnYmOhcj5Nr_Yg2ZU7PFohO_J9o-j2Vfk8hVtNjjwJ9ORfVFvY1-G_wO7x-_u1sS5uJ6ayXswuSM8pGGKYW964g/360fx360f';
        if (msg.photo && msg.photo.length > 0) {
            try { imageUrl = await bot.getFileLink(msg.photo[msg.photo.length - 1].file_id); } catch (err) {}
        }

        giveaways.push({ _id: Date.now().toString(), title, sponsor, sponsorUsername, timer: timer || 'Скоро', image: imageUrl, participantsCount: 0, participants: [] });
        saveData();
        await bot.sendMessage(msg.chat.id, `✅ Розыгрыш "${title}" добавлен!`);
        return;
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Bot and Server are running on port ${PORT}`);
});
