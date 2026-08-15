const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');

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

app.get('/api/user/profile', (req, res) => {
    const { tgId, tgUser } = req.query;
    if (!users[tgId]) {
        users[tgId] = { tgId, username: tgUser, balance: 0, rating: 5.0, completedDeals: 0, tradeUrl: '' };
    }
    res.json({ success: true, ...users[tgId] });
});

app.post('/api/user/save', (req, res) => {
    const { tgId, tradeUrl, steamId } = req.body;
    if (!users[tgId]) {
        users[tgId] = { tgId, balance: 0, rating: 5.0, completedDeals: 0 };
    }
    users[tgId].tradeUrl = tradeUrl;
    users[tgId].steamId = steamId;
    res.json({ success: true });
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

app.post('/api/steam/inventory', (req, res) => {
    res.json({ success: false, items: [], descriptions: [] });
});

app.get('/api/steam/price', (req, res) => {
    res.json({ success: true, price: 1500 });
});

app.post('/api/deals/buy', (req, res) => {
    res.json({ success: true });
});

app.post('/api/billing/invoice', (req, res) => {
    res.json({ success: true });
});

app.post('/api/billing/withdraw', (req, res) => {
    res.json({ success: true });
});

app.post('/api/inventory/instant-sell', (req, res) => {
    const { tgId, payout } = req.body;
    if (users[tgId]) {
        users[tgId].balance += (payout || 0);
    }
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
