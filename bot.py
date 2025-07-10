# drednot_bot.py
# This is the "Game Host" version, upgraded with a robust JavaScript parser
# to fix the issue of not hearing commands.

import os
import queue
import atexit
import logging
import threading
import traceback
import random
import time
from datetime import datetime
from collections import deque
from threading import Lock
from concurrent.futures import ThreadPoolExecutor

from flask import Flask, Response
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import WebDriverException, TimeoutException, InvalidArgumentException

# --- CONFIGURATION ---
SHIP_INVITE_LINK = os.environ.get("SHIP_INVITE_LINK", 'https://drednot.io/invite/elFrrxDttMHVZa5UK25jT6Sk')
ANONYMOUS_LOGIN_KEY = os.environ.get("ANONYMOUS_LOGIN_KEY", '_M85tFxFxIRDax_nh-HYm1gT')

# Bot Behavior
MESSAGE_DELAY_SECONDS = 1.2
ZWSP = '\u200B'
INACTIVITY_TIMEOUT_SECONDS = 5 * 60
MAIN_LOOP_POLLING_INTERVAL_SECONDS = 0.05
MAX_WORKER_THREADS = 10

# Spam Control
USER_COOLDOWN_SECONDS = 1.0
SPAM_STRIKE_LIMIT = 5
SPAM_TIMEOUT_SECONDS = 30
SPAM_RESET_SECONDS = 5

# --- LOGGING & VALIDATION ---
logging.basicConfig(level=logging.INFO, format='[%(asctime)s] [%(levelname)s] %(message)s', datefmt='%Y-%m-%d %H:%M:%S')

if not SHIP_INVITE_LINK: logging.critical("FATAL: SHIP_INVITE_LINK environment variable is not set!"); exit(1)

class InvalidKeyError(Exception): pass

# --- JAVASCRIPT INJECTION SCRIPT (UPGRADED FOR MODERN DREDNOT.IO) ---
MUTATION_OBSERVER_SCRIPT = """
    window.isDrednotBotObserverActive = false; if (window.drednotBotMutationObserver) { window.drednotBotMutationObserver.disconnect(); console.log('[Bot-JS] Disconnected old observer.'); }
    window.isDrednotBotObserverActive = true; console.log('[Bot-JS] Initializing Upgraded Observer...'); window.py_bot_events = [];
    const zwsp = arguments[0], allCommands = arguments[1], cooldownMs = arguments[2] * 1000,
          spamStrikeLimit = arguments[3], spamTimeoutMs = arguments[4] * 1000, spamResetMs = arguments[5] * 1000;
    const commandSet = new Set(allCommands); window.botUserCooldowns = window.botUserCooldowns || {};
    window.botSpamTracker = window.botSpamTracker || {}; const targetNode = document.getElementById('chat-content');
    if (!targetNode) { return; }
    const callback = (mutationList, observer) => {
        const now = Date.now();
        for (const mutation of mutationList) {
            if (mutation.type !== 'childList') continue;
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== 1 || node.tagName !== 'P' || node.dataset.botProcessed) continue;
                node.dataset.botProcessed = 'true'; const pText = node.textContent || "";
                if (pText.startsWith(zwsp)) continue;
                
                // --- START OF NEW, ROBUST PARSING LOGIC ---
                // System messages like "Joined ship" or "It's only you here" are handled here.
                if (pText.includes("Joined ship '")) { 
                    const match = pText.match(/{[A-Z\\d]+}/); 
                    if (match && match[0]) window.py_bot_events.push({ type: 'ship_joined', id: match[0] }); 
                    continue; 
                }

                // A regular chat message must have a colon.
                const colonIdx = pText.indexOf(':');
                if (colonIdx === -1) continue;
                
                // Find all <bdi> tags. The last one is always the username.
                const bdiElements = node.querySelectorAll("bdi");
                if (bdiElements.length === 0) continue;
                const usernameElement = bdiElements[bdiElements.length - 1];
                const username = usernameElement.innerText.trim();
                
                // The command is everything after the colon.
                const msgTxt = pText.substring(colonIdx + 1).trim();
                // --- END OF NEW, ROBUST PARSING LOGIC ---

                if (!msgTxt.startsWith('!')) continue; const parts = msgTxt.slice(1).trim().split(/ +/);
                const command = parts.shift().toLowerCase(); if (!commandSet.has(command)) continue;
                
                const spamTracker = window.botSpamTracker[username] = window.botSpamTracker[username] || { count: 0, lastCmd: '', lastTime: 0, penaltyUntil: 0 };
                if (now < spamTracker.penaltyUntil) continue;
                const lastCmdTime = window.botUserCooldowns[username] || 0; if (now - lastCmdTime < cooldownMs) continue;
                window.botUserCooldowns[username] = now;
                if (now - spamTracker.lastTime > spamResetMs || command !== spamTracker.lastCmd) { spamTracker.count = 1; } else { spamTracker.count++; }
                spamTracker.lastCmd = command; spamTracker.lastTime = now;
                if (spamTracker.count >= spamStrikeLimit) {
                    spamTracker.penaltyUntil = now + spamTimeoutMs; spamTracker.count = 0;
                    window.py_bot_events.push({ type: 'spam_detected', username: username, command: command }); continue;
                }
                window.py_bot_events.push({ type: 'command', command: command, username: username, args: parts });
            }
        }
    };
    const observer = new MutationObserver(callback); observer.observe(targetNode, { childList: true });
    window.drednotBotMutationObserver = observer; console.log('[Bot-JS] Upgraded Spam Detection is now active.');
"""

# --- GLOBAL STATE & THREADING PRIMITIVES ---
message_queue = queue.Queue(maxsize=100)
driver_lock = Lock()
inactivity_timer = None
driver = None
SERVER_COMMAND_LIST = []
BOT_STATE = {"status": "Initializing...", "start_time": datetime.now(), "current_ship_id": "N/A", "last_command_info": "None yet.", "last_message_sent": "None yet.", "event_log": deque(maxlen=20)}
command_executor = ThreadPoolExecutor(max_workers=MAX_WORKER_THREADS, thread_name_prefix='CmdWorker')
atexit.register(lambda: command_executor.shutdown(wait=True))

# =========================================================================
# === SORT THE CHAT - GAME LOGIC (UNCHANGED) ===
# =========================================================================
GAME_STATE = {}
EVENT_DECK = []
game_lock = Lock()
EVENTS = [
    { "petitioner": "A Farmer", "text": "My liege, a terrible blight has struck our fields! We need 50 gold for new seeds or we'll starve.", "onYes": {"text": "The farmers are grateful! They begin replanting with the funds you provided.", "effects": {"treasury": -50, "happiness": 15, "population": 5}}, "onNo":  {"text": "The farmers despair. The blight spreads, and the harvest is meager.", "effects": {"happiness": -15, "population": -10}}},
    { "petitioner": "The Royal Architect", "text": "Your majesty, for 75 gold, I can build a grand aqueduct, improving sanitation and bringing fresh water to the city!", "onYes": {"text": "Construction begins! The aqueduct is a marvel of engineering, a symbol of your benevolent rule.", "effects": {"treasury": -75}, "modifier": {"source": "Aqueduct", "duration": 10, "effects": {"happiness": 2, "population": 1}}}, "onNo":  {"text": "The people grumble about the dusty streets and murky well water.", "effects": {"happiness": -5}}},
    { "petitioner": "A Shady-Looking Merchant", "text": "Psst, ruler... I've 'acquired' some exotic goods. A small investment of 20 gold could double your return!", "onYes": [ {"chance": 60, "text": "The gamble pays off! The merchant returns with 40 gold.", "effects": {"treasury": 20}}, {"chance": 30, "text": "The goods were a fad. The merchant returns with only your initial 20 gold. No harm done.", "effects": {"treasury": 0}}, {"chance": 10, "text": "It was a scam! The merchant disappears with your money.", "effects": {"treasury": -20, "happiness": -5}}], "onNo":  {"text": "You wisely refuse. The city guard later arrests the merchant for selling stolen property.", "effects": {"happiness": 5}}},
    { "petitioner": "The Tax Collector", "text": "Sire, the people complain the taxes are too high. Should we lower them to improve their mood?", "onYes": {"text": "The people rejoice at the tax break! Our treasury will see less income this season.", "effects": {"treasury": -30, "happiness": 15}}, "onNo":  {"text": "The people sigh, but pay their taxes as required. The treasury is stable.", "effects": {"happiness": -10}}},
    { "petitioner": "A Traveling Circus", "text": "We are the magnificent Marvelous circus! For a mere 30 gold, we will perform for your citizens and lift their spirits!", "onYes": {"text": "The circus is a hit! Laughter echoes through the city streets.", "effects": {"treasury": -30, "happiness": 25}}, "onNo":  {"text": "The circus packs up and leaves, taking their joy with them. The town feels a bit duller.", "effects": {"happiness": -5}}},
    { "petitioner": "The Captain of the Guard", "text": "My lord, our equipment is outdated. 40 gold would supply the guards with new steel armor and weapons, making the city safer.", "onYes": {"text": "The guards stand taller and prouder with their new gear. Crime rates drop.", "effects": {"treasury": -40, "happiness": 10}}, "onNo":  {"text": "The guards continue their patrols, but their effectiveness is limited by their old gear.", "effects": {"happiness": -5}}},
    { "petitioner": "An Alchemist", "text": "Your eminence! My research into turning lead into gold is nearly complete. I require a 60 gold grant to finish my magnum opus!", "onYes": [ {"chance": 5, "text": "He did it! The madman actually did it! He hands you a lump of pure gold worth 200 gold before mysteriously vanishing.", "effects": {"treasury": 140, "happiness": 10}}, {"chance": 25, "text": "The experiment resulted in a powerful new fertilizer. The fields will be extra bountiful next season.", "effects": {"treasury": -60, "population": 15, "happiness": 5}}, {"chance": 70, "text": "A small explosion rocks the lab. The alchemist sheepishly reports that he has failed, and your gold is gone.", "effects": {"treasury": -60, "happiness": -5}}], "onNo":  {"text": "You dismiss the alchemist as a charlatan. He leaves the city, dejected.", "effects": {}}},
]

def format_effects(effects):
    parts = []; symbols = {"treasury": '💰', "happiness": '😊', "population": '👨‍👩‍👧‍👦'}
    for stat, value in effects.items(): parts.append(f"{'+' if value > 0 else ''}{value} {symbols.get(stat, stat)}")
    return ", ".join(parts)
def shuffle_event_deck():
    global EVENT_DECK; logging.info("Shuffling the event deck..."); EVENT_DECK = EVENTS[:]; random.shuffle(EVENT_DECK)
def start_game(username):
    global GAME_STATE
    with game_lock:
        if GAME_STATE.get("gameActive"): queue_reply("A game is already in progress. Use !endgame to stop it."); return
        GAME_STATE = {"day": 0, "treasury": 100, "happiness": 50, "population": 100, "gameActive": True, "isAwaitingDecision": False, "currentEvent": None, "modifiers": []}
        log_event(f"GAME: New game started by {username}.")
        queue_reply(["A new reign begins! Rule your kingdom with wisdom.", "Commands: !yes, !no, !status, !help, !endgame"]); shuffle_event_deck()
    command_executor.submit(lambda: (time.sleep(MESSAGE_DELAY_SECONDS * 2), next_event()))
def end_game(reason, username):
    global GAME_STATE
    with game_lock:
        if not GAME_STATE.get("gameActive"): return
        log_event(f"GAME: Game ended by {username}. Reason: {reason}")
        queue_reply([f"--- Your reign has ended after {GAME_STATE.get('day', 0)} days. ---", f"Reason: {reason}", f"Final Stats: {GAME_STATE.get('treasury', 0)} gold, {GAME_STATE.get('happiness', 0)} happiness, {GAME_STATE.get('population', 0)} people.", "Type !startgame to play again."])
        GAME_STATE["gameActive"] = False; GAME_STATE["isAwaitingDecision"] = False
def next_event():
    global GAME_STATE
    with game_lock:
        if not GAME_STATE.get("gameActive"): return
        modifier_log = []; expired_modifiers = []
        for mod in GAME_STATE.get("modifiers", []):
            for stat, effect in mod["effects"].items(): GAME_STATE[stat] += effect
            mod["duration"] -= 1; modifier_log.append(f"{format_effects(mod['effects'])} from {mod['source']}")
            if mod["duration"] <= 0: expired_modifiers.append(mod)
        GAME_STATE["modifiers"] = [mod for mod in GAME_STATE["modifiers"] if mod not in expired_modifiers]
        if modifier_log: queue_reply(f"Daily upkeep: {', '.join(modifier_log)}")
        if GAME_STATE.get("treasury", 0) < 0: end_game("The kingdom is bankrupt!", "System"); return
        if GAME_STATE.get("happiness", 0) <= 0: end_game("The people have revolted due to unhappiness!", "System"); return
        if GAME_STATE.get("population", 0) <= 0: end_game("The kingdom has become a ghost town.", "System"); return
        GAME_STATE["day"] += 1;
        if not EVENT_DECK: shuffle_event_deck()
        GAME_STATE["currentEvent"] = EVENT_DECK.pop(); GAME_STATE["isAwaitingDecision"] = True
        event = GAME_STATE["currentEvent"]
        queue_reply([f"--- Day {GAME_STATE['day']} ---", f"{event['petitioner']} approaches the throne.", f"\"{event['text']}\"", "How do you respond? (!yes / !no)"])
def handle_decision(choice, username):
    global GAME_STATE
    with game_lock:
        if not GAME_STATE.get("gameActive") or not GAME_STATE.get("isAwaitingDecision"): return
        log_event(f"GAME: {username} chose '{choice}'."); GAME_STATE["isAwaitingDecision"] = False
        event = GAME_STATE["currentEvent"]; decision_key = 'onYes' if choice == '!yes' else 'onNo'; outcomes = event[decision_key]
        if not isinstance(outcomes, list): outcomes = [outcomes]
        total_chance = sum(o.get("chance", 100) for o in outcomes); roll = random.uniform(0, total_chance)
        chosen_outcome = next((o for o in outcomes if (roll := roll - o.get("chance", 100)) < 0), outcomes[-1])
        if "effects" in chosen_outcome:
            for stat, value in chosen_outcome["effects"].items(): GAME_STATE[stat] += value
        if "modifier" in chosen_outcome: GAME_STATE["modifiers"].append(dict(chosen_outcome["modifier"]))
        effects_str = format_effects(chosen_outcome.get("effects", {})); feedback = f"{chosen_outcome['text']} ({effects_str})" if effects_str else chosen_outcome['text']
        queue_reply(feedback)
    command_executor.submit(lambda: (time.sleep(MESSAGE_DELAY_SECONDS * 4), next_event()))
def show_status(username):
    global GAME_STATE
    with game_lock:
        if not GAME_STATE.get("gameActive"): queue_reply("There is no active game. Type !startgame to begin."); return
        lines = [f"--- Kingdom Status (Day {GAME_STATE['day']}) ---", f"💰 Treasury: {GAME_STATE['treasury']}", f"😊 Happiness: {GAME_STATE['happiness']}", f"👨‍👩‍👧‍👦 Population: {GAME_STATE['population']}"]
        if GAME_STATE.get("modifiers"):
            lines.append("--- Active Effects ---")
            for mod in GAME_STATE["modifiers"]: lines.append(f"• {mod['source']} ({mod['duration']}d left)")
        queue_reply(lines)
def show_help(username):
    queue_reply(["--- Sort the Chat Help ---", "This is a kingdom management game where you rule by making decisions.", "Reply with !yes or !no to each petitioner.", "Your decisions affect your Treasury 💰, Happiness 😊, and Population 👨‍👩‍👧‍👦.", "Try to keep your kingdom thriving for as long as possible!", "Commands: !startgame, !endgame, !yes, !no, !status, !help"])
# =========================================================================

def log_event(message):
    timestamp = datetime.now().strftime('%H:%M:%S')
    full_message = f"[{timestamp}] {message}"
    BOT_STATE["event_log"].appendleft(full_message)
    logging.info(f"EVENT: {message}")

def setup_driver():
    logging.info("Launching headless browser for Docker environment...")
    chrome_options = Options()
    try:
        chrome_options.binary_location = "/usr/bin/chromium"
        service = Service(executable_path="/usr/bin/chromedriver")
    except (FileNotFoundError, InvalidArgumentException):
        logging.warning("Chromium/chromedriver not found at /usr/bin/. Assuming local non-Docker setup.")
        service = Service()

    chrome_options.add_argument("--headless=new"); chrome_options.add_argument("--no-sandbox")
    chrome_options.add_argument("--disable-dev-shm-usage"); chrome_options.add_argument("--disable-gpu")
    chrome_options.add_argument("--disable-extensions"); chrome_options.add_argument("--disable-infobars")
    chrome_options.add_argument("--mute-audio"); chrome_options.add_argument("--disable-setuid-sandbox")
    chrome_options.add_argument("--disable-images"); chrome_options.add_argument("--blink-settings=imagesEnabled=false")
    return webdriver.Chrome(service=service, options=chrome_options)

flask_app = Flask('')
@flask_app.route('/')
def health_check():
    html = f"""<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="refresh" content="10"><title>Drednot Bot Status</title><style>body{{font-family:'Courier New',monospace;background-color:#1e1e1e;color:#d4d4d4;padding:20px;}}.container{{max-width:800px;margin:auto;background-color:#252526;border:1px solid #373737;padding:20px;border-radius:8px;}}h1,h2{{color:#4ec9b0;border-bottom:1px solid #4ec9b0;padding-bottom:5px;}}p{{line-height:1.6;}}.status-ok{{color:#73c991;font-weight:bold;}}.label{{color:#9cdcfe;font-weight:bold;}}ul{{list-style-type:none;padding-left:0;}}li{{background-color:#2d2d2d;margin-bottom:8px;padding:10px;border-radius:4px;white-space:pre-wrap;word-break:break-all;}}</style></head><body><div class="container"><h1>Drednot Bot Status (Game Edition)</h1><p><span class="label">Status:</span><span class="status-ok">{BOT_STATE['status']}</span></p><p><span class="label">Current Ship ID:</span>{BOT_STATE['current_ship_id']}</p><p><span class="label">Last Command:</span>{BOT_STATE['last_command_info']}</p><p><span class="label">Last Message Sent:</span>{BOT_STATE['last_message_sent']}</p><h2>Recent Events (Log)</h2><ul>{''.join(f'<li>{event}</li>' for event in BOT_STATE['event_log'])}</ul></div></body></html>"""
    return Response(html, mimetype='text/html')

def run_flask():
    port = int(os.environ.get("PORT", 8080))
    logging.info(f"Health check server listening on http://0.0.0.0:{port}")
    flask_app.run(host='0.0.0.0', port=port)

def queue_reply(message):
    MAX_LEN = 199
    lines = message if isinstance(message, list) else [message]
    for line in lines:
        text = str(line)
        while len(text) > 0:
            try:
                if len(text) <= MAX_LEN:
                    if text.strip(): message_queue.put(ZWSP + text, timeout=5)
                    break
                else:
                    bp = text.rfind(' ', 0, MAX_LEN)
                    chunk = text[:bp if bp > 0 else MAX_LEN].strip()
                    if chunk: message_queue.put(ZWSP + chunk, timeout=5)
                    text = text[bp if bp > 0 else MAX_LEN:].strip()
            except queue.Full:
                logging.warning("Message queue is full. Dropping message."); log_event("WARN: Message queue full."); break

def message_processor_thread():
    while True:
        message = message_queue.get()
        try:
            with driver_lock:
                if driver:
                    driver.execute_script("const msg=arguments[0];const chatBox=document.getElementById('chat');const chatInp=document.getElementById('chat-input');const chatBtn=document.getElementById('chat-send');if(chatBox&&chatBox.classList.contains('closed')){chatBtn.click();}if(chatInp){chatInp.value=msg;}chatBtn.click();", message)
            clean_msg = message[1:]; logging.info(f"SENT: {clean_msg}"); BOT_STATE["last_message_sent"] = clean_msg
        except WebDriverException: logging.warning("Message processor: WebDriver not available.")
        except Exception as e: logging.error(f"Unexpected error in message processor: {e}")
        time.sleep(MESSAGE_DELAY_SECONDS)

def reset_inactivity_timer():
    global inactivity_timer
    if inactivity_timer: inactivity_timer.cancel()
    inactivity_timer = threading.Timer(INACTIVITY_TIMEOUT_SECONDS, lambda: log_event("INACTIVITY: Timer expired. No action taken in this version."))

def fetch_command_list():
    """Statically defines the command list for this game. Returns success."""
    global SERVER_COMMAND_LIST
    log_event("Loading static game command list...")
    SERVER_COMMAND_LIST = ["startgame", "endgame", "yes", "no", "status", "help"]
    log_event(f"Successfully loaded {len(SERVER_COMMAND_LIST)} game commands.")
    return True

def queue_browser_update():
    """Re-injects the JS observer with the current command list."""
    with driver_lock:
        if driver:
            log_event("Injecting/updating chat observer with game commands...")
            driver.execute_script(MUTATION_OBSERVER_SCRIPT, ZWSP, SERVER_COMMAND_LIST, USER_COOLDOWN_SECONDS, SPAM_STRIKE_LIMIT, SPAM_TIMEOUT_SECONDS, SPAM_RESET_SECONDS)

def start_bot(use_key_login):
    global driver
    BOT_STATE["status"] = "Launching Browser..."; log_event("Performing full start...")
    driver = setup_driver()
    
    with driver_lock:
        logging.info(f"Navigating to invite link..."); driver.get(SHIP_INVITE_LINK)
        wait = WebDriverWait(driver, 15)
        
        try:
            btn = wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, ".modal-container .btn-green")))
            driver.execute_script("arguments[0].click();", btn)
            logging.info("Clicked 'Accept' on notice.")
            
            if ANONYMOUS_LOGIN_KEY and use_key_login:
                 log_event("Attempting login with hardcoded key.")
                 link = wait.until(EC.presence_of_element_located((By.XPATH, "//a[contains(., 'Restore old anonymous key')]")))
                 driver.execute_script("arguments[0].click();", link)
                 wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, 'div.modal-window input[maxlength="24"]'))).send_keys(ANONYMOUS_LOGIN_KEY)
                 submit_btn = wait.until(EC.presence_of_element_located((By.XPATH, "//div[.//h2[text()='Restore Account Key']]//button[contains(@class, 'btn-green')]")))
                 driver.execute_script("arguments[0].click();", submit_btn)
                 wait.until(EC.invisibility_of_element_located((By.XPATH, "//div[.//h2[text()='Restore Account Key']]")))
                 wait.until(EC.any_of(EC.presence_of_element_located((By.ID, "chat-input")), EC.presence_of_element_located((By.XPATH, "//h2[text()='Login Failed']"))))
                 if driver.find_elements(By.XPATH, "//h2[text()='Login Failed']"):
                     raise InvalidKeyError("Login Failed! Key may be invalid.")
                 log_event("✅ Successfully logged in with key.")
            else:
                 log_event("Playing as new guest.")
                 play_btn = wait.until(EC.presence_of_element_located((By.XPATH, "//button[contains(., 'Play Anonymously')]")))
                 driver.execute_script("arguments[0].click();", play_btn)
        except TimeoutException:
            logging.warning("Login procedure timed out or elements not found. Assuming already in-game.")
            log_event("Login timeout; assuming in-game.")
        except InvalidKeyError as e:
            raise e
        except Exception as e:
            log_event(f"Login/entry sequence failed: {e}")
            raise e

        log_event("Waiting for game UI to be fully ready...")
        try:
            WebDriverWait(driver, 60).until(EC.presence_of_element_located((By.ID, "chat-input")))
            log_event("✅ Game UI is ready. The bot can now see and hear.")
        except TimeoutException:
            log_event("CRITICAL: Game UI did not load within 60 seconds. The bot cannot continue.")
            raise RuntimeError("Timed out waiting for the main game interface to load.")

        log_event("Setting up the command listener...")
        if not fetch_command_list():
            raise RuntimeError("Could not load the internal command list.")
        queue_browser_update()
        log_event("✅ Command listener is active.")
    
    BOT_STATE["status"] = "Running"
    queue_reply("Sort the Chat Bot is online! Type !startgame to begin.")
    reset_inactivity_timer()
    logging.info("Event-driven chat monitor active.")
    
    while True:
        try:
            with driver_lock:
                if not driver: break
                new_events = driver.execute_script("return window.py_bot_events.splice(0, window.py_bot_events.length);")
            
            if new_events:
                reset_inactivity_timer()
                for event in new_events:
                    if event['type'] == 'ship_joined':
                        BOT_STATE["current_ship_id"] = event['id']
                        log_event(f"Joined/Identified ship: {BOT_STATE['current_ship_id']}")
                    
                    elif event['type'] == 'command':
                        cmd, user = event['command'], event['username']
                        command_str = f"!{cmd}"
                        logging.info(f"RECV: '{command_str}' from {user}")
                        BOT_STATE["last_command_info"] = f"{command_str} (from {user})"
                        
                        route = { "startgame": start_game,
                                  "endgame": lambda u: end_game("You have abdicated the throne.", u),
                                  "yes": lambda u: handle_decision("!yes", u),
                                  "no": lambda u: handle_decision("!no", u),
                                  "status": show_status,
                                  "help": show_help }.get(cmd)
                        if route: command_executor.submit(route, user)

                    elif event['type'] == 'spam_detected':
                        username, command = event['username'], event['command']
                        log_event(f"SPAM: Timed out '{username}' for {SPAM_TIMEOUT_SECONDS}s for spamming '!{command}'.")

        except WebDriverException as e:
            logging.error(f"WebDriver exception in main loop. Assuming disconnect: {e.msg}")
            raise
        time.sleep(MAIN_LOOP_POLLING_INTERVAL_SECONDS)

def main():
    threading.Thread(target=run_flask, daemon=True).start()
    threading.Thread(target=message_processor_thread, daemon=True).start()
    use_key_login = True
    while True:
        try:
            start_bot(use_key_login)
        except InvalidKeyError as e:
            BOT_STATE["status"] = "Invalid Key!"; err_msg = f"CRITICAL: {e}. Switching to Guest Mode for next restart."
            log_event(err_msg); logging.error(err_msg); use_key_login = False
        except Exception as e:
            BOT_STATE["status"] = "Crashed! Restarting..."; log_event(f"CRITICAL ERROR: {e}")
            logging.critical(f"Full restart. Reason: {e}"); traceback.print_exc()
        finally:
            global driver
            if inactivity_timer: inactivity_timer.cancel()
            if driver:
                try: driver.quit()
                except: pass
            driver = None;
            time.sleep(5)

if __name__ == "__main__":
    main()
