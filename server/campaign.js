'use strict';

const { getSellPrice } = require('./items');

// Campaign grid: 6 columns × 6 rows = 36 missions
// Stored values (on disk):
//   0 = not completed
//   2 = completed  (frame 4 in Sun.as — visible, non-interactive)
//
// Derived when sending srcampaign (never stored):
//   1 = available to play (frame 1 in Sun.as — interactive)
//       computed as: adjacent to a completed (2) node
//       The start node (campaignstart) is always forced visible by Map.as even
//       when campaign[start] == 0, so no special treatment needed.

// ---------------------------------------------------------------------------
// Grid helpers
// ---------------------------------------------------------------------------

function idxToXY(idx) { return { x: idx % 6, y: Math.floor(idx / 6) }; }
function xyToIdx(x, y) {
  if (x < 0 || x >= 6 || y < 0 || y >= 6) return -1;
  return x + y * 6;
}
function neighbors(idx) {
  const { x, y } = idxToXY(idx);
  return [xyToIdx(x-1,y), xyToIdx(x+1,y), xyToIdx(x,y-1), xyToIdx(x,y+1)].filter(i => i >= 0);
}

// ---------------------------------------------------------------------------
// Migrate old saves
// Old server stored completed=1, adjacent=2.  Correct is completed=2.
// Strip 1s → 2, strip any other junk → 0 or 2 only.
// ---------------------------------------------------------------------------
function migrateCampaign(campaign) {
  return campaign.map(v => (v === 1 || v === 2) ? 2 : 0);
}

// ---------------------------------------------------------------------------
// Item drops
// ---------------------------------------------------------------------------
// Only IDs that have corresponding "I<id>" icon symbols in the SWF.
const VALID_TURRET_IDS = [100,101,102,103,104,105,106,107,108,109,110,111,113,114,116,117,
                           147,148,149,150,151,152,153,175,176,177,178,179,180,181,182,183];
const VALID_SHIP_IDS   = [200,201,202,203,204,205,206,207,208,209,210,212,213,214,215,
                           248,249,250,251,252,253,254,255,256,257,258,259,260,261,262,263,264,265,
                           299,300,301,302,303,304,305,306,307,308,309,310,311,312,313,314,315,316];
const VALID_TECH_IDS   = [350,351,352,353,354,355,356,357,358,359,360,361,362,363,364,365,
                           366,367,368,369,370,371,372,373,374,375,376,377,378,379];

// Mod codes for s[1] / s[2] slots.
// Ships support engine, shield, ammo, hangar mods.
// Turrets (StructData) support shield mods only.
// Tech items have no effective mod slots.
const ENGINE_MODS  = [1, 2, 3, 4, 5];            // Engine A-E  (speed/turn/thrust)
const SHIELD_MODS  = [6, 7, 8, 9, 10];           // Shield A-E  (shield HP + regen)
const AMMO_MODS    = [11, 12, 13, 14, 15, 16, 17, 18]; // EMP/Acid/Force/Neutron/Iridium/Thermal/Freeze/Fusion
const HANGAR_MODS  = [21, 22, 23, 24, 25, 26, 27, 28]; // Hangar ship types

/**
 * Generate a fresh rotating shop inventory.
 * Uses real mod codes so the game shows actual upgrade descriptions.
 * 2 ships per tier (basic/mid/advanced) + 2 turrets + 1 tech = 9 items.
 */
function generateShopItems() {
  // All ships split into tiers by ID range
  const tierBasic    = VALID_SHIP_IDS.filter(id => id >= 200 && id <= 215);   // 15 ships
  const tierMid      = VALID_SHIP_IDS.filter(id => id >= 248 && id <= 265);   // 18 ships
  const tierAdvanced = VALID_SHIP_IDS.filter(id => id >= 299 && id <= 316);   // 18 ships

  function pick(pool)  { return pool[Math.floor(Math.random() * pool.length)]; }
  function maybe(pool, chance) { return Math.random() < chance ? pick(pool) : 0; }

  // Build an item with zero, one, or two mods chosen from appropriate pools.
  function shipItem(tier) {
    const id = pick(tier);
    // Each slot: independently roll a mod category or none
    const candidates1 = [...ENGINE_MODS, ...SHIELD_MODS, ...AMMO_MODS, 0, 0, 0]; // weighted toward none
    const candidates2 = [...ENGINE_MODS, ...SHIELD_MODS, 0, 0, 0, 0, 0]; // simpler second mod
    const m1 = pick(candidates1);
    const m2 = m1 > 0 ? pick(candidates2) : 0;
    return [id, m1, m2, 0];
  }

  function turretItem() {
    const id = pick(VALID_TURRET_IDS);
    // Turrets support shield mods and some ammo mods
    const candidates = [...SHIELD_MODS, ...AMMO_MODS, 0, 0, 0, 0];
    const m1 = pick(candidates);
    return [id, m1, 0, 0];
  }

  function techItem() {
    // Tech items are standalone; no effective mod slots
    return [pick(VALID_TECH_IDS), 0, 0, 0];
  }

  return [
    shipItem(tierBasic),
    shipItem(tierBasic),
    shipItem(tierMid),
    shipItem(tierMid),
    shipItem(tierAdvanced),
    shipItem(tierAdvanced),
    turretItem(),
    turretItem(),
    techItem(),
  ];
}

function rollItemDrop(nextsun, danger) {
  const dropChance = 0.4 + Math.min(0.4, nextsun * 0.01 + danger * 0.05);
  if (Math.random() > dropChance) return null;

  const roll = Math.random();
  let pool;
  if (roll < 0.55)      pool = VALID_TURRET_IDS;
  else if (roll < 0.85) pool = VALID_SHIP_IDS;
  else                  pool = VALID_TECH_IDS;

  const id = pool[Math.floor(Math.random() * pool.length)];
  const rarRoll = Math.random();
  const rarity = rarRoll < 0.6 ? 0 : rarRoll < 0.85 ? 1 : rarRoll < 0.95 ? 2 : 3;
  return [id, rarity, 0, 0];
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Process a mission result.
 * On win: mark nextsun completed (2).  Derived available (1) nodes are
 * computed at send time — never stored.
 */
function processMissionResult(player, nextsun, won) {
  const updated = Object.assign({}, player);
  updated.campaign = migrateCampaign(player.campaign.slice());

  const resultCode = won ? 1 : 0;
  let creditReward = 0;
  let itemDrop = null;

  if (won) {
    updated.campaign[nextsun] = 2;   // completed
    updated.wins = (player.wins || 0) + 1;

    const danger = player.campaigndanger || 0;
    creditReward = Math.floor(100 + nextsun * 15 + danger * 50);
    updated.credits = (player.credits || 0) + creditReward;

    itemDrop = rollItemDrop(nextsun, danger);
    if (itemDrop) updated.vault = (player.vault || []).concat([itemDrop]);

    const totalWins = updated.campaign.filter(v => v === 2).length;
    const newLock = Math.min(6, 1 + Math.floor(totalWins / 6));
    updated.campaignlock = Math.max(player.campaignlock || 1, newLock);
    updated.rating = (player.rating || 1000) + 10;
  } else {
    updated.losses = (player.losses || 0) + 1;
    updated.rating = Math.max(0, (player.rating || 1000) - 5);
  }

  return { creditReward, itemDrop, resultCode, updatedPlayer: updated };
}

/**
 * Reset campaign to a fresh state at the chosen danger level.
 */
function resetCampaign(player, dangerLevel) {
  const updated = Object.assign({}, player);
  updated.campaigndanger = Math.min(dangerLevel, (player.campaignlock || 1) - 1);
  updated.campaignseed   = Math.floor(Math.random() * 90000) + 10000;
  updated.campaignstart  = 0;
  updated.nextsun        = 0;
  updated.campaign = new Array(36).fill(0);  // all unplayed

  updated.prizes = [];
  for (let i = 0; i < 36; i++) {
    const amount = 300 + i * 20 + updated.campaigndanger * 100;
    updated.prizes.push(1000, amount, 0, 0);  // 1000 = credits icon in Sun popup
  }
  return updated;
}

/**
 * Build the srcampaign message args (184 ints):
 *   [seed, danger, lock, start, campaign[36], prizes[144]]
 *
 * The stored campaign has only 0 (not done) or 2 (completed).
 * We derive 1 (available) here: any cell adjacent to a completed (2) cell.
 * The start node is left as-is (0 or 2); Map.as forces it visible even at 0.
 */
function buildCampaignArgs(player) {
  const stored = migrateCampaign(player.campaign.slice());
  const out = stored.slice();

  for (let i = 0; i < 36; i++) {
    if (stored[i] === 2) {
      for (const n of neighbors(i)) {
        if (out[n] === 0) out[n] = 1;  // adjacent to completed → available
      }
    }
  }

  return [
    player.campaignseed,
    player.campaigndanger,
    player.campaignlock,
    player.campaignstart,
    ...out,
    ...player.prizes,
  ];
}

/**
 * Build the srarmory args: flat [id, rar, m1, m2, ...]
 * Null slots are [-1, 0, 0, 0].
 */
function buildArmoryArgs(armory) {
  const args = [];
  for (const item of armory) {
    if (item) args.push(item[0], item[1], item[2], item[3]);
    else      args.push(-1, 0, 0, 0);
  }
  return args;
}

/**
 * Build armory args padded to maxinventory with null slots.
 * BuyItemPack() in the SWF counts null (−1) slots and refuses to proceed
 * if fewer than 5 are free. A compact armory has 0 nulls → always blocked.
 * Padding to maxinventory ensures the check passes.
 */
function buildFullArmoryArgs(player) {
  const maxinv = player.maxinventory || 50;
  const padded = player.armory.slice();
  while (padded.length < maxinv) padded.push(null);
  return buildArmoryArgs(padded);
}

function upgradeItem(player, armoryIndex) {
  if (armoryIndex < 0 || armoryIndex >= player.armory.length) return { success: false };
  if ((player.credits || 0) < 750) return { success: false };
  const updated  = Object.assign({}, player);
  updated.armory = player.armory.map(i => i ? [...i] : null);
  updated.credits = player.credits - 750;
  const item = updated.armory[armoryIndex];
  if (!item || item[0] < 0) return { success: false };
  item[1] = Math.min(item[1] + 1, 4);
  return { success: true, updatedPlayer: updated };
}

function sellItem(player, armoryIndex, type, priceTable) {
  if (armoryIndex < 0 || armoryIndex >= player.armory.length) return { success: false };
  const item = player.armory[armoryIndex];
  if (!item || item[0] < 0) return { success: false };
  const updated  = Object.assign({}, player);
  updated.armory = player.armory.slice();
  updated.armory[armoryIndex] = null;
  updated.equipmap = player.equipmap.map(idx => idx === armoryIndex ? -1 : idx);
  if (type === 1) {
    updated.vault = player.vault.concat([[...item]]);
    return { success: true, updatedPlayer: updated, sellPrice: 0, vaultDeposit: true };
  }
  const sellPrice = getSellPrice(item[0], item[1]);
  updated.credits = (player.credits || 0) + sellPrice;
  return { success: true, updatedPlayer: updated, sellPrice };
}

/**
 * Build the combined display-vault list that is sent as srvault.
 * shopItems come first (so their indices are stable), then earned drops.
 */
function combineVault(player) {
  return [
    ...(player.shopItems || []),
    ...(player.vault || []).filter(Boolean),
  ];
}

function buyItem(player, vaultIndex, type, priceTable) {
  // The display vault (what the client sees) is shopItems first, then earned vault.
  const shopItems   = (player.shopItems || []);
  const earnedItems = (player.vault     || []).filter(Boolean);
  const combined    = [...shopItems, ...earnedItems];

  if (vaultIndex < 0 || vaultIndex >= combined.length) return { success: false };
  const item = combined[vaultIndex];
  if (!item || item[0] < 0) return { success: false };

  const idx = item[0] - 100;
  const [creditCost, platCost] = (idx >= 0 && idx < priceTable.length) ? priceTable[idx] : [0, 0];
  // rarity = count of non-zero mod slots (s[1], s[2], s[3])
  const rarity = [item[1] || 0, item[2] || 0, item[3] || 0].filter(v => v > 0).length;
  const rarityMult = Math.pow(3, rarity);
  const finalCredit = Math.ceil(creditCost * rarityMult);
  const finalPlat   = Math.ceil(platCost   * rarityMult);

  let freeSlot = -1;
  for (let j = 0; j < player.armory.length; j++) {
    if (!player.armory[j] || player.armory[j][0] < 0) { freeSlot = j; break; }
  }
  if (freeSlot < 0 && player.armory.length >= (player.maxinventory || 50)) {
    return { success: false, reason: 'no_space' };
  }

  const updated = Object.assign({}, player);
  updated.armory = player.armory.slice().map(i => i ? [...i] : null);

  if (type === 0) {
    if ((player.credits || 0) < finalCredit) return { success: false, reason: 'no_credits' };
    updated.credits = player.credits - finalCredit;
  } else {
    if ((player.platinum || 0) < finalPlat) return { success: false, reason: 'no_plat' };
    updated.platinum = player.platinum - finalPlat;
  }

  if (freeSlot >= 0) updated.armory[freeSlot] = [...item];
  else               updated.armory.push([...item]);

  // Remove from the right list
  if (vaultIndex < shopItems.length) {
    updated.shopItems = shopItems.filter((_, i) => i !== vaultIndex);
  } else {
    // Remove the item from earned vault (skip nulls to match filtered index)
    const earnedPos = vaultIndex - shopItems.length;
    let seen = 0;
    updated.vault = (player.vault || []).filter(it => {
      if (!it || it[0] < 0) return false;
      if (seen === earnedPos) { seen++; return false; }
      seen++;
      return true;
    });
  }

  return { success: true, updatedPlayer: updated };
}

// ---------------------------------------------------------------------------
// Random packs (6 packs = 2 pages × 3; down button locks at ptab==3)
// ---------------------------------------------------------------------------

// Names to draw from for random pack variety
const PACK_NAMES = [
  'Turret Cache', 'Cannon Bundle', 'Defense Pack', 'Heavy Guns',
  'Scout Fleet',  'Fighter Wing',  'Warship Pack', 'Armada Bundle',
  'Tech Crate',   'Science Pack',  'Booster Set',  'Upgrade Kit',
];

/**
 * Generate 6 random packs for the pack screen (2 pages of 3).
 * Returns an array of 6 pack objects: { name, price, items: [[id,m1,m2,m3] × 5] }
 * Save this to player.currentPacks so sbuyitempack can read the same items.
 */
function generateRandomPacks() {
  function pick(pool) { return pool[Math.floor(Math.random() * pool.length)]; }

  function sample(pool, n) {
    const arr = pool.slice().sort(() => Math.random() - 0.5);
    return arr.slice(0, n);
  }

  function makeTurretPack() {
    const ids = sample(VALID_TURRET_IDS, 5);
    const mods = [...SHIELD_MODS, ...AMMO_MODS, 0, 0, 0];
    return {
      name:  pick(['Turret Cache', 'Cannon Bundle', 'Defense Pack', 'Heavy Guns']),
      price: 30 + Math.floor(Math.random() * 3) * 10,
      items: ids.map(id => [id, pick(mods), 0, 0]),
    };
  }

  function makeShipPack() {
    const basic    = VALID_SHIP_IDS.filter(id => id >= 200 && id <= 215);
    const mid      = VALID_SHIP_IDS.filter(id => id >= 248 && id <= 265);
    const advanced = VALID_SHIP_IDS.filter(id => id >= 299 && id <= 316);
    const allMods  = [...ENGINE_MODS, ...SHIELD_MODS, ...AMMO_MODS, 0, 0, 0, 0];
    const items = [
      ...sample(basic,    2),
      ...sample(mid,      2),
      ...sample(advanced, 1),
    ].map(id => [id, pick(allMods), pick([...ENGINE_MODS, ...SHIELD_MODS, 0, 0, 0]), 0]);
    return {
      name:  pick(['Scout Fleet', 'Fighter Wing', 'Warship Pack', 'Armada Bundle']),
      price: 40 + Math.floor(Math.random() * 3) * 10,
      items,
    };
  }

  function makeTechPack() {
    const ids = sample(VALID_TECH_IDS, 5);
    return {
      name:  pick(['Tech Crate', 'Science Pack', 'Booster Set', 'Upgrade Kit']),
      price: 25 + Math.floor(Math.random() * 3) * 10,
      items: ids.map(id => [id, 0, 0, 0]),
    };
  }

  function makeMixedPack() {
    const turrets = sample(VALID_TURRET_IDS, 2);
    const ships   = sample(VALID_SHIP_IDS,   2);
    const techs   = sample(VALID_TECH_IDS,   1);
    const mods    = [...ENGINE_MODS, ...SHIELD_MODS, ...AMMO_MODS, 0, 0, 0, 0];
    const items = [
      ...turrets.map(id => [id, pick([...SHIELD_MODS, 0, 0]), 0, 0]),
      ...ships.map(id   => [id, pick(mods), 0, 0]),
      ...techs.map(id   => [id, 0, 0, 0]),
    ];
    return {
      name:  'Mixed Pack',
      price: 35 + Math.floor(Math.random() * 3) * 10,
      items,
    };
  }

  // 6 packs: 2 turret, 2 ship, 1 tech, 1 mixed — shuffled
  const packs = [makeTurretPack(), makeShipPack(), makeTurretPack(), makeShipPack(), makeTechPack(), makeMixedPack()];
  packs.sort(() => Math.random() - 0.5);
  return packs;
}

/**
 * Convert the array of pack objects to the flat srpacks wire format.
 * Each pack occupies 22 fields: 5 items × 4 ints, then price, then name.
 */
function packsToWireArgs(packs) {
  const args = [];
  for (const pack of packs) {
    for (const item of pack.items) args.push(...item);
    args.push(pack.price, pack.name);
  }
  return args;
}

module.exports = {
  processMissionResult, resetCampaign, buildCampaignArgs,
  buildArmoryArgs, buildFullArmoryArgs, upgradeItem, sellItem, buyItem,
  generateShopItems, combineVault, generateRandomPacks, packsToWireArgs,
};
