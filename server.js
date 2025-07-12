// server.js

// --- CHANGE LOG ---
// 1. BUG FIX: Corrected a `ReferenceError` in `handleDecision` where `outcome` was used instead of `chosenOutcome`. This was the cause of the crash.
// 2. IMPROVED: The stat change reporting in `handleDecision` is now more robust and correctly reports changes to all stats, including those modified by complex `onSuccess` functions.
// 3. All previous features (Crime system, unique events, emojis, etc.) are preserved and stable.
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
    _id: { type: String, required: true },
    day: { type: Number, default: 0 },
    treasury: { type: Number, default: 100 },
    happiness: { type: Number, default: 50 },
    population: { type: Number, default: 100 },
    military: { type: Number, default: 10 },
    jailedPopulation: { type: Number, default: 0 },
    taxRate: { type: String, default: 'normal' },
    taxChangeCooldown: { type: Number, default: 0 },
    season: { type: String, default: 'Spring' },
    dayOfSeason: { type: Number, default: 1 },
    advisors: { type: Map, of: Boolean, default: () => new Map() },
    flags: { type: Map, of: mongoose.Schema.Types.Mixed, default: () => new Map() },
    eventsForToday: { type: [String], default: [] },
    currentEventIndex: { type: Number, default: 0 },
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

function resetKingdomState(playerState) {
    playerState.day = 0;
    playerState.treasury = 100;
    playerState.happiness = 50;
    playerState.population = 100;
    playerState.military = 10;
    playerState.jailedPopulation = 0;
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
    playerState.eventsForToday = [];
    playerState.currentEventIndex = 0;
    return playerState;
}

async function createKingdom(playerName) {
    const existingKingdom = await Kingdom.findById(playerName);

    if (existingKingdom && existingKingdom.gameActive) {
        const expirationTime = new Date(Date.now() + 30000);
        existingKingdom.pendingAction = { action: 'confirm_reset', expires: expirationTime };
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
            `Are you sure you want to restart? This will ERASE your current game. 💥`,
            `Respond with !y (yes) or !n (no) within 30 seconds.`
        ];
    }
    
    let kingdomToUpdate = existingKingdom || new Kingdom({ _id: playerName });
    kingdomToUpdate = resetKingdomState(kingdomToUpdate);
    await kingdomToUpdate.save({ upsert: true });

    return [`Welcome, ruler of ${playerName}! 👑 Your kingdom has been created!`, `Type !chat for your first event.`];
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
            resetKingdomState(playerState);
            await playerState.save();
            return [`${playerName}'s kingdom has been reset. A new era begins! 🌅`];
        } else {
            await playerState.save();
            return [`${playerName}, restart cancelled. Your kingdom is safe. ✅`];
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
    return [`--- ${playerName}'s reign has ended after ${kingdom.day} days. ☠️ ---`, `Reason: ${reason}`];
}

async function requestNextChat(playerName) {
    const playerState = await Kingdom.findById(playerName);
    if (!playerState || !playerState.gameActive) return [`${playerName}, you don't have a kingdom. Type !kcreate to start.`];
    
    if (playerState.isAwaitingDecision) {
        const currentEvent = eventsMap.get(playerState.currentEventId);
        if (!currentEvent) {
            playerState.isAwaitingDecision = false;
            await playerState.save();
            return [`An error occurred with your last event. Please type !chat to continue.`];
        }
        const petitioner = typeof currentEvent.petitioner === 'function' ? currentEvent.petitioner() : currentEvent.petitioner;
        const eventText = typeof currentEvent.text === 'function' ? currentEvent.text(playerState) : currentEvent.text;
        return [
            `🔔 Just a reminder, ${playerName}... you're still in a conversation.`,
            `${petitioner} 🗣️ is waiting for your answer.`,
            `They said: "${eventText}"`,
            "What is your decision? 🤔 (!yes / !no)"
        ];
    }

    if (playerState.pendingAction) return [`${playerName}, you must first respond to your pending confirmation (!y or !n).`];

    const replies = [];
    const isNewDay = playerState.currentEventIndex >= playerState.eventsForToday.length;

    if (isNewDay) {
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
                replies.push(`A new season has begun in ${playerName}'s kingdom: ${SEASONS[playerState.season].icon} ${playerState.season}!`);
            }
            const seasonEffect = SEASONS[playerState.season].effects;
            for (const stat in seasonEffect) playerState[stat] += seasonEffect[stat];

            const taxInfo = TAX_LEVELS[playerState.taxRate];
            const happinessModifier = Math.max(1, (playerState.happiness / 50) + 1);
            const baseIncome = (playerState.population / 10) * taxInfo.income_per_10_pop;
            const incomeAfterHappiness = baseIncome * happinessModifier;
            const treasurerBonus = playerState.advisors.get('treasurer') ? 1.10 : 1.0;
            let finalIncome = incomeAfterHappiness * treasurerBonus;
            if (playerState.flags.get('active_crime_gang')) {
                const dailyTheft = playerState.flags.get('active_crime_gang') === 'entrenched' ? 40 : 20;
                finalIncome -= dailyTheft;
                replies.push(`❗️ A criminal gang steals ${dailyTheft} 💰 from your coffers!`);
            }
            if (playerState.flags.get('gilded_blight_active')) {
                finalIncome = finalIncome * 0.75; 
                replies.push("❗️ The Gilded Blight's placid calm saps your kingdom's productivity and vigilance.");
            }
            const taxIncome = Math.floor(finalIncome);
            playerState.treasury += taxIncome;
            if (taxInfo.happiness_effect !== 0) playerState.happiness += taxInfo.happiness_effect;
            
            let totalSalary = 0;
            for (const [advisorKey, isHired] of playerState.advisors) { if (isHired) { const advisor = ADVISORS[advisorKey]; if (advisor.upkeep.salary) totalSalary += advisor.upkeep.salary; if (advisor.upkeep.effects) { for (const stat in advisor.upkeep.effects) playerState[stat] += advisor.upkeep.effects[stat]; } } }
            playerState.treasury -= totalSalary;
            const jailUpkeep = Math.floor((playerState.jailedPopulation || 0) * 0.5);
            playerState.treasury -= jailUpkeep;

            let prisoners = playerState.flags.get('prisoners') || [];
            const remainingPrisoners = [];
            let releasedCount = 0;
            for (const group of prisoners) {
                if (playerState.day >= group.releaseDay) {
                    playerState.population += group.count;
                    playerState.jailedPopulation -= group.count;
                    releasedCount += group.count;
                } else {
                    remainingPrisoners.push(group);
                }
            }
            if (releasedCount > 0) {
                replies.push(`⛓️ ${releasedCount} prisoners have served their time and been released back into the populace.`);
                playerState.flags.set('prisoners', remainingPrisoners);
            }
            if (playerState.jailedPopulation < 0) playerState.jailedPopulation = 0;

            let upkeepReport = [];
            const trackableStats = ['happiness', 'population', 'jailedPopulation', 'treasury', 'military'];
            trackableStats.forEach(stat => {
                 if (playerState[stat] !== oldStats[stat]) {
                      upkeepReport.push(formatStatChange(stat, oldStats[stat], playerState[stat]));
                 }
            });
            if (upkeepReport.length > 0) replies.push(`📈 Daily changes for ${playerName}: ${upkeepReport.join(' | ')}`);
            if (jailUpkeep > 0) replies.push(`⛓️ The upkeep for your ${playerState.jailedPopulation} prisoners costs ${jailUpkeep} 💰.`);

            if (playerState.happiness <= REVOLT_HAPPINESS_THRESHOLD && playerState.taxRate !== 'low') {
                replies.push(`🚨 WARNING: Happiness in ${playerName}'s kingdom is critically low!`);
                playerState.happiness -= 2;
            }
        } else {
             playerState.day = 1;
        }
        
        playerState.eventsForToday = [];
        playerState.currentEventIndex = 0;
        const dailyEventCounts = new Map();
        const numberOfEvents = Math.floor(Math.random() * 3) + 3;
        const uniqueEventsThisDay = new Set();
        for (let i = 0; i < numberOfEvents; i++) { const availableEvents = allEvents.filter(e => { const count = dailyEventCounts.get(e.id) || 0; if (count >= 2) return false; if (e.isUnique && uniqueEventsThisDay.has(e.id)) return false; const condition = e.condition ? e.condition(playerState) : true; const seasonCondition = e.season ? e.season === playerState.season : true; let advisorCondition = true; if (e.advisor) advisorCondition = playerState.advisors.get(e.advisor); else if (e.requiresNoAdvisor) advisorCondition = !playerState.advisors.get(e.requiresNoAdvisor); return condition && seasonCondition && advisorCondition; }); if (availableEvents.length === 0) break; const chosenEvent = availableEvents[Math.floor(Math.random() * availableEvents.length)]; playerState.eventsForToday.push(chosenEvent.id); dailyEventCounts.set(chosenEvent.id, (dailyEventCounts.get(chosenEvent.id) || 0) + 1); if (chosenEvent.isUnique) { uniqueEventsThisDay.add(chosenEvent.id); } }
        
        const princeEventAvailable = playerState.eventsForToday.includes('prince_loan_offer');
        if (playerState.treasury < 0 && !princeEventAvailable) { return destroyKingdom(playerName, "The kingdom is bankrupt!"); }
        if (playerState.happiness <= 0) { return destroyKingdom(playerName, "The people have revolted!"); }
        if (playerState.eventsForToday.length === 0) { replies.push(`--- ${playerName}'s Kingdom, Day ${playerState.day} ---`); replies.push("The kingdom is quiet today. 😌 No new petitions have arrived."); replies.push("Type !chat to start the next day."); await playerState.save(); return replies; }
    }

    const eventId = playerState.eventsForToday[playerState.currentEventIndex];
    const currentEvent = eventsMap.get(eventId);
    if (!currentEvent) { playerState.currentEventIndex++; await playerState.save(); return requestNextChat(playerName); }
    playerState.currentEventId = currentEvent.id;
    playerState.isAwaitingDecision = true;
    await playerState.save();
    const petitioner = typeof currentEvent.petitioner === 'function' ? currentEvent.petitioner() : currentEvent.petitioner;
    const eventText = typeof currentEvent.text === 'function' ? currentEvent.text(playerState) : currentEvent.text;
    replies.push(`--- ${playerName}'s Kingdom, Day ${playerState.day} (Event ${playerState.currentEventIndex + 1}/${playerState.eventsForToday.length}) ---`);
    replies.push(`${petitioner} 🗣️ wants to talk.`);
    replies.push(`"${eventText}"`);
    if (currentEvent.isNarrativeOnly) { playerState.isAwaitingDecision = false; const resolutionReplies = await handleDecision(playerName, '!narrative'); return replies.concat(resolutionReplies); }
    replies.push("What do you say? 🤔 (!yes / !no)");
    return replies;
}

async function handleDecision(playerName, choice) {
    const playerState = await Kingdom.findById(playerName);
    if (!playerState || !playerState.gameActive || (playerState.isAwaitingDecision === false && choice !== '!narrative')) return [];
    if (playerState.pendingAction) return [`${playerName}, you must first respond to your pending confirmation (!y or !n).`];
    const currentEvent = eventsMap.get(playerState.currentEventId);
    if (!currentEvent) { playerState.isAwaitingDecision = false; playerState.currentEventIndex++; await playerState.save(); return ["An error occurred with your current event. Type !chat to continue."]; }

    const oldStats = { ...playerState.toObject() };
    const replies = [];
    let chosenOutcome;
    let customOutcomeText = null;

    if (choice === '!narrative' && currentEvent.isNarrativeOnly) {
        chosenOutcome = currentEvent;
        replies.push(`📜 ${playerName}, ${currentEvent.outcome_text}`);
    } else {
        const decisionKey = (choice === '!yes') ? 'onYes' : 'onNo';
        chosenOutcome = currentEvent[decisionKey];
        if (!chosenOutcome) { return ["That is not a valid choice for this event."]; }
        replies.push(`💬 ${playerName}, ${chosenOutcome.text}`);
    }

    if (chosenOutcome.triggersGameOver) { return destroyKingdom(playerName, chosenOutcome.text); }
    
    // --- *** BUG FIX: Renamed all instances of `outcome` to `chosenOutcome` below *** ---
    if (chosenOutcome.random_outcomes) { const roll = Math.random(); let cumulativeChance = 0; for (const outcome of chosenOutcome.random_outcomes) { cumulativeChance += outcome.chance; if (roll < cumulativeChance) { replies.push(`🎲 ${outcome.text}`); if (outcome.effects) { for (const stat in outcome.effects) { if (playerState[stat] !== undefined) playerState[stat] += outcome.effects[stat]; } } break; } } }
    if (chosenOutcome.effects) { for (const stat in chosenOutcome.effects) { if (playerState[stat] !== undefined) playerState[stat] += chosenOutcome.effects[stat]; } }
    
    if (chosenOutcome.onSuccess) { 
        chosenOutcome.onSuccess(playerState); 
        if (playerState.outcome_text) {
            customOutcomeText = playerState.outcome_text;
            delete playerState.outcome_text;
        }
    }
    
    if (customOutcomeText) {
        replies.push(`⚖️ ${customOutcomeText}`);
    }

    if (chosenOutcome.clearFlags) { chosenOutcome.clearFlags.forEach(flag => playerState.flags.delete(flag)); }
    
    playerState.isAwaitingDecision = false;
    playerState.currentEventId = null;
    playerState.currentEventIndex++;
    await playerState.save();

    let statusChanges = [];
    const trackableStats = ['happiness', 'population', 'jailedPopulation', 'treasury', 'military'];
    trackableStats.forEach(stat => {
        if (oldStats[stat] !== playerState[stat]) {
            statusChanges.push(formatStatChange(stat, oldStats[stat], playerState[stat]));
        }
    });

    if (statusChanges.length > 0) replies.push(`📊 Stat Changes: ${statusChanges.join(' | ')}`);
    if (playerState.currentEventIndex >= playerState.eventsForToday.length) { replies.push("The day's business is concluded. ✅ Type !chat to start the next day."); }
    else { replies.push("A new petitioner approaches. 👉 Type !chat for your next event."); }
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
    return [`✅ Your kingdom's tax rate is now set to ${TAX_LEVELS[newRate].label}.`];
}

function formatStatChange(stat, oldValue, newValue) {
    // --- *** BUG FIX: This function is now simple and correct. *** ---
    const symbols = { treasury: '💰', happiness: '😊', population: '👨‍👩‍👧‍👦', military: '💂', jailedPopulation: '⛓️' };
    return `${symbols[stat]} ${oldValue} ➞ ${newValue}`;
}

async function showStatus(playerName) {
    const playerState = await Kingdom.findById(playerName);
    if (!playerState || !playerState.gameActive) return [`${playerName}, you don't have a kingdom. Type !kcreate to begin.`];
    let advisorList = 'None';
    if (playerState.advisors && playerState.advisors.size > 0) { const hiredAdvisors = []; for (const [key, isHired] of playerState.advisors.entries()) { if (isHired) { hiredAdvisors.push(ADVISORS[key].name); } } if (hiredAdvisors.length > 0) { advisorList = hiredAdvisors.join(', '); } }
    
    const status = [
        `--- ${playerName}'s Kingdom Status (Day ${playerState.day}) ---`,
        `💰 Treasury: ${playerState.treasury}`, 
        `😊 Happiness: ${playerState.happiness}`,
        `👨‍👩‍👧‍👦 Population: ${playerState.population}`, 
        `💂 Military: ${playerState.military}`,
        `⚖️ Tax Rate: ${TAX_LEVELS[playerState.taxRate].label}`, 
        `🌸 Season: ${playerState.season}`,
        `👑 Council: ${advisorList}`
    ];
    if ((playerState.jailedPopulation || 0) > 0) {
        status.splice(4, 0, `⛓️ Jailed Population: ${playerState.jailedPopulation}`);
    }
    return status;
}

function showHelp() {
    return [
        "--- Kingdom Chat Help ---",
        "🏰 `!kcreate`: Create or restart your personal kingdom.",
        "💬 `!chat`: Talk to the next person waiting. This progresses the day.",
        "👍 `!yes` / 👎 `!no`: Respond to the person you're talking to.",
        "✅ `!y` / ❌ `!n`: Respond to a confirmation prompt (like restarting).",
        "📊 `!status`: Shows the full status of your kingdom.",
        "⚖️ `!settax [low|normal|high]`: Sets your tax rate.",
        "💥 `!kdestroy`: Abdicate the throne and end your game."
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
