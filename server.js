import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import { RestClientV5 } from 'bybit-api';

const app = express();
const port = process.env.PORT || 3000;
app.use(express.json());

const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHANNEL_ID, BYBIT_API_KEY, BYBIT_API_SECRET } = process.env;

const bybitClient = new RestClientV5({ key: BYBIT_API_KEY, secret: BYBIT_API_SECRET, testnet: false });

const sendTelegramMessage = async (message) => {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHANNEL_ID) return;
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { 
            chat_id: TELEGRAM_CHANNEL_ID, 
            text: message, 
            parse_mode: 'Markdown' 
        });
    } catch (error) {
        console.error('Klaida siunčiant pranešimą į Telegram:', error.response?.data || error.message);
    }
};

app.post('/webhook', async (req, res) => {
    console.log('\n--- Gaunamas signalas ---');
    const data = req.body;
    console.log('Gauti duomenys:', data);

    if (data.action !== 'TEST_CONDITIONAL_ORDER') {
        return res.status(200).json({ status: 'ignored', message: `Veiksmas '${data.action}' ignoruojamas.` });
    }

    try {
        // Paimame VISUS reikalingus duomenis, įskaitant positionIdx
        const { ticker, side, qty, triggerPrice, positionIdx } = data;

        const order = {
            category: 'linear',
            symbol: ticker,
            side: side,
            orderType: 'Market',
            qty: String(qty),
            triggerPrice: String(triggerPrice),
            triggerDirection: side === 'Buy' ? 1 : 2, // 1 = Kaina kyla (longui), 2 = Kaina krenta (shortui)
            stopOrderType: 'Market',
            positionIdx: positionIdx, // Šis parametras yra BŪTINAS jūsų "Hedge" režimui
        };
        
        console.log('Pateikiamas FINALINIS sąlyginis orderis su parametrais:', order);
        const orderResponse = await bybitClient.submitOrder(order);

        if (orderResponse.retCode !== 0) {
            const errorDetails = JSON.stringify(orderResponse.retExtInfo);
            throw new Error(`Bybit klaida (${orderResponse.retCode}): ${orderResponse.retMsg}. Detalės: ${errorDetails}`);
        }

        const msg = `✅ *SĄLYGINIS ORDERIS SĖKMINGAI PATEIKTAS: ${ticker}*\n` +
                    `Kryptis: ${side}, Kiekis: ${qty}\n` +
                    `Aktyvavimo kaina: ${triggerPrice}\n` +
                    `Pozicijos ID: ${positionIdx}`;
                    
        await sendTelegramMessage(msg);
        res.status(200).json({ status: 'success', response: orderResponse.result });

    } catch (error) {
        console.error('❌ KLAIDA:', error.message);
        await sendTelegramMessage(`❌ KLAIDA: ${error.message}`);
        res.status(500).json({ status: 'error', error: error.message });
    }
});

app.listen(port, '0.0.0.0', () => console.log(`🚀 Botas (HEDGE REŽIMO VERSIJA) veikia ant porto ${port}`));