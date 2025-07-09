const puppeteer = require('puppeteer');

// --- Configuration ---
const DREDNOT_URL = 'https://drednot.io/invite/elFrrxDttMHVZa5UK25jT6Sk'; // You can change this to a specific server URL if you want
const BOT_NAME = 'SortTheChatBot'; // The name the bot will try to use

// This is our main function that runs the bot
async function runBot() {
    console.log('Launching the bot...');

    // Launch a new browser instance.
    // 'headless: false' is VERY useful for debugging, as it opens a visible Chrome window.
    // Once you're sure it works, you can change this to 'true'.
    const browser = await puppeteer.launch({
        headless: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox'] // Good practice for compatibility
    });

    // Open a new page (like a new tab)
    const page = await browser.newPage();

    // --- Navigation and Setup ---
    console.log(`Navigating to ${DREDNOT_URL}`);
    await page.goto(DREDNOT_URL, { waitUntil: 'networkidle2' }); // Wait until the page is mostly loaded

    console.log('Page loaded. Setting up the bot...');

    // Wait for the name input field to appear, then type the bot's name
    await page.waitForSelector('#name-input');
    await page.type('#name-input', BOT_NAME, { delay: 100 }); // Typing with a small delay looks more natural

    // Click the play button (we use a more robust selector)
    await page.click('button.green');

    // Wait for the chat to be ready
    await page.waitForSelector('#chat-input', { timeout: 60000 });
    console.log('Bot has joined the game and chat is ready!');


    // --- The Bot's "Mouth": A function for sending messages ---
    async function sendChatMessage(message) {
        console.log(`Sending message: "${message}"`);
        await page.type('#chat-input', message);
        await page.click('#chat-send');
        // A small delay to prevent being rate-limited by the game
        await page.waitForTimeout(1000);
    }

    
    // --- The Bot's "Ears": A function to handle commands from chat ---
    // This function will run in our Node.js environment.
    // We will "expose" it to the browser so the browser can call it.
    const handleChatCommand = (fullMessage) => {
        const colonIdx = fullMessage.indexOf(':');
        if (colonIdx === -1) return; // Not a standard chat message

        const player = fullMessage.substring(0, colonIdx).trim();
        const command = fullMessage.substring(colonIdx + 1).trim().toLowerCase().split(' ')[0];
        
        // This is our simple test logic.
        // Later, this will be replaced with a call to our game server.
        if (command === '!ping') {
            console.log(`Received !ping from ${player}. Responding...`);
            // Call our "Mouth" function to reply
            sendChatMessage(`Pong, ${player}!`);
        }
        
        if (command === '!help') {
             sendChatMessage(`I am a bot! Right now, I only respond to !ping.`);
        }
    };

    // Use page.exposeFunction to make our Node.js function available inside the browser
    await page.exposeFunction('onNewChatMessage', handleChatCommand);


    // --- The Listening Mechanism: Use a MutationObserver inside the browser ---
    // This is the most reliable way to watch for new elements being added to the chat.
    await page.evaluate(() => {
        const chatContent = document.getElementById("chat-content");

        // The MutationObserver API is a standard browser feature
        const observer = new MutationObserver(mutations => {
            mutations.forEach(mutation => {
                mutation.addedNodes.forEach(node => {
                    // We only care about new <p> (paragraph) elements being added
                    if (node.nodeType === 1 && node.tagName === "P") {
                        // When a new message appears, call the function we exposed from Node.js
                        window.onNewChatMessage(node.textContent || "");
                    }
                });
            });
        });

        // Tell the observer to watch the chat for new child elements
        observer.observe(chatContent, { childList: true });
    });

    console.log('✅ Bot is now online and listening for commands like !ping');
    await sendChatMessage("Hello! I am the Sort the Chat bot, ready for duty. Type !ping to test me.");
}

// Start the bot and catch any fatal errors
runBot().catch(error => {
    console.error("A critical error occurred:", error);
    process.exit(1);
});
