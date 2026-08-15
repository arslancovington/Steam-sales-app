import fetch from 'node-fetch';

// Локальное состояние в памяти для быстрого доступа
export const db = {
    users: {},
    marketItems: [],
    giveaways: [],
    // ID последнего служебного сообщения с данными в чате
    lastMessageId: null 
};

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

// Функция загрузки данных из закрытого телеграм-чата при старте сервера
export async function loadDatabaseFromTelegram() {
    if (!BOT_TOKEN || !ADMIN_CHAT_ID) {
        console.log("⚠️ BOT_TOKEN или ADMIN_CHAT_ID не заданы, работаем на чистой памяти.");
        return;
    }

    try {
        // Забираем последние сообщения из админ-чата
        const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatHistory?chat_id=${ADMIN_CHAT_ID}&limit=10`;
        // Либо через getUpdates / поиск поpinned, но проще через getUpdates или кастомный тег бэкапа
        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates`);
        const data = await res.json();

        if (data.ok && data.result) {
            // Ищем последнее сообщение, содержащее наш тег бэкапа #DB_BACKUP
            const backupMsg = data.result
                .map(u => u.message)
                .filter(m => m && m.chat && String(m.chat.id) === String(ADMIN_CHAT_ID) && m.text && m.text.includes('#DB_BACKUP'))
                .pop();

            if (backupMsg) {
                const jsonStr = backupMsg.text.replace('#DB_BACKUP', '').trim();
                const parsedData = JSON.parse(jsonStr);
                
                if (parsedData.users) db.users = parsedData.users;
                if (parsedData.marketItems) db.marketItems = parsedData.marketItems;
                if (parsedData.giveaways) db.giveaways = parsedData.giveaways;
                
                console.log("✅ База данных успешно восстановлена из Telegram-чата!");
            }
        }
    } catch (e) {
        console.error("⚠️ Не удалось восстановить базу из Telegram:", e.message);
    }
}

// Функция сохранения текущего состояния в закрытый телеграм-чат
export async function saveDatabaseToTelegram() {
    if (!BOT_TOKEN || !ADMIN_CHAT_ID) return;

    try {
        const payload = JSON.stringify({
            users: db.users,
            marketItems: db.marketItems,
            giveaways: db.giveaways
        });

        const text = `#DB_BACKUP\n${payload}`;

        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: ADMIN_CHAT_ID,
                text: text
            })
        });
    } catch (e) {
        console.error("⚠️ Ошибка сохранения бэкапа в Telegram:", e.message);
    }
}
