# Buzz Board

A Jeopardy-style quiz board that runs on your laptop, displays on a TV, and turns everyone's phone into a buzzer. No internet needed — just one WiFi network.

## Run it

```bash
npm install
npm start
```

The terminal prints two addresses:

- **`http://localhost:3000`** — open this on the laptop, drag it to the TV, press `F` for fullscreen.
- **`http://192.168.x.x:3000/play`** — this is what the QR code points to. Players scan it or type it in.

## Hosting a game

1. Connect the laptop to the TV and open the board. The start screen shows the QR code, the rules, and the setup panel.
2. Add your teams (or leave the list empty to score people individually). Players scan, enter a name, pick a team.
3. Pick a game from the dropdown and press **Start game**.
4. Click a dollar value. Read the clue out loud, then press **space** to open the buzzers.
5. First name to buzz goes up on the screen with everyone else's lag behind it. Press **Y** for right, **N** for wrong.
6. **Archive & finish** writes the whole game to `archives/`.

### Keyboard shortcuts

| Key | Does |
| --- | --- |
| `space` | Open buzzers / re-open / dismiss the Daily Double card |
| `Y` / `N` | Right / wrong |
| `P` | Pause and resume the clock |
| `T` | Change both clock lengths without leaving the game |
| `R` | Reveal the answer on screen |
| `A` | Peek at the answer (host only — hide it before the TV sees) |
| `Esc` | Close the clue, mark it used, back to the board |
| `F` | Fullscreen |

Click any score card to correct it by hand.

## How scoring works

- **Everyone gets one buzz per clue.** Teammates can queue up behind each other.
- **A miss knocks out the whole team.** Points come off the team score and the clue passes to the next team in the queue — teammates further down the line are skipped.
- **Running out the clock counts as wrong.** Same deduction, same hand-off.
- **Daily Doubles pay double, both ways.** A $600 Daily Double is worth $1,200 right and −$1,200 wrong. Buzzers work as normal.

## Timers

Two clocks, both shown as a bar on the TV and a ring around the buzzer on phones:

- **Buzz window** — how long the buzzers stay open before the clue dies unanswered. Default 8 seconds.
- **Answer clock** — starts the moment someone buzzes. Default 10 seconds.

Set both on the start screen under **Clocks**. Enter `0` for either to turn that clock off — buzzers then stay open until you close the clue by hand.

A game file can also carry its own timings:

```json
"timers": { "buzz": 8, "answer": 10 }
```

Whichever you touched last wins, with one rule: once you type a value on the start screen it becomes *your* setting and loading a game file won't overwrite it. Press **Let the game file decide** to hand control back.

Press `P` any time to freeze the clock — useful when someone interrupts or you need to rule on a close answer. Press `T` mid-game to change the lengths without going back to the start screen; the new values apply from the next clue.

## Writing your own game

Copy `games/template.json`, rename it, fill it in, drop it back in `games/`. It appears in the dropdown on the next page refresh.

```json
{
  "title": "Friday Trivia",
  "timers": { "buzz": 8, "answer": 10 },
  "rounds": [
    {
      "name": "Round 1",
      "dailyDoubles": 1,
      "categories": [
        {
          "name": "CATEGORY NAME",
          "clues": [
            { "value": 200, "clue": "Shown on the TV", "answer": "Checked by you" },
            { "value": 400, "clue": "...", "answer": "...", "dailyDouble": true }
          ]
        }
      ]
    }
  ],
  "final": { "category": "", "clue": "", "answer": "" }
}
```

Two ways to place a Daily Double, and they don't mix — hand-placed wins:

- **Hand-placed:** add `"dailyDouble": true` to the clue you want.
- **Random:** set `"dailyDoubles": 1` on the round and leave every clue unmarked. One gets picked at random each time the game loads, so the same file plays differently every time.

Either way the tile looks identical to every other tile on the board. Nothing gives it away until it's clicked.

Five or six categories fills a TV nicely.

## Managing the room

The start screen lists everyone as a chip:

- **×** on a chip removes that person. Their phone drops back to the name screen.
- **Drop anyone offline** clears out phones that wandered off, leaving active players alone.
- **Remove everyone** empties the room for a fresh group.
- The little dropdown on each chip moves someone between teams.

**New game** returns to the start screen with scores zeroed and everyone still joined, so you can prune from there.

## Family Feud mode

Drop a file with `"type": "feud"` into `games/` and it appears in the same dropdown. The board switches to Feud automatically — teams, buzzers, timers, scoreboard and archiving all work the same.

### Running a Feud round

1. Pick a question from the grid. Tiles show numbers only — **1, 2, 3** — so nobody reads ahead. Round tabs across the top switch between rounds; the **FM** tile opens Fast Money.
2. Press **space** to open the buzzers for the face-off. First person to buzz shows on screen.
3. **Give them the board**, or **Pass to the other side** if they'd rather not play it.
4. Players shout answers out. **Type what they said into the box and press Enter** — the board finds the matching slot itself, so you never have to remember which tile is which. It forgives typos, plurals and alternate wordings ("box milk" finds Milk, "shugar" finds Sugar). If nothing matches it says so in red and leaves the board alone. You can still click any slot to flip it over — the points drop into the pot, multiplied if the round says so. Click a revealed slot again to hide it if you flipped the wrong one.
5. Need to put someone on the clock? **10s / 20s / 30s** buttons sit above the type-in box, with the countdown across the board. `P` pauses it, **Stop** clears it. Nothing happens automatically when it runs out — it's there for pressure, you still make the call.
6. **Strike (X)** for a miss. Three strikes hands the steal to the other side, who get one guess.
7. **Award to <team>** drops the pot onto that team's score.
8. **Show the rest** flips the remaining answers for the room — it does not add to the pot.
9. **Next question** (Esc) marks it used and returns to the grid.

Rounds with a `multiplier` are worth double or triple; the board says so under the question.

### Fast Money

If the file has a `fastMoney` block, a **Fast Money** button sits in the top bar the whole game — press it any time. The same thing appears as a tile at the bottom of the question grid. Press it again (it reads "Back to board") to return.

Two players, five questions, a running total against a target (200 by default). Type each player's answer into its cell and press Enter — same matching as the main board. Points stay hidden until you click the number beside the cell, so you can reveal one at a time like the show. **20s** and **25s** clock buttons run the countdown on screen.

If player two repeats an answer player one already gave, the cell shows **DUP** and scores zero.

```json
"fastMoney": {
  "target": 200,
  "questions": [
    {
      "prompt": "Name something you do first thing when you wake up",
      "answers": [
        { "text": "Check the phone", "points": 34, "alt": ["phone", "scroll"] }
      ]
    }
  ]
}
```

### Alternate wordings

Any answer, in either mode, can carry an `alt` list of other ways people say it:

```json
{ "text": "Bread", "points": 31, "alt": ["hard dough", "bulla"] }
```

Worth filling in for anything with a local name — it saves you overruling the board mid-round.

### Writing a Feud file

```json
{
  "type": "feud",
  "title": "Monday Family Feud",
  "rounds": [
    {
      "name": "Round 2 — double points",
      "multiplier": 2,
      "questions": [
        {
          "prompt": "Name something people take to the beach",
          "answers": [
            { "text": "Towel", "points": 33 },
            { "text": "Cooler", "points": 25 }
          ]
        }
      ]
    }
  ]
}
```

Answers get sorted highest-first automatically, so you can list them in any order. A `multiplier` on a single question overrides the round's. Five or six answers per question fits the screen best; more than six splits into two columns.

## Archives

Every finished game lands in `archives/` as a timestamped JSON file with final scores, team rosters, duration, and which clues got used. Copy an old file into `games/` to replay it.

## If phones can't connect

- **Everyone must be on the same WiFi as the laptop.** Guest networks and most office WiFi block device-to-device traffic on purpose.
- **The fix that always works:** turn on a hotspot from your phone, connect the laptop to it, and have everyone else join the hotspot too. Restart the server so it picks up the new address.
- If the printed address looks wrong (a `172.x` or `169.254.x` from a VPN or virtual adapter), disconnect the VPN and restart.
- On a Mac you may get a firewall prompt on first run — allow incoming connections for Node.

## Notes

- Buzz order is decided by arrival time at the server, so everyone is judged on the same clock rather than their own phone's.
- Timers are also driven by the server, and phones correct for clock drift, so the countdown you see on the TV matches the one on every phone.
- Phones reconnect automatically if they sleep — scores are kept against a stored ID, not the connection.
