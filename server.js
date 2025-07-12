// server.js

// --- CHANGE LOG ---
// 1. RESTRUCTURED: The game loop now supports multiple events per day.
//    - A "day" now consists of 3-5 random events.
//    - The `!chat` command progresses through the event list for the current day.
//    - Daily upkeep (taxes, salaries, etc.) is now processed only ONCE at the beginning of a new day of events.
// 2. ADDED: New fields in KingdomSchema to manage the new loop.
//    - `eventsForToday`: An array of event IDs for the current day.
//    - `currentEventIndex`: Tracks progress through the `eventsForToday` array.
// 3. UPDATED: `requestNextChat` now contains the main logic for starting a new day vs. continuing an existing one.
// 4. UPDATED: `handleDecision` now increments `currentEventIndex` after a decision is made and guides the user.
// 5. ADDED: A rule to prevent the same event from appearing more than twice in a single day.
// 6. ADDED: Logic in daily upkeep to handle persistent effects from flags (e.g., 'gilded_blight_active').
// --- END CHANGE LOG ---


// --- 1. SETUP & IMPORTS ---
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

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
    flags: { type: Map, of: mongoose.Schema.Types.Mixed, default: () => new Map() },
    // NEW FIELDS for multi-event days
    eventsForToday: { type: [String], default: [] },
    currentEventIndex: { type: Number, default: 0 },
    // ---
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

// Helper function to reset the kingdom state
function resetKingdomState(playerState) {
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
    playerState.flags = new Map();
    playerState.gameActive = true;
    playerState.isAwaitingDecision = false;
    playerState.currentEventId = null;
    playerState.pendingAction = null;
    // Reset new fields
    playerState.eventsForToday = [];
    playerState.currentEventIndex = 0;
    return playerState;
}

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
    
    // Use the reset helper for both new and existing-but-inactive games
    let kingdomToUpdate = existingKingdom || new Kingdom({ _id: playerName });
    kingdomToUpdate = resetKingdomState(kingdomToUpdate);
    await kingdomToUpdate.save({ upsert: true });

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
            resetKingdomState(playerState); // Use the reset helper
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

async function requestNextChat(playerName) {
    const playerState = await Kingdom.findById(playerName);
    if (!playerState || !playerState.gameActive) return [`${playerName}, you don't have a kingdom. Type !kcreate to start.`];
    if (playerState.isAwaitingDecision) return [`${playerName}, you need to respond to your current event first! (!yes or !no)`];
    if (playerState.pendingAction) return [`${playerName}, you must first respond to your pending confirmation (!y or !n).`];

    const replies = [];

    // Check if we have finished all events for the current day.
    const isNewDay = playerState.currentEventIndex >= playerState.eventsForToday.length;

    if (isNewDay) {
        // --- START OF DAY LOGIC ---
        // Only process upkeep if it's not the very first day (day 0)
        const isFirstTurnOfGame = playerState.day === 0 && playerState.eventsForToday.length === 0;

        if (!isFirstTurnOfGame) {
            const oldStats = { ...playerState.toObject() };

            playerState.day++;
            if (playerState.taxChangeCooldown > 0) playerState.taxChangeCooldown--;
            playerState.dayOfSeason++;

            if (playerState.dayOfSeason > SEASON_LENGTH) {
                playerState.dayOfSeason = 1;
                const seasonNames = Object.keys(SEASONS);
                playerState.season = seasonNames[(seasonNames.indexOf(playerState.season) + 1) % seasonNames.length];
                replies.push(`A new season has begun in ${playerName}'s kingdom: ${playerState.season}!`);
            }
            const seasonEffect = SEASONS[playerState.season].effects;
            for (const stat in seasonEffect) playerState[stat] += seasonEffect[stat];

            const taxInfo = TAX_LEVELS[playerState.taxRate];
            const treasurerBonus = playerState.advisors.get('treasurer') ? 1.10 : 1.0;
            // *** MODIFIED LINE: Changed const to let ***
            let taxIncome = Math.floor((playerState.population / 10) * taxInfo.income_per_10_pop * treasurerBonus);
            
            // --- *** NEW BLOCK: Check for persistent flag effects *** ---
            if (playerState.flags.get('gilded_blight_active')) {
                taxIncome = Math.floor(taxIncome * 0.75); // 25% penalty to income
                playerState.military -= 1; // Military readiness slowly decays
                replies.push("[!] The Gilded Blight's placid calm saps your kingdom's productivity and vigilance.");
            }
            // --- *** END NEW BLOCK *** ---

            playerState.treasury += taxIncome;
            if (taxInfo.happiness_effect !== 0) playerState.happiness += taxInfo.happiness_effect;

            let totalSalary = 0;
            for (const [advisorKey, isHired] of playerState.advisors) {
                if (isHired) {
                    const advisor = ADVISORS[advisorKey];
                    if (advisor.upkeep.salary) totalSalary += advisor.upkeep.salary;
                    if (advisor.upkeep.effects) {
                        for (const stat in advisor.upkeep.effects) playerState[stat] += advisor.upkeep.effects[stat];
                    }
                }
            }
            playerState.treasury -= totalSalary;

            let upkeepReport = [];
            if (playerState.happiness !== oldStats.happiness) upkeepReport.push(formatStatChange('happiness', oldStats.happiness, playerState.happiness));
            if (playerState.population !== oldStats.population) upkeepReport.push(formatStatChange('population', oldStats.population, playerState.population));
            if (playerState.treasury !== oldStats.treasury) upkeepReport.push(formatStatChange('treasury', oldStats.treasury, playerState.treasury));
            if (playerState.military !== oldStats.military) upkeepReport.push(formatStatChange('military', oldStats.military, playerState.military));
            if (upkeepReport.length > 0) replies.push(`Daily changes for ${playerName}: ${upkeepReport.join(' | ')}`);

            if (playerState.happiness <= REVOLT_HAPPINESS_THRESHOLD && playerState.taxRate !== 'low') {
                replies.push(`[!] WARNING: Happiness in ${playerName}'s kingdom is critically low!`);
                playerState.happiness -= 2;
            }
        } else {
             playerState.day = 1; // It is now Day 1
        }
        
        // --- Generate new events for the day ---
        playerState.eventsForToday = [];
        playerState.currentEventIndex = 0;

        const dailyEventCounts = new Map();
        const numberOfEvents = Math.floor(Math.random() * 3) + 3; // 3 to 5 events

        for (let i = 0; i < numberOfEvents; i++) {
            const availableEvents = allEvents.filter(e => {
                const count = dailyEventCounts.get(e.id) || 0;
                if (count >= 2) return false; // Max 2 times per day rule

                const condition = e.condition ? e.condition(playerState) : true;
                const seasonCondition = e.season ? e.season === playerState.season : true;
                let advisorCondition = true;
                if (e.advisor) advisorCondition = playerState.advisors.get(e.advisor);
                else if (e.requiresNoAdvisor) advisorCondition = !playerState.advisors.get(e.requiresNoAdvisor);
                return condition && seasonCondition && advisorCondition;
            });

            if (availableEvents.length === 0) break; // Stop if no more valid events

            const chosenEvent = availableEvents[Math.floor(Math.random() * availableEvents.length)];
            playerState.eventsForToday.push(chosenEvent.id);
            dailyEventCounts.set(chosenEvent.id, (dailyEventCounts.get(chosenEvent.id) || 0) + 1);
        }
        
        // --- Post-upkeep game over check ---
        // If the prince's loan is in the list, it can save the player.
        const princeEventAvailable = playerState.eventsForToday.includes('prince_loan_offer');
        if (playerState.treasury < 0 && !princeEventAvailable) {
            return destroyKingdom(playerName, "The kingdom is bankrupt!");
        }
        if (playerState.happiness <= 0) {
            return destroyKingdom(playerName, "The people have revolted!");
        }

        if (playerState.eventsForToday.length === 0) {
            replies.push(`--- ${playerName}'s Kingdom, Day ${playerState.day} ---`);
            replies.push("The kingdom is quiet today. No new petitions have arrived.");
            replies.push("Type !chat to start the next day.");
            await playerState.save();
            return replies;
        }
    }

    // --- PRESENT THE CURRENT EVENT (for both new and continuing days) ---
    const eventId = playerState.eventsForToday[playerState.currentEventIndex];
    const currentEvent = eventsMap.get(eventId);

    if (!currentEvent) {
        playerState.currentEventIndex++; // Skip broken event
        await playerState.save();
        return requestNextChat(playerName); // Try to get the next one
    }

    playerState.currentEventId = currentEvent.id;
    playerState.isAwaitingDecision = true;
    await playerState.save();

    const petitioner = typeof currentEvent.petitioner === 'function' ? currentEvent.petitioner() : currentEvent.petitioner;
    const eventText = typeof currentEvent.text === 'function' ? currentEvent.text(playerState) : currentEvent.text;

    replies.push(`--- ${playerName}'s Kingdom, Day ${playerState.day} (Event ${playerState.currentEventIndex + 1}/${playerState.eventsForToday.length}) ---`);
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
        playerState.isAwaitingDecision = false;
        playerState.currentEventIndex++; // Move past the broken event
        await playerState.save();
        return ["An error occurred with your current event. Type !chat to continue."];
    }

    const oldStats = { ...playerState.toObject() };
    const decisionKey = (choice === '!yes') ? 'onYes' : 'onNo';
    const chosenOutcome = currentEvent[decisionKey];

    if (chosenOutcome.triggersGameOver) {
        return destroyKingdom(playerName, chosenOutcome.text);
    }

    const replies = [`${playerName}, ${chosenOutcome.text}`];

    if (chosenOutcome.random_outcomes) {
        const roll = Math.random();
        let cumulativeChance = 0;
        for (const outcome of chosenOutcome.random_outcomes) {
            cumulativeChance += outcome.chance;
            if (roll < cumulativeChance) {
                replies.push(outcome.text);
                if (outcome.effects) {
                    for (const stat in outcome.effects) {
                        if (playerState[stat] !== undefined) playerState[stat] += outcome.effects[stat];
                    }
                }
                break;
            }
        }
    }

    if (chosenOutcome.effects) {
        for (const stat in chosenOutcome.effects) {
            if (playerState[stat] !== undefined) playerState[stat] += chosenOutcome.effects[stat];
        }
    }
    if (chosenOutcome.onSuccess) { chosenOutcome.onSuccess(playerState); }

    if (chosenOutcome.clearFlags) {
        chosenOutcome.clearFlags.forEach(flag => playerState.flags.delete(flag));
    }

    playerState.isAwaitingDecision = false;
    playerState.currentEventId = null;
    playerState.currentEventIndex++; // *** KEY CHANGE: Move to the next event index ***

    await playerState.save();

    let statusChanges = [];
    const allEffectKeys = new Set(Object.keys(chosenOutcome.effects || {}));
    if (chosenOutcome.random_outcomes) {
        chosenOutcome.random_outcomes.forEach(o => Object.keys(o.effects || {}).forEach(k => allEffectKeys.add(k)));
    }

    for (const stat of allEffectKeys) {
        if (oldStats.hasOwnProperty(stat) && oldStats[stat] !== playerState[stat]) {
            statusChanges.push(formatStatChange(stat, oldStats[stat], playerState[stat]));
        }
    }

    if (statusChanges.length > 0) replies.push(statusChanges.join(' | '));
    
    // Add a message indicating what to do next
    if (playerState.currentEventIndex >= playerState.eventsForToday.length) {
        replies.push("The day's business is concluded. Type !chat to start the next day.");
    } else {
        replies.push("Type !chat for your next petitioner.");
    }
    
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
        "!chat: Talk to the next person waiting. This progresses the day.",
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
