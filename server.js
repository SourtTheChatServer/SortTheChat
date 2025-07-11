// server.js

// --- 1. SETUP & IMPORTS ---
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

// --- 2. MONGOOSE SCHEMA DEFINITION ---
// This defines the structure of a "Kingdom" document in our database.
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
    advisors: { type: Map, of: Boolean, default: {} }, // Tracks hired advisors, e.g., { general: true }
    gameActive: { type: Boolean, default: true },
    isAwaitingDecision: { type: Boolean, default: false },
    currentEventId: { type: String, default: null }
});

const Kingdom = mongoose.model('Kingdom', KingdomSchema);

const app = express();
app.use(express.json());
app.use(cors());

// --- 3. DATABASE CONNECTION ---
const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
    console.error("FATAL ERROR: MONGO_URI environment variable is not set.");
    process.exit(1); // Exit if the database connection string is missing.
}
mongoose.connect(MONGO_URI)
    .then(() => console.log("MongoDB connected successfully."))
    .catch(err => console.error("MongoDB connection error:", err));


// --- 4. GAME DATA AND CONSTANTS ---
const TAX_LEVELS = { 'low': { income_per_10_pop: 0.5, happiness_effect: +1, label: "Low" }, 'normal': { income_per_10_pop: 1.0, happiness_effect: 0, label: "Normal" }, 'high': { income_per_10_pop: 1.5, happiness_effect: -2, label: "High" } };
const HAPPINESS_BASELINE = 50;
const HAPPINESS_MODIFIER_STRENGTH = 0.5;
const REVOLT_HAPPINESS_THRESHOLD = 20;
const SEASON_LENGTH = 20;
const SEASONS = { 'Spring': { icon: '🌸', effects: { population: +1 } }, 'Summer': { icon: '☀️', effects: { happiness: +1 } }, 'Autumn': { icon: '🍂', effects: { treasury: +2 } }, 'Winter': { icon: '❄️', effects: { happiness: -1 } } };
const ADVISORS = { 'general': { name: "General Kael", upkeep: { salary: 5, effects: { military: +1 } } }, 'treasurer': { name: "Lady Elara", upkeep: { salary: 8 } }, 'spymaster': { name: "The Whisper", upkeep: { salary: 10, effects: { happiness: -1 } } } };

const allEvents = [
    { id: 'recruit_general', petitioner: "A battle-scarred soldier", text: "My liege, our army is disorganized. For a salary, the legendary General Kael could lead our troops. He would bring discipline and strength.", requiresNoAdvisor: 'general', onYes: { text: "General Kael accepts your offer. 'I will not fail you,' he says, his voice like gravel.", effects: { military: +10 }, onSuccess: (gs) => { gs.advisors.set('general', true); } }, onNo: { text: "You decline. The army remains a rudderless ship.", effects: { happiness: -5 } } },
    { id: 'recruit_treasurer', petitioner: "A guild merchant", text: "Your Majesty, the economy is a tangled mess. Lady Elara has a gift for numbers. Her services are costly, but she can make tax collection 10% more effective.", requiresNoAdvisor: 'treasurer', condition: (gs) => gs.treasury > 200, onYes: { text: "Lady Elara joins your council. 'Let's get this treasury in order,' she says, already sharpening a quill.", effects: {}, onSuccess: (gs) => { gs.advisors.set('treasurer', true); } }, onNo: { text: "You decide your current methods are sufficient. The merchant sighs.", effects: {} } },
    { id: 'recruit_spymaster', petitioner: "A cloaked figure in the shadows", text: "Knowledge is power, your Majesty. Secrets are a weapon. I can be your weapon... for a price.", requiresNoAdvisor: 'spymaster', onYes: { text: "The figure nods. 'My whispers will serve you.' You feel a chill, but also a sense of power.", effects: {}, onSuccess: (gs) => { gs.advisors.set('spymaster', true); } }, onNo: { text: "The figure melts back into the shadows. 'A shame,' you hear on the wind.", effects: {} } },
    { id: 'general_report', advisor: 'general', petitioner: () => ADVISORS.general.name, text: (gs) => `My liege, our current military strength is ${gs.military}. To improve readiness, I request an additional 50 gold to conduct training exercises.`, onYes: { text: "The training exercises are a great success! The army is sharper than ever.", effects: { treasury: -50, military: +15 } }, onNo: { text: "'As you command,' the General says, a hint of disappointment in his eyes. 'We will make do.'", effects: { happiness: -5 } } },
    { id: 'treasurer_report', advisor: 'treasurer', petitioner: () => ADVISORS.treasurer.name, text: "Sire, I've identified an opportunity to invest 100 gold in the merchant guilds. It's a safe venture that should provide a steady return.", onYes: { text: "The investment pays off, providing a small but reliable boost to our daily income.", effects: { treasury: -100 } /* Special handling for modifiers needed */ }, onNo: { text: "'A missed opportunity, but your decision is final,' Lady Elara notes in her ledger.", effects: { } } },
    { id: 'spymaster_report', advisor: 'spymaster', petitioner: () => ADVISORS.spymaster.name, text: "A whisper, my liege... A noble family plots against you. For 25 gold, I can... 'discourage' them.", onYes: { text: "The problem is dealt with. The noble family is suddenly and completely loyal.", effects: { treasury: -25, happiness: +10 } }, onNo: { text: "You let them be. A week later, they publicly denounce your rule, sowing dissent.", effects: { happiness: -15 } } },
    { id: 'farmer_blight', petitioner: "A Farmer", text: "My liege, a terrible blight has struck our fields! We need 50 gold for new seeds or we'll starve.", onYes: { text: "The farmers are grateful!", effects: { treasury: -50, happiness: +15, population: +5 } }, onNo: { text: "The farmers despair.", effects: { happiness: -15, population: -10 } } },
    { id: 'traveling_circus', petitioner: "A Traveling Circus", text: "For a mere 30 gold, our magnificent circus will perform for your citizens and lift their spirits!", onYes: { text: "The circus is a hit!", effects: { treasury: -30, happiness: +25 } }, onNo: { text: "The circus packs up and leaves.", effects: { happiness: -5 } } },
    { id: 'shady_merchant', petitioner: "A Shady-Looking Merchant", text: "Psst, ruler... I've 'acquired' some exotic goods. A small investment of 20 gold could double your return!", onYes: { text: "The gamble pays off!", effects: { treasury: +20 } }, onNo: { text: "You wisely refuse.", effects: { happiness: +5 } } },
    { id: 'goblin_raid', petitioner: "A Scout", text: (gs) => `My liege, a goblin raiding party has been spotted! Our military strength is at ${gs.military}.`, condition: (gs) => gs.military < 30, onYes: { text: "The guards repel the goblins, but take some losses.", effects: { military: -5, happiness: +10, treasury: -10 } }, onNo: { text: "The goblins raid several farms before retreating.", effects: { happiness: -15, population: -10, treasury: -20 } } },
    { id: 'migrant_group', petitioner: "The Captain of the Guard", text: "A group of 20 migrants has arrived at our gates, seeking refuge. Shall we let them in?", condition: (gs) => gs.population > 50, onYes: { text: "You welcome the migrants. They are hardworking and grateful.", effects: { population: +20, happiness: +5 } }, onNo: { text: "You turn the migrants away.", effects: { happiness: -10 } } },
    { id: 'spring_festival', season: 'Spring', petitioner: "A Cheerful Villager", text: "Let's celebrate the end of winter with a grand Spring Festival! It will cost 40 gold.", onYes: { text: "The festival is a joyous success!", effects: { treasury: -40, happiness: +25 } }, onNo: { text: "You cancel the festival.", effects: { happiness: -10 } } },
    { id: 'summer_drought', season: 'Summer', petitioner: "A Worried Farmer", text: "There has been no rain for weeks, my liege! Our crops are withering. We need 50 gold for irrigation.", onYes: { text: "The irrigation effort saves the harvest!", effects: { treasury: -50, population: +5 } }, onNo: { text: "The crops fail under the blazing sun.", effects: { happiness: -10, population: -10 } } },
    { id: 'autumn_harvest_bonus', season: 'Autumn', petitioner: "The Royal Treasurer", text: "My liege, the autumn harvest has been exceptionally bountiful! We have a surplus of 100 gold.", onYes: { text: "You order a feast to celebrate!", effects: { treasury: +50, happiness: +10 } }, onNo: { text: "You wisely store the entire surplus.", effects: { treasury: +100, happiness: -5 } } },
    { id: 'winter_blizzard', season: 'Winter', petitioner: "The Captain of the Guard", text: "A fierce blizzard has buried the kingdom in snow! We need 70 gold for a relief effort.", onYes: { text: "The relief effort is a success!", effects: { treasury: -70, happiness: +20, population: +5 } }, onNo: { text: "The kingdom remains paralyzed. Some do not survive the cold.", effects: { happiness: -20, population: -15 } } },
];
const eventsMap = new Map(allEvents.map(e => [e.id, e]));

// --- 5. CORE GAME LOGIC FUNCTIONS (ASYNC) ---

async function createKingdom(playerName) {
    await Kingdom.findByIdAndUpdate(playerName, {
        _id: playerName, day: 0, treasury: 100, happiness: 50, population: 100, military: 10, taxRate: 'normal',
        taxChangeCooldown: 0, season: 'Spring', dayOfSeason: 1, advisors: new Map(), gameActive: true,
        isAwaitingDecision: false, currentEventId: null
    }, { upsert: true, new: true });
    return [`${playerName}'s kingdom has been created!`, `Type !chat for your first event.`];
}

async function destroyKingdom(playerName, reason) {
    const kingdom = await Kingdom.findById(playerName);
    if (!kingdom || !kingdom.gameActive) return [];
    kingdom.gameActive = false;
    await kingdom.save();
    return [`--- ${playerName}'s reign has ended after ${kingdom.day} days. ---`, `Reason: ${reason}`];
}

async function requestNextChat(playerName) {
    let replies = [];
    const playerState = await Kingdom.findById(playerName);
    if (!playerState || !playerState.gameActive) return [`${playerName}, you don't have a kingdom. Type !kcreate to start.`];
    if (playerState.isAwaitingDecision) return [`${playerName}, you need to respond to your current event first! (!yes or !no)`];

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
    const taxEffect = TAX_LEVELS[playerState.taxRate].happiness_effect;
    if (taxEffect !== 0) playerState.happiness += taxEffect;
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
    if(chosenOutcome.effects) {
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
    if(playerState.advisors && playerState.advisors.size > 0) {
        advisorList = Array.from(playerState.advisors.keys()).map(key => ADVISORS[key].name).join(', ');
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
        "!status: Shows the full status of your kingdom.",
        "!settax [low|normal|high]: Sets your tax rate.",
        "!kdestroy: Abdicate the throne and end your game."
    ];
}

// --- 6. THE API ENDPOINT (Now async) ---
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

// --- 7. SERVER STARTUP ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Kingdom Chat server (Advanced) listening on port ${PORT}`);
});
