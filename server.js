import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import { RestClientV5 } from 'bybit-api';

const app = express();
const port = process.env.PORT || 3000;
app.use(express.json());

const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHANNEL_ID, BYBIT_API_KEY, BYBIT_API_SECRET } = process.env;
const bybitClient = new RestClientV5({ key: BYBIT_API_KEY, secret: BYBIT_API_SECRET });

const sendTelegramMessage = async (message) => {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHANNEL_ID) return;
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: TELEGRAM_CHANNEL_ID, text: message, parse_mode: 'Markdown' });
    } catch (error) { console.error('Telegram klaida:', error.response?.data || error.message); }
};

app.post('/webhook', async (req, res) => {
    console.log('\n--- Gaunamas ATŠAUKIMO signalas ---');
    const data = req.body;
    console.log('Gauti duomenys:', data);

    if (data.action !== 'CANCEL_CONDITIONAL') {
        return res.status(200).json({ status: 'ignored', message: 'Laukiama tik CANCEL_CONDITIONAL veiksmo.' });
    }

    try {
        const { ticker, direction } = data;
        // Atkuriame tą patį unikalų ID, kurį būtų sukūręs orderio pateikimo skriptas
        const orderLinkId = `${ticker}_${direction}_conditional`;
        
        console.log(`Atšaukiamas sąlyginis orderis su ID: ${orderLinkId}`);
        const cancelResponse = await bybitClient.cancelOrder({
            category: 'linear',
            symbol: ticker,
            orderLinkId: orderLinkId,
        });

        // 110001 = Order does not exist. Tai irgi yra sėkmė, nes orderio nebėra.
        if (cancelResponse.retCode !== 0 && cancelResponse.retCode !== 110001) {
            throw new Error(`Bybit klaida atšaukiant orderį (${cancelResponse.retCode}): ${cancelResponse.retMsg}`);
        }

        await sendTelegramMessage(`↪️ *Sąlyginis Orderis ATŠAUKTAS: ${ticker}* (${direction})\nOrderio ID: \`${orderLinkId}\``);
        res.status(200).json({ status: 'success', message: 'Orderis atšauktas arba neegzistuoja.' });

    } catch (error) {
        console.error('❌ ATŠAUKIMO KLAIDA:', error.message);
        await sendTelegramMessage(`❌ ATŠAUKIMO KLAIDA: ${error.message}`);
        res.status(500).json({ status: 'error', error: error.message });
    }
});

app.listen(port, '0.0.0.0', () => console.log(`🚀 Botas (TIK ATŠAUKIMUI) veikia ant porto ${port}`));