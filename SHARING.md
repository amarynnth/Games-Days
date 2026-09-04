# Sharing Buzz Board

Two ways to let someone else host a game night. They solve different problems — read the trade-off before picking.

---

## Option A — Put it online (recommended)

You deploy it once. Your friend opens a web address on their laptop, casts it to the TV, and everyone scans the QR code. Nobody installs anything, nobody opens a terminal, and phones don't need to be on the same WiFi as the laptop.

### One-time setup (you, about 15 minutes)

1. **Put the code on GitHub.** Create a free account, make a new repository, and upload the whole `buzz-board` folder — but *not* `node_modules`. The files you need are `server.js`, `package.json`, `render.yaml`, `README.md`, and the `public/` and `games/` folders.

2. **Deploy it on Render.** Sign up free at render.com, choose **New → Web Service**, connect your GitHub account, and pick the repository. The included `render.yaml` fills in the settings, so you can accept the defaults and click create. First build takes a few minutes.

3. **Copy the address it gives you** — something like `https://buzz-board-xxxx.onrender.com`. That's the whole app. Send it to your friend.

### Running a game after that

- **Host screen:** your friend opens the address on the laptop and casts the tab to the TV.
- **Players:** scan the QR code on screen, or type the address into any browser.
- **You manage the questions:** edit or add files in the `games/` folder on GitHub. Render redeploys automatically within a couple of minutes, and the new game shows up in the dropdown.

### What to know before you commit to this

- **Free Render services sleep after inactivity.** The first person to open the link waits 30–60 seconds while it wakes. Load it a few minutes before the game starts and it's a non-issue.
- **The app has one shared game state.** Two households opening the link at the same time will land in the *same* game and fight over the same board. Fine if you take turns; a problem if you both want Friday night. Tell me if you need it and I'll add room codes so each group gets its own.
- **Buzz timing gets slightly less fair.** Locally, everyone's tap travels the same 20ms over the same WiFi. Over the internet, someone on strong 5G might beat someone on weak WiFi by 50ms on a genuine tie. For a party game it's unnoticeable; it's just not the dead-even race the local version is.
- **Anyone with the link can open the host board.** There's no password. Don't post it publicly.

---

## Option B — They run it themselves, no terminal

Better buzz fairness and no internet needed, but your friend's computer becomes the server and every phone must be on the same WiFi as it.

They'll still need **Node.js installed once** (nodejs.org, standard installer, no terminal). After that, add a double-clickable launcher to the folder:

**On a Mac** — create a file called `Start Game Night.command` containing:

```bash
#!/bin/bash
cd "$(dirname "$0")"
npm install --silent
open http://localhost:3000
npm start
```

Then, once, in Terminal: `chmod +x "Start Game Night.command"`. After that it's double-click forever. The first time they open it, macOS will warn about an unidentified developer — right-click the file and choose Open to get past it.

**On Windows** — create `Start Game Night.bat` containing:

```bat
@echo off
cd /d "%~dp0"
call npm install --silent
start http://localhost:3000
call npm start
```

Double-click and it runs. Windows Firewall will ask once whether to allow Node on private networks — they must say yes, or phones can't connect.

To share updated questions you send them the `.json` file and they drop it in `games/`.

---

## Which to pick

Go with **Option A** unless buzz timing down to the millisecond matters to you, or you're somewhere with unreliable internet. The no-install, no-terminal, works-from-anywhere trade is worth the small latency cost for a party game — and it means you can push a new set of questions on Friday afternoon without sending anyone a file.
