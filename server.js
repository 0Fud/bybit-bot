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

// DIAGNOSTIKOS ENDPOINT - patikrinti sąskaitos informaciją
app.get('/check-account', async (req, res) => {
    try {
        // Patikrinti sąskaitos informaciją
        const accountInfo = await bybitClient.getAccountInfo();
        console.log('=== ACCOUNT INFO ===');
        console.log(JSON.stringify(accountInfo, null, 2));

        // Patikrinti pozicijų informaciją
        const positions = await bybitClient.getPositionInfo({
            category: 'linear',
            symbol: 'SOLUSDT'
        });
        console.log('=== POSITION INFO ===');
        console.log(JSON.stringify(positions, null, 2));

        // Patikrinti instrumento informaciją
        const instrumentInfo = await bybitClient.getInstrumentsInfo({
            category: 'linear',
            symbol: 'SOLUSDT'
        });
        console.log('=== INSTRUMENT INFO ===');
        console.log(JSON.stringify(instrumentInfo, null, 2));

        res.json({
            account: accountInfo,
            positions: positions,
            instrument: instrumentInfo
        });

    } catch (error) {
        console.error('Klaida gaunant sąskaitos informaciją:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/webhook', async (req, res) => {
    console.log('\n--- Gaunamas signalas ---');
    const data = req.body;
    console.log('Gauti duomenys:', data);

    if (data.action !== 'TEST_CONDITIONAL_ORDER') {
        return res.status(200).json({ status: 'ignored', message: `Veiksmas '${data.action}' ignoruojamas.` });
    }

    try {
        const { ticker, side, qty, triggerPrice } = data;

        // Pataisyta logika triggerDirection
        const order = {
            category: 'linear',
            symbol: ticker,
            side: side,
            orderType: 'Market',
            qty: String(qty),
            triggerPrice: String(triggerPrice),
            // PATAISYTA: Buy reikia Fall (stop loss tipo), Sell reikia Rise
            // Alternatyvus variantas su string reikšmėmis:
            // triggerDirection: side === 'Buy' ? 'Rise' : 'Fall',
            triggerDirection: side === 'Buy' ? 1 : 2, // 1 = Rise, 2 = Fall
            stopOrderType: 'Market',
            // Pašalintas orderFilter parametras
        };
        
        console.log('Pateikiamas PATAISYTAS sąlyginis orderis su parametrais:', order);
        const orderResponse = await bybitClient.submitOrder(order);

        if (orderResponse.retCode !== 0) {
            const errorDetails = JSON.stringify(orderResponse.retExtInfo);
            throw new Error(`Bybit klaida (${orderResponse.retCode}): ${orderResponse.retMsg}. Detalės: ${errorDetails}`);
        }

        const msg = `✅ *SĄLYGINIS ORDERIS SĖKMINGAI PATEIKTAS: ${ticker}*\n` +
                    `Kryptis: ${side}, Kiekis: ${qty}\n` +
                    `Aktyvavimo kaina: ${triggerPrice}`;
                    
        await sendTelegramMessage(msg);
        res.status(200).json({ status: 'success', response: orderResponse.result });

    } catch (error) {
        console.error('❌ KLAIDA:', error.message);
        await sendTelegramMessage(`❌ KLAIDA: ${error.message}`);
        res.status(500).json({ status: 'error', error: error.message });
    }
});

app.listen(port, '0.0.0.0', () => console.log(`🚀 Botas (PATAISYTA VERSIJA) veikia ant porto ${port}`));