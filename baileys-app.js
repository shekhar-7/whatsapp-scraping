require('dotenv').config();
const qrcode = require('qrcode-terminal');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason
} = require('@whiskeysockets/baileys');

const P = require('pino');

let isConnecting = false;

// Mock function to simulate scraping data from an API or DB
async function scrapeData() {

    console.log('Fetching data from API/DB...');

    return new Promise((resolve) => {

        setTimeout(() => {

            resolve([
                {
                    id: 1,
                    title: 'Daily Report Available',
                    priority: 'Low'
                }
            ]);

        }, 1000);
    });
}

// Format message
function formatMessage(data) {

    let message = '*Scraped Data Update*\n\n';

    data.forEach(item => {
        message += `• *${item.title}* (Priority: ${item.priority})\n`;
    });

    return message;
}

// Convert number to WhatsApp JID
function formatNumber(number) {
    return number.replace(/\D/g, '') + '@s.whatsapp.net';
}

// Send message
async function sendWhatsAppMessage(sock, to, messageBody) {

    try {

        const jid = formatNumber(to);

        const response = await sock.sendMessage(jid, {
            text: messageBody
        });

        console.log(
            JSON.stringify(
                {
                    success: true,
                    to,
                    jid,
                    response
                },
                null,
                2
            )
        );

    } catch (error) {

        console.error(
            JSON.stringify(
                {
                    success: false,
                    to,
                    error: error.message
                },
                null,
                2
            )
        );
    }
}

// Main function
async function startBot() {

    if (isConnecting) return;

    isConnecting = true;

    try {

        const targetNumbers = [
            process.env.TEST_TARGET_NUMBER || '+919876543210'
        ];

        // Auth state
        const { state, saveCreds } =
            await useMultiFileAuthState('./auth');

        // Latest WA version
        const { version } =
            await fetchLatestBaileysVersion();

        console.log('Using WA Version:', version);

        // Create socket
        const sock = makeWASocket({

            version,

            auth: state,

            logger: P({
                level: 'silent'
            }),

            browser: ['Ubuntu', 'Chrome', '20.0.04']
        });

        // Save creds
        sock.ev.on('creds.update', saveCreds);

        // Connection updates
        sock.ev.on(
            'connection.update',
            async (update) => {

                const {
                    connection,
                    lastDisconnect,
                    qr
                } = update;

                // QR code
                if (qr) {

                    console.log('\nScan this QR using WhatsApp:\n');

                    qrcode.generate(qr, {
                        small: true
                    });
                }

                // Connected
                if (connection === 'open') {

                    console.log(
                        '\n✅ WhatsApp connected successfully\n'
                    );

                    try {

                        // Scrape data
                        const scrapedData =
                            await scrapeData();

                        // Format message
                        const messageBody =
                            formatMessage(scrapedData);

                        console.log(
                            '\nPrepared Message Body:\n----------------------\n' +
                            messageBody +
                            '----------------------\n'
                        );

                        // Send messages
                        for (const number of targetNumbers) {

                            await sendWhatsAppMessage(
                                sock,
                                number,
                                messageBody
                            );
                        }

                    } catch (error) {

                        console.error(
                            'Error in execution:',
                            error
                        );
                    }
                }

                // Disconnected
                if (connection === 'close') {

                    isConnecting = false;

                    const error =
                        lastDisconnect?.error;

                    const statusCode =
                        error?.output?.statusCode;

                    console.log(
                        '\n❌ Connection closed'
                    );

                    console.log(
                        JSON.stringify(
                            {
                                statusCode,
                                error: error?.message,
                                data: error?.output
                            },
                            null,
                            2
                        )
                    );

                    const shouldReconnect =
                        statusCode !==
                        DisconnectReason.loggedOut;

                    if (shouldReconnect) {

                        console.log(
                            '\n🔄 Reconnecting in 5 seconds...\n'
                        );

                        setTimeout(() => {
                            startBot();
                        }, 5000);

                    } else {

                        console.log(
                            '\n🚪 Logged out from WhatsApp\n'
                        );
                    }
                }
            }
        );

    } catch (error) {

        isConnecting = false;

        console.error(
            '\nFatal Error:',
            error
        );

        setTimeout(() => {
            startBot();
        }, 5000);
    }
}

startBot();