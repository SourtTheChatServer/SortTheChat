// server.js

// --- CHANGE LOG ---
// 1. FIXED: Tax income is now correctly calculated and added to the treasury each day.
//    - The logic now uses `income_per_10_pop` from the `TAX_LEVELS` object.
// 2. IMPLEMENTED: The Treasurer advisor's 10% tax bonus is now functional.
//    - The tax income calculation checks if the treasurer is hired and applies the bonus.
// 3. RESTRUCTURED: The daily upkeep logic in `requestNextChat` has been reordered
//    and commented for better clarity (Income -> Expenses).
// --- END CHANGE LOG ---


// --- 1. SETUP & IMPORTS ---
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

// Assuming gameData.js is in the same directory and is complete
const {
    TAX_LEVELS, REVOLT_HAPPINESS_THRESHOLD, SEASON_LENGTH, SEASONS, ADVISORS, allEvents, eventsMap
} = require('./gameData');

// --- 2. MONGOOSE SCHEMA DEFINITION ---
const KingdomSchema = new mongoose.Schema({
    _id: { type: String, required: true }, // Player's name
    day: { type: Number, default: 0 },
    treasury: { type: Number, default: 100 },
    happiness: { type: Number, default: 50 },
    population: { type: Number, default: 100 },
    military: { type: Number, default: 10 },
    taxRate: { type: String, default: 'normal' },
    taxChangeCooldown: { type: Number, default: 0 },
    season: { type: String, default: 'Spring' },
    dayOfSeason: { type: Number, default: 1 },
    advisors: { type: Map, of: Boolean, default: () => new Map() },
    gameActive: { type: Boolean, default: true },
    isAwaitingDecision: { type: Boolean, default: false },
    currentEventId: { type: String, default: null },
    pendingAction: {
        type: {
            action: String,
            expires: Date
        },
        default: null
    }
});
const Kingdom = mongoose.model('Kingdom', KingdomSchema);

const app = express();
app.use(express.json());
app.use(cors());

// --- 3. DATABASE CONNECTION ---
const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
    console.error("FATAL ERROR: MONGO_URI environment variable is not set.");
    process.exit(1);
}
mongoose.connect(MONGO_URI)
    .then(() => console.log("MongoDB connected successfully."))
    .catch(err => console.error("MongoDB connection error:", err));


// --- 4. CORE GAME LOGIC FUNCTIONS (ASYNC) ---

async function createKingdom(playerName) {
    const existingKingdom = await Kingdom.findById(playerName);

    if (existingKingdom && existingKingdom.gameActive) {
        const expirationTime = new Date(Date.now() + 30000);
        existingKingdom.pendingAction = {
            action: 'confirm_reset',
            expires: expirationTime
        };
        await existingKingdom.save();

        setTimeout(async () => {
            const freshState = await Kingdom.findById(playerName);
            if (freshState && freshState.pendingAction && freshState.pendingAction.action === 'confirm_reset' && new Date() > freshState.pendingAction.expires) {
                freshState.pendingAction = null;
                await freshState.save();
            }
        }, 31000);

        return [
            `${playerName}, you already have a kingdom in progress.`,
            `Are you sure you want to restart? This will ERASE your current game.`,
            `Respond with !y (yes) or !n (no) within 30 seconds.`
        ];
    }

    await Kingdom.findByIdAndUpdate(playerName, {
        _id: playerName, day: 0, treasury: 100, happiness: 50, population: 100, military: 10, taxRate: 'normal',
        taxChangeCooldown: 0, season: 'Spring', dayOfSeason: 1, advisors: new Map(), gameActive: true,
        isAwaitingDecision: false, currentEventId: null, pendingAction: null
    }, { upsert: true, new: true });

    return [`${playerName}'s kingdom has been created!`, `Type !chat for your first event.`];
}

async function handleConfirmation(playerName, choice) {
    const playerState = await Kingdom.findById(playerName);

    if (!playerState || !playerState.pendingAction || new Date() > playerState.pendingAction.expires) {
        return [`${playerName}, you have no pending action to confirm, or the confirmation window has expired.`];
    }

    const action = playerState.pendingAction.action;
    playerState.pendingAction = null;

    if (action === 'confirm_reset') {
        if (choice === '!y') {
            playerState.day = 0;
            playerState.treasury = 100;
            playerState.happiness = 50;
            playerState.population = 100;
            playerState.military = 10;
            playerState.taxRate = 'normal';
            playerState.taxChangeCooldown = 0;
            playerState.season = 'Spring';
            playerState.dayOfSeason = 1;
            playerState.advisors = new Map();
            playerState.gameActive = true;
            playerState.isAwaitingDecision = false;
            playerState.currentEventId = null;

            await playerState.save();
            return [`${playerName}'s kingdom has been reset.`];
        } else {
            await playerState.save();
            return [`${playerName}, restart cancelled. Your kingdom is safe.`];
        }
    }
    await playerState.save();
    return [];
}

async function destroyKingdom(playerName, reason) {
    const kingdom = await Kingdom.findById(playerName);
    if (!kingdom || !kingdom.gameActive) return [];
    kingdom.gameActive = false;
    await kingdom.save();
    return [`--- ${playerName}'s reign has ended after ${kingdom.day} days. ---`, `Reason: ${reason}`];
}


// --- FUNCTION WITH UPDATED TAX LOGIC ---
async function requestNextChat(playerName) {
    const playerState = await Kingdom.findById(playerName);
    if (!playerState || !playerState.gameActive) return [`${playerName}, you don't have a kingdom. Type !kcreate to start.`];
    if (playerState.isAwaitingDecision) return [`${playerName}, you need to respond to your current event first! (!yes or !no)`];
    if (playerState.pendingAction) return [`${playerName}, you must first respond to your pending confirmation (!y or !n).`];

    const replies = [];
    const oldStats = { ...playerState.toObject() };

    // --- Daily Time Progression ---
    playerState.day++;
    if (playerState.taxChangeCooldown > 0) playerState.taxChangeCooldown--;
    playerState.dayOfSeason++;

    // --- Daily Upkeep & Income Calculations ---

    // 1. Handle Season Change & Apply Daily Season Effects
    if (playerState.dayOfSeason > SEASON_LENGTH) {
        playerState.dayOfSeason = 1;
        const seasonNames = Object.keys(SEASONS);
        playerState.season = seasonNames[(seasonNames.indexOf(playerState.season) + 1) % seasonNames.length];
        replies.push(`A new season has begun in ${playerName}'s kingdom: ${playerState.season}!`);
    }
    const seasonEffect = SEASONS[playerState.season].effects;
    for (const stat in seasonEffect) playerState[stat] += seasonEffect[stat];

    // 2. Calculate and Apply Tax Effects (Income & Happiness) - THIS IS THE CORRECTED LOGIC
    const taxInfo = TAX_LEVELS[playerState.taxRate];
    if (taxInfo) {
        // Calculate income, including the Treasurer's 10% bonus if hired
        const treasurerBonus = playerState.advisors.get('treasurer') ? 1.10 : 1.0;
        const taxIncome = Math.floor((playerState.population / 10) * taxInfo.income_per_10_pop * treasurerBonus);
        playerState.treasury += taxIncome;

        // Apply happiness effect
        if (taxInfo.happiness_effect !== 0) {
            playerState.happiness += taxInfo.happiness_effect;
        }
    }

    // 3. Calculate and Apply Advisor Upkeep (Salaries & Passive Effects)
    let totalSalary = 0;
    if (playerState.advisors) {
        for (const [advisorKey, isHired] of playerState.advisors) {
            if (isHired) {
                const advisor = ADVISORS[advisorKey];
                if (advisor.upkeep.salary) totalSalary += advisor.upkeep.salary;
                if (advisor.upkeep.effects) {
                    for (const stat in advisor.upkeep.effects) playerState[stat] += advisor.upkeep.effects[stat];
                }
            }
        }
    }
    playerState.treasury -= totalSalary;

    // --- Generate Reports & Check Game Over Conditions ---
    let upkeepReport = [];
    if (playerState.happiness !== oldStats.happiness) upkeepReport.push(formatStatChange('happiness', oldStats.happiness, playerState.happiness));
    if (playerState.population !== oldStats.population) upkeepReport.push(formatStatChange('population', oldStats.population, playerState.population));
    if (playerState.treasury !== oldStats.treasury) upkeepReport.push(formatStatChange('treasury', oldStats.treasury, playerState.treasury));
    if (playerState.military !== oldStats.military) upkeepReport.push(formatStatChange('military', oldStats.military, playerState.military));
    if (upkeepReport.length > 0) replies.push(`Daily changes for ${playerName}: ${upkeepReport.join(' | ')}`);

    if (playerState.treasury < 0) return destroyKingdom(playerName, "The kingdom is bankrupt!");
    if (playerState.happiness <= REVOLT_HAPPINESS_THRESHOLD && playerState.taxRate !== 'low') {
        replies.push(`[!] WARNING: Happiness in ${playerName}'s kingdom is critically low!`);
        playerState.happiness -= 2;
    }
    if (playerState.happiness <= 0) return destroyKingdom(playerName, "The people have revolted!");

    // --- Select and Present a New Event ---
    const availableEvents = allEvents.filter(e => {
        const condition = e.condition ? e.condition(playerState) : true;
        const seasonCondition = e.season ? e.season === playerState.season : true;
        let advisorCondition = true;
        if (e.advisor) advisorCondition = playerState.advisors.get(e.advisor);
        else if (e.requiresNoAdvisor) advisorCondition = !playerState.advisors.get(e.requiresNoAdvisor);
        return condition && seasonCondition && advisorCondition;
    });
    const chosenEvent = availableEvents[Math.floor(Math.random() * availableEvents.length)];
    if (!chosenEvent) {
        replies.push("The kingdom is quiet today. No one has come to petition the throne.");
        await playerState.save();
        return replies;
    }
    playerState.currentEventId = chosenEvent.id;
    playerState.isAwaitingDecision = true;
    await playerState.save();

    const petitioner = typeof chosenEvent.petitioner === 'function' ? chosenEvent.petitioner() : chosenEvent.petitioner;
    const eventText = typeof chosenEvent.text === 'function' ? chosenEvent.text(playerState) : chosenEvent.text;
    replies.push(`--- ${playerName}'s Kingdom, Day ${playerState.day} ---`);
    replies.push(`${petitioner} wants to talk.`);
    replies.push(`"${eventText}"`);
    replies.push("What do you say? (!yes / !no)");
    return replies;
}


async function handleDecision(playerName, choice) {
    const playerState = await Kingdom.findById(playerName);
    if (!playerState || !playerState.gameActive || !playerState.isAwaitingDecision) return [];
    if (playerState.pendingAction) return [`${playerName}, you must first respond to your pending confirmation (!y or !n).`];
    const currentEvent = eventsMap.get(playerState.currentEventId);
    if (!currentEvent) {
        playerState.isAwaitingDecision = false; await playerState.save();
        return ["An error occurred with your current event. Type !chat to continue."];
    }
    const oldStats = { ...playerState.toObject() };
    const decisionKey = (choice === '!yes') ? 'onYes' : 'onNo';
    const chosenOutcome = currentEvent[decisionKey];
    if (chosenOutcome.effects) {
        for (const stat in chosenOutcome.effects) {
            if (playerState[stat] !== undefined) playerState[stat] += chosenOutcome.effects[stat];
        }
    }
    if (chosenOutcome.onSuccess) { chosenOutcome.onSuccess(playerState); }
    playerState.isAwaitingDecision = false;
    playerState.currentEventId = null;
    await playerState.save();
    const replies = [`${playerName}, ${chosenOutcome.text}`];
    let statusChanges = [];
    if (chosenOutcome.effects) {
        for (const stat in chosenOutcome.effects) {
            if (oldStats.hasOwnProperty(stat)) statusChanges.push(formatStatChange(stat, oldStats[stat], playerState[stat]));
        }
    }
    if (statusChanges.length > 0) replies.push(statusChanges.join(' | '));
    return replies;
}

async function handleSetTax(playerName, newRate) {
    const playerState = await Kingdom.findById(playerName);
    if (!playerState || !playerState.gameActive) return [];
    if (!newRate || !TAX_LEVELS[newRate]) return [`${playerName}, invalid tax rate. Choose from: low, normal, high.`];
    if (playerState.taxRate === newRate) return [`${playerName}, your tax rate is already ${newRate}.`];
    if (playerState.taxChangeCooldown > 0) return [`${playerName}, you can't change taxes for ${playerState.taxChangeCooldown} more day(s).`];
    playerState.taxRate = newRate;
    playerState.taxChangeCooldown = 3;
    await playerState.save();
    return [`${playerName}, your kingdom's tax rate is now ${TAX_LEVELS[newRate].label}.`];
}

function formatStatChange(stat, oldValue, newValue) {
    const symbols = { treasury: '💰', happiness: '😊', population: '👨‍👩‍👧‍👦', military: '🛡️' };
    return `${symbols[stat]} ${oldValue} ➞ ${newValue}`;
}

async function showStatus(playerName) {
    const playerState = await Kingdom.findById(playerName);
    if (!playerState || !playerState.gameActive) return [`${playerName}, you don't have a kingdom. Type !kcreate to begin.`];
    let advisorList = 'None';
    if (playerState.advisors && playerState.advisors.size > 0) {
        const hiredAdvisors = [];
        for (const [key, isHired] of playerState.advisors.entries()) {
            if (isHired) {
                hiredAdvisors.push(ADVISORS[key].name);
            }
        }
        if (hiredAdvisors.length > 0) {
            advisorList = hiredAdvisors.join(', ');
        }
    }
    return [
        `--- ${playerName}'s Kingdom Status (Day ${playerState.day}) ---`,
        `💰 Treasury: ${playerState.treasury}`, `😊 Happiness: ${playerState.happiness}`,
        `👨‍👩‍👧‍👦 Population: ${playerState.population}`, `🛡️ Military: ${playerState.military}`,
        `⚖️ Tax Rate: ${TAX_LEVELS[playerState.taxRate].label}`, `🌸 Season: ${playerState.season}`,
        `👑 Council: ${advisorList}`
    ];
}

function showHelp() {
    return [
        "--- Kingdom Chat Help ---",
        "!kcreate: Create/restart your personal kingdom.",
        "!chat: Talk to the next person waiting. This moves time forward one day.",
        "!yes / !no: Respond to the person you're talking to.",
        "!y / !n: Respond to a confirmation prompt.",
        "!status: Shows the full status of your kingdom.",
        "!settax [low|normal|high]: Sets your tax rate.",
        "!kdestroy: Abdicate the throne and end your game."
    ];
}

// --- 5. THE API ENDPOINT ---
app.post('/command', async (req, res) => {
    const { playerName, command, args } = req.body;
    if (!playerName || !command) return res.status(400).json({ error: "Missing playerName or command" });
    let replies = [];
    try {
        switch (command) {
            case '!kcreate':    replies = await createKingdom(playerName); break;
            case '!kdestroy':   replies = await destroyKingdom(playerName, "You have abdicated the throne."); break;
            case '!chat':       replies = await requestNextChat(playerName); break;
            case '!yes':
            case '!no':         replies = await handleDecision(playerName, command); break;
            case '!y':
            case '!n':          replies = await handleConfirmation(playerName, command); break;
            case '!status':     replies = await showStatus(playerName); break;
            case '!help':       replies = showHelp(); break;
            case '!settax':     replies = await handleSetTax(playerName, args[0]); break;
            default: break;
        }
    } catch (error) {
        console.error("Error processing command:", error);
        replies = ["A critical server error occurred."];
    }
    res.json({ replies });
});

// --- 6. SERVER STARTUP ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Kingdom Chat server (Advanced) listening on port ${PORT}`);
});
