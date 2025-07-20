// Įkelia kintamuosius iš .env failo
import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import { RestClientV5 } from 'bybit-api';

// --- APLIKACIJOS IR SERVERIO KONFIGŪRACIJA ---
const app = express();
const port = process.env.PORT || 3000;
app.use(express.json());

// --- KONFIGŪRACIJA IR PREKYBOS TAISYKLĖS ---
const FIXED_RISK_USD = 1.0; // Fiksuota rizika USD per sandorį

// --- APLINKOS KINTAMIEJI ---
const {
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHANNEL_ID,
    BYBIT_API_KEY,
    BYBIT_API_SECRET
} = process.env;

// --- BYBIT KLIENTO INICIALIZAVIMAS ---
const bybitClient = new RestClientV5({
    key: BYBIT_API_KEY,
    secret: BYBIT_API_SECRET,
});

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
    console.log('\n--- Naujas signalas ---');
    const data = req.body;
    console.log('Gauti duomenys:', data);

    try {
        if (!data.action) {
             return res.status(200).json({ status: 'ignored', message: 'No action specified.' });
        }

        const ticker = data.ticker.replace('.P', '');
        const positionIdx = parseInt(data.positionIdx, 10);
        const direction = data.direction?.toLowerCase();

        switch (data.action) {
            // =================================================================================
            // VEIKSMAS 1: Pateikti naują sąlyginį orderį
            // =================================================================================
            case 'ENTER_CONDITIONAL': {
                const side = direction === 'long' ? 'Buy' : 'Sell';
                const triggerPrice = parseFloat(data.triggerPrice);
                const stopLoss = parseFloat(data.stopLoss);
                const takeProfit = parseFloat(data.takeProfit);

                const instrumentsInfo = await bybitClient.getInstrumentsInfo({ category: 'linear', symbol: ticker });
                const instrument = instrumentsInfo.result.list[0];
                const { minOrderQty, qtyStep } = instrument.lotSizeFilter;

                const risk_per_asset = Math.abs(triggerPrice - stopLoss);
                if (risk_per_asset === 0) throw new Error('triggerPrice negali būti lygus stopLoss.');
                
                const position_size = FIXED_RISK_USD / risk_per_asset;
                const precision = qtyStep.toString().split('.')[1]?.length || 0;
                const qty = (Math.floor(position_size / parseFloat(qtyStep)) * parseFloat(qtyStep)).toFixed(precision);

                if (parseFloat(qty) < parseFloat(minOrderQty)) {
                    throw new Error(`Apskaičiuotas kiekis (${qty}) per mažas. Minimalus: ${minOrderQty}.`);
                }

                const orderLinkId = `${ticker}_${direction}_conditional`;

                const order = {
                    category: 'linear',
                    symbol: ticker,
                    side: side,
                    orderType: 'Market',
                    qty: qty,
                    triggerPrice: String(triggerPrice),
                    triggerDirection: side === 'Buy' ? 1 : 2,
                    stopOrderType: 'Market',
                    positionIdx: positionIdx,
                    orderLinkId: orderLinkId,
                    takeProfit: String(takeProfit),
                    stopLoss: String(stopLoss),
                    tpslMode: 'Full',
                };

                console.log('Pateikiamas sąlyginis orderis:', order);
                const orderResponse = await bybitClient.submitOrder(order);

                if (orderResponse.retCode !== 0) {
                    throw new Error(`Bybit klaida (${orderResponse.retCode}): ${orderResponse.retMsg}`);
                }

                await sendTelegramMessage(
                    `✅ *Sąlyginis Orderis Pateiktas: ${ticker}*\n` +
                    `Kryptis: ${side}, Dydis: ${qty}\n` +
                    `Aktyvavimo kaina: ${triggerPrice}\n` +
                    `TP: ${takeProfit}, SL: ${stopLoss}\n` +
                    `Orderio ID: \`${orderLinkId}\``
                );
                break;
            }

            // =================================================================================
            // VEIKSMAS 2: Atšaukti laukiantį sąlyginį orderį (PATAISYTA)
            // =================================================================================
            case 'CANCEL_CONDITIONAL': {
                // PATAISYMAS: Sugeneruojame orderLinkId patys, o ne bandome gauti iš TradingView.
                // Tam naudojame `ticker` ir `direction`, kuriuos webhook'as visada atsiunčia.
                const orderLinkId = `${ticker}_${direction}_conditional`;
                
                console.log(`Atšaukiamas sąlyginis orderis su sugeneruotu ID: ${orderLinkId}`);
                const cancelResponse = await bybitClient.cancelOrder({
                    category: 'linear',
                    symbol: ticker,
                    orderLinkId: orderLinkId,
                });

                // Klaidos kodas 110001 reiškia "order does not exist" - tai nėra kritinė klaida,
                // nes orderis galėjo būti įvykdytas arba atšauktas anksčiau.
                if (cancelResponse.retCode !== 0 && cancelResponse.retCode !== 110001) {
                    throw new Error(`Bybit klaida atšaukiant orderį (${cancelResponse.retCode}): ${cancelResponse.retMsg}`);
                }

                await sendTelegramMessage(`↪️ *Sąlyginis Orderis Atšauktas: ${ticker}* (${direction})\nOrderio ID: \`${orderLinkId}\``);
                break;
            }

            // =================================================================================
            // VEIKSMAS 3: Uždaryti jau atidarytą poziciją, jei ji paseno
            // =================================================================================
            case 'CLOSE_BY_AGE': {
                console.log(`Uždaroma pozicija ${ticker} (idx: ${positionIdx}), nes baigėsi laikas.`);
                const positions = await bybitClient.getPositionInfo({ category: 'linear', symbol: ticker });
                const position = positions.result.list.find(p => p.positionIdx === positionIdx && parseFloat(p.size) > 0);

                if (!position) {
                    await sendTelegramMessage(`⚠️ Bandyta uždaryti pasenusią poziciją *${ticker}* (idx: ${positionIdx}), bet ji nerasta.`);
                    return res.status(200).json({ status: 'ignored', message: 'Position not found.' });
                }
                
                const closeSide = position.side === 'Buy' ? 'Sell' : 'Buy';
                const closeResponse = await bybitClient.submitOrder({
                    category: 'linear',
                    symbol: ticker,
                    side: closeSide,
                    orderType: 'Market',
                    qty: position.size,
                    reduceOnly: true,
                    positionIdx: positionIdx,
                });

                if (closeResponse.retCode !== 0) {
                    throw new Error(`Bybit klaida uždarant poziciją: ${closeResponse.retMsg}`);
                }
                await sendTelegramMessage(`✅ Pozicija *${ticker}* (idx: ${positionIdx}) sėkmingai uždaryta, nes baigėsi laikas.`);
                break;
            }

            default:
                console.log(`Gautas veiksmas '${data.action}', kuris yra ignoruojamas.`);
                return res.status(200).json({ status: 'ignored', message: `Action '${data.action}' is not handled.` });
        }

        res.status(200).json({ status: 'success', message: `Action '${data.action}' processed.` });

    } catch (error) {
        console.error('❌ KLAIDA APDOROJANT SIGNALĄ:', error.message);
        await sendTelegramMessage(`❌ Įvyko klaida: ${error.message}`);
        res.status(500).json({ status: 'error', error: error.message });
    }
});

// --- SERVERIO PALEIDIMAS ---
app.listen(port, '0.0.0.0', async () => {
    const msg = `🚀 Bybit botas v9 (PRODUKCINĖ VERSIJA) paleistas ir laukia signalų per http://0.0.0.0:${port}/webhook`;
    console.log(msg);
    await sendTelegramMessage(msg);
});