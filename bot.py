# drednot_bot.py
# FINAL VERSION - Merges the robust "shell" of the working bot
# with the internal game logic of the prototype.

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
USER_COOLDOWN_SECONDS = 2.0
SPAM_STRIKE_LIMIT = 3
SPAM_TIMEOUT_SECONDS = 30
SPAM_RESET_SECONDS = 5

# --- LOGGING & VALIDATION ---
logging.basicConfig(level=logging.INFO, format='[%(asctime)s] [%(levelname)s] %(message)s', datefmt='%Y-%m-%d %H:%M:%S')
if not SHIP_INVITE_LINK: logging.critical("FATAL: SHIP_INVITE_LINK environment variable is not set!"); exit(1)

class InvalidKeyError(Exception): pass

# --- JAVASCRIPT INJECTION SCRIPT (FROM THE WORKING BOT) ---
MUTATION_OBSERVER_SCRIPT = """
    window.isDrednotBotObserverActive = false; if (window.drednotBotMutationObserver) { window.drednotBotMutationObserver.disconnect(); console.log('[Bot-JS] Disconnected old observer.'); }
    window.isDrednotBotObserverActive = true; console.log('[Bot-JS] Initializing Observer with Dynamic Command List...'); window.py_bot_events = [];
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
                if (pText.includes("Joined ship '")) { const match = pText.match(/{[A-Z\\d]+}/); if (match && match[0]) window.py_bot_events.push({ type: 'ship_joined', id: match[0] }); continue; }
                const colonIdx = pText.indexOf(':'); if (colonIdx === -1) continue;
                const bdiElement = node.querySelector("bdi"); if (!bdiElement) continue;
                const username = bdiElement.innerText.trim(); const msgTxt = pText.substring(colonIdx + 1).trim();
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
    window.drednotBotMutationObserver = observer; console.log('[Bot-JS] Advanced Spam Detection is now active.');
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
    # ... all your other events are here ...
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
    # ... unchanged next_event logic ...
    pass
def handle_decision(choice, username):
    # ... unchanged handle_decision logic ...
    pass
def show_status(username):
    # ... unchanged show_status logic ...
    pass
def show_help(username):
    # ... unchanged show_help logic ...
    pass
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
    html = f"""<!DOCTYPE html><html>...</html>""" # Unchanged health check HTML
    return Response(html, mimetype='text/html')

def run_flask():
    port = int(os.environ.get("PORT", 8080))
    logging.info(f"Health check server listening on http://0.0.0.0:{port}")
    flask_app.run(host='0.0.0.0', port=port)

def queue_reply(message):
    # ... unchanged queue_reply logic ...
    pass

def message_processor_thread():
    # ... unchanged message_processor_thread logic ...
    pass

def reset_inactivity_timer():
    global inactivity_timer
    if inactivity_timer: inactivity_timer.cancel()
    inactivity_timer = threading.Timer(INACTIVITY_TIMEOUT_SECONDS, lambda: log_event("INACTIVITY: Timer expired. No action taken in this version."))

def fetch_command_list():
    global SERVER_COMMAND_LIST
    log_event("Loading static game command list...")
    SERVER_COMMAND_LIST = ["startgame", "endgame", "yes", "no", "status", "help"]
    log_event(f"Successfully loaded {len(SERVER_COMMAND_LIST)} game commands.")
    return True

def queue_browser_update():
    with driver_lock:
        if driver:
            log_event("Injecting/updating chat observer with game commands...")
            driver.execute_script(MUTATION_OBSERVER_SCRIPT, ZWSP, SERVER_COMMAND_LIST, USER_COOLDOWN_SECONDS, SPAM_STRIKE_LIMIT, SPAM_TIMEOUT_SECONDS, SPAM_RESET_SECONDS)

# --- MAIN BOT LOGIC (FROM WORKING BOT) ---
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
                # ... unchanged key login logic ...
                pass
            else:
                log_event("Playing as new guest.")
                play_btn = wait.until(EC.presence_of_element_located((By.XPATH, "//button[contains(., 'Play Anonymously')]")))
                driver.execute_script("arguments[0].click();", play_btn)
        except TimeoutException:
            logging.warning("Login procedure timed out. Assuming already in-game.")
        except Exception as e:
            raise e

        WebDriverWait(driver, 60).until(EC.presence_of_element_located((By.ID, "chat-input")))
        if not fetch_command_list(): raise RuntimeError("Initial command fetch failed.")

        queue_browser_update() # This injects the JS listener

        # Proactively find Ship ID
        PROACTIVE_SCAN_SCRIPT = """const chatContent = document.getElementById('chat-content'); if (!chatContent) { return null; } const paragraphs = chatContent.querySelectorAll('p'); for (const p of paragraphs) { const pText = p.textContent || ""; if (pText.includes("Joined ship '")) { const match = pText.match(/{[A-Z\\d]+}/); if (match && match[0]) { return match[0]; } } } return null;"""
        found_id = driver.execute_script(PROACTIVE_SCAN_SCRIPT)
        if found_id:
            BOT_STATE["current_ship_id"] = found_id
            log_event(f"Confirmed Ship ID via scan: {found_id}")
        else:
            log_event("No existing ID found. Waiting for live event...")
    
    BOT_STATE["status"] = "Running"
    queue_reply("Sort the Chat Bot is online! Type !startgame to begin.")
    reset_inactivity_timer()
    logging.info(f"Event-driven chat monitor active.")
    
    # --- MAIN LOOP (FROM WORKING BOT) ---
    while True:
        try:
            with driver_lock:
                if not driver: break
                new_events = driver.execute_script("return window.py_bot_events.splice(0, window.py_bot_events.length);")
            
            if new_events:
                reset_inactivity_timer()
                for event in new_events:
                    if event['type'] == 'ship_joined' and event['id'] != BOT_STATE.get("current_ship_id"):
                        BOT_STATE["current_ship_id"] = event['id']
                        log_event(f"Switched to new ship: {BOT_STATE['current_ship_id']}")
                    
                    elif event['type'] == 'command':
                        cmd, user, args = event['command'], event['username'], event['args']
                        command_str = f"!{cmd} {' '.join(args)}"
                        logging.info(f"RECV: '{command_str}' from {user}")
                        BOT_STATE["last_command_info"] = f"{command_str} (from {user})"
                        
                        # --- THIS IS THE ROUTING TO YOUR GAME LOGIC ---
                        route = { "startgame": start_game,
                                  "endgame": lambda u: end_game("You have abdicated the throne.", u),
                                  "yes": lambda u: handle_decision("!yes", u),
                                  "no": lambda u: handle_decision("!no", u),
                                  "status": show_status,
                                  "help": show_help }.get(cmd)
                        if route:
                            # Note: we ignore 'args' here because your game doesn't use them.
                            command_executor.submit(route, user)

                    elif event['type'] == 'spam_detected':
                        username, command = event['username'], event['command']
                        log_event(f"SPAM: Timed out '{username}' for {SPAM_TIMEOUT_SECONDS}s for spamming '!{command}'.")
        except WebDriverException as e:
            logging.error(f"WebDriver exception in main loop. Assuming disconnect: {e.msg}")
            raise
        time.sleep(MAIN_LOOP_POLLING_INTERVAL_SECONDS)

# --- MAIN EXECUTION (FROM WORKING BOT) ---
def main():
    threading.Thread(target=run_flask, daemon=True).start()
    threading.Thread(target=message_processor_thread, daemon=True).start()
    use_key_login = True
    restart_count = 0
    last_restart_time = time.time()
    while True:
        current_time = time.time()
        if current_time - last_restart_time < 3600:
            restart_count += 1
        else:
            restart_count = 1
        last_restart_time = current_time

        if restart_count > 10:
            log_event("CRITICAL: Bot is thrashing. Pausing for 5 minutes.")
            logging.critical("BOT RESTARTED >10 TIMES/HOUR. PAUSING FOR 5 MINS.")
            time.sleep(300)
        
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
            driver = None
            time.sleep(5)

if __name__ == "__main__":
    main()
