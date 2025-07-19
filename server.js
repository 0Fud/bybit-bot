// Įkelia kintamuosius iš .env failo
import 'dotenv/config'; 
import express from 'express';
import axios from 'axios';
import { RestClientV5 } from 'bybit-api';

// --- APLIKACIJOS IR SERVERIO KONFIGŪRACIJA ---
const app = express();
// Serveris veiks per 3000 portą
const port = process.env.PORT || 3000; 
// Leidžia apdoroti JSON formato užklausas
app.use(express.json()); 

// --- KONFIGŪRACIJA IR PREKYBOS TAISYKLĖS ---
const FIXED_RISK_USD = 100.0;
const MIN_SL_PERCENT = 1.5;
const MAX_SL_PERCENT = 5.0;

// --- APLINKOS KINTAMIEJI ---
const {
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHANNEL_ID,
    BYBIT_API_KEY,
    BYBIT_API_SECRET
} = process.env;

// --- PAGALBINĖS FUNKCIJOS ---
const sendTelegramMessage = async (message) => {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHANNEL_ID) {
        console.log("Telegram kintamieji nenustatyti, pranešimas nesiunčiamas.");
        return;
    }
    try {
        await axios.post(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
            { chat_id: TELEGRAM_CHANNEL_ID, text: message, parse_mode: 'Markdown' }
        );
    } catch (error) {
        console.error('Klaida siunčiant pranešimą į Telegram:', error.response?.data || error.message);
    }
};

// --- PAGRINDINIS MARŠRUTAS (WEBHOOK HANDLER) ---
app.post('/webhook', async (req, res) => {
    console.log('Gautas signalas į /webhook maršrutą');

    if (!BYBIT_API_KEY || !BYBIT_API_SECRET) {
        const error_message = '❌ Kritinė konfigūracijos klaida: API raktai nėra nustatyti .env faile.';
        console.error(error_message);
        await sendTelegramMessage(error_message);
        return res.status(500).json({ error: 'Server configuration error.' });
    }

    const bybitClient = new RestClientV5({
        key: BYBIT_API_KEY,
        secret: BYBIT_API_SECRET,
    });

    try {
        const data = req.body;
        console.log('Gauti duomenys:', data);

        if (data.type === 'long_setup' || data.type === 'short_setup') {
            const entry_price = parseFloat(data.entry);
            const sl_price = parseFloat(data.stoploss);
            const tp_price = parseFloat(data.target1);
            const side = data.type === 'long_setup' ? 'Buy' : 'Sell';

            let ticker = data.ticker;
            if (ticker.endsWith('.P')) {
                ticker = ticker.slice(0, -2);
            }

            const sl_percent = Math.abs(entry_price - sl_price) / entry_price;

            if (sl_percent * 100 < MIN_SL_PERCENT || sl_percent * 100 > MAX_SL_PERCENT) {
                const msg = `⚠️ Signalas ${ticker} atmestas. SL plotis ${ (sl_percent * 100).toFixed(2)}% neatitinka kriterijų.`;
                console.log(msg);
                await sendTelegramMessage(msg);
                return res.status(200).json({ status: 'rejected', message: msg });
            }

            const position_size_in_asset = FIXED_RISK_USD / (entry_price * sl_percent);
            const position_size_rounded = position_size_in_asset.toFixed(3);

            if (parseFloat(position_size_rounded) <= 0) {
                const msg = `⚠️ Signalas ${ticker} atmestas. Apskaičiuotas pozicijos dydis per mažas.`;
                console.log(msg);
                await sendTelegramMessage(msg);
                return res.status(200).json({ status: 'rejected', message: msg });
            }

            console.log(`Siunčiamas įsakymas: ${side} ${position_size_rounded} ${ticker}`);
            const orderResponse = await bybitClient.submitOrder({
                category: 'linear',
                symbol: ticker,
                side: side,
                orderType: 'Market',
                qty: position_size_rounded,
                takeProfit: String(tp_price),
                stopLoss: String(sl_price),
                timeInForce: 'GTC',
            });

            if (orderResponse.retCode === 0) {
                const msg = `✅ Įsakymas sėkmingai išsiųstas: ${ticker} ${side} ${position_size_rounded}`;
                await sendTelegramMessage(msg);
                return res.status(200).json({ status: 'success', data: orderResponse });
            } else {
                throw new Error(`Bybit klaida: ${orderResponse.retMsg} (Kodas: ${orderResponse.retCode})`);
            }
        } else {
            const msg = `ℹ️ Gautas informacinis signalas: ${data.type || 'Nežinomas tipas'}`;
            console.log(msg);
            await sendTelegramMessage(msg);
            return res.status(200).json({ status: 'info_received' });
        }
    } catch (error) {
        const errorMessage = error.message;
        console.error('Klaida apdorojant užklausą:', error);
        await sendTelegramMessage(`❌ Įvyko kritinė klaida: ${errorMessage}`);
        return res.status(500).json({ error: errorMessage });
    }
});

// --- SERVERIO PALEIDIMAS ---
app.listen(port, '0.0.0.0', () => {
    console.log(`Bybit botas paleistas ir laukia signalų per http://0.0.0.0:${port}/webhook`);
});
