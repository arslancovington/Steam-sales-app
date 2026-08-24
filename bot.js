const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const TOKEN = process.env.BOT_TOKEN || 'YOUR_TELEGRAM_BOT_TOKEN';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || 'YOUR_ADMIN_CHAT_ID';
const CRYPTO_BOT_TOKEN = process.env.CRYPTO_BOT_TOKEN || '';
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://your-app.onrender.com';

const bot = new TelegramBot(TOKEN, { polling: true });
const app = express();

bot.on('polling_error', (error) => console.error('⚠️ Ошибка Telegram:', error.code, error.message));
bot.on('error', (error) => console.error('⚠️ Общая ошибка бота:', error.code, error.message));

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
const pricesFile = fs.existsSync(dataDir) ? path.join(dataDir, 'pricesCache.json') : path.join(__dirname, 'pricesCache.json');

let db = { users: {}, marketItems: [], giveaways: [], chats: [] };
let cards = [];
let pricesCache = {}; 

if (fs.existsSync(dbFile)) { try { db = JSON.parse(fs.readFileSync(dbFile, 'utf8')); } catch (e) {} }
if (fs.existsSync(cardsFile)) { try { cards = JSON.parse(fs.readFileSync(cardsFile, 'utf8')).map(c => ({ ...c, type: c.type || 'UZ' })); } catch (e) {} }
if (fs.existsSync(pricesFile)) { try { pricesCache = JSON.parse(fs.readFileSync(pricesFile, 'utf8')); } catch (e) {} }

let users = db.users || {};
let marketItems = db.marketItems || [];
let giveaways = db.giveaways || [];
let chats = db.chats || [];
let cardIndexRu = 0;
let cardIndexUz = 0;

function saveData() { 
    try { fs.writeFileSync(dbFile, JSON.stringify({ users, marketItems, giveaways, chats }, null, 2)); } catch (e) {} 
}

function getOrCreateUser(tgId, username = 'Игрок', photoUrl = null) {
    const now = Date.now();
    if (!users[tgId]) {
        users[tgId] = { tgId, username: username || 'Игрок', photoUrl, balance: 0, rating: 5.0, completedDeals: 0, tradeUrl: '', steamId: '', lastActive: now };
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
        try { return (BigInt(partnerMatch[1]) + 76561197960265728n).toString(); } catch (e) { return null; }
    }
    return null;
}

/* =========================================
   ФОНОВЫЕ ПРОЦЕССЫ (БИТВЫ И РОЗЫГРЫШИ)
========================================= */
const BATTLE_COLORS = ['#00ffff', '#7cfc00', '#bf00ff', '#ff0055', '#ffaa00', '#00ffaa'];
let battleState = resetBattleState();

function resetBattleState() {
    return { id: Date.now().toString(), status: 'waiting', participants: [], bank: 0, startTime: null, rollEndTime: null, winnerTgId: null, winnerPrize: 0 };
}

setInterval(async () => {
    const now = Date.now();
    
    if (battleState.status === 'countdown' && now >= battleState.startTime) {
        battleState.status = 'rolling';
        battleState.rollEndTime = now + 13000; 
        let rand = Math.random() * battleState.bank, current = 0;
        for (let p of battleState.participants) {
            current += p.bet;
            if (rand <= current) { battleState.winnerTgId = p.tgId; break; }
        }
    } else if (battleState.status === 'rolling' && now >= battleState.rollEndTime) {
        battleState.status = 'finished';
        if (battleState.winnerTgId) {
            const winner = users[battleState.winnerTgId];
            battleState.winnerPrize = Math.round(battleState.bank * 0.8);
            if (winner) {
                winner.balance += battleState.winnerPrize;
                saveData();
                try { await bot.sendMessage(battleState.winnerTgId, `🏆 Поздравляем! Вы выиграли Королевскую битву и получили куш: ${battleState.winnerPrize} ₽!`); } catch (e) {}
            }
        }
        setTimeout(() => { battleState = resetBattleState(); }, 7000);
    }

    let giveawaysUpdated = false;
    giveaways.forEach(g => {
        if (!g.ended && g.endTime && now >= g.endTime) {
            g.ended = true;
            g.endedAt = now;
            giveawaysUpdated = true;

            if (g.participants && g.participants.length > 0) {
                const winnerId = g.participants[Math.floor(Math.random() * g.participants.length)];
                g.winnerTgId = winnerId;
                const winnerUser = users[winnerId];
                g.winnerUsername = winnerUser ? winnerUser.username : String(winnerId);
                g.winnerTradeUrl = winnerUser ? (winnerUser.tradeUrl || 'Не указан') : 'Не указан';

                try {
                    bot.sendMessage(winnerId, `🎉 Поздравляем! Вы выиграли в розыгрыше предмета: *${g.title}*!\nАдминистратор скоро свяжется с вами для передачи скина.`, { parse_mode: 'Markdown' });
                } catch (e) {}

                if (ADMIN_CHAT_ID && ADMIN_CHAT_ID !== 'YOUR_ADMIN_CHAT_ID') {
                    try {
                        bot.sendMessage(ADMIN_CHAT_ID, `🎁 Розыгрыш завершен!\n\n🏆 Приз: *${g.title}*\n👤 Победитель: @${g.winnerUsername} (ID: \`${winnerId}\`)\n🔗 Trade URL: \`${g.winnerTradeUrl}\``, { parse_mode: 'Markdown' });
                    } catch (e) {}
                }
            } else {
                g.winnerUsername = 'Нет участников';
                if (ADMIN_CHAT_ID && ADMIN_CHAT_ID !== 'YOUR_ADMIN_CHAT_ID') {
                    try { bot.sendMessage(ADMIN_CHAT_ID, `🎁 Розыгрыш завершен: *${g.title}* — участников не было.`, { parse_mode: 'Markdown' }); } catch (e) {}
                }
            }
        }
    });

    const activeOrRecentGiveaways = giveaways.filter(g => {
        if (g.ended && g.endedAt) return (now - g.endedAt) < 24 * 60 * 60 * 1000;
        return true;
    });

    if (activeOrRecentGiveaways.length !== giveaways.length) {
        giveaways = activeOrRecentGiveaways;
        giveawaysUpdated = true;
    }

    if (giveawaysUpdated) saveData();

}, 15000);

/* =========================================
   API МАРКЕТПЛЕЙСА И СДЕЛОК
========================================= */
app.get('/api/battle/state', (req, res) => res.json({ success: true, state: battleState, serverTime: Date.now() }));

app.post('/api/battle/bet', (req, res) => {
    const { tgId, username, photoUrl, amount } = req.body;
    const bet = parseFloat(amount);
    if (isNaN(bet) || bet < 10) return res.json({ success: false, error: 'Минимальная ставка 10 ₽' });
    if (battleState.status !== 'waiting' && battleState.status !== 'countdown') return res.json({ success: false, error: 'Ставки закрыты!' });

    const user = getOrCreateUser(tgId, username, photoUrl);
    if (user.balance < bet) return res.json({ success: false, error: 'Недостаточно средств!' });

    user.balance -= bet;
    saveData();

    let existing = battleState.participants.find(p => p.tgId === tgId);
    if (existing) existing.bet += bet;
    else {
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

app.get('/api/user/profile', (req, res) => {
    const { tgId, tgUser, photoUrl } = req.query;
    if (!tgId) return res.json({ success: false });
    res.json({ success: true, ...getOrCreateUser(tgId, tgUser, photoUrl) });
});

app.post('/api/user/save', (req, res) => {
    const { tgId, tradeUrl } = req.body;
    const user = getOrCreateUser(tgId);
    user.tradeUrl = tradeUrl || '';
    const steamId = extractSteamIdFromTradeUrl(tradeUrl);
    if (steamId) user.steamId = steamId;
    saveData();
    res.json({ success: true, steamId: user.steamId });
});

app.get('/api/market/items', (req, res) => res.json({ success: true, items: marketItems }));

app.post('/api/market/add', (req, res) => {
    const item = req.body;
    const user = getOrCreateUser(item.tgId);
    if (item.isVip) {
        if (user.balance < 245) return res.json({ success: false, error: 'Недостаточно средств для VIP (245 ₽)' });
        user.balance -= 245;
    }
    item.price = parseFloat(item.price);
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
    if (itemIndex === -1) return res.json({ success: false, error: 'Предмет не найден' });
    
    const item = marketItems[itemIndex];
    if (String(item.tgId) === String(buyerTgId)) return res.json({ success: false, error: 'Нельзя купить свой лот' });
    if (buyer.balance < item.buyerPrice) return res.json({ success: false, error: 'Недостаточно средств' });

    buyer.balance -= item.buyerPrice;
    const seller = getOrCreateUser(item.tgId, item.seller);
    seller.balance += item.price;
    seller.completedDeals = (seller.completedDeals || 0) + 1;

    marketItems.splice(itemIndex, 1);
    saveData();

    try { await bot.sendMessage(item.tgId, `🎉 Ваш предмет "${item.name}" был куплен за ${item.price} ₽! Средства зачислены.`); } catch (e) {}

    if (ADMIN_CHAT_ID && ADMIN_CHAT_ID !== 'YOUR_ADMIN_CHAT_ID') {
        try {
            await bot.sendMessage(ADMIN_CHAT_ID, `🛍 Успешная сделка на маркете!\n\n🏷 Предмет: *${item.name}*\n💰 Цена продавцу: ${item.price} ₽\n👤 Продавец ID: \`${item.tgId}\`\n👤 Покупатель ID: \`${buyerTgId}\``, { parse_mode: 'Markdown' });
        } catch (e) {}
    }

    res.json({ success: true, newBalance: buyer.balance });
});

/* =========================================
   РОЗЫГРЫШИ И СТИМ API
========================================= */
app.get('/api/giveaways/list', (req, res) => res.json({ success: true, giveaways }));

app.post('/api/giveaways/join', async (req, res) => {
    const { tgId, giveawayId } = req.body;
    const giveaway = giveaways.find(g => g._id === giveawayId);
    if (!giveaway) return res.json({ success: false, error: 'Розыгрыш не найден' });
    if (giveaway.ended) return res.json({ success: false, error: 'Розыгрыш уже завершен' });
    if (giveaway.participants.includes(String(tgId))) return res.json({ success: false, error: 'Вы уже участвуете!' });

    if (giveaway.sponsorUsername) {
        try {
            const member = await bot.getChatMember(giveaway.sponsorUsername, tgId);
            if (!['creator', 'administrator', 'member'].includes(member.status)) {
                return res.json({ success: false, error: `Подпишитесь на канал: ${giveaway.sponsor}` });
            }
        } catch (e) {}
    }

    giveaway.participants.push(String(tgId));
    giveaway.participantsCount = giveaway.participants.length;
    saveData();
    res.json({ success: true });
});

app.post('/api/steam/inventory', async (req, res) => {
    let { steamId, tgId } = req.body;
    if (!steamId && tgId && users[tgId]) steamId = users[tgId].steamId;
    
    try {
        if (steamId) {
            const invRes = await axios.get(`https://steamcommunity.com/inventory/${steamId}/730/2?l=russian&count=75`, { 
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, 
                timeout: 5000 
            });
            if (invRes?.data?.success && invRes.data.assets?.length > 0) {
                return res.json({ success: true, items: invRes.data.assets, descriptions: invRes.data.descriptions });
            }
        }
    } catch (e) {}

    res.json({
        success: true,
        items: [
            { assetid: "demo_1", classid: "101", instanceid: "0" },
            { assetid: "demo_2", classid: "102", instanceid: "0" },
            { assetid: "demo_3", classid: "103", instanceid: "0" },
            { assetid: "demo_4", classid: "104", instanceid: "0" }
        ],
        descriptions: [
            { classid: "101", instanceid: "0", name: "AWP | Asiimov (Прямо с завода)", market_hash_name: "AWP | Asiimov (Прямо с завода)", icon_url: "-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I56KU0Zwwo4NUX4oFJZEHLbXH5ApeO4YmlhxYQknCRvCo04DEVlxkKgpot7HxfDhjxszJemkV092lnYmOhcj5Nr_Yg2ZU7PFohO_J9o-j2Vfk8hVtNjjwJ9ORfVFvY1-G_wO7x-_u1sS5uJ6ayXswuSM8pGGKYW964g/360fx360f" },
            { classid: "102", instanceid: "0", name: "AK-47 | Красная линия (После полевых)", market_hash_name: "AK-47 | Красная линия (После полевых)", icon_url: "-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I56KU0Zwwo4NUX4oFJZEHLbXH5ApeO4YmlhxYQknCRvCo04DEVlxkKgpot7HxfDhjxszJemkV092lnYmOhcj5Nr_Yg2ZU7PFohO_J9o-j2Vfk8hVtNjjwJ9ORfVFvY1-G_wO7x-_u1sS5uJ6ayXswuSM8pGGKYW964g/360fx360f" },
            { classid: "103", instanceid: "0", name: "M4A4 | Император (Немного поношенное)", market_hash_name: "M4A4 | Император (Немного поношенное)", icon_url: "-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I56KU0Zwwo4NUX4oFJZEHLbXH5ApeO4YmlhxYQknCRvCo04DEVlxkKgpot7HxfDhjxszJemkV092lnYmOhcj5Nr_Yg2ZU7PFohO_J9o-j2Vfk8hVtNjjwJ9ORfVFvY1-G_wO7x-_u1sS5uJ6ayXswuSM8pGGKYW964g/360fx360f" },
            { classid: "104", instanceid: "0", name: "Desert Eagle | Поток информации", market_hash_name: "Desert Eagle | Поток информации", icon_url: "-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I56KU0Zwwo4NUX4oFJZEHLbXH5ApeO4YmlhxYQknCRvCo04DEVlxkKgpot7HxfDhjxszJemkV092lnYmOhcj5Nr_Yg2ZU7PFohO_J9o-j2Vfk8hVtNjjwJ9ORfVFvY1-G_wO7x-_u1sS5uJ6ayXswuSM8pGGKYW964g/360fx360f" }
        ]
    });
});

app.get('/api/steam/price', async (req, res) => {
    let skinName = req.query.name;
    if (!skinName) return res.json({ success: true, price: 150 });
    if (pricesCache[skinName]) return res.json({ success: true, price: pricesCache[skinName].price });
    res.json({ success: true, price: 150 });
});

/* =========================================
   ПЛАТЕЖИ, ВЫВОДЫ И ВЕБХУК
========================================= */
app.post('/api/billing/invoice', async (req, res) => {
    const { tgId, amount, currency } = req.body;
    try {
        let rubles = currency === 'USDT' ? amount * 80 : (currency === 'Stars' ? amount * 1.5 : amount);

        if (currency === 'P2P RU' || currency === 'P2P UZ') {
            const isRu = (currency === 'P2P RU');
            const targetType = isRu ? 'RU' : 'UZ';
            const filteredCards = cards.filter(c => (c.type || 'UZ') === targetType);
            if (filteredCards.length === 0) return res.json({ success: false, error: 'Карты для приема не настроены.' });

            let activeCard = isRu ? filteredCards[cardIndexRu++ % filteredCards.length] : filteredCards[cardIndexUz++ % filteredCards.length];
            const sumText = isRu ? `${amount} ₽` : `${Math.round(amount * 175).toLocaleString()} сум (${amount} ₽)`;

            await bot.sendMessage(tgId, `💳 Реквизиты для оплаты ${currency}\nСумма: **${sumText}**\nКарта (${activeCard.holder}):\n\`${activeCard.number}\``, {
                parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '✅ Я оплатил(-а)', callback_data: `user_paid_${tgId}_${amount}` }]] }
            });

            if (ADMIN_CHAT_ID && ADMIN_CHAT_ID !== 'YOUR_ADMIN_CHAT_ID') {
                await bot.sendMessage(ADMIN_CHAT_ID, `💳 Запрос пополнения (${currency})!\n👤 ID: \`${tgId}\`\n💰 Сумма: ${amount} ₽\n🏦 Карта: \`${activeCard.number}\``, {
                    parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '✅ Подтвердить', callback_data: `p2p_confirm_pay_${tgId}_${amount}` }, { text: '❌ Отклонить', callback_data: `p2p_cancel_${tgId}_${amount}` }]] }
                });
            }
        } else if (currency === 'USDT') {
            let payUrl = 'https://t.me/CryptoBot';
            if (CRYPTO_BOT_TOKEN) {
                try {
                    const cryptoRes = await axios.post('https://pay.crypt.bot/api/createInvoice', {
                        asset: 'USDT',
                        amount: amount.toString(),
                        description: `Пополнение баланса на ${Math.round(rubles)} ₽`,
                        payload: `topup_${tgId}_${Math.round(rubles)}`
                    }, { headers: { 'Crypto-Pay-API-Token': CRYPTO_BOT_TOKEN } });
                    if (cryptoRes.data?.ok) payUrl = cryptoRes.data.result.pay_url;
                } catch (err) {}
            }
            await bot.sendMessage(tgId, `🧾 Счет на пополнение\n\nСумма: ${amount} USDT`, { reply_markup: { inline_keyboard: [[{ text: '💎 Оплатить в CryptoBot', url: payUrl }]] } });
        }
        res.json({ success: true });
    } catch (e) { res.json({ success: false, error: 'Ошибка создания счета.' }); }
});

app.post('/api/crypto/webhook', async (req, res) => {
    const update = req.body;
    if (update && (update.update_type === 'invoice_paid' || update.payload)) {
        const invoice = update.payload || update;
        const payloadStr = invoice.payload;
        if (payloadStr && payloadStr.startsWith('topup_')) {
            const parts = payloadStr.split('_');
            const tgId = parts[1];
            const rubles = parseFloat(parts[2]);
            if (tgId && !isNaN(rubles)) {
                const user = getOrCreateUser(tgId);
                user.balance += rubles;
                saveData();
                try { await bot.sendMessage(tgId, `✅ Оплата через CryptoBot прошла успешно! Баланс пополнен на ${Math.round(rubles)} ₽.`); } catch (e) {}
                if (ADMIN_CHAT_ID && ADMIN_CHAT_ID !== 'YOUR_ADMIN_CHAT_ID') {
                    try { await bot.sendMessage(ADMIN_CHAT_ID, `💎 Успешное пополнение через CryptoBot!\n👤 ID: \`${tgId}\`\n💰 Сумма: ${Math.round(rubles)} ₽`, { parse_mode: 'Markdown' }); } catch (e) {}
                }
            }
        }
    }
    res.status(200).send('OK');
});

app.post('/api/billing/withdraw', async (req, res) => {
    const { tgId, amount, recipientAccount, username, method } = req.body;
    const user = getOrCreateUser(tgId, username);
    if (user.balance < amount) return res.json({ success: false, error: 'Недостаточно средств' });

    user.balance -= amount;
    saveData();
    try {
        if (ADMIN_CHAT_ID && ADMIN_CHAT_ID !== 'YOUR_ADMIN_CHAT_ID') {
            await bot.sendMessage(ADMIN_CHAT_ID, `💸 Заявка на вывод (${method})!\n👤 @${username || tgId} (ID: \`${tgId}\`)\n💰 Сумма: ${amount} ₽\n💳 Реквизиты: \`${recipientAccount}\``, {
                parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '✅ Подтвердить вывод', callback_data: `p2p_withdraw_done_${tgId}_${amount}` }, { text: '❌ Отменить', callback_data: `p2p_cancel_${tgId}_${amount}` }]] }
            });
        }
        res.json({ success: true, newBalance: user.balance });
    } catch (e) {
        user.balance += amount;
        saveData();
        res.json({ success: false, error: 'Ошибка отправки заявки.' });
    }
});

/* =========================================
   ТЕЛЕГРАМ СОБЫТИЯ И КОМАНДЫ
========================================= */
bot.on('pre_checkout_query', async (query) => {
    try { await bot.answerPreCheckoutQuery(query.id, true); } catch (e) {}
});

bot.on('message', async (msg) => {
    // Сохраняем чаты и группы, где бот активен, для автоматических рассылок
    if (msg.chat && msg.chat.type !== 'private') {
        if (!chats.includes(msg.chat.id)) {
            chats.push(msg.chat.id);
            saveData();
        }
    }

    if (msg.successful_payment) {
        const payload = msg.successful_payment.invoice_payload;
        if (payload && payload.startsWith('topup_')) {
            const parts = payload.split('_');
            const tgId = parts[1], rubles = parseFloat(parts[3]);
            const user = getOrCreateUser(tgId);
            user.balance += rubles;
            saveData();
            await bot.sendMessage(tgId, `✅ Оплата через Telegram Stars прошла успешно! Баланс пополнен на ${Math.round(rubles)} ₽.`);
            
            if (ADMIN_CHAT_ID && ADMIN_CHAT_ID !== 'YOUR_ADMIN_CHAT_ID') {
                await bot.sendMessage(ADMIN_CHAT_ID, `⭐ Успешное пополнение Stars!\n👤 ID: \`${tgId}\`\n💰 Сумма: ${Math.round(rubles)} ₽`, { parse_mode: 'Markdown' });
            }
        }
        return;
    }

    const text = msg.text || msg.caption;
    if (!text) return;

    if (text.startsWith('/start')) {
        await bot.sendMessage(msg.chat.id, '🎮 Добро пожаловать в **P2P Skin Sales**!\n\nТоргуйте скинами, участвуйте в битвах и розыгрышах прямо в Telegram.', {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[{ text: '🚀 Открыть Маркетплейс', web_app: { url: WEBAPP_URL } }]]
            }
        });
        return;
    }

    // Команда удаления розыгрышей /delgiveaway
    if (text.startsWith('/delgiveaway')) {
        const activeGiveaways = giveaways.filter(g => !g.ended);
        if (activeGiveaways.length === 0) {
            return await bot.sendMessage(msg.chat.id, '❌ Нет активных розыгрышей для удаления.');
        }
        const buttons = activeGiveaways.map(g => [{ text: `🗑 Удалить: ${g.title}`, callback_data: `del_gw_${g._id}` }]);
        return await bot.sendMessage(msg.chat.id, '📋 Выберите розыгрыш для удаления:', {
            reply_markup: { inline_keyboard: buttons }
        });
    }

    if (text.startsWith('/newgiveaway')) {
        const lines = text.split('\n');
        let title = '', sponsor = '', timerLine = '';
        lines.forEach(l => {
            if (l.toLowerCase().startsWith('prize:')) title = l.replace(/^prize:/i, '').trim();
            if (l.toLowerCase().startsWith('sponsor:')) sponsor = l.replace(/^sponsor:/i, '').trim();
            if (l.toLowerCase().startsWith('timer:') || l.toLowerCase().startsWith('date:')) timerLine = l.replace(/^(timer|date):/i, '').trim();
        });
        
        if (!title || !sponsor) {
            return await bot.sendMessage(msg.chat.id, '❌ Неверный формат!\nПример:\n`/newgiveaway\nPrize: AWP | Asiimov\nSponsor: @channel\nTimer: 30.08.2026 18:00`', { parse_mode: 'Markdown' });
        }

        let endTime = Date.now() + 24 * 60 * 60 * 1000;
        let timerText = timerLine || '24 часа';

        if (timerLine) {
            const ruFormat = timerLine.match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})$/);
            if (ruFormat) {
                const [, d, m, y, h, min] = ruFormat;
                const customDate = new Date(`${y}-${m}-${d}T${h}:${min}:00`);
                if (!isNaN(customDate.getTime())) endTime = customDate.getTime();
            } else {
                let parsed = Date.parse(timerLine);
                if (!isNaN(parsed)) endTime = parsed;
                else if (timerLine.toLowerCase().includes('час')) {
                    const hMatch = timerLine.match(/(\d+)/);
                    if (hMatch) endTime = Date.now() + parseInt(hMatch[1]) * 60 * 60 * 1000;
                }
            }
        }

        let sponsorUsername = sponsor.startsWith('@') ? sponsor : '@' + sponsor;
        giveaways.push({
            _id: Date.now().toString(),
            title,
            sponsor,
            sponsorUsername,
            timerText,
            endTime,
            ended: false,
            winnerTgId: null,
            winnerUsername: null,
            winnerTradeUrl: null,
            image: 'https://community.cloudflare.steamstatic.com/economy/image/-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I56KU0Zwwo4NUX4oFJZEHLbXH5ApeO4YmlhxYQknCRvCo04DEVlxkKgpot7HxfDhjxszJemkV092lnYmOhcj5Nr_Yg2ZU7PFohO_J9o-j2Vfk8hVtNjjwJ9ORfVFvY1-G_wO7x-_u1sS5uJ6ayXswuSM8pGGKYW964g/360fx360f',
            participantsCount: 0,
            participants: []
        });
        saveData();
        
        const dateStr = new Date(endTime).toLocaleString('ru-RU');
        
        // Отправка подтверждения создателю
        await bot.sendMessage(msg.chat.id, `✅ Розыгрыш "${title}" запущен!\n⏰ Окончание: *${dateStr}*`, { parse_mode: 'Markdown' });

        // Рассылка уведомления во все чаты/группы, где бот добавлен
        const broadcastText = `🎁 **НОВЫЙ РОЗЫГРЫШ!**\n\n🏆 Приз: *${title}*\n📢 Спонсор: ${sponsor}\n⏰ Итоги: *${dateStr}*\n\nПереходите в приложение, чтобы принять участие!`;
        const broadcastKeyboard = {
            inline_keyboard: [
                [{ text: '🚀 Участвовать в розыгрыше', web_app: { url: WEBAPP_URL } }]
            ]
        };

        for (const chatId of chats) {
            try {
                await bot.sendMessage(chatId, broadcastText, { parse_mode: 'Markdown', reply_markup: broadcastKeyboard });
            } catch (err) {}
        }
    }
});

bot.on('callback_query', async (query) => {
    const data = query.data, parts = data.split('_');

    // Обработка удаления розыгрыша по кнопке
    if (data.startsWith('del_gw_')) {
        const gwId = data.replace('del_gw_', '');
        const index = giveaways.findIndex(g => g._id === gwId);
        if (index !== -1) {
            const removedTitle = giveaways[index].title;
            giveaways.splice(index, 1);
            saveData();
            await bot.editMessageText(`✅ Розыгрыш "${removedTitle}" успешно удален.`, { chat_id: query.message.chat.id, message_id: query.message.message_id });
        } else {
            await bot.answerCallbackQuery(query.id, { text: 'Розыгрыш уже удален или не найден', show_alert: true });
        }
        return;
    }

    if (data.startsWith('p2p_confirm_pay_')) {
        const tgId = parts[3], amount = parseFloat(parts[4]);
        getOrCreateUser(tgId).balance += amount; saveData();
        await bot.sendMessage(tgId, `✅ Ваша оплата на сумму ${amount} ₽ подтверждена! Баланс пополнен.`);
        await bot.editMessageText(`✅ Пополнение на ${amount} ₽ для игрока ${tgId} подтверждено.`, { chat_id: query.message.chat.id, message_id: query.message.message_id });
    } else if (data.startsWith('p2p_withdraw_done_')) {
        const tgId = parts[3], amount = parts[4];
        await bot.sendMessage(tgId, `✅ Ваша заявка на вывод ${amount} ₽ успешно обработана администратором!`);
        await bot.editMessageText(`✅ Вывод ${amount} ₽ для ${tgId} выполнен.`, { chat_id: query.message.chat.id, message_id: query.message.message_id });
    } else if (data.startsWith('p2p_cancel_')) {
        const tgId = parts[2], amount = parts[3];
        await bot.sendMessage(tgId, `❌ Ваша операция на сумму ${amount} ₽ отклонена/отменена администратором.`);
        await bot.editMessageText(`❌ Заявка/платеж отменены.`, { chat_id: query.message.chat.id, message_id: query.message.message_id });
    } else if (data.startsWith('user_paid_')) {
        const tgId = parts[2], amount = parts[3];
        if (ADMIN_CHAT_ID && ADMIN_CHAT_ID !== 'YOUR_ADMIN_CHAT_ID') {
            await bot.sendMessage(ADMIN_CHAT_ID, `🔔 Пользователь \`${tgId}\` нажал кнопку "Я оплатил" на сумму **${amount} ₽**!`, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '✅ Подтвердить', callback_data: `p2p_confirm_pay_${tgId}_${amount}` }, { text: '❌ Отклонить', callback_data: `p2p_cancel_${tgId}_${amount}` }]] }
            });
        }
        await bot.editMessageText(`✅ Вы сообщили об оплате. Ожидайте проверки администратором.`, { chat_id: query.message.chat.id, message_id: query.message.message_id });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
