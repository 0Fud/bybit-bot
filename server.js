import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import { RestClientV5 } from 'bybit-api';

const app = express();
const port = process.env.PORT || 3000;
app.use(express.json());

const FIXED_RISK_USD = 1.0;

const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHANNEL_ID, BYBIT_API_KEY, BYBIT_API_SECRET } = process.env;

const bybitClient = new RestClientV5({ key: BYBIT_API_KEY, secret: BYBIT_API_SECRET });

const sendTelegramMessage = async (message) => {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHANNEL_ID) return;
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: TELEGRAM_CHANNEL_ID, text: message, parse_mode: 'Markdown' });
    } catch (error) {
        console.error('Klaida siunčiant pranešimą į Telegram:', error.response?.data || error.message);
    }
};

app.post('/webhook', async (req, res) => {
    console.log('\n--- Gaunamas TESTO signalas ---');
    const data = req.body;
    console.log('Gauti duomenys:', data);

    // Lauksime tik vieno specifinio testo veiksmo
    if (data.action !== 'TEST_ORDER') {
        return res.status(200).json({ status: 'ignored', message: `Veiksmas '${data.action}' ignoruojamas. Laukiama 'TEST_ORDER'.` });
    }

    try {
        const { ticker, direction, positionIdx, triggerPrice, stopLoss, takeProfit } = data;
        const side = direction.toLowerCase() === 'long' ? 'Buy' : 'Sell';

        // Gauname prekybos taisykles iš Bybit
        const instrumentsInfo = await bybitClient.getInstrumentsInfo({ category: 'linear', symbol: ticker });
        const instrument = instrumentsInfo.result.list[0];
        const { minOrderQty, qtyStep } = instrument.lotSizeFilter;

        // Pozicijos dydžio skaičiavimas pagal JŪSŲ nurodytas kainas
        const risk_per_asset = Math.abs(parseFloat(triggerPrice) - parseFloat(stopLoss));
        if (risk_per_asset === 0) throw new Error('triggerPrice negali būti lygus stopLoss.');

        const position_size = FIXED_RISK_USD / risk_per_asset;
        const precision = qtyStep.toString().split('.')[1]?.length || 0;
        const qty = (Math.floor(position_size / parseFloat(qtyStep)) * parseFloat(qtyStep)).toFixed(precision);

        if (parseFloat(qty) < parseFloat(minOrderQty)) {
            throw new Error(`Apskaičiuotas kiekis (${qty}) per mažas. Minimalus: ${minOrderQty}.`);
        }

        console.log('Teikiamas TESTINIS sąlyginis orderis...');
        const orderResponse = await bybitClient.submitOrder({
            category: 'linear',
            symbol: ticker,
            side: side,
            orderType: 'Market',
            qty: qty,
            positionIdx: positionIdx,
            triggerPrice: String(triggerPrice), // Kaina, kurią pasiekus įvykdomas market orderis
            orderFilter: 'StopOrder',           // Būtent tai įjungia sąlyginį orderį
            triggerDirection: side === 'Buy' ? 'Rise' : 'Fall',
            takeProfit: String(takeProfit),
            stopLoss: String(stopLoss),
        });

        if (orderResponse.retCode !== 0) {
            throw new Error(`Bybit klaida: ${orderResponse.retMsg}`);
        }

        const msg = `✅ *TESTINIS Sąlyginis Orderis Pateiktas: ${ticker}* (${side})\n` +
                    `📈 Aktyvavimo kaina: ${triggerPrice}\n` +
                    `💰 Dydis: ${qty}\n` +
                    `🎯 TP: ${takeProfit}\n` +
                    `🛑 SL: ${stopLoss}`;

        await sendTelegramMessage(msg);
        res.status(200).json({ status: 'success', response: orderResponse });

    } catch (error) {
        console.error('❌ KLAIDA TESTUOJANT:', error.message);
        await sendTelegramMessage(`❌ TESTO KLAIDA: ${error.message}`);
        res.status(500).json({ status: 'error', error: error.message });
    }
});

app.listen(port, '0.0.0.0', () => console.log(`🚀 Botas (TIK TESTAVIMUI) veikia ant porto ${port}`));