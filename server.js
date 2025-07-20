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
        if (!BYBIT_API_KEY || !BYBIT_API_SECRET) {
            throw new Error('Kritinė konfigūracijos klaida: API raktai nėra nustatyti .env faile.');
        }

        // Tikriname, ar yra 'action' laukas.
        if (!data.action) {
             return res.status(200).json({ status: 'ignored', message: 'No action specified.' });
        }

        const ticker = data.ticker.replace('.P', '');
        const positionIdx = parseInt(data.positionIdx, 10);

        // Veiksmų skirstytuvas
        switch (data.action) {
            // --- 1. ATIDARYTI POZICIJĄ RINKOS KAINA ---
            case 'ENTER_MARKET': {
                const direction = data.direction.toLowerCase();
                const side = direction === 'long' ? 'Buy' : 'Sell';
                
                const sl_price = parseFloat(data.stopLoss);
                const tp_price = parseFloat(data.takeProfit);
            
                // Pirmiausia gaukime instrumento informaciją
                const instrumentInfo = await bybitClient.getInstrumentInfo({
                    category: 'linear',
                    symbol: ticker
                });
            
                if (!instrumentInfo.result.list[0]) {
                    throw new Error(`Nepavyko gauti instrumento informacijos ${ticker}.`);
                }
            
                const instrument = instrumentInfo.result.list[0];
                const minOrderQty = parseFloat(instrument.lotSizeFilter.minOrderQty);
                const qtyStep = parseFloat(instrument.lotSizeFilter.qtyStep);
            
                console.log(`Instrumento info ${ticker}: minOrderQty=${minOrderQty}, qtyStep=${qtyStep}`);
            
                // Pozicijos dydžio skaičiavimas
                const tickerInfo = await bybitClient.getTickers({ category: 'linear', symbol: ticker });
                const current_price = parseFloat(tickerInfo.result.list[0].lastPrice);
            
                if (!current_price) {
                    throw new Error(`Nepavyko gauti dabartinės kainos ${ticker}.`);
                }
            
                const sl_percent = Math.abs(current_price - sl_price) / current_price;
                if (sl_percent === 0) {
                    throw new Error(`Signalas ${ticker} atmestas. Stop Loss negali būti lygus dabartinei kainai.`);
                }
            
                const position_size_in_asset = FIXED_RISK_USD / (current_price * sl_percent);
                
                // SVARBU: Suapvalinkime pagal qtyStep reikalavimus
                const position_size_rounded = Math.floor(position_size_in_asset / qtyStep) * qtyStep;
                const final_qty = Math.max(position_size_rounded, minOrderQty);
                
                // Formatuokime pagal qtyStep tikslumą
                const decimals = qtyStep.toString().split('.')[1]?.length || 0;
                const position_size_formatted = final_qty.toFixed(decimals);
            
                console.log(`Skaičiavimas ${ticker}:`);
                console.log(`- Dabartinė kaina: ${current_price}`);
                console.log(`- SL plotis: ${(sl_percent * 100).toFixed(2)}%`);
                console.log(`- Apskaičiuotas dydis: ${position_size_in_asset}`);
                console.log(`- Suapvalintas dydis: ${position_size_formatted}`);
            
                if (parseFloat(position_size_formatted) < minOrderQty) {
                    throw new Error(`Signalas ${ticker} atmestas. Pozicijos dydis ${position_size_formatted} per mažas (min: ${minOrderQty}).`);
                }
                
                console.log(`Ruosiamas RINKOS orderis: ${side} ${position_size_formatted} ${ticker}`);
                console.log(`Parametrai: SL=${sl_price}, TP=${tp_price}`);
            
                // Orderio pateikimas
                const orderResponse = await bybitClient.submitOrder({
                    category: 'linear',
                    symbol: ticker,
                    side: side,
                    orderType: 'Market',
                    qty: position_size_formatted,
                    positionIdx: positionIdx,
                    takeProfit: String(tp_price),
                    stopLoss: String(sl_price),
                });
            
                if (orderResponse.retCode !== 0) {
                    throw new Error(`Bybit klaida atidarant poziciją: ${orderResponse.retMsg}`);
                }
            
                console.log(`Pozicija ${ticker} (idx: ${positionIdx}) sėkmingai atidaryta. Order ID: ${orderResponse.result.orderId}`);
                
                await sendTelegramMessage(
                    `✅ *Pozicija Atidaryta: ${ticker}* (${side})\n` +
                    `💰 Dydis: ${position_size_formatted}\n` +
                    `🎯 TP: ${tp_price}\n` +
                    `🛑 SL: ${sl_price}`
                );
                
                break;
            }

            // --- 2. UŽDARYTI POZICIJĄ DĖL LAIKO ---
            case 'CLOSE_BY_AGE': {
                console.log(`Uždaroma pozicija ${ticker} (idx: ${positionIdx}), nes baigėsi laikas (Invalidated by Age).`);

                // Gauname atidarytos pozicijos duomenis, kad žinotume jos dydį
                const positions = await bybitClient.getPositions({ category: 'linear', symbol: ticker });
                const position = positions.result.list.find(p => p.positionIdx === positionIdx && parseFloat(p.size) > 0);

                if (!position) {
                    // Tai nėra klaida, galbūt pozicija jau buvo uždaryta rankiniu būdu arba per SL/TP
                    console.log(`Nerasta aktyvi pozicija ${ticker} (idx: ${positionIdx}), kurią būtų galima uždaryti. Galbūt jau uždaryta.`);
                    await sendTelegramMessage(`⚠️ Bandyta uždaryti pasenusią poziciją *${ticker}* (idx: ${positionIdx}), bet ji nerasta.`);
                    return res.status(200).json({ status: 'ignored', message: 'Position not found, likely already closed.' });
                }
                
                const side = position.side === 'Buy' ? 'Sell' : 'Buy'; // Priešinga pusė uždarymui
                const size = position.size;

                const orderResponse = await bybitClient.submitOrder({
                    category: 'linear',
                    symbol: ticker,
                    side: side,
                    orderType: 'Market',
                    qty: size,
                    reduceOnly: true, // **SVARBU**: Tik uždaro poziciją, neatidaro naujos
                    positionIdx: positionIdx,
                });

                if (orderResponse.retCode !== 0) {
                    throw new Error(`Bybit klaida uždarant poziciją: ${orderResponse.retMsg}`);
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
    const msg = `🚀 Bybit botas v3 (Reaktyvusis su Uždarymu) paleistas ir laukia signalų per http://0.0.0.0:${port}/webhook`;
    console.log(msg);
    await sendTelegramMessage(msg);
});
