require('dotenv').config();
const auth = require('../auth');

async function testGrid() {
    console.log('Logging in...');
    await auth.login(process.env.BRIGHTREE_USERNAME, process.env.BRIGHTREE_PASSWORD);
    
    console.log('Fetching grid...');
    const url = 'https://brightree.net/F1/01825/PulmRX/ARManagement/frmPrivateERNs.aspx';
    const dataRaw = process.env.BRIGHTREE_API_BODY;
    
    const client = auth.getClient();
    try {
        const response = await client.post(url, dataRaw, {
            headers: {
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-GB,en;q=0.5',
                'Cache-Control': 'max-age=0',
                'Connection': 'keep-alive',
                'Content-Type': 'application/x-www-form-urlencoded',
                'Origin': 'https://brightree.net',
                'Referer': 'https://brightree.net/F1/01825/PulmRX/ARManagement/frmPrivateERNs.aspx',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'same-origin',
                'Sec-Fetch-User': '?1',
                'Sec-GPC': '1',
                'Upgrade-Insecure-Requests': '1',
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
            },
            maxRedirects: 0
        });
        console.log('Grid fetched successfully. Status:', response.status);
    } catch (e) {
        if (e.response) {
            console.log('Grid fetch failed. Status:', e.response.status);
            console.log('Redirect Location:', e.response.headers.location);
        } else {
            console.log('Error:', e.message);
        }
    }
}

testGrid();
