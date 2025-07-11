// server.js

// --- 1. SETUP ---
const express = require('express');
const cors = require('cors');

const app = express();
app.use(express.json()); // Middleware to parse JSON bodies from requests
app.use(cors());         // Middleware to allow cross-origin requests from Drednot.io

// --- 2. GAME CONFIGURATION AND DATA ---
// All of your game's core rules and data are stored here on the server.
const TAX_CHANGE_COOLDOWN = 3;
const TAX_LEVELS = { 'low': { income_per_10_pop: 0.5, happiness_effect: +1, label: "Low" }, 'normal': { income_per_10_pop: 1.0, happiness_effect: 0, label: "Normal" }, 'high': { income_per_10_pop: 1.5, happiness_effect: -2, label: "High" } };

const events = [
    { id: 'farmer_blight', petitioner: "A Farmer", text: (gs) => `Ruler, a blight's hit our fields! We need 50 gold for new seeds. You've got ${gs.treasury} in the bank.`, onYes: { text: "The farmers are grateful!", effects: { treasury: -50, happiness: +15 } }, onNo: { text: "The farmers despair.", effects: { happiness: -15, population: -10 } } },
    { id: 'traveling_circus', petitioner: "A Circus Ringleader", text: "For just 30 gold, my circus will put on a show for your whole kingdom!", onYes: { text: "The circus is a hit!", effects: { treasury: -30, happiness: +25 } }, onNo: { text: "The circus packs up and leaves.", effects: { happiness: -5 } } },
    { id: 'shady_merchant', petitioner: "A Shady Merchant", text: "Psst... you look like someone who appreciates an opportunity. 20 gold. Double it. Whaddya say?", onYes: { text: "The gamble pays off!", effects: { treasury: +20 } }, onNo: { text: "You pass. Probably for the best.", effects: { happiness: +5 } } },
    { id: 'goblin_raid', petitioner: "A Scout", text: (gs) => `Goblins are raiding the western farms! Our military strength is only ${gs.military}! We need to do something!`, onYes: { text: "You send the guards. They handle it.", effects: { military: -5, happiness: +10 } }, onNo: { text: "You do nothing. The goblins pillage freely.", effects: { happiness: -15, population: -10, treasury: -20 } } },
    { id: 'migrant_group', petitioner: "The Guard Captain", text: "A group of 20 migrants are at the gates. They're asking for a new home.", onYes: { text: "You welcome them. They seem like good people.", effects: { population: +20, happiness: +5 } }, onNo: { text: "You turn them away. It feels wrong.", effects: { happiness: -10 } } },
];

// --- 3. GAME STATE MANAGEMENT ---
// This object lives in the server's memory. It will be wiped if the server restarts.
let gameHub = {};

// NOTE: For true persistence, you would replace these functions with database calls (e.g., to Redis, PostgreSQL, or even just writing to a file).
function saveAllGames() {
    console.log("State changed. In a real app, this would save to a database.");
    // For example: fs.writeFileSync('./savegame.json', JSON.stringify(gameHub));
}
function loadAllGames() {
    console.log("Server started. In a real app, this would load from a database.");
    // For example: if (fs.existsSync('./savegame.json')) { gameHub = JSON.parse(fs.readFileSync('./savegame.json')); }
}

// --- 4. CORE GAME LOGIC FUNCTIONS ---
// These are your functions from the userscript, refactored to return an array of replies.

function createKingdom(playerName) {
    let replies = [];
    if (gameHub[playerName] && gameHub[playerName].gameActive) {
        replies.push(`${playerName}, you already have a kingdom. Use !kdestroy to end it.`);
        return replies;
    }
    gameHub[playerName] = {
        day: 0, treasury: 100, happiness: 50, population: 100, military: 10,
        taxRate: 'normal', taxChangeCooldown: 0,
        gameActive: true, isAwaitingDecision: false, currentEvent: null,
        eventDeck: [...events], playerName: playerName
    };
    shuffleDeckForPlayer(playerName);
    replies.push(`${playerName}'s kingdom has been created!`);
    replies.push(`When you're ready for your first event, type !chat`);
    saveAllGames();
    return replies;
}

function destroyKingdom(playerName, reason) {
    let replies = [];
    const playerState = gameHub[playerName];
    if (!playerState || !playerState.gameActive) return replies;
    replies.push(`--- ${playerState.playerName}'s reign has ended after ${playerState.day} days. ---`);
    replies.push(`Reason: ${reason}`);
    delete gameHub[playerName];
    saveAllGames();
    return replies;
}

function shuffleDeckForPlayer(playerName) {
    const playerState = gameHub[playerName];
    if (!playerState) return;
    for (let i = playerState.eventDeck.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[playerState.eventDeck[i], playerState.eventDeck[j]] = [playerState.eventDeck[j], playerState.eventDeck[i]]; }
}

function requestNextChat(playerName) {
    let replies = [];
    const playerState = gameHub[playerName];
    if (!playerState || !playerState.gameActive) {
        replies.push(`${playerName}, you don't have a kingdom. Type !kcreate to start.`);
        return replies;
    }
    if (playerState.isAwaitingDecision) {
        replies.push(`${playerName}, you need to respond to your current event first! (!yes or !no)`);
        return replies;
    }
    playerState.day++;
    if (playerState.taxChangeCooldown > 0) playerState.taxChangeCooldown--;
    const oldHappiness = playerState.happiness;
    const currentTaxLevel = TAX_LEVELS[playerState.taxRate];
    if (currentTaxLevel.happiness_effect !== 0) {
        playerState.happiness += currentTaxLevel.happiness_effect;
        replies.push(`${playerName}, your tax policy affects your people's happiness... ${formatStatChange('happiness', oldHappiness, playerState.happiness)}`);
    }
    if (playerState.treasury < 0) return destroyKingdom(playerName, "The kingdom is bankrupt!");
    if (playerState.happiness <= 0) return destroyKingdom(playerName, "The people have revolted!");

    if (playerState.eventDeck.length === 0) shuffleDeckForPlayer(playerName);
    const chosenEvent = playerState.eventDeck.pop();
    playerState.currentEvent = chosenEvent;
    playerState.isAwaitingDecision = true;
    const eventText = typeof chosenEvent.text === 'function' ? chosenEvent.text(playerState) : chosenEvent.text;
    replies.push(`--- ${playerState.playerName}'s Kingdom, Day ${playerState.day} ---`);
    replies.push(`${chosenEvent.petitioner} wants to talk.`);
    replies.push(`"${eventText}"`);
    replies.push("What do you say? (!yes / !no)");
    saveAllGames();
    return replies;
}

function handleDecision(playerName, choice) {
    let replies = [];
    const playerState = gameHub[playerName];
    if (!playerState || !playerState.gameActive || !playerState.isAwaitingDecision) return replies;
    playerState.isAwaitingDecision = false;
    const decisionKey = (choice === '!yes') ? 'onYes' : 'onNo';
    const chosenOutcome = playerState.currentEvent[decisionKey];
    const oldStats = { ...playerState };
    if (chosenOutcome.effects) {
        for (const stat in chosenOutcome.effects) { playerState[stat] += chosenOutcome.effects[stat]; }
    }
    replies.push(`${playerName}, ${chosenOutcome.text}`);
    let statusChanges = [];
    if (chosenOutcome.effects) {
        for (const stat in chosenOutcome.effects) { if (oldStats.hasOwnProperty(stat)) statusChanges.push(formatStatChange(stat, oldStats[stat], playerState[stat])); }
    }
    if (statusChanges.length > 0) replies.push(statusChanges.join(' | '));
    saveAllGames();
    return replies;
}

function handleSetTax(playerName, newRate) {
    let replies = [];
    const playerState = gameHub[playerName];
    if (!playerState || !playerState.gameActive) return replies;
    if (!newRate || !TAX_LEVELS[newRate]) { replies.push(`${playerName}, invalid tax rate. Choose from: low, normal, high.`); return replies; }
    if (playerState.taxRate === newRate) { replies.push(`${playerName}, your tax rate is already ${newRate}.`); return replies; }
    if (playerState.taxChangeCooldown > 0) { replies.push(`${playerName}, you can't change taxes for ${playerState.taxChangeCooldown} more day(s).`); return replies; }
    playerState.taxRate = newRate;
    playerState.taxChangeCooldown = TAX_CHANGE_COOLDOWN;
    replies.push(`${playerName}, your kingdom's tax rate is now ${TAX_LEVELS[newRate].label}.`);
    saveAllGames();
    return replies;
}

function formatStatChange(stat, oldValue, newValue) {
    const symbols = { treasury: '💰', happiness: '😊', population: '👨‍👩‍👧‍👦', military: '🛡️' };
    return `${symbols[stat]} ${oldValue} ➞ ${newValue}`;
}

function showStatus(playerName) {
    const playerState = gameHub[playerName];
    if (!playerState || !playerState.gameActive) { return [`${playerName}, you don't have a kingdom. Type !kcreate to begin.`]; }
    return [
        `--- ${playerState.playerName}'s Kingdom Status (Day ${playerState.day}) ---`,
        `💰 Treasury: ${playerState.treasury}`, `😊 Happiness: ${playerState.happiness}`,
        `👨‍👩‍👧‍👦 Population: ${playerState.population}`, `🛡️ Military: ${playerState.military}`,
        `⚖️ Tax Rate: ${TAX_LEVELS[playerState.taxRate].label}`
    ];
}

function showHelp() {
    return [
        "--- Kingdom Chat Help ---",
        "!kcreate: Create your own personal kingdom.",
        "!chat: Talk to the next person waiting. This moves time forward one day.",
        "!yes / !no: Respond to the person you're talking to.",
        "!status: Shows the full status of your kingdom.",
        "!kdestroy: Abdicate the throne and end your game."
    ];
}

// --- 5. THE API ENDPOINT ---
app.post('/command', (req, res) => {
    const { playerName, command, args } = req.body;
    if (!playerName || !command) {
        return res.status(400).json({ error: "Missing playerName or command" });
    }
    console.log(`[API] Received command: ${command} from ${playerName} with args: ${args.join(' ')}`);
    
    let replies = [];

    switch (command) {
        case '!kcreate':    replies = createKingdom(playerName); break;
        case '!kdestroy':   replies = destroyKingdom(playerName, "You have abdicated the throne."); break;
        case '!chat':       replies = requestNextChat(playerName); break;
        case '!yes':
        case '!no':         replies = handleDecision(playerName, command); break;
        case '!status':     replies = showStatus(playerName); break;
        case '!help':       replies = showHelp(); break;
        case '!settax':     replies = handleSetTax(playerName, args[0]); break;
        default: break; // Do nothing for unknown commands
    }

    // Send the array of replies back to the Tampermonkey client
    res.json({ replies });
});

// --- 6. SERVER STARTUP ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Kingdom Chat server listening on port ${PORT}`);
    loadAllGames();
});
