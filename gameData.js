// gameData.js

// This file contains all the static data for the Kingdom Chat game.
// It is imported by server.js to separate content from logic.

const TAX_LEVELS = {
    'low': { income_per_10_pop: 0.5, happiness_effect: +1, label: "Low" },
    'normal': { income_per_10_pop: 1.0, happiness_effect: 0, label: "Normal" },
    'high': { income_per_10_pop: 1.5, happiness_effect: -2, label: "High" }
};

const HAPPINESS_BASELINE = 50;
const HAPPINESS_MODIFIER_STRENGTH = 0.5;
const REVOLT_HAPPINESS_THRESHOLD = 20;

const SEASON_LENGTH = 20;
const SEASONS = {
    'Spring': { icon: '🌸', effects: { population: +1 } },
    'Summer': { icon: '☀️', effects: { happiness: +1 } },
    'Autumn': { icon: '🍂', effects: { treasury: +2 } },
    'Winter': { icon: '❄️', effects: { happiness: -1 } }
};

const ADVISORS = {
    'general': { name: "General Kael", upkeep: { salary: 5, effects: { military: +1 } } },
    'treasurer': { name: "Lady Elara", upkeep: { salary: 8 } },
    'spymaster': { name: "The Whisper", upkeep: { salary: 10, effects: { happiness: -1 } } }
};

const allEvents = [
    // Advisor Events
    { id: 'recruit_general', petitioner: "A battle-scarred soldier", text: "My liege, our army is disorganized. For a salary, the legendary General Kael could lead our troops.", requiresNoAdvisor: 'general', onYes: { text: "General Kael accepts your offer.", effects: { military: +10 }, onSuccess: (gs) => { gs.advisors.set('general', true); } }, onNo: { text: "You decline. The army remains a rudderless ship.", effects: { happiness: -5 } } },
    { id: 'recruit_treasurer', petitioner: "A guild merchant", text: "Your Majesty, the economy is a tangled mess. Lady Elara's services are costly, but she can make tax collection 10% more effective.", requiresNoAdvisor: 'treasurer', condition: (gs) => gs.treasury > 200, onYes: { text: "Lady Elara joins your council.", effects: {}, onSuccess: (gs) => { gs.advisors.set('treasurer', true); } }, onNo: { text: "You decide your current methods are sufficient.", effects: {} } },
    { id: 'recruit_spymaster', petitioner: "A cloaked figure", text: "Knowledge is power, your Majesty. Secrets are a weapon. I can be your weapon... for a price.", requiresNoAdvisor: 'spymaster', onYes: { text: "The figure nods. 'My whispers will serve you.'", effects: {}, onSuccess: (gs) => { gs.advisors.set('spymaster', true); } }, onNo: { text: "The figure melts back into the shadows.", effects: {} } },
    { id: 'general_report', advisor: 'general', petitioner: () => ADVISORS.general.name, text: (gs) => `My liege, our military strength is ${gs.military}. I request 50 gold for training exercises.`, onYes: { text: "The training exercises are a success!", effects: { treasury: -50, military: +15 } }, onNo: { text: "'As you command,' the General says, disappointed.", effects: { happiness: -5 } } },
    { id: 'spymaster_report', advisor: 'spymaster', petitioner: () => ADVISORS.spymaster.name, text: "A whisper... A noble family plots against you. For 25 gold, I can... 'discourage' them.", onYes: { text: "The problem is dealt with. The nobles are suddenly very loyal.", effects: { treasury: -25, happiness: +10 } }, onNo: { text: "You let them be. Dissent grows.", effects: { happiness: -15 } } },
    
    // Standard Events
    { id: 'farmer_blight', petitioner: "A Farmer", text: "My liege, a terrible blight has struck our fields! We need 50 gold for new seeds.", onYes: { text: "The farmers are grateful!", effects: { treasury: -50, happiness: +15, population: +5 } }, onNo: { text: "The farmers despair.", effects: { happiness: -15, population: -10 } } },
    { id: 'traveling_circus', petitioner: "A Traveling Circus", text: "For 30 gold, our circus will perform and lift the spirits of your citizens!", onYes: { text: "The circus is a hit!", effects: { treasury: -30, happiness: +25 } }, onNo: { text: "The circus packs up and leaves.", effects: { happiness: -5 } } },
    { id: 'shady_merchant', petitioner: "A Shady Merchant", text: "Psst... a small investment of 20 gold could double your return!", onYes: { text: "The gamble pays off!", effects: { treasury: +20 } }, onNo: { text: "You wisely refuse.", effects: { happiness: +5 } } },
    { id: 'goblin_raid', petitioner: "A Scout", text: (gs) => `Goblins are raiding the western farms! Our military strength is only ${gs.military}!`, condition: (gs) => gs.military < 30, onYes: { text: "The guards repel the goblins, but take some losses.", effects: { military: -5, happiness: +10, treasury: -10 } }, onNo: { text: "The goblins raid several farms before retreating.", effects: { happiness: -15, population: -10, treasury: -20 } } },
    { id: 'migrant_group', petitioner: "The Guard Captain", text: "A group of 20 migrants has arrived at the gates, seeking refuge.", onYes: { text: "You welcome them. They are hardworking and grateful.", effects: { population: +20, happiness: +5 } }, onNo: { text: "You turn the migrants away.", effects: { happiness: -10 } } },
    
    // Seasonal Events
    { id: 'spring_festival', season: 'Spring', petitioner: "A Cheerful Villager", text: "Let's celebrate the end of winter with a grand Spring Festival! It will cost 40 gold.", onYes: { text: "The festival is a joyous success!", effects: { treasury: -40, happiness: +25 } }, onNo: { text: "You cancel the festival.", effects: { happiness: -10 } } },
    { id: 'summer_drought', season: 'Summer', petitioner: "A Worried Farmer", text: "There has been no rain for weeks! Our crops are withering. We need 50 gold for irrigation.", onYes: { text: "The irrigation effort saves the harvest!", effects: { treasury: -50, population: +5 } }, onNo: { text: "The crops fail under the blazing sun.", effects: { happiness: -10, population: -10 } } },
    { id: 'autumn_harvest_bonus', season: 'Autumn', petitioner: "The Royal Treasurer", text: "My liege, the autumn harvest has been exceptionally bountiful! We have a surplus of 100 gold.", onYes: { text: "You order a feast to celebrate!", effects: { treasury: +50, happiness: +10 } }, onNo: { text: "You wisely store the entire surplus.", effects: { treasury: +100, happiness: -5 } } },
    { id: 'winter_blizzard', season: 'Winter', petitioner: "The Guard Captain", text: "A fierce blizzard has buried the kingdom in snow! We need 70 gold for a relief effort.", onYes: { text: "The relief effort is a success!", effects: { treasury: -70, happiness: +20, population: +5 } }, onNo: { text: "The kingdom remains paralyzed. Some do not survive the cold.", effects: { happiness: -20, population: -15 } } },
];

const eventsMap = new Map(allEvents.map(e => [e.id, e]));

// Export everything so server.js can use it
module.exports = {
    TAX_LEVELS,
    HAPPINESS_BASELINE,
    HAPPINESS_MODIFIER_STRENGTH,
    REVOLT_HAPPINESS_THRESHOLD,
    SEASON_LENGTH,
    SEASONS,
    ADVISORS,
    allEvents,
    eventsMap
};
