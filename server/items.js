'use strict';

// ---------------------------------------------------------------------------
// Item ID ranges (mirrors the game's AS3 item type system):
//   0-199   = StructData  (structures/buildings)
//   200-349 = ShipData    (ships/units)
//   350+    = TechData    (tech upgrades)
//
// Buyable/sellable items (those that can appear in the armory shop) have IDs
// >= 100.  The price table is indexed as  prices[itemId - 100].
// ---------------------------------------------------------------------------

// Number of price entries we send (covers item IDs 100 through 449).
const PRICE_COUNT = 350;

/**
 * Generate [creditBuyPrice, platBuyPrice] for each item ID offset from 100.
 * Rough tiers:
 *   offset 0-99   → turret structs (IDs 100-199)
 *   offset 100-249 → ships         (IDs 200-349)
 *   offset 250-349 → tech          (IDs 350-449)
 */
function buildPriceTable() {
  const prices = [];
  for (let i = 0; i < PRICE_COUNT; i++) {
    let credits, plat;
    if (i < 100) {
      // Turrets
      credits = 200 + i * 30;
      plat    = 1 + Math.floor(i / 25);
    } else if (i < 250) {
      // Ships
      const j = i - 100;
      credits = 800  + j * 60;
      plat    = 3    + Math.floor(j / 30);
    } else {
      // Tech
      const j = i - 250;
      credits = 2000 + j * 150;
      plat    = 5    + Math.floor(j / 20);
    }
    prices.push([credits, plat]);
  }
  return prices;
}

const PRICE_TABLE = buildPriceTable();

/**
 * Flatten the price table into the wire format for srprices:
 * [cred0, plat0, cred1, plat1, ...]
 */
function getPriceArgs() {
  const out = [];
  for (const [c, p] of PRICE_TABLE) {
    out.push(c, p);
  }
  return out;
}

/** Return sell price (credits) for an item at a given rarity. */
function getSellPrice(itemId, rarity) {
  const idx = itemId - 100;
  if (idx < 0 || idx >= PRICE_TABLE.length) return 0;
  const buyCredit = PRICE_TABLE[idx][0];
  return Math.ceil(0.1 * buyCredit * Math.pow(3, rarity));
}

// ---------------------------------------------------------------------------
// New player default state
// ---------------------------------------------------------------------------

function newPlayer(username, password) {
  // Campaign: all undiscovered (0). Map.as forces the start position visible.
  const campaign = new Array(36).fill(0);

  // Prize preview for each mission cell: [prizetype=1 (credits), amount, 0, 0]
  const prizes = [];
  for (let i = 0; i < 36; i++) {
    prizes.push(1, 300 + i * 20, 0, 0);
  }

  return {
    username,
    password,
    credits:      2000,
    platinum:     0,
    stations:     1,
    maxstations:  7,
    maxinventory: 50,
    wins:         0,
    losses:       0,
    rating:       1000,
    bonus:        0,

    // Armory: each item is [id, rarity, mod1, mod2]
    // Slot 0 = Piranha ship (200), slot 1 = Blaster turret (100)
    armory: [
      [200, 0, 0, 0],
      [100, 0, 0, 0],
      [101, 0, 0, 0],
    ],

    // equipmap[0-7]   = ship slots (armory index, or -1)
    // equipmap[8-14]  = structure slots (armory index, or -1)
    // equipmap[15]    triggers injection of hardcoded default structures
    // equipmap[15-16] = additional structure slots
    // equipmap[17-20] = tech slots
    equipmap: [
      0, -1, -1, -1, -1, -1, -1, -1,   // ship slots: Piranha in slot 0
      1,  2, -1, -1, -1, -1, -1,         // struct slots: Blaster in slot 8, Double Blaster in slot 9
      -1, -1,                             // additional struct slots 15-16
      -1, -1, -1, -1                      // tech slots 17-20
    ],

    // Starter vault: turrets, light ship, medium ship so the store isn't empty
    vault: [
      [100, 0, 0, 0],  // Blaster
      [101, 0, 0, 0],  // Double Blaster
      [102, 0, 0, 0],  // Missile
      [103, 0, 0, 0],  // Cannon
      [104, 0, 0, 0],  // Laser
      [200, 0, 0, 0],  // Piranha (light ship)
      [201, 0, 0, 0],  // light ship type 2
      [202, 0, 0, 0],  // medium ship
    ],
    campaignseed:   Math.floor(Math.random() * 90000) + 10000,
    campaigndanger: 0,   // displayed as danger+1 = 1
    campaignlock:   1,   // max unlockable difficulty
    campaignstart:  0,
    campaign,
    prizes,              // flat array: 36 * 4 = 144 ints
    nextsun:        0,   // last requested mission
  };
}

module.exports = { getPriceArgs, getSellPrice, newPlayer, PRICE_TABLE };
