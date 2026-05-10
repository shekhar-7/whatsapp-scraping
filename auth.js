const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const axios = require('axios');
const cheerio = require('cheerio');

class BrightreeAuth {
    constructor() {
        this.jar = new CookieJar();
        this.client = wrapper(axios.create({
            jar: this.jar,
            withCredentials: true,
            maxRedirects: 10,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36'
            }
        }));
        this.isAuthenticated = false;
        this.isAuthenticating = false;
    }

    /**
     * Get the authenticated axios client.
     */
    getClient() {
        return this.client;
    }

    /**
     * Check if the client currently has a valid session ID cookie.
     */
    async checkSession() {
        const cookies = await this.jar.getCookies('https://brightree.net');
        const hasSession = cookies.some(c => c.key === 'PROD.BT-SID');
        this.isAuthenticated = hasSession;
        return hasSession;
    }

    /**
     * Perform the full OIDC login flow.
     */
    async login(username, password) {
        if (this.isAuthenticating) {
            // Prevent multiple concurrent login attempts
            return;
        }
        
        if (!username || !password) {
            throw new Error('Missing Brightree username or password in .env');
        }

        this.isAuthenticating = true;
        console.log('[auth] Starting automated login sequence...');

        try {
            // 1. Hit main application to trigger OIDC redirect
            let res = await this.client.get('https://brightree.net/F1/01825/PulmRX/Default.aspx');
            
            if (!res.request.res.responseUrl.includes('login.brightree.net')) {
                // Already logged in, or redirect didn't happen
                if (await this.checkSession()) {
                    console.log('[auth] Already authenticated.');
                    return;
                }
                throw new Error('Did not redirect to login page. Unexpected flow.');
            }

            // 2. Parse the login page for tokens
            const $ = cheerio.load(res.data);
            const requestVerificationToken = $('input[name="__RequestVerificationToken"]').val();
            const returnUrl = $('input[name="ReturnUrl"]').val() || new URL(res.request.res.responseUrl).searchParams.get('ReturnUrl');

            if (!requestVerificationToken) {
                throw new Error('Could not find __RequestVerificationToken on login page.');
            }

            // 3. Submit credentials to the login endpoint
            const loginData = new URLSearchParams();
            loginData.append('Username', username);
            loginData.append('Password', password);
            loginData.append('__RequestVerificationToken', requestVerificationToken);
            loginData.append('ReturnUrl', returnUrl || '');
            loginData.append('ScreenResolution', '1680x1050');
            loginData.append('NonceTimeoutSeconds', '3540');

            res = await this.client.post(res.request.res.responseUrl, loginData.toString(), {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Referer': res.request.res.responseUrl
                }
            });

            // 4. Extract OIDC form and post to brightree.net
            const $form = cheerio.load(res.data);
            const action = $form('form').attr('action');
            
            if (action && action.includes('signin-oidc')) {
                const oidcData = new URLSearchParams();
                $form('input[type="hidden"]').each((_, el) => {
                    oidcData.append($form(el).attr('name'), $form(el).attr('value'));
                });

                try {
                    res = await this.client.post(action, oidcData.toString(), {
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded',
                            'Referer': res.request.res.responseUrl
                        },
                        maxRedirects: 0 // Do not load the heavy dashboard immediately
                    });
                } catch (e) {
                    // Axios throws on 302 if maxRedirects is 0, this is expected
                    if (e.response && e.response.status >= 300 && e.response.status < 400) {
                        res = e.response;
                    } else {
                        throw e;
                    }
                }
                
                if (await this.checkSession()) {
                    console.log('[auth] Successfully authenticated and generated session cookies.');
                } else {
                    throw new Error('OIDC sign-in completed but session cookies were not found.');
                }
            } else {
                throw new Error('Did not find signin-oidc form. Invalid credentials?');
            }

        } finally {
            this.isAuthenticating = false;
        }
    }
}

module.exports = new BrightreeAuth();
