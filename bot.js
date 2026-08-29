const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

// Защита от падений сервера (предотвращение 502 ошибок)
process.on('uncaughtException', (err) => console.error('⚠️ [CRITICAL] Uncaught Exception:', err.message));
process.on('unhandledRejection', (reason) => console.error('⚠️ [CRITICAL] Unhandled Rejection:', reason));

const TOKEN = process.env.BOT_TOKEN || 'YOUR_TELEGRAM_BOT_TOKEN';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || 'YOUR_ADMIN_CHAT_ID';
const CRYPTO_BOT_TOKEN = process.env.CRYPTO_BOT_TOKEN || '';
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://your-app.onrender.com';
const PROXY_URL = process.env.PROXY_URL || '';

const USD_TO_RUB = 95; // Курс конвертации долларов в рубли

const bot = new TelegramBot(TOKEN, { polling: true });
const app = express();

let botUserId = null;
bot.getMe().then(me => { botUserId = me.id; }).catch(e => {});

bot.on('polling_error', (error) => console.error('⚠️ Ошибка Telegram:', error.code, error.message));
bot.on('error', (error) => console.error('⚠️ Общая ошибка бота:', error.message));

app.use(express.json());
app.use(express.static(__dirname));

app.get('/', (req, res) => {
    const indexPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(indexPath)) res.sendFile(indexPath);
    else res.status(404).send('Файл index.html не найден в корне проекта!');
});

const dataDir = '/data';
if (!fs.existsSync(dataDir)) {
    try { fs.mkdirSync(dataDir, { recursive: true }); } catch (e) {}
}

const dbFile = fs.existsSync(dataDir) ? path.join(dataDir, 'database.json') : path.join(__dirname, 'database.json');
const cardsFile = fs.existsSync(dataDir) ? path.join(dataDir, 'cards.json') : path.join(__dirname, 'cards.json');
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    try { fs.mkdirSync(uploadsDir, { recursive: true }); } catch (e) {}
}

let users = {};
let marketItems = [];
let giveaways = [];
let chats = [];
let shopCatalog = []; 
let cards = [];

if (fs.existsSync(dbFile)) { 
    try { 
        const db = JSON.parse(fs.readFileSync(dbFile, 'utf8')); 
        if (db.users) users = db.users;
        if (Array.isArray(db.marketItems)) marketItems = db.marketItems;
        if (db.giveaways) giveaways = db.giveaways;
        if (db.chats) chats = db.chats;
        if (db.shopCatalog) shopCatalog = db.shopCatalog;
    } catch (e) {} 
}

if (fs.existsSync(cardsFile)) { 
    try { cards = JSON.parse(fs.readFileSync(cardsFile, 'utf8')).map(c => ({ ...c, type: c.type || 'UZ' })); } catch (e) {} 
}

function saveData() { 
    try { 
        fs.writeFileSync(dbFile, JSON.stringify({ users, marketItems, giveaways, chats, shopCatalog }, null, 2)); 
        fs.writeFileSync(cardsFile, JSON.stringify(cards, null, 2));
    } catch (e) {} 
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

function isAdmin(msg) {
    const userId = String(msg.from ? msg.from.id : '');
    const chatId = String(msg.chat.id);
    const adminId = String(ADMIN_CHAT_ID);
    return userId === adminId || chatId === adminId;
}

const BATTLE_COLORS = ['#FF9900', '#ffffff', '#ffaa33', '#cc7a00', '#ffc266', '#e68a00'];
let battleState = { id: Date.now().toString(), status: 'waiting', participants: [], bank: 0, startTime: null, rollEndTime: null, winnerTgId: null, winnerPrize: 0 };

let pendingAddItems = {};

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
                try { await bot.sendMessage(battleState.winnerTgId, `🏆 Поздравляем! Вы выиграли Королевскую битву: ${battleState.winnerPrize} ₽`); } catch (e) {}
            }
        }
        setTimeout(() => { battleState = { id: Date.now().toString(), status: 'waiting', participants: [], bank: 0, startTime: null, rollEndTime: null, winnerTgId: null, winnerPrize: 0 }; }, 7000);
    }

    let giveawaysUpdated = false;
    giveaways.forEach(g => {
        if (!g.ended && g.endTime && now >= g.endTime) {
            g.ended = true; g.endedAt = now; giveawaysUpdated = true;
            if (g.participants && g.participants.length > 0) {
                const winnerId = g.participants[Math.floor(Math.random() * g.participants.length)];
                g.winnerTgId = winnerId;
                const winnerUser = users[winnerId];
                g.winnerUsername = winnerUser ? winnerUser.username : String(winnerId);
                g.winnerTradeUrl = winnerUser ? (winnerUser.tradeUrl || 'Не указан') : 'Не указан';
                try { bot.sendMessage(winnerId, `🎉 Вы выиграли в розыгрыше: *${g.title}*!`, { parse_mode: 'Markdown' }); } catch (e) {}
                if (ADMIN_CHAT_ID !== 'YOUR_ADMIN_CHAT_ID') {
                    try { bot.sendMessage(ADMIN_CHAT_ID, `🎁 Розыгрыш завершен!\n🏆 Приз: *${g.title}*\n👤 Победитель: @${g.winnerUsername}`, { parse_mode: 'Markdown' }); } catch (e) {}
                }
            }
        }
    });
    if (giveawaysUpdated) saveData();
}, 15000);

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

app.get('/api/giveaways/list', (req, res) => res.json({ success: true, giveaways }));

app.post('/api/giveaways/join', async (req, res) => {
    const { tgId, giveawayId } = req.body;
    const giveaway = giveaways.find(g => g._id === giveawayId);
    if (!giveaway) return res.json({ success: false, error: 'Розыгрыш не найден' });
    if (giveaway.ended) return res.json({ success: false, error: 'Розыгрыш уже завершен' });
    if (giveaway.participants.includes(String(tgId))) return res.json({ success: false, error: 'Вы уже участвуете!' });

    giveaway.participants.push(String(tgId));
    giveaway.participantsCount = giveaway.participants.length;
    saveData();
    res.json({ success: true });
});

app.post('/api/steam/inventory', async (req, res) => {
    let { steamId, tgId } = req.body;
    if (!steamId && tgId && users[tgId]) steamId = users[tgId].steamId;
    if (!steamId) return res.json({ success: false, error: 'Не указан SteamID или Trade URL' });

    try {
        let axiosConfig = {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept-Language': 'ru-RU,ru;q=0.9' },
            timeout: 10000
        };
        if (PROXY_URL) axiosConfig.httpsAgent = new HttpsProxyAgent(PROXY_URL);

        const invRes = await axios.get(`https://steamcommunity.com/inventory/${steamId}/730/2?l=russian&count=75`, axiosConfig);
        if (invRes?.data?.success && invRes.data.assets?.length > 0) {
            return res.json({ success: true, items: invRes.data.assets, descriptions: invRes.data.descriptions });
        }
    } catch (e) {}
    res.json({ success: false, error: 'Не удалось загрузить инвентарь.' });
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

    try { await bot.sendMessage(item.tgId, `🎉 Ваш лот P2P "${item.name}" куплен!`); } catch (e) {}
    res.json({ success: true, newBalance: buyer.balance });
});

app.get('/api/shop/items', (req, res) => res.json({ success: true, items: shopCatalog }));

// Покупка в магазине (время работы теперь 24/7, проверка по времени удалена)
app.post('/api/shop/buy', async (req, res) => {
    const { tgId, itemId, itemName, itemPrice } = req.body;
    const user = getOrCreateUser(tgId);
    const finalPrice = parseFloat(itemPrice);

    if (isNaN(finalPrice) || user.balance < finalPrice) {
        return res.json({ success: false, error: 'Недостаточно средств' });
    }
    
    // Проверка на наличие tradeUrl (если нужно, можно смягчить, но лучше оставить для отправки трейда)
    if (!user.tradeUrl) {
        return res.json({ success: false, error: 'Укажите Trade URL в профиле!' });
    }

    user.balance -= finalPrice;
    saveData();

    try {
        await bot.sendMessage(tgId, `🛍 **Заказ оформлен!** Скин *${itemName || 'Предмет'}* успешно куплен за ${finalPrice} ₽.`);
        if (ADMIN_CHAT_ID !== 'YOUR_ADMIN_CHAT_ID') {
            await bot.sendMessage(ADMIN_CHAT_ID, `🔥 **Покупка в Магазине!**\n👤 ID: \`${user.tgId}\`\n🏷 Товар: *${itemName}*\n💰 Сумма: ${finalPrice} ₽\n🔗 Трейд:\n\`${user.tradeUrl}\``, { parse_mode: 'Markdown' });
        }
        res.json({ success: true, newBalance: user.balance });
    } catch (error) {
        user.balance += finalPrice;
        saveData();
        res.json({ success: false, error: 'Ошибка оформления заказа.' });
    }
});

app.post('/api/billing/invoice', async (req, res) => {
    const { tgId, amount, currency } = req.body;
    try {
        let rubles = currency === 'USDT' ? amount * 80 : (currency === 'Stars' ? amount * 1.5 : amount);

        if (currency === 'P2P RU' || currency === 'P2P UZ') {
            const isRu = (currency === 'P2P RU');
            const targetType = isRu ? 'RU' : 'UZ';
            const filteredCards = cards.filter(c => (c.type || 'UZ') === targetType);
            if (filteredCards.length === 0) return res.json({ success: false, error: 'Карты для приема не настроены.' });

            let activeCard = filteredCards[0];
            const sumText = isRu ? `${amount} ₽` : `${Math.round(amount * 175).toLocaleString()} сум (${amount} ₽)`;

            await bot.sendMessage(tgId, `💳 Реквизиты для оплаты ${currency}\nСумма: **${sumText}**\nКарта (${activeCard.holder}):\n\`${activeCard.number}\``, {
                parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '✅ Я оплатил(-а)', callback_data: `user_paid_${tgId}_${amount}` }]] }
            });

            if (ADMIN_CHAT_ID !== 'YOUR_ADMIN_CHAT_ID') {
                await bot.sendMessage(ADMIN_CHAT_ID, `💳 Запрос пополнения (${currency})!\n👤 ID: \`${tgId}\`\n💰 Сумма: ${amount} ₽`, { parse_mode: 'Markdown' });
            }
        } else if (currency === 'USDT') {
            let payUrl = 'https://t.me/CryptoBot';
            if (CRYPTO_BOT_TOKEN) {
                try {
                    const cryptoRes = await axios.post('https://pay.crypt.bot/api/createInvoice', {
                        asset: 'USDT', amount: amount.toString(),
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

app.post('/api/billing/withdraw', async (req, res) => {
    const { tgId, amount, recipientAccount, username, method } = req.body;
    const user = getOrCreateUser(tgId, username);
    if (user.balance < amount) return res.json({ success: false, error: 'Недостаточно средств' });

    user.balance -= amount;
    saveData();
    try {
        if (ADMIN_CHAT_ID !== 'YOUR_ADMIN_CHAT_ID') {
            await bot.sendMessage(ADMIN_CHAT_ID, `💸 Заявка на вывод (${method})!\n👤 @${username || tgId}\n💰 Сумма: ${amount} ₽\n💳 Реф: \`${recipientAccount}\``, {
                parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '✅ Подтвердить', callback_data: `p2p_withdraw_done_${tgId}_${amount}` }, { text: '❌ Отменить', callback_data: `p2p_cancel_${tgId}_${amount}` }]] }
            });
        }
        res.json({ success: true, newBalance: user.balance });
    } catch (e) {
        user.balance += amount;
        saveData();
        res.json({ success: false, error: 'Ошибка отправки заявки.' });
    }
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from ? String(msg.from.id) : '';
    const text = msg.text || msg.caption || '';

    if (!isAdmin(msg)) return;

    if (msg.photo && msg.photo.length > 0) {
        const photo = msg.photo[msg.photo.length - 1];
        const fileId = photo.file_id;

        try {
            const file = await bot.getFile(fileId);
            const filePath = file.file_path;
            const fileUrl = `https://api.telegram.org/file/bot${TOKEN}/${filePath}`;
            const fileName = `item_${Date.now()}${path.extname(filePath) || '.jpg'}`;
            const localPath = path.join(uploadsDir, fileName);

            const writer = fs.createWriteStream(localPath);
            const response = await axios({
                url: fileUrl,
                method: 'GET',
                responseType: 'stream'
            });
            response.data.pipe(writer);

            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });

            const permanentImageUrl = `${WEBAPP_URL}/uploads/${fileName}`;

            if (text.startsWith('/add')) {
                const args = text.replace('/add', '').trim();
                const parts = args.split('|').map(p => p.trim());

                if (parts.length < 2) {
                    return await bot.sendMessage(chatId, '❌ Неверный формат в описании!\nИспользуйте: `/add Название скина | Цена в $`', { parse_mode: 'Markdown' });
                }

                const priceUsdStr = parts[parts.length - 1].replace('$', '').trim();
                const priceUsd = parseFloat(priceUsdStr);
                const name = parts.slice(0, parts.length - 1).join(' | ');

                if (isNaN(priceUsd)) return await bot.sendMessage(chatId, '❌ Ошибка: цена в долларах должна быть числом.', { parse_mode: 'Markdown' });

                const priceRub = Math.round(priceUsd * USD_TO_RUB);

                const newItem = {
                    id: 'item_' + Date.now(),
                    name: name,
                    image: permanentImageUrl,
                    price: priceRub,
                    discount: null
                };

                shopCatalog.unshift(newItem);
                saveData();

                await bot.sendMessage(chatId, `✅ **Товар успешно добавлен!**\n\n🆔 ID: \`${newItem.id}\`\n🏷 Название: *${name}*\n💵 Цена: $${priceUsd} ➔ 💰 **${priceRub} ₽**`, { parse_mode: 'Markdown' });
                return;
            } else {
                pendingAddItems[userId] = { imageUrl: permanentImageUrl };
                return await bot.sendMessage(chatId, '📸 Картинка сохранена!\nТеперь отправьте сообщение в формате:\n`/add Название скина | Цена в $`', { parse_mode: 'Markdown' });
            }
        } catch (e) {
            return await bot.sendMessage(chatId, `❌ Ошибка обработки фото: ${e.message}`);
        }
    }

    if (!text) return;

    if (text.startsWith('/start')) {
        getOrCreateUser(userId, msg.from?.username, msg.from?.photo_url);
        await bot.sendMessage(chatId, '🟧⬛️ Добро пожаловать в **Skin Hub**!', {
            parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🚀 Открыть Skin Hub', web_app: { url: WEBAPP_URL } }]] }
        });
        return;
    }

    if (text.startsWith('/add')) {
        const args = text.replace('/add', '').trim();
        const parts = args.split('|').map(p => p.trim());

        if (parts.length < 2) {
            return await bot.sendMessage(chatId, '❌ Неверный формат!\nИспользуйте: `/add Название скина | Цена в $`', { parse_mode: 'Markdown' });
        }

        const priceUsdStr = parts[parts.length - 1].replace('$', '').trim();
        const priceUsd = parseFloat(priceUsdStr);
        const name = parts.slice(0, parts.length - 1).join(' | ');

        if (isNaN(priceUsd)) return await bot.sendMessage(chatId, '❌ Ошибка: цена в долларах должна быть числом.', { parse_mode: 'Markdown' });

        let imageUrl = 'https://community.cloudflare.steamstatic.com/economy/image/-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I56KU0Zwwo4NUX4oFJZEHLbXH5ApeO4YmlhxYQknCRvCo04DEVlxkKgpovbSsLQJf2-r3ZzRSyN2xlZaYwLz0Orjcx2gGssEh0uw_j9r38Vfj-xU5Yjj3d4STJFA7aQ3RqVa4kLvpjMe7u5TJynIwuCcrsCvZlgv3308xN85S9A/360fx360f';
        if (pendingAddItems[userId] && pendingAddItems[userId].imageUrl) {
            imageUrl = pendingAddItems[userId].imageUrl;
            delete pendingAddItems[userId];
        }

        const priceRub = Math.round(priceUsd * USD_TO_RUB);

        const newItem = {
            id: 'item_' + Date.now(),
            name: name,
            image: imageUrl,
            price: priceRub,
            discount: null
        };

        shopCatalog.unshift(newItem);
        saveData();

        await bot.sendMessage(chatId, `✅ **Товар успешно добавлен!**\n\n🆔 ID: \`${newItem.id}\`\n🏷 Название: *${name}*\n💵 Цена: $${priceUsd} ➔ 💰 **${priceRub} ₽**`, { parse_mode: 'Markdown' });
        return;
    }

    if (text.startsWith('/catalog')) {
        if (shopCatalog.length === 0) return await bot.sendMessage(chatId, '🛍 Каталог пуст.');

        let responseText = '🛍 **Управление каталогом**\nКоманды:\n• `/setprice ID Рубли`\n• `/delitem ID`\n\n';
        shopCatalog.slice(0, 30).forEach(item => {
            responseText += `🆔 \`${item.id}\` | 🏷 ${item.name} | 💰 ${item.price} ₽\n`;
        });
        await bot.sendMessage(chatId, responseText, { parse_mode: 'Markdown' });
        return;
    }

    if (text.startsWith('/delitem')) {
        const parts = text.split(' ');
        if (parts.length < 2) return await bot.sendMessage(chatId, '❌ Укажите ID товара: `/delitem <ID>`', { parse_mode: 'Markdown' });

        const targetId = parts[1];
        const initialLen = shopCatalog.length;
        shopCatalog = shopCatalog.filter(i => i.id !== targetId);

        if (shopCatalog.length === initialLen) {
            return await bot.sendMessage(chatId, `❌ Товар с ID \`${targetId}\` не найден.`);
        }

        saveData();
        await bot.sendMessage(chatId, `✅ Товар с ID \`${targetId}\` успешно удален!`, { parse_mode: 'Markdown' });
        return;
    }

    if (text.startsWith('/setprice')) {
        const parts = text.split(' ');
        if (parts.length < 3) return await bot.sendMessage(chatId, '❌ Формат: `/setprice <ID> <Цена в ₽>`', { parse_mode: 'Markdown' });
        
        const targetId = parts[1];
        const newPrice = parseFloat(parts[2]);
        if (isNaN(newPrice)) return await bot.sendMessage(chatId, '❌ Цена должна быть числом.');
        
        const itemIndex = shopCatalog.findIndex(i => i.id === targetId);
        if (itemIndex === -1) return await bot.sendMessage(chatId, `❌ Товар с ID ${targetId} не найден.`);

        shopCatalog[itemIndex].price = newPrice;
        saveData();
        await bot.sendMessage(chatId, `✅ Цена для **${shopCatalog[itemIndex].name}** обновлена на **${newPrice} ₽**!`, { parse_mode: 'Markdown' });
        return;
    }

    if (text.startsWith('/newgiveaway')) {
        const lines = text.split('\n');
        let title = '', sponsor = '', timerLine = '';
        lines.forEach(l => {
            if (l.toLowerCase().startsWith('prize:')) title = l.replace(/^prize:/i, '').trim();
            if (l.toLowerCase().startsWith('sponsor:')) sponsor = l.replace(/^sponsor:/i, '').trim();
            if (l.toLowerCase().startsWith('timer:') || l.toLowerCase().startsWith('date:')) timerLine = l.replace(/^(timer|date):/i, '').trim();
        });
        
        if (!title || !sponsor) return await bot.sendMessage(chatId, '❌ Неверный формат!\nПример:\n`/newgiveaway\nPrize: AWP | Asiimov\nSponsor: @channel\nTimer: 30.08.2026 18:00`', { parse_mode: 'Markdown' });

        let endTime = Date.now() + 24 * 60 * 60 * 1000;
        giveaways.push({
            _id: Date.now().toString(), title, sponsor, sponsorUsername: sponsor.startsWith('@') ? sponsor : '@' + sponsor,
            timerText: timerLine || '24 часа', endTime, ended: false, winnerTgId: null, winnerUsername: null, winnerTradeUrl: null,
            image: '',
            participantsCount: 0, participants: []
        });
        saveData();
        await bot.sendMessage(chatId, `✅ Розыгрыш "${title}" запущен!`);
        return;
    }

    if (text.startsWith('/broadcast')) {
        const broadcastText = text.replace('/broadcast', '').trim();
        let successCount = 0;
        for (const chatId of chats) {
            try { await bot.sendMessage(chatId, broadcastText, { parse_mode: 'Markdown' }); successCount++; } catch (err) {}
        }
        await bot.sendMessage(chatId, `📢 Рассылка завершена! Доставлено: ${successCount}`);
    }
});

bot.on('callback_query', async (query) => {
    const data = query.data, parts = data.split('_');
    if (data.startsWith('p2p_confirm_pay_')) {
        const tgId = parts[3], amount = parseFloat(parts[4]);
        getOrCreateUser(tgId).balance += amount; saveData();
        await bot.sendMessage(tgId, `✅ Ваша оплата на сумму ${amount} ₽ подтверждена! Баланс пополнен.`);
        await bot.editMessageText(`✅ Пополнение подтверждено.`, { chat_id: query.message.chat.id, message_id: query.message.message_id });
    } else if (data.startsWith('p2p_withdraw_done_')) {
        const tgId = parts[3], amount = parts[4];
        await bot.sendMessage(tgId, `✅ Вывод ${amount} ₽ успешно обработан!`);
        await bot.editMessageText(`✅ Вывод выполнен.`, { chat_id: query.message.chat.id, message_id: query.message.message_id });
    } else if (data.startsWith('p2p_cancel_')) {
        const tgId = parts[2], amount = parts[3];
        await bot.sendMessage(tgId, `❌ Операция на сумму ${amount} ₽ отклонена.`);
        await bot.editMessageText(`❌ Отменено.`, { chat_id: query.message.chat.id, message_id: query.message.message_id });
    } else if (data.startsWith('user_paid_')) {
        const tgId = parts[2], amount = parts[3];
        if (ADMIN_CHAT_ID !== 'YOUR_ADMIN_CHAT_ID') {
            await bot.sendMessage(ADMIN_CHAT_ID, `🔔 Пользователь \`${tgId}\` сообщил об оплате **${amount} ₽**!`, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '✅ Подтвердить', callback_data: `p2p_confirm_pay_${tgId}_${amount}` }, { text: '❌ Отклонить', callback_data: `p2p_cancel_${tgId}_${amount}` }]] }
            });
        }
        await bot.editMessageText(`✅ Вы сообщили об оплате. Ожидайте проверки.`, { chat_id: query.message.chat.id, message_id: query.message.message_id });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
