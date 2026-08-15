const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');

const TOKEN = process.env.BOT_TOKEN || 'YOUR_TELEGRAM_BOT_TOKEN';
const CRYPTO_BOT_TOKEN = process.env.CRYPTO_BOT_TOKEN || 'YOUR_CRYPTO_BOT_TOKEN';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || 'YOUR_ADMIN_CHAT_ID';

// Безопасная инициализация с принудительным сбросом конфликтов (ошибка 409)
const bot = new TelegramBot(TOKEN, { polling: false });
bot.deleteWebhook().then(() => {
    bot.startPolling();
}).catch(() => {
    bot.startPolling();
});

const app = express();

app.use(express.json());
app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

let users = {};
let marketItems = [];
let giveaways = [];

// Авторизация через Steam (редирект)
app.get('/auth/steam', (req, res) => {
    // Упрощенный редирект на главную с параметром-заглушкой, либо интеграция OpenID
    res.redirect('/?steamId=76561198000000000');
});

// Профиль пользователя
app.get('/api/user/profile', (req, res) => {
    const { tgId, tgUser } = req.query;
    if (!users[tgId]) {
        users[tgId] = { tgId, username: tgUser, balance: 0, rating: 5.0, completedDeals: 0, tradeUrl: '', steamId: '' };
    }
    res.json({ success: true, ...users[tgId] });
});

// Сохранение настроек пользователя
app.post('/api/user/save', (req, res) => {
    const { tgId, tradeUrl, steamId } = req.body;
    if (!users[tgId]) {
        users[tgId] = { tgId, balance: 0, rating: 5.0, completedDeals: 0 };
    }
    users[tgId].tradeUrl = tradeUrl;
    users[tgId].steamId = steamId;
    res.json({ success: true });
});

// Список товаров на маркетплейсе
app.get('/api/market/items', (req, res) => {
    res.json({ success: true, items: marketItems });
});

// Добавление лота на маркетплейс
app.post('/api/market/add', (req, res) => {
    const item = req.body;
    item._id = Date.now().toString();
    marketItems.push(item);
    res.json({ success: true, item });
});

// Отмена лота на маркетплейсе
app.post('/api/market/cancel', (req, res) => {
    const { itemId, tgId } = req.body;
    marketItems = marketItems.filter(i => !(i._id === itemId && String(i.tgId) === String(tgId)));
    res.json({ success: true });
});

// Список розыгрышей
app.get('/api/giveaways/list', (req, res) => {
    const formattedGiveaways = giveaways.map(g => ({
        ...g,
        participantsCount: g.participants ? g.participants.length : 0
    }));
    res.json({ success: true, giveaways: formattedGiveaways });
});

// Участие в розыгрыше
app.post('/api/giveaways/join', async (req, res) => {
    const { tgId, giveawayId } = req.body;
    const giveaway = giveaways.find(g => g._id === giveawayId);
    
    if (!giveaway) {
        return res.json({ success: false, error: 'Розыгрыш не найден' });
    }

    if (!giveaway.participants) {
        giveaway.participants = [];
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
            console.error("Subscription check error (bypassed for safety):", err.message);
        }
    }

    giveaway.participants.push(String(tgId));
    giveaway.participantsCount = giveaway.participants.length;
    res.json({ success: true });
});

// Получение инвентаря Steam
app.post('/api/steam/inventory', async (req, res) => {
    try {
        const { tgId, steamId } = req.body;
        
        let targetSteamId = steamId;
        if (!targetSteamId && tgId && users[tgId]) {
            targetSteamId = users[tgId].steamId;
        }

        if (!targetSteamId) {
            return res.json({ success: false, error: 'Steam ID не указан', items: [], descriptions: [] });
        }

        const url = `https://steamcommunity.com/inventory/${targetSteamId}/730/2?l=russian&count=75`;
        
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7'
            }
        });

        if (!response.ok) {
            return res.json({ success: false, error: 'Профиль закрыт или инвентарь недоступен', items: [], descriptions: [] });
        }

        const data = await response.json();

        if (!data || !data.success) {
            return res.json({ success: false, error: 'Не удалось загрузить инвентарь', items: [], descriptions: [] });
        }

        res.json({
            success: true,
            items: data.assets || [],
            descriptions: data.descriptions || []
        });

    } catch (error) {
        console.error('Steam inventory fetch error:', error.message);
        res.json({ success: false, error: 'Ошибка сервера при запросе инвентаря', items: [], descriptions: [] });
    }
});

// Получение цены предмета
app.get('/api/steam/price', async (req, res) => {
    const { name } = req.query;
    if (!name) return res.json({ success: true, price: 1500, name: 'Unknown Item' });

    try {
        const encodedName = encodeURIComponent(name);
        const response = await fetch(`https://steamcommunity.com/market/priceoverview/?appid=730&currency=5&market_hash_name=${encodedName}`);
        const data = await response.json();

        if (data && data.success && data.lowest_price) {
            let priceNum = parseFloat(data.lowest_price.replace(/[^\d,]/g, '').replace(',', '.'));
            return res.json({ success: true, price: priceNum || 150 });
        }
    } catch (e) {
        console.error("Steam price fetch error:", e.message);
    }

    const isCheap = name.toLowerCase().includes('sticker') || name.toLowerCase().includes('граффити');
    res.json({ success: true, price: isCheap ? 30 : 1500, name });
});

// Покупка предмета
app.post('/api/deals/buy', (req, res) => {
    const { tgId, itemId } = req.body;
    
    const itemIndex = marketItems.findIndex(i => i._id === itemId);
    if (itemIndex === -1) {
        return res.json({ success: false, error: 'Лот не найден или уже был продан' });
    }

    const item = marketItems[itemIndex];
    if (!users[tgId]) {
        return res.json({ success: false, error: 'Покупатель не найден' });
    }

    const price = Number(item.price || 0);
    if (users[tgId].balance < price) {
        return res.json({ success: false, error: 'Недостаточно средств на балансе' });
    }

    users[tgId].balance -= price;
    users[tgId].completedDeals = (users[tgId].completedDeals || 0) + 1;

    const sellerId = item.tgId;
    if (sellerId && users[sellerId]) {
        users[sellerId].balance += price;
        users[sellerId].completedDeals = (users[sellerId].completedDeals || 0) + 1;
        
        bot.sendMessage(sellerId, `🎉 Ваш предмет "${item.name || 'Скин'}" успешно продан за ${price} ₽! Средства зачислены на баланс.`).catch(() => {});
    }

    marketItems.splice(itemIndex, 1);

    res.json({ success: true, newBalance: users[tgId].balance });
});

// Создание счета на оплату
app.post('/api/billing/invoice', async (req, res) => {
    try {
        const { tgId, method, amount } = req.body;

        if (!tgId || !method || !amount) {
            return res.json({ success: false, error: 'Не переданы обязательные параметры оплаты' });
        }

        if (method === 'stars') {
            const title = 'Пополнение баланса Steam Sales';
            const description = `Пополнение баланса на ${amount} Telegram Stars`;
            const payload = JSON.stringify({ tgId, amount });
            const currency = 'XTR';
            const prices = [{ label: 'Звёзды', amount: Number(amount) }];

            const invoiceLink = await bot.createInvoiceLink(title, description, payload, '', currency, prices);
            return res.json({ success: true, invoiceUrl: invoiceLink });
        } 
        else if (method === 'crypto') {
            if (!CRYPTO_BOT_TOKEN || CRYPTO_BOT_TOKEN === 'YOUR_CRYPTO_BOT_TOKEN') {
                return res.json({ success: false, error: 'Не задан CRYPTO_BOT_TOKEN на сервере' });
            }

            const resp = await fetch('https://pay.crypt.bot/api/createInvoice', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Crypto-Pay-API-Token': CRYPTO_BOT_TOKEN
                },
                body: JSON.stringify({
                    asset: 'USDT',
                    amount: String(amount),
                    description: `Пополнение баланса Steam Sales для пользователя ${tgId}`,
                    payload: JSON.stringify({ tgId, amount })
                })
            });

            const data = await resp.json();
            if (data.ok && data.result) {
                return res.json({ success: true, invoiceUrl: data.result.pay_url });
            } else {
                const errName = data.error ? (data.error.name || JSON.stringify(data.error)) : 'Неизвестная ошибка';
                return res.json({ success: false, error: `Crypto Bot: ${errName}` });
            }
        }

        res.json({ success: false, error: 'Неизвестный метод оплаты' });
    } catch (error) {
        console.error('Billing invoice creation error:', error.message);
        res.json({ success: false, error: 'Ошибка сервера при создании счета' });
    }
});

// Запрос на вывод средств
app.post('/api/billing/withdraw', async (req, res) => {
    const { tgId, amount, address } = req.body;
    
    if (!users[tgId]) {
        return res.json({ success: false, error: 'Пользователь не найден' });
    }

    const withdrawAmount = Number(amount);
    if (isNaN(withdrawAmount) || withdrawAmount <= 0) {
        return res.json({ success: false, error: 'Некорректная сумма вывода' });
    }

    if (users[tgId].balance < withdrawAmount) {
        return res.json({ success: false, error: 'Недостаточно средств для вывода' });
    }

    users[tgId].balance -= withdrawAmount;

    if (ADMIN_CHAT_ID && ADMIN_CHAT_ID !== 'YOUR_ADMIN_CHAT_ID') {
        await bot.sendMessage(ADMIN_CHAT_ID, `💸 **Новая заявка на вывод средств!**\n\n👤 Пользователь: \`${tgId}\`\n💰 Сумма: ${withdrawAmount} ₽\n📬 Реквизиты: ${address || 'Не указаны'}`, { parse_mode: 'Markdown' }).catch(() => {});
    }

    res.json({ success: true, newBalance: users[tgId].balance });
});

// Обработка Telegram Stars платежей
bot.on('pre_checkout_query', async (query) => {
    try {
        await bot.answerPreCheckoutQuery(query.id, true);
    } catch (e) {
        console.error('Pre-checkout error:', e);
    }
});

bot.on('successful_payment', (msg) => {
    const chatId = msg.chat.id;
    const tgId = String(msg.from.id);
    const payment = msg.successful_payment;

    if (payment.currency === 'XTR') {
        const starsAmount = payment.total_amount;
        if (users[tgId]) {
            users[tgId].balance += starsAmount; 
        }
        bot.sendMessage(chatId, `✅ Оплата на ${starsAmount} Telegram Stars успешно проведена! Баланс обновлен.`);
    }
});

// Создание розыгрыша через админ-чат
bot.on('message', async (msg) => {
    const text = msg.text || msg.caption;
    if (!text || !text.startsWith('/newgiveaway')) return;
    
    const lines = text.split('\n');
    let title = '', sponsor = '', timer = 'Скоро', image = '';

    lines.forEach(line => {
        if (line.toLowerCase().startsWith('приз:') || line.toLowerCase().startsWith('prize:')) 
            title = line.replace(/^(приз:|prize:)/i, '').trim();
        if (line.toLowerCase().startsWith('спонсор:') || line.toLowerCase().startsWith('sponsor:')) 
            sponsor = line.replace(/^(спонсор:|sponsor:)/i, '').trim();
        if (line.toLowerCase().startsWith('таймер:') || line.toLowerCase().startsWith('timer:')) 
            timer = line.replace(/^(таймер:|timer:)/i, '').trim();
        if (line.toLowerCase().startsWith('картинка:') || line.toLowerCase().startsWith('image:')) 
            image = line.replace(/^(картинка:|image:)/i, '').trim();
    });

    if (msg.photo && msg.photo.length > 0) {
        try {
            const photo = msg.photo[msg.photo.length - 1];
            const fileLink = await bot.getFileLink(photo.file_id);
            if (fileLink) {
                image = fileLink;
            }
        } catch (err) {
            console.error('Error fetching photo from telegram:', err.message);
        }
    }

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
        timer,
        image: image || 'https://community.cloudflare.steamstatic.com/economy/image/-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I56KU0Zwwo4NUX4oFJZEHLbXH5ApeO4YmlhxYQknCRvCo04DEVlxkKgpot7HxfDhjxszJemkV092lnYmOhcj5Nr_Yg2ZU7PFohO_J9o-j2Vfk8hVtNjjwJ9ORfVFvY1-G_wO7x-_u1sS5uJ6ayXswuSM8pGGKYW964g/360fx360f',
        participantsCount: 0,
        participants: []
    };

    giveaways.push(newGiveaway);
    await bot.sendMessage(msg.chat.id, `✅ Розыгрыш приза "${title}" успешно добавлен!`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Bot and Server are running on port ${PORT}`);
});
