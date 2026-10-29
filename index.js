const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const QRCode = require('qrcode');
const axios = require('axios');
const pino = require('pino');

const app = express();
const PORT = process.env.PORT || 3000;

// Render-এর Environment Variable থেকে Google Sheet-এর লিংক নেবে
const GOOGLE_SHEET_URL = process.env.GOOGLE_SHEET_URL || 'YOUR_APPS_SCRIPT_WEB_APP_URL';

// ==========================================
// ১. এখানে আপনার অর্ডার গ্রুপের হুবহু নামগুলো দিন
// ==========================================
const ALLOWED_GROUPS = [
    'Order Group',       // আপনার গ্রুপের আসল নাম এখানে লিখুন
    'VIP Order Group'    // একাধিক গ্রুপ থাকলে কমা দিয়ে নিচে নিচে লিখুন
];

// অথবা গ্রুপের আইডি দিয়ে লক করতে চাইলে এখানে আইডি দিতে পারেন (ঐচ্ছিক)
const ALLOWED_GROUP_IDS = []; 

let qrCodeData = null;
let isConnected = false;

// ব্রাউজারে QR কোড দেখানোর ওয়েব পেজ
app.get('/', async (req, res) => {
    if (isConnected) {
        return res.send(`
            <div style="text-align:center;font-family:sans-serif;margin-top:50px;">
                <h2 style="color:green;">✅ WhatsApp Order Bot is Connected & Running 24/7!</h2>
                <p>Monitoring Groups: <b>${ALLOWED_GROUPS.join(', ')}</b></p>
            </div>
        `);
    }
    if (qrCodeData) {
        const qrImage = await QRCode.toDataURL(qrCodeData);
        return res.send(`
            <div style="text-align:center;font-family:sans-serif;margin-top:30px;">
                <h2>Scan QR Code from WhatsApp (Linked Devices)</h2>
                <img src="${qrImage}" style="width:300px;height:300px;border:2px solid #25D366;padding:10px;border-radius:10px;" />
                <p>স্ক্যান করার পর ৫ সেকেন্ড অপেক্ষা করে পেজটি Refresh দিন।</p>
            </div>
        `);
    }
    res.send('<h3 style="font-family:sans-serif;text-align:center;margin-top:50px;">⏳ QR Code তৈরি হচ্ছে... ৫ সেকেন্ড পর পেজটি Refresh দিন।</h3>');
});

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ['Order Automation Bot', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrCodeData = qr;
            isConnected = false;
            console.log('New QR Code generated! Visit your Render URL to scan.');
        }

        if (connection === 'close') {
            isConnected = false;
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                console.log('Reconnecting...');
                startBot();
            } else {
                console.log('Logged out. Please delete auth_info or redeploy to scan again.');
            }
        } else if (connection === 'open') {
            isConnected = true;
            qrCodeData = null;
            console.log('✅ WhatsApp Order Bot Connected Successfully!');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const remoteJid = msg.key.remoteJid;

        // শুধু গ্রুপের মেসেজ চেক করবে (@g.us মানে গ্রুপ)
        if (!remoteJid.endsWith('@g.us')) return;

        // মেসেজের টেক্সট বের করা (সাধারণ টেক্সট বা ক্যাপশন)
        const text = (
            msg.message.conversation || 
            msg.message.extendedTextMessage?.text || 
            msg.message.imageMessage?.caption || 
            ''
        ).trim();

        if (!text) return;

        // গ্রুপের নাম ও তথ্য বের করা
        let groupName = 'Unknown Group';
        try {
            const groupMetadata = await sock.groupMetadata(remoteJid);
            groupName = groupMetadata.subject;
        } catch (err) {
            console.error('Failed to fetch group metadata:', err.message);
        }

        // ====================================================
        // বিশেষ কমান্ড: যেকোনো গ্রুপে #groupid লিখলে নাম ও আইডি জানাবে
        // ====================================================
        if (text.toLowerCase() === '#groupid') {
            await sock.sendMessage(remoteJid, {
                text: `📌 *Group Info*\n*Name:* ${groupName}\n*Group ID:* \`${remoteJid}\``
            }, { quoted: msg });
            return;
        }

        // ====================================================
        // ২. চেক করবে এই গ্রুপটি আমাদের অনুমোদিত লিস্টে আছে কি না
        // ====================================================
        const isAllowedByName = ALLOWED_GROUPS.includes(groupName);
        const isAllowedById = ALLOWED_GROUP_IDS.includes(remoteJid);

        if (!isAllowedByName && !isAllowedById) {
            return; // অনুমোদিত গ্রুপ না হলে বট চুপচাপ ইগনোর করবে
        }

        // ====================================================
        // ৩. মেসেজের শুরুতে #order থাকলে ডাটাবেসে সেভ করবে
        // ====================================================
        if (text.toLowerCase().startsWith('#order')) {
            const senderName = msg.pushName || 'Unknown';
            const senderNumber = (msg.key.participant || '').split('@')[0];

            // প্রসেসিং শুরু হলে ঘড়ি (⏳) রিঅ্যাকশন দেবে
            await sock.sendMessage(remoteJid, { react: { text: '⏳', key: msg.key } });

            try {
                // Google Sheet-এ ডেটা পাঠানো
                await axios.post(GOOGLE_SHEET_URL, {
                    messageId: msg.key.id,
                    groupName: groupName,
                    senderName: senderName,
                    senderNumber: senderNumber,
                    rawMessage: text,
                    status: 'Unseen by Admin'
                });

                // সফল হলে মেসেজটি Seen করবে এবং টিক (✅) রিঅ্যাকশন দেবে
                // (ফোনে Unseen রাখতে চাইলে নিচের readMessages লাইনটির শুরুতে // দিয়ে রাখুন)
                await sock.readMessages([msg.key]);
                await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });

                // মেসেজটি মেনশন করে রিপ্লাই দেওয়া
                await sock.sendMessage(
                    remoteJid,
                    { text: `✅ ধন্যবাদ *${senderName}*! আপনার অর্ডারটি সফলভাবে ডাটাবেসে এন্ট্রি হয়েছে।` },
                    { quoted: msg }
                );

            } catch (err) {
                // কোনো সমস্যা হলে ❌ চিহ্ন দেবে এবং মেসেজটি ফোনে Unseen রেখে দেবে
                await sock.sendMessage(remoteJid, { react: { text: '❌', key: msg.key } });
                console.error('Google Sheet Error:', err.message);
            }
        }
    });
}

startBot();
