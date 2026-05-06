require('dotenv').config();
const twilio = require('twilio');

// Initialize Twilio Client
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;

// Initialize the client only if credentials    are provided to avoid crashing on import
let client;
if (accountSid && authToken && accountSid !== 'your_account_sid_here') {
    client = twilio(accountSid, authToken);
} else {
    console.warn('⚠️ Twilio credentials missing or using placeholders. Please update the .env file.');
}

// Mock function to simulate scraping data from an API or DB
async function scrapeData() {
    console.log('Fetching data from API/DB...');
    // In the future, this is where you would use axios to fetch from an API
    // e.g. const response = await axios.get('https://api.example.com/data');

    // Simulating a network delay and returning mock data
    return new Promise((resolve) => {
        setTimeout(() => {
            resolve([
                // { id: 1, title: 'New Alert: Server Down', priority: 'High' },
                { id: 1, title: 'Daily Report Available', priority: 'Low' }
            ]);
        }, 1000);
    });
}

// Function to format the scraped data into a WhatsApp message string
function formatMessage(data) {
    let message = '*Scraped Data Update*\n\n';
    data.forEach(item => {
        message += `• *${item.title}* (Priority: ${item.priority})\n`;
    });
    return message;
}

// Function to send a WhatsApp message using Twilio
async function sendWhatsAppMessage(to, messageBody) {
    if (!client) {
        console.error(`Cannot send message to ${to} because Twilio client is not initialized.`);
        return;
    }

    try {
        const message = await client.messages.create({
            body: messageBody,
            from: process.env.TWILIO_WHATSAPP_NUMBER, // e.g., 'whatsapp:+14155238886'
            to: `whatsapp:${to}`
        });
        console.log(`Message sent to ${to} successfully! Message SID: ${message.sid}`);
    } catch (error) {
        console.error(`Failed to send message to ${to}:`, error.message);
    }
}

// Main execution block
async function main() {
    // List of recipient phone numbers (with country code, e.g., '+1234567890')
    const targetNumbers = [
        process.env.TEST_TARGET_NUMBER || '+1234567890'
    ];

    try {
        // 1. Scrape the data
        const scrapedData = await scrapeData();

        // 2. Format the message
        const messageBody = formatMessage(scrapedData);

        console.log('\nPrepared Message Body:\n----------------------\n' + messageBody + '----------------------\n');

        // 3. Send message to all target numbers
        for (const number of targetNumbers) {
            await sendWhatsAppMessage(number, messageBody);
        }

    } catch (error) {
        console.error('Error in main execution:', error);
    }
}

main();
