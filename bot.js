const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const axios = require('axios');

const TOKEN = process.env.BOT_TOKEN || 'YOUR_TELEGRAM_BOT_TOKEN';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || 'YOUR_ADMIN_CHAT_ID';

const bot = new TelegramBot(TOKEN, { polling: true });
const app = express();

app.use(express.json());
app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

let users = {};
let marketItems = [];
let giveaways = [];

// Безопасное получение или создание пользователя
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
    }
    return users[tgId];
}

// Функция для извлечения и конвертации SteamID64 из Trade URL
function extractSteamIdFromTradeUrl(url) {
    if (!url) return null;
    const profileMatch = url.match(/\/profiles\/(\d{17})/);
    if (profileMatch && profileMatch[1]) {
        return profileMatch[1];
    }
    const partnerMatch = url.match(/partner=(\d+)/);
    if (partnerMatch && partnerMatch[1]) {
        const partnerId = partnerMatch[1];
        try {
            const steamId64 = (BigInt(partnerId) + 76561197960265728n).toString();
            return steamId64;
        } catch (e) {
            return null;
        }
    }
    return null;
}

// Парсинг никнейма и аватара из публичного профиля Steam (XML)
async function getSteamProfileInfo(steamId) {
    try {
        const res = await axios.get(`https://steamcommunity.com/profiles/${steamId}/?xml=1`, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 5000
        });
        const xml = res.data;
        const nameMatch = xml.match(/<steamID><!\[CDATA\[(.*?)\]\]><\/steamID>/) || xml.match(/<steamID>(.*?)<\/steamID>/);
        const avatarMatch = xml.match(/<avatarMedium><!\[CDATA\[(.*?)\]\]><\/avatarMedium>/) || xml.match(/<avatarMedium>(.*?)<\/avatarMedium>/);
        
        return {
            steamName: nameMatch ? nameMatch[1] : null,
            avatarUrl: avatarMatch ? avatarMatch[1] : null
        };
    } catch (e) {
        return { steamName: null, avatarUrl: null };
    }
}

app.get('/api/user/profile', (req, res) => {
    const { tgId, tgUser } = req.query;
    if (!tgId) return res.json({ success: false, error: 'No tgId provided' });
    
    const user = getOrCreateUser(tgId, tgUser);
    if (tgUser && user.username === 'Игрок') {
        user.username = tgUser;
    }
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

    res.json({ success: true, steamId: user.steamId });
});

app.get('/api/market/items', (req, res) => {
    res.json({ success: true, items: marketItems });
});

app.post('/api/market/add', (req, res) => {
    const item = req.body;
    item._id = Date.now().toString();
    marketItems.push(item);
    res.json({ success: true });
});

app.post('/api/market/cancel', (req, res) => {
    const { itemId, tgId } = req.body;
    marketItems = marketItems.filter(i => !(i._id === itemId && String(i.tgId) === String(tgId)));
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
    res.json({ success: true });
});

// Запрос инвентаря Steam + подгрузка аватара и никнейма
app.post('/api/steam/inventory', async (req, res) => {
    let { steamId, tgId } = req.body;
    
    if (!steamId && tgId && users[tgId]) {
        steamId = users[tgId].steamId;
    }

    if (!steamId) {
        return res.json({ success: false, items: [], descriptions: [] });
    }

    try {
        const [invRes, profileInfo] = await Promise.all([
            axios.get(`https://steamcommunity.com/inventory/${steamId}/730/2?l=russian&count=75`, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'application/json, text/javascript, */*; q=0.01',
                    'Accept-Language': 'ru-RU,ru;q=0.9',
                    'Referer': `https://steamcommunity.com/profiles/${steamId}/inventory/`
                },
                timeout: 10000
            }).catch(() => ({ data: null })),
            getSteamProfileInfo(steamId)
        ]);

        const invData = invRes?.data;
        if (invData && invData.success) {
            res.json({
                success: true,
                items: invData.assets || [],
                descriptions: invData.descriptions || [],
                steamName: profileInfo.steamName,
                avatarUrl: profileInfo.avatarUrl
            });
        } else {
            res.json({ 
                success: false, 
                items: [], 
                descriptions: [], 
                steamName: profileInfo.steamName, 
                avatarUrl: profileInfo.avatarUrl 
            });
        }
    } catch (e) {
        console.error("Steam API Error:", e.message);
        res.json({ success: false, items: [], descriptions: [] });
    }
});

// Получение реальной цены скина со Steam Community Market (в рублях)
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

// Пополнение баланса
app.post('/api/billing/invoice', async (req, res) => {
    const { tgId, amount, currency } = req.body;
    let rubles = currency === 'USDT' ? amount * 80 : amount * 1.5;

    try {
        await bot.sendMessage(tgId, `🧾 **Счет на пополнение баланса**\n\nСумма: ${amount} ${currency}\nК зачислению: ${Math.round(rubles)} ₽\n\nПожалуйста, завершите оплату через @CryptoBot или Telegram Stars.`);
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, error: 'Не удалось отправить счет. Напишите боту /start в личные сообщения.' });
    }
});

// Вывод средств (с защитой от списания при ошибке отправки)
app.post('/api/billing/withdraw', async (req, res) => {
    const { tgId, amount, recipientAccount, username } = req.body;
    const user = getOrCreateUser(tgId, username);
    
    if (user.balance < amount) {
        return res.json({ success: false, error: 'Недостаточно средств на балансе' });
    }

    user.balance -= amount;

    try {
        if (ADMIN_CHAT_ID && ADMIN_CHAT_ID !== 'YOUR_ADMIN_CHAT_ID') {
            await bot.sendMessage(ADMIN_CHAT_ID, `💸 **Новая заявка на вывод средств!**\n\n👤 Игрок: @${username || user.username || tgId}\n🆔 ID: \`${tgId}\`\n💰 Сумма: ${amount} ₽\n💎 Кошелек: \`${recipientAccount}\``, { parse_mode: 'Markdown' });
        }
        res.json({ success: true, newBalance: user.balance });
    } catch (e) {
        user.balance += amount; // Возвращаем баланс в случае ошибки сети/телеграма
        res.json({ success: false, error: 'Ошибка отправки чека администраторам' });
    }
});

app.post('/api/inventory/instant-sell', (req, res) => {
    const { tgId, payout } = req.body;
    const user = getOrCreateUser(tgId);
    user.balance += (payout || 0);
    res.json({ success: true });
});

bot.on('message', async (msg) => {
    if (!msg.text || !msg.text.startsWith('/newgiveaway')) return;
    
    const lines = msg.text.split('\n');
    let title = '', sponsor = '', timer = '', image = '';

    lines.forEach(line => {
        if (line.startsWith('Приз:')) title = line.replace('Приз:', '').trim();
        if (line.startsWith('Спонсор:')) sponsor = line.replace('Спонсор:', '').trim();
        if (line.startsWith('Таймер:')) timer = line.replace('Таймер:', '').trim();
        if (line.startsWith('Картинка:')) image = line.replace('Картинка:', '').trim();
    });

    if (!title || !sponsor) {
        await bot.sendMessage(msg.chat.id, '❌ Ошибка! Укажите поля "Приз:" и "Спонсор:".');
        return;
    }

    let sponsorUsername = sponsor.trim();
    if (sponsorUsername.includes('t.me/')) {
        const clean = sponsorUsername.split('t.me/')[1].replace('/', '');
        sponsorUsername = '@' + clean;
    } else if (!sponsorUsername.startsWith('@') && !sponsorUsername.startsWith('http')) {
        sponsorUsername = '@' + sponsorUsername;
    }

    const newGiveaway = {
        _id: Date.now().toString(),
        title,
        sponsor,
        sponsorUsername,
        timer: timer || 'Скоро',
        image: image || 'https://community.cloudflare.steamstatic.com/economy/image/-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I56KU0Zwwo4NUX4oFJZEHLbXH5ApeO4YmlhxYQknCRvCo04DEVlxkKgpot7HxfDhjxszJemkV092lnYmOhcj5Nr_Yg2ZU7PFohO_J9o-j2Vfk8hVtNjjwJ9ORfVFvY1-G_wO7x-_u1sS5uJ6ayXswuSM8pGGKYW964g/360fx360f',
        participantsCount: 0,
        participants: []
    };

    giveaways.push(newGiveaway);
    await bot.sendMessage(msg.chat.id, `✅ Обязательный розыгрыш приза "${title}" успешно добавлен! Проверка подписки на ${sponsorUsername} активна.`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Bot and Server are running on port ${PORT}`);
});
