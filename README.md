# ObliterateEverything 3 — Local Revival

ObliterateEverything 3 (OE3) was a Flash tower-defense game. This project lets you play it again using a local Node.js backend server and the [Ruffle](https://ruffle.rs) Flash emulator.

All accounts, progress, and item drops are stored locally in `server/data/players/`.

---

## Requirements

- **[Node.js](https://nodejs.org/)** v14 or later — runs the backend server (no npm install needed)
- **[Ruffle Desktop](https://ruffle.rs/#downloads)** — plays the SWF file (Flash emulator)

---

## Setup

1. Download or clone this repository.
2. That's it — no dependencies to install.

---

## Playing

**Step 1 — Start the server**

Open a terminal in this folder and run:

```
node server/server.js
```

You should see:
```
OE3 Local Backend Server
========================
Listening on 127.0.0.1:8123
Waiting for the game to connect...
```

Keep this terminal open while playing.

**Step 2 — Open the game**

Open `OE3_Local.swf` with Ruffle Desktop.

- On the login screen, enter any username and password. A new account is created automatically on first login.
- Your progress is saved to `server/data/players/<username>.json`.

---

## Notes

- **Singleplayer only** — multiplayer is stubbed out.
- **Platinum is free** — click the platinum store button and purchase any tier; it's credited instantly.
- **Item packs** — 6 rotating packs refresh each login. Each costs platinum and gives 5 items. I made a guess based on my memory of about what things were like. I plan to keep rounding out the rough edges, but I wanted to share this since I got it to work. Originally when I started to study computer science one of the reasons was to create games like this, and maybe I am not there yet, but I am happy I can revive a classic like this.
