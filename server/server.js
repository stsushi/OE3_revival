'use strict';

const net  = require('net');
const fs   = require('fs');
const path = require('path');

const { getPriceArgs, getSellPrice, newPlayer, PRICE_TABLE } = require('./items');
const {
  processMissionResult,
  resetCampaign,
  buildCampaignArgs,
  buildArmoryArgs,
  buildFullArmoryArgs,
  upgradeItem,
  sellItem,
  buyItem,
  generateShopItems,
  combineVault,
  generateRandomPacks,
  packsToWireArgs,
} = require('./campaign');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT        = 8123;
const PLAYERS_DIR = path.join(__dirname, 'data', 'players');

if (!fs.existsSync(PLAYERS_DIR)) fs.mkdirSync(PLAYERS_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Player persistence
// ---------------------------------------------------------------------------
function playerFile(username) {
  // Sanitize username to be a safe filename
  const safe = username.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(PLAYERS_DIR, safe + '.json');
}

function loadPlayer(username) {
  const f = playerFile(username);
  if (!fs.existsSync(f)) return null;
  try   { return JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch { return null; }
}

function savePlayer(player) {
  const f = playerFile(player.username);
  fs.writeFileSync(f, JSON.stringify(player, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Wire protocol helpers
// ---------------------------------------------------------------------------

// Send one message to a socket.  XMLSocket expects null-terminated strings;
// we send the message text followed by \0.
function send(socket, type, ...args) {
  const parts = [type, ...args.map(String)];
  socket.write(parts.join('\t') + '\0');
}

// Send the full account state to the client after login/create.
function sendFullState(socket, player) {
  // Stats
  send(socket, 'sstats',
    player.credits,
    player.stations,
    player.maxinventory,
    player.bonus,
    player.rating,
    player.wins,
    player.losses
  );

  // Platinum
  send(socket, 'splat', player.platinum);

  // Armory (flat int4 groups) — padded to maxinventory so BuyItemPack null-slot check passes
  const armArgs = buildFullArmoryArgs(player);
  send(socket, 'srarmory', ...armArgs);

  // Equip map
  send(socket, 'srequip', ...player.equipmap);

  // Campaign (184 ints)
  const campArgs = buildCampaignArgs(player);
  send(socket, 'srcampaign', ...campArgs);

  // Price table (700 ints)
  const priceArgs = getPriceArgs();
  send(socket, 'srprices', ...priceArgs);

  // Refresh shop items on every login so the player sees new variety each session
  player.shopItems = generateShopItems();
  savePlayer(player);

  // Vault display = rotating shop items first, then earned campaign drops
  const displayVault = combineVault(player);
  const vaultArgs = buildArmoryArgs(displayVault);
  if (vaultArgs.length > 0) send(socket, 'srvault', ...vaultArgs);
  else send(socket, 'srvault');

  // Packs: 6 packs (2 pages × 3). Format per pack (22 fields):
  //   item1[4] item2[4] item3[4] item4[4] item5[4] price name
  // Down-scroll locks at ptab==3 so 6 packs = 2 pages with proper lock behavior.
  // Save the pack objects so sbuyitempack can read the exact same items.
  player.currentPacks = generateRandomPacks();
  savePlayer(player);
  send(socket, 'srpacks', ...packsToWireArgs(player.currentPacks));
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------
function handleMessage(socket, type, args, state) {
  switch (type) {

    // ---- Account creation ------------------------------------------------
    case 'screateaccount': {
      const [username, password] = args;
      if (!username) return;

      if (loadPlayer(username)) {
        send(socket, 'snametaken');
        return;
      }

      const player = newPlayer(username, password);
      savePlayer(player);
      state.player = player;

      console.log(`[+] Created account: ${username}`);
      send(socket, 'screated');
      sendFullState(socket, player);
      break;
    }

    // ---- Login -----------------------------------------------------------
    case 'slogin': {
      const [username, password] = args;
      if (!username) return;

      let player = loadPlayer(username);
      if (!player) {
        // Auto-create on first login attempt to be forgiving
        player = newPlayer(username, password);
        savePlayer(player);
        console.log(`[+] Auto-created account: ${username}`);
        send(socket, 'screated');
      } else {
        // Reset daily bonus on each login so players always have something to claim
        player.bonus = 1;
        console.log(`[>] Login: ${username}`);
        send(socket, 'sloggedon');
      }

      state.player = player;
      sendFullState(socket, player);
      break;
    }

    // ---- Kongregate login (treated same as regular login) ----------------
    case 'skong': {
      const [username] = args;
      if (!username) return;

      let player = loadPlayer(username);
      if (!player) {
        player = newPlayer(username, username);
        savePlayer(player);
        send(socket, 'screated');
      } else {
        player.bonus = 1;
        send(socket, 'sloggedon');
      }

      state.player = player;
      sendFullState(socket, player);
      break;
    }

    // ---- Mission request: client wants to start a mission ---------------
    case 'srequestmission': {
      const nextsun = parseInt(args[0], 10) || 0;
      if (state.player) state.player.nextsun = nextsun;
      console.log(`[*] Mission requested: nextsun=${nextsun}`);
      send(socket, 'sstartmission');
      break;
    }

    // ---- Fix mission (sent before sgameover, and on disconnect recovery) ---
    // Just record nextsun — do NOT send sstartmission here.
    // The client sends sfixmission+sgameover as a pair after a match ends;
    // sending sstartmission here fires mom.flag=1 before the game-over result
    // is processed and corrupts the campaign map.
    case 'sfixmission': {
      const nextsun = parseInt(args[0], 10) || 0;
      if (state.player) state.player.nextsun = nextsun;
      break;
    }

    // ---- Game over -------------------------------------------------------
    case 'sgameover': {
      const won    = parseInt(args[0], 10) === 1;
      const player = state.player;
      if (!player) return;

      const nextsun = player.nextsun || 0;
      const { creditReward, itemDrop, resultCode, updatedPlayer } = processMissionResult(player, nextsun, won);
      state.player = updatedPlayer;
      savePlayer(updatedPlayer);

      // Send prize first so the result screen has the data
      if (won && creditReward > 0) {
        send(socket, 'prize', 1, creditReward, 0, 0, 0);
      } else if (!won) {
        send(socket, 'prize', 0, 0, 0, 0, 0);
      }

      // Send item drop to vault if one occurred
      if (itemDrop) {
        const vArgs = buildArmoryArgs(updatedPlayer.vault.filter(Boolean));
        send(socket, 'srvault', ...vArgs);
        console.log(`[*] Item drop: [${itemDrop}]`);
      }

      // Updated stats
      send(socket, 'sstats',
        updatedPlayer.credits,
        updatedPlayer.stations,
        updatedPlayer.maxinventory,
        updatedPlayer.bonus,
        updatedPlayer.rating,
        updatedPlayer.wins,
        updatedPlayer.losses
      );

      // Confirm result first — this triggers StartGameOver() on the client which
      // creates a new BaseScreen and sets GameState=4.  srcampaign must arrive
      // AFTER that so the GameState==4 check in the handler passes and SetupMap()
      // is called on the fresh BaseScreen.
      send(socket, 'sresultconfirmed', resultCode);

      // Updated campaign (sent after sresultconfirmed so SetupMap() fires)
      send(socket, 'srcampaign', ...buildCampaignArgs(updatedPlayer));
      console.log(`[*] Game over nextsun=${nextsun} won=${won} reward=${creditReward}`);
      break;
    }

    // ---- New campaign ---------------------------------------------------
    case 'snewcampaign': {
      const danger = parseInt(args[0], 10) || 0;
      const player = state.player;
      if (!player) return;

      const updated = resetCampaign(player, danger);
      state.player = updated;
      savePlayer(updated);

      send(socket, 'srcampaign', ...buildCampaignArgs(updated));
      send(socket, 'sstats',
        updated.credits,
        updated.stations,
        updated.maxinventory,
        updated.bonus,
        updated.rating,
        updated.wins,
        updated.losses
      );
      console.log(`[*] New campaign danger=${danger} seed=${updated.campaignseed}`);
      break;
    }

    // ---- Save equipment loadout ----------------------------------------
    case 'stequip': {
      const player = state.player;
      if (!player) return;

      player.equipmap = args.map(v => parseInt(v, 10));
      savePlayer(player);
      break;
    }

    // ---- Sell item -------------------------------------------------------
    case 'ssell': {
      const armoryIndex = parseInt(args[0], 10);
      const type        = parseInt(args[1], 10) || 0;
      const player      = state.player;
      if (!player) return;

      const result = sellItem(player, armoryIndex, type, PRICE_TABLE);
      if (!result.success) return;

      state.player = result.updatedPlayer;
      savePlayer(result.updatedPlayer);

      // Send armory/equip BEFORE ssold so SetupSellScreen() sees the updated armory
      // (ssold triggers SetupSellScreen on the client — if srarmory hasn't arrived
      // yet the sold item still appears in the list and clicking it again crashes)
      send(socket, 'sstats',
        result.updatedPlayer.credits,
        result.updatedPlayer.stations,
        result.updatedPlayer.maxinventory,
        result.updatedPlayer.bonus,
        result.updatedPlayer.rating,
        result.updatedPlayer.wins,
        result.updatedPlayer.losses
      );
      send(socket, 'srarmory', ...buildFullArmoryArgs(result.updatedPlayer));
      send(socket, 'srequip', ...result.updatedPlayer.equipmap);
      send(socket, 'ssold');
      if (result.vaultDeposit) {
        const vArgs = buildArmoryArgs(result.updatedPlayer.vault.filter(Boolean));
        send(socket, 'srvault', ...vArgs);
        console.log(`[*] Deposited armory[${armoryIndex}] to vault`);
      } else {
        console.log(`[*] Sold armory[${armoryIndex}] for ${result.sellPrice} credits`);
      }
      break;
    }

    // ---- Player opened the shop — refresh shop items and send new vault ----
    case 'sopenstore': {
      const player = state.player;
      if (!player) return;
      player.shopItems = generateShopItems();
      savePlayer(player);
      const vaultArgs = buildArmoryArgs(combineVault(player));
      send(socket, 'srvault', ...vaultArgs);
      break;
    }

    // ---- Buy from vault --------------------------------------------------
    case 'sbuy': {
      const vaultIndex = parseInt(args[0], 10);
      const type       = parseInt(args[1], 10) || 0;
      const player     = state.player;
      if (!player) return;

      const result = buyItem(player, vaultIndex, type, PRICE_TABLE);
      if (!result.success) {
        if (result.reason === 'no_credits') send(socket, 'snospace');
        return;
      }

      state.player = result.updatedPlayer;
      savePlayer(result.updatedPlayer);

      send(socket, 'sbought');
      send(socket, 'sstats',
        result.updatedPlayer.credits,
        result.updatedPlayer.stations,
        result.updatedPlayer.maxinventory,
        result.updatedPlayer.bonus,
        result.updatedPlayer.rating,
        result.updatedPlayer.wins,
        result.updatedPlayer.losses
      );
      send(socket, 'srarmory', ...buildFullArmoryArgs(result.updatedPlayer));
      const postBuyVault = buildArmoryArgs(combineVault(result.updatedPlayer));
      send(socket, 'srvault', ...postBuyVault);
      break;
    }

    // ---- Buy credits with platinum --------------------------------------
    case 'sbuycredits': {
      const player = state.player;
      if (!player) return;

      const tier = parseInt(args[0], 10) || 0;
      const costs    = [1, 10, 50];
      const rewards  = [100, 1500, 10000];
      const cost     = costs[tier]   || 1;
      const reward   = rewards[tier] || 100;

      if ((player.platinum || 0) < cost) return;
      player.platinum -= cost;
      player.credits  += reward;
      savePlayer(player);

      send(socket, 'sstats',
        player.credits, player.stations, player.maxinventory,
        player.bonus,   player.rating,   player.wins, player.losses
      );
      send(socket, 'splat', player.platinum);
      break;
    }

    // ---- Buy station slot -----------------------------------------------
    case 'sbuystations': {
      const player = state.player;
      if (!player) return;

      const cost = 2 * ((player.maxstations || 7) - (player.stations || 1));
      if ((player.platinum || 0) < cost) return;

      player.platinum -= cost;
      player.stations  = (player.stations || 1) + 1;
      savePlayer(player);

      send(socket, 'sstats',
        player.credits, player.stations, player.maxinventory,
        player.bonus,   player.rating,   player.wins, player.losses
      );
      send(socket, 'splat', player.platinum);
      break;
    }

    // ---- Buy inventory expansion (sbuypack = add 5 slots for 50 plat) -------
    case 'sbuypack': {
      const player = state.player;
      if (!player) return;

      const cost = 50;
      if ((player.platinum || 0) < cost) {
        send(socket, 'splat', player.platinum);  // remind client of actual balance
        return;
      }

      player.platinum    -= cost;
      player.maxinventory = (player.maxinventory || 50) + 5;
      savePlayer(player);

      send(socket, 'sstats',
        player.credits, player.stations, player.maxinventory,
        player.bonus,   player.rating,   player.wins, player.losses
      );
      send(socket, 'splat', player.platinum);
      send(socket, 'srarmory', ...buildFullArmoryArgs(player));
      console.log(`[*] Inventory expanded to ${player.maxinventory} (-${cost} plat)`);
      break;
    }

    // ---- Buy platinum (local mode — free, bypassing Kongregate MTX) -------
    case 'sbuyplatinum': {
      const player = state.player;
      if (!player) return;

      const tier    = parseInt(args[0], 10) || 0;
      const rewards = [50, 110, 250, 700, 1500];
      const reward  = rewards[tier] !== undefined ? rewards[tier] : 50;
      player.platinum = (player.platinum || 0) + reward;
      savePlayer(player);

      send(socket, 'splat', player.platinum);
      console.log(`[*] Platinum purchased: tier=${tier} +${reward} → ${player.platinum}`);
      break;
    }

    // ---- Buy item pack --------------------------------------------------
    case 'sbuyitempack': {
      const player = state.player;
      if (!player) return;

      const packId = parseInt(args[0], 10) || 0;
      const packs  = player.currentPacks || [];
      if (packId < 0 || packId >= packs.length) {
        console.log(`[!] sbuyitempack: invalid packId ${packId} (have ${packs.length} packs)`);
        return;
      }

      const pack   = packs[packId];
      const items  = (pack.items || []).filter(it => it && it[0] > 0);
      const maxinv = player.maxinventory || 50;
      const realItems = (player.armory || []).filter(s => s && s[0] > 0).length;
      const freeSlots = maxinv - realItems;
      const toAdd  = items.slice(0, freeSlots);

      if (toAdd.length === 0) { send(socket, 'snospace'); return; }

      // Charge platinum
      const price = pack.price || 0;
      if (price > 0) {
        if ((player.platinum || 0) < price) { send(socket, 'snospace'); return; }
        player.platinum -= price;
      }

      for (const item of toAdd) player.armory.push([...item]);
      savePlayer(player);

      console.log(`[*] Pack bought: id=${packId} name="${pack.name}" items=${toAdd.length} plat=-${price}`);
      send(socket, 'sbought');
      send(socket, 'splat', player.platinum);
      send(socket, 'srarmory', ...buildFullArmoryArgs(player));
      break;
    }

    // ---- Upgrade item ---------------------------------------------------
    case 'supgrade': {
      const armoryIndex = parseInt(args[0], 10);
      const player      = state.player;
      if (!player) return;

      const result = upgradeItem(player, armoryIndex);
      if (!result.success) return;

      state.player = result.updatedPlayer;
      savePlayer(result.updatedPlayer);

      const item = result.updatedPlayer.armory[armoryIndex];
      send(socket, 'supgraderesult', item[0], item[1], item[2], item[3]);
      send(socket, 'sstats',
        result.updatedPlayer.credits,
        result.updatedPlayer.stations,
        result.updatedPlayer.maxinventory,
        result.updatedPlayer.bonus,
        result.updatedPlayer.rating,
        result.updatedPlayer.wins,
        result.updatedPlayer.losses
      );
      send(socket, 'srarmory', ...buildFullArmoryArgs(result.updatedPlayer));
      break;
    }

    // ---- Claim daily bonus ---------------------------------------------
    case 'sclaimprize': {
      const player = state.player;
      if (!player || player.bonus !== 1) return;

      // Give platinum (game displays "Daily bonus of X platinum!")
      const reward = 5 + Math.floor(Math.random() * 10);
      player.platinum = (player.platinum || 0) + reward;
      player.bonus    = 0;
      savePlayer(player);

      send(socket, 'claimed', reward);
      send(socket, 'splat', player.platinum);
      send(socket, 'sstats',
        player.credits, player.stations, player.maxinventory,
        player.bonus,   player.rating,   player.wins, player.losses
      );
      console.log(`[*] Daily bonus claimed: +${reward} platinum`);
      break;
    }

    // ---- Update platinum (Kongregate MTX) --------------------------------
    case 'supdateplatinum': {
      const player = state.player;
      if (!player) return;
      send(socket, 'splat', player.platinum);
      break;
    }

    // ---- Callsign (Kongregate display name) -----------------------------
    case 'scallsign': {
      // Just acknowledge silently
      break;
    }

    // ---- Ping ------------------------------------------------------------
    case 'sping': {
      send(socket, 'srping');
      break;
    }

    // ---- Multiplayer stubs (ignored in single-player mode) ---------------
    case 'glogin':
    case 'gready':
    case 'gcheckin':
    case 'ggameover':
    case 'gprivate':
      break;

    default:
      console.log(`[?] Unhandled message: ${type} [${args.join(', ')}]`);
      break;
  }
}

// ---------------------------------------------------------------------------
// TCP server
// ---------------------------------------------------------------------------
const server = net.createServer((socket) => {
  const addr = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log(`[+] Client connected: ${addr}`);

  // Per-connection mutable state
  const state = { player: null };

  let buffer = '';

  socket.on('data', (data) => {
    const raw_hex = data.slice(0, 80).toString('hex');
    const raw_str = JSON.stringify(data.slice(0, 80).toString('utf8'));
    console.log(`[DBG] ${data.length} bytes: ${raw_str}`);
    buffer += data.toString('utf8');

    // Flash Player sends a cross-domain policy request before the real connection.
    // Respond immediately and let it proceed.
    if (buffer.includes('<policy-file-request/>')) {
      const policy = '<?xml version="1.0"?><cross-domain-policy>' +
                     '<allow-access-from domain="*" to-ports="*"/>' +
                     '</cross-domain-policy>\0';
      socket.write(policy);
      buffer = buffer.replace(/<policy-file-request\/>\0?/g, '');
      console.log('[*] Sent socket policy');
    }

    // Messages are null-terminated (\0); split on \0
    const parts = buffer.split('\0');
    buffer = parts.pop(); // last chunk may be incomplete

    for (const raw of parts) {
      if (!raw) continue;
      const fields = raw.split('\t');
      const type   = fields.shift();
      try {
        handleMessage(socket, type, fields, state);
      } catch (err) {
        console.error(`[!] Error handling "${type}":`, err.message);
      }
    }
  });

  socket.on('close', () => {
    console.log(`[-] Client disconnected: ${addr}`);
    if (state.player) savePlayer(state.player);
  });

  socket.on('error', (err) => {
    if (err.code !== 'ECONNRESET') console.error(`[!] Socket error (${addr}):`, err.message);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\nOE3 Local Backend Server`);
  console.log(`========================`);
  console.log(`Listening on 127.0.0.1:${PORT}`);
  console.log(`Player data: ${PLAYERS_DIR}`);
  console.log(`\nWaiting for the game to connect...\n`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Stop any existing server and retry.`);
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});
