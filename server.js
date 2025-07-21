// index.js (v3.0 - Patobulinta versija su dinaminiu qtyStep ir detaliais pranešimais)

import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import { RestClientV5 } from 'bybit-api';
import { createClient } from 'redis';

// --- APLIKACIJOS, BYBIT IR REDIS KONFIGŪRACIJA ---
const app = express();
app.use(express.json());
const port = process.env.PORT || 3000;

const {
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHANNEL_ID,
    BYBIT_API_KEY,
    BYBIT_API_SECRET,
    FIXED_RISK_USD // Paimame rizikos dydį iš .env failo
} = process.env;

// Patikriname, ar yra nurodyti kritiškai svarbūs kintamieji
if (!BYBIT_API_KEY || !BYBIT_API_SECRET || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHANNEL_ID || !FIXED_RISK_USD) {
    console.error("❌ Trūksta būtinų .env kintamųjų. Patikrinkite BYBIT_API_KEY, BYBIT_API_SECRET, TELEGRAM_BOT_TOKEN, TELEGRAM_CHANNEL_ID, FIXED_RISK_USD");
    process.exit(1); // Sustabdome aplikaciją, jei trūksta konfigūracijos
}

const bybitClient = new RestClientV5({
    key: BYBIT_API_KEY,
    secret: BYBIT_API_SECRET,
    testnet: false,
});

const redisClient = createClient();
redisClient.on('error', err => console.error('❌ Redis Client Error', err));

// --- PAGALBINĖS FUNKCIJOS IR KINTAMIEJI ---

// Instrumentų informacijos talpykla (cache), kad nereikėtų kaskart kreiptis į Bybit API
const instrumentInfoCache = new Map();

/**
 * Gauna ir kešuoja prekybos instrumento taisykles (qtyStep, minOrderQty, tickSize).
 * @param {string} symbol - Prekybos poros simbolis, pvz., "BTCUSDT"
 * @returns {Promise<object|null>} Instrumento informacija arba null, jei nepavyko gauti.
 */
async function getInstrumentInfo(symbol) {
    if (instrumentInfoCache.has(symbol)) {
        return instrumentInfoCache.get(symbol);
    }
    try {
        console.log(`[${symbol}] Gaunama instrumento informacija iš Bybit...`);
        const response = await bybitClient.getInstrumentsInfo({
            category: 'linear',
            symbol: symbol,
        });

        if (response.retCode !== 0 || !response.result.list || response.result.list.length === 0) {
            throw new Error(`Nepavyko gauti instrumento ${symbol} informacijos: ${response.retMsg}`);
        }

        const info = response.result.list[0].lotSizeFilter;
        const priceInfo = response.result.list[0].priceFilter;
        const instrumentData = {
            qtyStep: parseFloat(info.qtyStep),
            minOrderQty: parseFloat(info.minOrderQty),
            tickSize: parseFloat(priceInfo.tickSize),
        };

        instrumentInfoCache.set(symbol, instrumentData);
        console.log(`[${symbol}] Informacija sėkmingai gauta ir išsaugota:`, instrumentData);
        return instrumentData;
    } catch (error) {
        console.error(`❌ Klaida gaunant instrumento ${symbol} informaciją:`, error.message);
        return null;
    }
}

/**
 * Formatuoja skaičių pagal nurodytą žingsnį (pvz., apvalina kainą arba kiekį).
 * @param {number} number - Formatuojamas skaičius.
 * @param {number} step - Apvalinimo žingsnis (pvz., 0.01).
 * @returns {string} Formatuotas skaičius kaip tekstinė eilutė.
 */
function formatByStep(number, step) {
    const decimals = (step.toString().split('.')[1] || []).length;
    return number.toFixed(decimals);
}

/**
 * Siunčia pranešimą į Telegram kanalą.
 * @param {string} message - Pranešimo tekstas (gali būti formatuotas su Markdown).
 */
const sendTelegramMessage = async (message) => {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHANNEL_ID) return;
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHANNEL_ID,
            text: message,
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
        });
    } catch (error) {
        console.error('Klaida siunčiant pranešimą į Telegram:', error.response?.data || error.message);
    }
};


// --- PAGRINDINIS WEBHOOK MARŠRUTAS ---
app.post('/webhook', async (req, res) => {
    console.log('\n--- Gaunamas signalas ---');
    const data = req.body;
    console.log('Gauti duomenys:', data);

    try {
        if (!data.action || !data.ticker) {
            // Ignoruojame alertus be veiksmo arba tikerio, pvz., testinius.
            return res.status(200).json({ status: 'ignored', message: 'Veiksmas arba ticker nenurodytas.' });
        }

        const ticker = data.ticker.replace('.P', '');
        const positionIdx = parseInt(data.positionIdx, 10);
        const redisKey = `${ticker}_${positionIdx}`;
        const side = data.direction === 'long' ? 'Buy' : 'Sell';

        switch (data.action) {

            // 1. Sukuriamas naujas sąlyginis orderis
            case 'NEW_PATTERN': {
                console.log(`[${ticker}] Vykdomas veiksmas: NEW_PATTERN`);
                
                const instrument = await getInstrumentInfo(ticker);
                if (!instrument) {
                    throw new Error(`Kritinė klaida: nepavyko gauti ${ticker} prekybos taisyklių. Sandoris atmetamas.`);
                }

                const entryPrice = parseFloat(data.entryPrice);
                const takeProfit = parseFloat(data.takeProfit);

                // Skaičiuojame SL pagal 1:2 R:R
                const profitDistance = Math.abs(takeProfit - entryPrice);
                const riskDistance = profitDistance / 2;
                const stopLoss = data.direction === 'long' ? entryPrice - riskDistance : entryPrice + riskDistance;

                // Pozicijos dydžio skaičiavimas
                const sl_percent = Math.abs(entryPrice - stopLoss) / entryPrice;
                if (sl_percent === 0) throw new Error('Stop Loss negali būti lygus įėjimo kainai.');
                
                const position_size_raw = parseFloat(FIXED_RISK_USD) / (entryPrice * sl_percent);
                
                // Kiekio (qty) formatavimas pagal instrumento taisykles
                const qty = formatByStep(position_size_raw, instrument.qtyStep);

                // Patikriname, ar dydis nėra per mažas
                if (parseFloat(qty) < instrument.minOrderQty) {
                    const errorMsg = `Apskaičiuotas kiekis (${qty}) yra mažesnis už minimalų leidžiamą (${instrument.minOrderQty}). Sandoris atmetamas.`;
                    await sendTelegramMessage(`⚠️ *ATMestas Sandoris* [${ticker}]\n\n*Priežastis:* Per mažas kiekis.\n*Info:* ${errorMsg}`);
                    throw new Error(errorMsg);
                }

                const order = {
                    category: 'linear',
                    symbol: ticker,
                    side: side,
                    orderType: 'Market',
                    qty: String(qty),
                    triggerPrice: formatByStep(entryPrice, instrument.tickSize),
                    triggerDirection: data.direction === 'long' ? 1 : 2,
                    positionIdx: positionIdx,
                };
                
                console.log('Pateikiamas sąlyginis orderis:', order);
                const orderResponse = await bybitClient.submitOrder(order);
                
                // Detalus pranešimas apie orderio rezultatą
                if (orderResponse.retCode === 0) {
                    const orderId = orderResponse.result.orderId;
                    await redisClient.set(redisKey, orderId);
                    
                    const positionValueUSD = parseFloat(qty) * entryPrice;
                    
                    const successMessage = `✅ *Pateiktas Sąlyginis Orderis*\n\n` +
                                           `*Pora:* \`${ticker}\`\n` +
                                           `*Kryptis:* ${data.direction.toUpperCase()}\n` +
                                           `*Rizika:* $${parseFloat(FIXED_RISK_USD).toFixed(2)}\n\n` +
                                           `*Įėjimas:* \`${order.triggerPrice}\`\n` +
                                           `*Stop Loss:* \`${formatByStep(stopLoss, instrument.tickSize)}\`\n` +
                                           `*Take Profit:* \`${formatByStep(takeProfit, instrument.tickSize)}\`\n\n` +
                                           `*Dydis:* \`${qty} ${ticker.replace('USDT', '')}\` (~$${positionValueUSD.toFixed(2)})\n` +
                                           `*Orderio ID:* \`${orderId}\``;
                    await sendTelegramMessage(successMessage);

                } else {
                    const errorMessage = `❌ *Orderis ATMestas*\n\n` +
                                         `*Pora:* \`${ticker}\`\n` +
                                         `*Kryptis:* ${data.direction.toUpperCase()}\n` +
                                         `*Bandytas Dydis:* \`${qty}\`\n\n` +
                                         `*Bybit Klaida (${orderResponse.retCode}):*\n` +
                                         `\`${orderResponse.retMsg}\``;
                    await sendTelegramMessage(errorMessage);
                    throw new Error(`Bybit klaida pateikiant orderį: ${orderResponse.retMsg}`);
                }
                break;
            }

            // 2. Anuliuojamas senas pattern'as ir atšaukiamas orderis
            case 'INVALIDATE_PATTERN': {
                console.log(`[${ticker}] Vykdomas veiksmas: INVALIDATE_PATTERN`);

                const orderId = await redisClient.get(redisKey);
                if (!orderId) {
                    console.log(`[${ticker}] Nerastas aktyvus sąlyginis orderis, kurį būtų galima atšaukti.`);
                    await sendTelegramMessage(`ℹ️ [${ticker}] Gautas INVALIDATE signalas, bet aktyvus sąlyginis orderis nerastas. Jokių veiksmų nesiimta.`);
                    break;
                }

                console.log(`[${ticker}] Atšaukiamas orderis su ID: ${orderId}`);
                const cancelResponse = await bybitClient.cancelOrder({ category: 'linear', symbol: ticker, orderId: orderId });

                if (cancelResponse.retCode === 0) {
                    await redisClient.del(redisKey);
                    await sendTelegramMessage(`🗑️ *Sąlyginis Orderis Atšauktas*\n\n*Pora:* \`${ticker}\`\n*Orderio ID:* \`${orderId}\``);
                } else {
                    // Jei nepavyksta atšaukti, gal orderis jau įvykdytas?
                    await sendTelegramMessage(`⚠️ *Klaida Atšaukiant Orderį*\n\n*Pora:* \`${ticker}\`\n*Orderio ID:* \`${orderId}\`\n*Bybit Atsakymas:* \`${cancelResponse.retMsg}\``);
                }
                break;
            }

            // 3. Įeinama į poziciją, nustatomas SL/TP
            case 'ENTERED_POSITION': {
                console.log(`[${ticker}] Vykdomas veiksmas: ENTERED_POSITION`);
                
                await redisClient.del(redisKey); // Ištriname iš Redis, nes orderis įvykdytas

                console.log(`[${ticker}] Nustatomas SL/TP...`);
                const setStopResponse = await bybitClient.setTradingStop({
                    category: 'linear',
                    symbol: ticker,
                    positionIdx: positionIdx,
                    stopLoss: String(data.stopLoss),
                    takeProfit: String(data.takeProfit)
                });

                if (setStopResponse.retCode === 0) {
                    await sendTelegramMessage(`▶️ *Pozicija Atidaryta ir Apsaugota*\n\n` +
                                              `*Pora:* \`${ticker}\`\n` +
                                              `*SL/TP Nustatytas:* Taip\n` +
                                              `*Stop Loss:* \`${data.stopLoss}\`\n` +
                                              `*Take Profit:* \`${data.takeProfit}\``);
                } else {
                     await sendTelegramMessage(`‼️ *KRITINĖ KLAIDA*\n\n` +
                                               `*Pora:* \`${ticker}\`\n` +
                                               `*Problema:* Pozicija atidaryta, BET nepavyko nustatyti SL/TP!\n` +
                                               `*Bybit Atsakymas:* \`${setStopResponse.retMsg}\`\n\n` +
                                               `*REIKALINGAS RANKINIS ĮSIKIŠIMAS!*`);
                }
                break;
            }

            // 4. UŽdaroma pozicija dėl laiko
            case 'CLOSE_BY_AGE': {
                console.log(`[${ticker}] Vykdomas veiksmas: CLOSE_BY_AGE`);
                
                const positions = await bybitClient.getPositionInfo({ category: 'linear', symbol: ticker });
                const position = positions.result.list.find(p => p.positionIdx === positionIdx && parseFloat(p.size) > 0);

                if (!position) {
                    await sendTelegramMessage(`ℹ️ [${ticker}] Gautas CLOSE_BY_AGE signalas, bet aktyvi pozicija nerasta.`);
                    break;
                }

                const closeResponse = await bybitClient.submitOrder({
                    category: 'linear',
                    symbol: ticker,
                    side: position.side === 'Buy' ? 'Sell' : 'Buy',
                    orderType: 'Market',
                    qty: position.size,
                    reduceOnly: true,
                    positionIdx: positionIdx,
                });

                if (closeResponse.retCode === 0) {
                    await sendTelegramMessage(`⏳ *Pozicija Uždaryta Dėl Laiko*\n\n*Pora:* \`${ticker}\`\n*Dydis:* \`${position.size}\``);
                } else {
                    await sendTelegramMessage(`⚠️ *Klaida Uždarant Pasenusią Poziciją*\n\n*Pora:* \`${ticker}\`\n*Bybit Atsakymas:* \`${closeResponse.retMsg}\``);
                }
                break;
            }

            default:
                console.log(`Gautas veiksmas '${data.action}', kuris yra ignoruojamas.`);
        }

        res.status(200).json({ status: 'success', message: `Veiksmas '${data.action}' apdorotas.` });

    } catch (error) {
        console.error('❌ KLAIDA APDOROJANT SIGNALĄ:', error.message);
        // Išsiunčiame bendrinę klaidos žinutę, jei įvyko netikėta klaida
        await sendTelegramMessage(`🆘 *Boto Vidinė Klaida*\n\n*Problema:* \`${error.message}\`\n*Gauti Duomenys:* \`${JSON.stringify(req.body)}\``);
        res.status(500).json({ status: 'error', error: error.message });
    }
});


// --- SERVERIO PALEIDIMAS ---
const startServer = async () => {
    try {
        await redisClient.connect();
        console.log("✅ Sėkmingai prisijungta prie Redis.");
        app.listen(port, '0.0.0.0', () => {
            const msg = `🚀 Bybit botas (v3.0 su dinaminiu qtyStep) paleistas ant porto ${port}`;
            console.log(msg);
            sendTelegramMessage(msg);
        });
    } catch (err) {
        console.error("❌ Kritinė klaida paleidžiant serverį arba jungiantis prie Redis:", err);
        process.exit(1);
    }
};

startServer();
