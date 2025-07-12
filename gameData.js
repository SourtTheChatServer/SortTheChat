// gameData.js

// --- CHANGE LOG ---
// 1. UPDATED: "The Prince of Almorg" event chain.
//    - Loan amount increased from 100 to 500 gold.
//    - A new flag, 'prince_is_enemy', is now used.
//    - Repaying the loan peacefully allows the prince to offer help again in the future.
//    - Refusing to repay and fighting the prince sets the 'prince_is_enemy' flag, permanently cutting off future aid from him.
// 2. UPDATED: "goblin_raid" event.
//    - The 'onYes' (fight) option is now a gamble with multiple outcomes.
//    - There is a 25% chance for a decisive victory that awards bonus treasure (gold or military armor).
//    - There is a chance for a standard victory or an outright defeat.
// 3. UPDATED: "kid_adventure_return" event.
//    - The 'onNo' path now has a slightly different outcome to better reflect player choice.
// 4. ADDED: New high-risk events ("The Living Chest", "The Gilded Blight").
// 5. ADDED: New narrative event chain ("The Cat, the Ball, and the Ruler").
// --- END CHANGE LOG ---


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

const EVENT_COOLDOWN_DAYS = 30;

const allEvents = [
    // --- User-Requested Events ---
    {
        id: 'grandma_coffee',
        petitioner: "An Old Grandma",
        text: "Oh, dearie. I'd love a nice cup of coffee from the tavern, but I'm just a few coins short. Could you spare a bit of gold for an old woman?",
        onYes: { text: "She blesses you with a warm smile. The tavern patrons notice your kindness.", effects: { treasury: -3, happiness: +3 } },
        onNo: { text: "She shuffles away sadly. It was only a few coins.", effects: {} }
    },
    {
        id: 'prince_loan_offer',
        petitioner: "The Smug Prince of Almorg",
        text: "Your Majesty. I couldn't help but notice your... empty-looking treasury. I would be *delighted* to offer you a loan of 500 gold. I'll return for it in 10 days, of course.",
        condition: (gs) => gs.treasury <= 0 && !gs.flags.has('prince_is_enemy'),
        onYes: {
            text: "He smirks. 'A pleasure doing business.' Your kingdom is saved, for now.",
            effects: { treasury: +500 },
            onSuccess: (gs) => { gs.flags.set('loan_from_prince', gs.day); }
        },
        onNo: { text: "You refuse his charity. With no funds and no prospects, your kingdom collapses into chaos.", triggersGameOver: true }
    },
    {
        id: 'prince_loan_collection',
        petitioner: "The Smug Prince of Almorg",
        text: "I've returned as promised for my 500 gold. I trust it's ready?",
        condition: (gs) => gs.flags.has('loan_from_prince') && gs.day >= gs.flags.get('loan_from_prince') + 10,
        onYes: {
            text: "He counts the coins and nods. 'Until next time.' The debt is settled.",
            effects: { treasury: -500 },
            clearFlags: ['loan_from_prince']
        },
        onNo: {
            text: "You refuse to pay. This is an act of war! His army marches on your kingdom.",
            clearFlags: ['loan_from_prince'],
            onSuccess: (gs) => { gs.flags.set('prince_is_enemy', true); },
            random_outcomes: [
                { chance: 0.5, text: "Against the odds, your forces claim a stunning victory! The debt is erased by the sword.", effects: { military: -10, happiness: +20 } },
                { chance: 0.5, text: "His professional army crushes yours. Your defeat is swift and humiliating.", effects: { military: -20, population: -15, happiness: -25, treasury: -50 } }
            ]
        }
    },
    {
        id: 'devil_bargain',
        petitioner: "A handsome, well-dressed man",
        text: "Greetings. I represent a foreign power with vast resources. I can solve your financial woes instantly. All I ask for is a small tithe of your population. Say, 10 souls?",
        onYes: { text: "He smiles, and it doesn't reach his eyes. 'The payment has been collected.'", effects: { population: -10, treasury: +200, happiness: -25 } },
        onNo: { text: "He vanishes in a puff of smoke. Your moral clarity inspires your people.", effects: { happiness: +5, population: +5 } }
    },
    {
        id: 'kid_adventure_start',
        petitioner: "An Eager-Eyed Kid",
        text: "Your Majesty! I'm going on a grand adventure! I just need a bit of funding... and maybe a few guards to carry my stuff. Please?",
        condition: (gs) => gs.treasury >= 25 && gs.military >= 10,
        onYes: { text: "He cheers and runs off, the guards struggling to keep up. Your people are charmed.", effects: { treasury: -25, military: -10, happiness: +5 }, onSuccess: (gs) => { gs.flags.set('kid_on_adventure', gs.day); } },
        onNo: { text: "The kid's face falls. He kicks a rock and trudges away.", effects: { happiness: -10 } }
    },
    {
        // *** MODIFIED EVENT ***
        id: 'kid_adventure_return',
        petitioner: "The Guard Captain",
        text: "He's back! The kid has returned from his adventure, looking muddy but triumphant. Shall we see what he found?",
        condition: (gs) => gs.flags.has('kid_on_adventure') && gs.day >= gs.flags.get('kid_on_adventure') + 3,
        onYes: {
            text: "You welcome the young hero back!",
            effects: { military: +10 },
            clearFlags: ['kid_on_adventure'],
            random_outcomes: [
                { chance: 0.05, text: "He found a dragon's nest and snagged a giant gem while it slept!", effects: { treasury: +500 } },
                { chance: 0.25, text: "He stumbled upon a goblin treasure hoard!", effects: { treasury: +200 } },
                { chance: 0.50, text: "He found a lost merchant's purse on the road.", effects: { treasury: +50 } },
                { chance: 0.20, text: "He proudly presents you with a... weirdly shaped rock.", effects: { treasury: +1 } }
            ]
        },
        onNo: {
            text: "You offer a perfunctory greeting before inspecting the haul. The kid looks a little disappointed by your lack of enthusiasm.",
            effects: { military: +10, happiness: -2 }, // Note: Differentiated effects
            clearFlags: ['kid_on_adventure'],
            random_outcomes: [
                { chance: 0.03, text: "He found a dragon's nest and snagged a giant gem while it slept!", effects: { treasury: +500 } },
                { chance: 0.22, text: "He stumbled upon a goblin treasure hoard!", effects: { treasury: +200 } },
                { chance: 0.55, text: "He found a lost merchant's purse on the road.", effects: { treasury: +50 } },
                { chance: 0.20, text: "He proudly presents you with a... weirdly shaped rock.", effects: { treasury: +1 } }
            ]
        }
    },

    // --- NEW: High-Risk, Tempting Events ---
    {
        id: 'living_chest_offer',
        petitioner: "A Grotesque, Living Chest",
        text: "It creaks open its single, bloodshot eye. A telepathic voice echoes in your mind: 'I hunger. You have... spare souls. I have... strength. Feed me 20 of your people, and I will grant your army impenetrable armor.'",
        condition: (gs) => gs.military < 40 && gs.population > 50,
        onYes: {
            text: "The chest's lid flies open with a horrifying shriek. A chilling wind sweeps through the throne room. You feel a great, silent loss across the kingdom, but your barracks captain reports the armor of your soldiers now glows with a faint, unholy light.",
            effects: { military: +35, population: -20, happiness: -25 }
        },
        onNo: {
            text: "You banish the abhorrent creature. It slams its eye shut and vanishes, leaving only the faint smell of ozone. Your people are relieved by your righteous choice.",
            effects: { happiness: +5 }
        }
    },
    {
        id: 'gilded_blight_offer',
        petitioner: "A smiling man in a golden mask",
        text: "Your people are so... morose. Unhappiness is a disease. I have the cure. For 150 gold, I can release a 'Golden Pollen' into the air. It will make everyone blissfully content. They will worry about nothing... not even work, or danger, or ambition.",
        condition: (gs) => gs.happiness < 30,
        onYes: {
            text: "You agree. The man bows, and soon a shimmering golden dust settles over the kingdom. The incessant complaining stops. A placid calm descends upon your people.",
            effects: { treasury: -150, happiness: +50 },
            // NOTE: For this flag to have a mechanical effect, a check must be added to the daily upkeep logic in server.js
            onSuccess: (gs) => { gs.flags.set('gilded_blight_active', true); } 
        },
        onNo: {
            text: "You refuse to resort to such measures. The man's smile tightens, and he fades from view. Your problems remain, but so does your people's free will.",
            effects: { happiness: +5 }
        }
    },

    // --- NEW: Narrative Event Chain (Cat Quest) ---
    {
        id: 'cat_quest_start',
        petitioner: "A small, anxious-looking cat",
        text: "Mrow... pardon, your Majesty. I seem to have misplaced my favorite ball. It's red, very bouncy, and answers to the name 'Sir Reginald.' Have you seen it?",
        onYes: {
            text: "The cat gives you a grateful slow-blink. 'Thank you, tall one. I will search the gardens again.'",
            effects: {},
            onSuccess: (gs) => { gs.flags.set('cat_quest_active', true); }
        },
        onNo: {
            text: "The cat's ears droop. It lets out a sad little 'mew' and slinks away.",
            effects: { happiness: -1 }
        }
    },
    {
        id: 'cat_quest_ball_encounter',
        petitioner: "A muffled voice from under your throne",
        text: "Psst! You! The ruler! That cat sent you, didn't she? Don't tell her where I am! She's a tyrant! She bats me under armoires and dunks me in water bowls! I'm finally free! Please, lie to her!",
        condition: (gs) => gs.flags.has('cat_quest_active'),
        onYes: {
            text: "The red ball vibrates with joy from its hiding spot. 'Oh, thank you! You won't regret this!'",
            effects: {},
            clearFlags: ['cat_quest_active'],
            onSuccess: (gs) => { gs.flags.set('sided_with_ball', gs.day); }
        },
        onNo: {
            text: "The ball lets out a tiny groan. 'You're a spoilsport. Fine. But don't expect me to come quietly.'",
            effects: {},
            clearFlags: ['cat_quest_active'],
            onSuccess: (gs) => { gs.flags.set('sided_with_cat', gs.day); }
        }
    },
    {
        id: 'cat_quest_cat_reward',
        petitioner: "The happy cat, batting Sir Reginald the ball",
        text: "I've got him! Thanks to your tip, I found him trying to roll out the main gate. He's a scamp! As thanks, I brought you a gift I found. It's very shiny.",
        condition: (gs) => gs.flags.has('sided_with_cat') && gs.day >= gs.flags.get('sided_with_cat') + 5,
        onYes: { 
            text: "The cat drops a large, glittering diamond at your feet. It must have belonged to a visiting noble.",
            effects: { treasury: +150, happiness: +5 },
            clearFlags: ['sided_with_cat']
        },
        onNo: {
            text: "You accept the shiny gift graciously.",
            effects: { treasury: +150, happiness: +5 },
            clearFlags: ['sided_with_cat']
        }
    },
    {
        id: 'cat_quest_ball_reward',
        petitioner: "The Guard Captain, looking puzzled",
        text: "Your Majesty, the oddest thing. We've been finding these exquisite, perfectly preserved mice behind various tapestries. The royal chefs say they're a rare delicacy. A... gift, perhaps?",
        condition: (gs) => gs.flags.has('sided_with_ball') && gs.day >= gs.flags.get('sided_with_ball') + 5,
        onYes: {
            text: "You graciously accept the strange but valuable tribute. The people are pleased with the unexpected bounty for the royal kitchens.",
            effects: { population: +10, happiness: +10 },
            clearFlags: ['sided_with_ball']
        },
        onNo: {
            text: "You have the strange gifts prepared for a feast. The people are pleased.",
            effects: { population: +10, happiness: +10 },
            clearFlags: ['sided_with_ball']
        }
    },

    // --- Advisor Events ---
    { id: 'recruit_general', petitioner: "A battle-scarred soldier", text: "My liege, our army is disorganized. For a salary, the legendary General Kael could lead our troops.", requiresNoAdvisor: 'general', onYes: { text: "General Kael accepts your offer.", effects: { military: +10 }, onSuccess: (gs) => { gs.advisors.set('general', true); } }, onNo: { text: "You decline. The army remains a rudderless ship.", effects: { happiness: -5 } } },
    { id: 'recruit_treasurer', petitioner: "A guild merchant", text: "Your Majesty, the economy is a tangled mess. Lady Elara's services are costly, but she can make tax collection 10% more effective.", requiresNoAdvisor: 'treasurer', condition: (gs) => gs.treasury > 200, onYes: { text: "Lady Elara joins your council.", effects: {}, onSuccess: (gs) => { gs.advisors.set('treasurer', true); } }, onNo: { text: "You decide your current methods are sufficient.", effects: {} } },
    { id: 'recruit_spymaster', petitioner: "A cloaked figure", text: "Knowledge is power, your Majesty. Secrets are a weapon. I can be your weapon... for a price.", requiresNoAdvisor: 'spymaster', onYes: { text: "The figure nods. 'My whispers will serve you.'", effects: {}, onSuccess: (gs) => { gs.advisors.set('spymaster', true); } }, onNo: { text: "The figure melts back into the shadows.", effects: {} } },
    { id: 'general_report', advisor: 'general', petitioner: () => ADVISORS.general.name, text: (gs) => `My liege, our military strength is ${gs.military}. I request 50 gold for training exercises.`, onYes: { text: "The training exercises are a success!", effects: { treasury: -50, military: +15 } }, onNo: { text: "'As you command,' the General says, disappointed.", effects: { happiness: -5 } } },
    { id: 'spymaster_report', advisor: 'spymaster', petitioner: () => ADVISORS.spymaster.name, text: "A whisper... A noble family plots against you. For 25 gold, I can... 'discourage' them.", onYes: { text: "The problem is dealt with. The nobles are suddenly very loyal.", effects: { treasury: -25, happiness: +10 } }, onNo: { text: "You let them be. Dissent grows.", effects: { happiness: -15 } } },

    // --- Other Chained & Standard Events ---
    { id: 'farmer_blight', petitioner: "A Farmer", text: "My liege, a terrible blight has struck our fields! We need 50 gold for new seeds.", onYes: { text: "The farmers are grateful! They promise to remember your generosity.", effects: { treasury: -50, happiness: +15 }, onSuccess: (gs) => { gs.flags.set('helped_farmer_blight', gs.day); } }, onNo: { text: "The farmers despair.", effects: { happiness: -15, population: -10 } } },
    { id: 'farmer_gratitude', petitioner: "The Farmer You Helped", text: "Your Majesty! Thanks to your aid, we had a bountiful harvest. Please, accept this share of our profits as thanks!", condition: (gs) => gs.flags.has('helped_farmer_blight') && gs.day >= gs.flags.get('helped_farmer_blight') + 15, onYes: { text: "You graciously accept their gift. The people's loyalty deepens.", effects: { treasury: +75, happiness: +10 }, clearFlags: ['helped_farmer_blight'] }, onNo: { text: "You refuse, stating it was your duty. They are touched by your humility.", effects: { happiness: +15 }, clearFlags: ['helped_farmer_blight'] } },
    { id: 'shady_merchant', petitioner: "A Shady Merchant", text: "Psst... a small investment of 20 gold could double your return!", onYes: { text: "The gamble pays off!", effects: { treasury: +20 }, onSuccess: (gs) => { gs.flags.set('trusted_shady_merchant', true); } }, onNo: { text: "You wisely refuse.", effects: { happiness: +5 } } },
    { id: 'shady_merchant_big_deal', petitioner: "The Shady Merchant", text: "You trusted me once, and it paid off! Now for a *real* opportunity. An overseas venture. It requires 200 gold. Are you in?", condition: (gs) => gs.flags.has('trusted_shady_merchant') && gs.treasury >= 200, onYes: { text: "You hand over the coin pouch... the merchant scurries away.", effects: { treasury: -200 }, clearFlags: ['trusted_shady_merchant'], random_outcomes: [ { chance: 0.5, text: "He returns with a chest of foreign silks! The investment was a massive success!", effects: { treasury: +500 } }, { chance: 0.5, text: "You never see him again. You've been had.", effects: { happiness: -20 } } ] }, onNo: { text: "You decide not to press your luck. The merchant shrugs and disappears.", effects: {}, clearFlags: ['trusted_shady_merchant'] } },
    { id: 'alchemist_offer', petitioner: "An Eccentric Alchemist", text: "Behold! My 'Elixir of Fortitude'! For just 40 gold, I can supply it to your guards. Their resolve will be unbreakable!", condition: (gs) => gs.military > 15, onYes: { text: "The alchemist mixes a bubbling green potion for the guards.", effects: { treasury: -40, military: +10, happiness: -5 } }, onNo: { text: "'Your loss!' the alchemist mutters, storming off.", effects: {} } },
    { id: 'inventor_proposal', petitioner: "A Pragmatic Inventor", text: "Your Majesty, I have designed a new type of plow that could revolutionize our farming. I need 100 gold to build the prototypes.", condition: (gs) => gs.population > 120, onYes: { text: "The investment pays off! Food production increases.", effects: { treasury: -100, population: +15 } }, onNo: { text: "The inventor sadly packs up her blueprints and seeks a more forward-thinking patron.", effects: { happiness: -5 } } },
    { id: 'border_dispute', petitioner: "A Stressed Diplomat", text: "A dispute has arisen with a neighboring kingdom over border territories. We can press our claim with military might, or seek a peaceful resolution.", condition: (gs) => gs.day > 50, onYes: { text: "You send a detachment of soldiers to secure the border. The neighbor backs down, for now.", effects: { military: +5, happiness: -5 } }, onNo: { text: "You cede the disputed land to maintain peace. Your neighbor is pleased, but some of your people see it as weakness.", effects: { treasury: +20, happiness: -10 } } },
    { id: 'traveling_circus', petitioner: "A Traveling Circus", text: "For 30 gold, our circus will perform and lift the spirits of your citizens!", onYes: { text: "The circus is a hit!", effects: { treasury: -30, happiness: +25 } }, onNo: { text: "The circus packs up and leaves.", effects: { happiness: -5 } } },
    { 
        // *** REWORKED EVENT ***
        id: 'goblin_raid', 
        petitioner: "A Scout", 
        text: (gs) => `Goblins are raiding the western farms! Our military strength is only ${gs.military}! We must act!`, 
        condition: (gs) => gs.military < 30, 
        onYes: { 
            text: "You order your troops to engage the goblin raiding party!",
            random_outcomes: [
                { chance: 0.10, text: "A stunning victory! Your troops crushed the goblins and found their treasure stash!", effects: { treasury: +75, happiness: +15 } },
                { chance: 0.15, text: "A stunning victory! Your troops routed the goblins and recovered a cache of surprisingly well-made goblin armor.", effects: { military: +10, happiness: +15 } },
                { chance: 0.50, text: "You repel the goblins, but not without cost. The western farms are safe, for now.", effects: { military: -5, happiness: +10, treasury: -10 } },
                { chance: 0.25, text: "The goblins were more numerous than expected! They broke your lines and pillaged freely before retreating.", effects: { military: -10, happiness: -15, population: -5 } }
            ]
        }, 
        onNo: { text: "You decide not to risk an engagement. The goblins raid several farms before retreating.", effects: { happiness: -15, population: -10, treasury: -20 } } 
    },
    { id: 'migrant_group', petitioner: "The Guard Captain", text: "A group of 20 migrants has arrived at the gates, seeking refuge.", onYes: { text: "You welcome them. They are hardworking and grateful.", effects: { population: +20, happiness: +5 } }, onNo: { text: "You turn the migrants away.", effects: { happiness: -10 } } },

    // --- Seasonal Events ---
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
    EVENT_COOLDOWN_DAYS,
    allEvents,
    eventsMap
};
