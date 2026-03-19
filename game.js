/**
 * Dungeon Crawler — Roguelike game spec using @engine SDK.
 *
 * Turn-based grid movement on a procedurally generated 32x32 dungeon.
 * Features fog of war, bump-to-attack combat, monsters, XP/leveling,
 * and descending floors via stairs.
 *
 * AI auto-explores using BFS toward unexplored tiles, fights monsters,
 * and descends stairs when the floor is clear.
 */

import { defineGame } from '@engine/core';
import { consumeAction } from '@engine/input';
import { clearCanvas, drawRoundedRect, drawLabel, drawGameOver, drawTextCell } from '@engine/render';
import { drawTouchOverlay } from '@engine/touch';
import { generateDungeon, computeFOV, createStats, takeDamage, gainXP, bfsPath, getNeighbors } from '@engine/rpg';

// ── Constants ───────────────────────────────────────────────────────

const MAP_W = 32;
const MAP_H = 32;
const VIEW_TILES = 16;       // visible viewport in tiles
const TILE_PX = 34;          // pixel size per tile in viewport
const CANVAS_W = 560;
const CANVAS_H = 560;
const HUD_H = 48;            // space reserved for HUD at top
const SIGHT_RADIUS = 7;
const AI_DELAY = 200;

// Tile constants
const WALL  = 0;
const FLOOR = 1;
const DOOR  = 2;
const STAIRS = 3;

// Monster templates scaled by floor
const MONSTER_TABLE = [
  { type: 'rat',      glyph: 'r', hp: 6,  atk: 2,  def: 0, xp: 15 },
  { type: 'goblin',   glyph: 'g', hp: 12, atk: 4,  def: 1, xp: 30 },
  { type: 'skeleton', glyph: 's', hp: 18, atk: 6,  def: 2, xp: 50 },
  { type: 'orc',      glyph: 'o', hp: 28, atk: 9,  def: 3, xp: 75 },
  { type: 'troll',    glyph: 'T', hp: 45, atk: 12, def: 5, xp: 120 },
];

// Tile colors
const COLOR_WALL_VIS      = '#3a3a4a';
const COLOR_WALL_EXP      = '#222230';
const COLOR_FLOOR_VIS     = '#6e6e7e';
const COLOR_FLOOR_EXP     = '#3a3a48';
const COLOR_DOOR_VIS      = '#8b6914';
const COLOR_DOOR_EXP      = '#5a4510';
const COLOR_STAIRS_VIS    = '#4fc3f7';
const COLOR_STAIRS_EXP    = '#2a6a8a';
const COLOR_UNEXPLORED    = '#0a0a0f';
const COLOR_BG            = '#0e0e14';
const COLOR_PLAYER        = '#4caf50';
const COLOR_MONSTER        = '#ef5350';
const COLOR_HP_BAR        = '#e53935';
const COLOR_HP_BG         = '#3a1a1a';
const COLOR_XP_BAR        = '#fdd835';
const COLOR_XP_BG         = '#3a3a1a';

// ── Game Definition ─────────────────────────────────────────────────

const game = defineGame({
  display: {
    type: 'custom',
    width: MAP_W,
    height: MAP_H,
    canvasWidth: CANVAS_W,
    canvasHeight: CANVAS_H,
    background: COLOR_BG,
  },
  input: {
    up:      { keys: ['ArrowUp', 'w'] },
    down:    { keys: ['ArrowDown', 's'] },
    left:    { keys: ['ArrowLeft', 'a'] },
    right:   { keys: ['ArrowRight', 'd'] },
    select:  { keys: [' ', 'Enter'] },
    restart: { keys: ['r', 'R'] },
  },
});

// ── Resources ───────────────────────────────────────────────────────

game.resource('state', {
  score: 0,
  gameOver: false,
  floor: 1,
  message: 'Explore the dungeon',
  turnCount: 0,
});

game.resource('player', {
  idx: 0,
  stats: null,
});

game.resource('dungeon', {
  grid: [],
  width: MAP_W,
  height: MAP_H,
  monsters: [],
  items: [],
  stairsIdx: -1,
  initialized: false,
});

game.resource('visibility', {
  visible: [],
  explored: [],
});

game.resource('_aiTimer', { elapsed: 0 });

// ── Helpers ─────────────────────────────────────────────────────────

function idxToXY(idx, w) {
  return { x: idx % w, y: Math.floor(idx / w) };
}

function xyToIdx(x, y, w) {
  return y * w + x;
}

function spawnMonstersForFloor(grid, floor, playerIdx) {
  const floorTiles = [];
  for (let i = 0; i < grid.length; i++) {
    if ((grid[i] === FLOOR || grid[i] === DOOR) && i !== playerIdx) {
      floorTiles.push(i);
    }
  }

  // Shuffle floor tiles
  for (let i = floorTiles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [floorTiles[i], floorTiles[j]] = [floorTiles[j], floorTiles[i]];
  }

  const count = Math.min(6 + floor * 2, 20, floorTiles.length);
  const monsters = [];

  // Higher floors unlock harder monsters
  const maxTier = Math.min(floor, MONSTER_TABLE.length);

  for (let i = 0; i < count; i++) {
    const tier = Math.floor(Math.random() * maxTier);
    const template = MONSTER_TABLE[tier];
    const scale = 1 + (floor - 1) * 0.15;
    monsters.push({
      idx: floorTiles[i],
      type: template.type,
      glyph: template.glyph,
      hp: Math.round(template.hp * scale),
      maxHp: Math.round(template.hp * scale),
      atk: Math.round(template.atk * scale),
      def: Math.round(template.def * scale),
      xp: Math.round(template.xp * scale),
      alive: true,
    });
  }

  return monsters;
}

function findPlayerStart(grid, w, h) {
  // Place player on the first floor tile found
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] === FLOOR) return i;
  }
  return 0;
}

function initFloor(dungeon, player, visibility, floor) {
  const grid = generateDungeon(MAP_W, MAP_H);
  dungeon.grid = grid;

  // Find stairs location
  let stairsIdx = -1;
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] === STAIRS) { stairsIdx = i; break; }
  }
  dungeon.stairsIdx = stairsIdx;

  // Place player
  player.idx = findPlayerStart(grid, MAP_W, MAP_H);
  if (!player.stats) {
    player.stats = createStats({ hp: 30, maxHp: 30, atk: 6, def: 3 });
  }

  // Spawn monsters
  dungeon.monsters = spawnMonstersForFloor(grid, floor, player.idx);
  dungeon.items = [];
  dungeon.initialized = true;

  // Reset visibility
  visibility.visible = [];
  visibility.explored = [];

  // Compute initial FOV
  updateFOV(dungeon, player, visibility);
}

function updateFOV(dungeon, player, visibility) {
  const { x, y } = idxToXY(player.idx, MAP_W);
  const visSet = computeFOV(dungeon.grid, MAP_W, MAP_H, x, y, SIGHT_RADIUS);

  // Merge visible into explored
  const expSet = new Set(visibility.explored);
  for (const idx of visSet) {
    expSet.add(idx);
  }

  visibility.visible = Array.from(visSet);
  visibility.explored = Array.from(expSet);
}

function monsterAt(monsters, idx) {
  for (let i = 0; i < monsters.length; i++) {
    if (monsters[i].alive && monsters[i].idx === idx) return monsters[i];
  }
  return null;
}

function isWalkable(tile) {
  return tile === FLOOR || tile === DOOR || tile === STAIRS;
}

function tryMovePlayer(dungeon, player, visibility, state, dx, dy) {
  const { x, y } = idxToXY(player.idx, MAP_W);
  const nx = x + dx;
  const ny = y + dy;

  if (nx < 0 || nx >= MAP_W || ny < 0 || ny >= MAP_H) return false;

  const targetIdx = xyToIdx(nx, ny, MAP_W);
  const tile = dungeon.grid[targetIdx];

  // Check for monster — bump to attack
  const monster = monsterAt(dungeon.monsters, targetIdx);
  if (monster) {
    const dmg = takeDamage(monster, player.stats.atk);
    state.message = `Hit ${monster.type} for ${dmg} dmg`;
    if (monster.hp <= 0) {
      monster.alive = false;
      const result = gainXP(player.stats, monster.xp);
      state.score += monster.xp;
      state.message = `Killed ${monster.type}! +${monster.xp} XP`;
      if (result.leveledUp) {
        state.message += ` Level up! (${result.newLevel})`;
      }
    }
    state.turnCount++;
    updateFOV(dungeon, player, visibility);
    return true;
  }

  // Move if walkable
  if (!isWalkable(tile)) return false;

  player.idx = targetIdx;
  state.turnCount++;

  // Check stairs
  if (targetIdx === dungeon.stairsIdx) {
    state.message = 'Press SPACE to descend stairs';
  } else {
    state.message = 'Explore the dungeon';
  }

  updateFOV(dungeon, player, visibility);
  return true;
}

function descendStairs(dungeon, player, visibility, state) {
  if (player.idx !== dungeon.stairsIdx) return false;

  state.floor++;
  state.message = `Descended to floor ${state.floor}`;
  dungeon.initialized = false;
  initFloor(dungeon, player, visibility, state.floor);
  return true;
}

// ── Dungeon Init System ─────────────────────────────────────────────

game.system('dungeonInit', function dungeonInitSystem(world, _dt) {
  const dungeon = world.getResource('dungeon');
  if (dungeon.initialized) return;

  const player = world.getResource('player');
  const visibility = world.getResource('visibility');
  const state = world.getResource('state');

  initFloor(dungeon, player, visibility, state.floor);
});

// ── Player Input System ─────────────────────────────────────────────

game.system('playerInput', function playerInputSystem(world, _dt) {
  const gm = world.getResource('gameMode');
  if (!gm || gm.mode !== 'playerVsAi') return;

  const state = world.getResource('state');
  if (state.gameOver) return;

  const input = world.getResource('input');
  const dungeon = world.getResource('dungeon');
  const player = world.getResource('player');
  const visibility = world.getResource('visibility');

  // Restart
  if (consumeAction(input, 'restart')) {
    state.score = 0;
    state.gameOver = false;
    state.floor = 1;
    state.turnCount = 0;
    state.message = 'Explore the dungeon';
    player.stats = null;
    dungeon.initialized = false;
    return;
  }

  if (consumeAction(input, 'up'))    tryMovePlayer(dungeon, player, visibility, state, 0, -1);
  if (consumeAction(input, 'down'))  tryMovePlayer(dungeon, player, visibility, state, 0, 1);
  if (consumeAction(input, 'left'))  tryMovePlayer(dungeon, player, visibility, state, -1, 0);
  if (consumeAction(input, 'right')) tryMovePlayer(dungeon, player, visibility, state, 1, 0);

  if (consumeAction(input, 'select')) {
    if (player.idx === dungeon.stairsIdx) {
      descendStairs(dungeon, player, visibility, state);
    }
    // else: wait a turn
    else {
      state.turnCount++;
      state.message = 'Waiting...';
    }
  }
});

// ── AI System (auto-explore) ────────────────────────────────────────

game.system('ai', function aiSystem(world, dt) {
  const gm = world.getResource('gameMode');
  if (gm && gm.mode === 'playerVsAi') return;

  const state = world.getResource('state');
  if (state.gameOver) return;

  const timer = world.getResource('_aiTimer');
  timer.elapsed += dt;
  if (timer.elapsed < AI_DELAY) return;
  timer.elapsed = 0;

  const dungeon = world.getResource('dungeon');
  const player = world.getResource('player');
  const visibility = world.getResource('visibility');
  const visSet = new Set(visibility.visible);
  const expSet = new Set(visibility.explored);

  // Check for adjacent monsters — attack them
  const pxy = idxToXY(player.idx, MAP_W);
  const neighbors = getNeighbors(player.idx, MAP_W, MAP_H);
  for (const nIdx of neighbors) {
    const m = monsterAt(dungeon.monsters, nIdx);
    if (m) {
      const nxy = idxToXY(nIdx, MAP_W);
      tryMovePlayer(dungeon, player, visibility, state, nxy.x - pxy.x, nxy.y - pxy.y);
      runMonsterAI(dungeon, player, visibility, state);
      return;
    }
  }

  // If on stairs and floor is reasonably clear, descend
  const aliveMonsters = dungeon.monsters.filter(m => m.alive);
  if (player.idx === dungeon.stairsIdx && (aliveMonsters.length === 0 || player.stats.hp < player.stats.maxHp * 0.3)) {
    descendStairs(dungeon, player, visibility, state);
    return;
  }

  // If stairs found and monsters dead, path to stairs
  if (aliveMonsters.length === 0 && dungeon.stairsIdx >= 0 && expSet.has(dungeon.stairsIdx)) {
    const path = bfsPath(dungeon.grid, MAP_W, MAP_H, player.idx, dungeon.stairsIdx);
    if (path && path.length > 1) {
      const nextIdx = path[1];
      const nxy = idxToXY(nextIdx, MAP_W);
      tryMovePlayer(dungeon, player, visibility, state, nxy.x - pxy.x, nxy.y - pxy.y);
      runMonsterAI(dungeon, player, visibility, state);
      return;
    }
  }

  // Find nearest visible monster and path to it
  let closestMonster = null;
  let closestPath = null;
  for (const m of aliveMonsters) {
    if (!visSet.has(m.idx)) continue;
    const mPath = bfsPath(dungeon.grid, MAP_W, MAP_H, player.idx, m.idx);
    if (mPath && (!closestPath || mPath.length < closestPath.length)) {
      closestMonster = m;
      closestPath = mPath;
    }
  }

  if (closestPath && closestPath.length > 1 && closestPath.length <= 8) {
    const nextIdx = closestPath[1];
    const nxy = idxToXY(nextIdx, MAP_W);
    tryMovePlayer(dungeon, player, visibility, state, nxy.x - pxy.x, nxy.y - pxy.y);
    runMonsterAI(dungeon, player, visibility, state);
    return;
  }

  // Explore: BFS to nearest unexplored walkable-adjacent tile
  const target = findExplorationTarget(dungeon, player, expSet);
  if (target !== null) {
    const path = bfsPath(dungeon.grid, MAP_W, MAP_H, player.idx, target);
    if (path && path.length > 1) {
      const nextIdx = path[1];
      const nxy = idxToXY(nextIdx, MAP_W);
      tryMovePlayer(dungeon, player, visibility, state, nxy.x - pxy.x, nxy.y - pxy.y);
      runMonsterAI(dungeon, player, visibility, state);
      return;
    }
  }

  // Fallback: wait
  state.turnCount++;
  runMonsterAI(dungeon, player, visibility, state);
});

function findExplorationTarget(dungeon, player, explored) {
  // BFS from player to find nearest walkable tile adjacent to unexplored
  const visited = new Set([player.idx]);
  const queue = [player.idx];

  while (queue.length > 0) {
    const current = queue.shift();
    const cNeighbors = getNeighbors(current, MAP_W, MAP_H);

    for (const n of cNeighbors) {
      if (!explored.has(n) && dungeon.grid[current] > 0) {
        // Current tile is walkable and borders unexplored
        return current;
      }
    }

    for (const n of cNeighbors) {
      if (visited.has(n) || dungeon.grid[n] === WALL) continue;
      visited.add(n);
      queue.push(n);
    }
  }

  return null;
}

// ── Monster AI System ───────────────────────────────────────────────

function runMonsterAI(dungeon, player, visibility, state) {
  if (state.gameOver) return;

  const visSet = new Set(visibility.visible);
  const occupied = new Set();
  occupied.add(player.idx);
  for (const m of dungeon.monsters) {
    if (m.alive) occupied.add(m.idx);
  }

  for (const monster of dungeon.monsters) {
    if (!monster.alive) continue;
    if (!visSet.has(monster.idx)) continue;

    const mxy = idxToXY(monster.idx, MAP_W);
    const pxy = idxToXY(player.idx, MAP_W);
    const dist = Math.abs(mxy.x - pxy.x) + Math.abs(mxy.y - pxy.y);

    if (dist > 5) continue;

    // Adjacent: attack player
    if (dist === 1) {
      const dmg = takeDamage(player.stats, monster.atk);
      state.message = `${monster.type} hits you for ${dmg}!`;
      if (player.stats.hp <= 0) {
        state.gameOver = true;
        state.message = `Killed by ${monster.type} on floor ${state.floor}`;
      }
      continue;
    }

    // Move toward player using BFS
    const path = bfsPath(dungeon.grid, MAP_W, MAP_H, monster.idx, player.idx);
    if (path && path.length > 1) {
      const nextIdx = path[1];
      if (!occupied.has(nextIdx)) {
        occupied.delete(monster.idx);
        monster.idx = nextIdx;
        occupied.add(nextIdx);
      }
    }
  }
}

game.system('monsterAI', function monsterAISystem(world, _dt) {
  // Monster AI is called inline after player/AI moves for turn sync.
  // This system exists for structural completeness but the logic is
  // triggered by runMonsterAI() after each player action.
});

// ── Render System ───────────────────────────────────────────────────

game.system('render', function renderSystem(world, _dt) {
  const renderer = world.getResource('renderer');
  if (!renderer) return;

  const { ctx } = renderer;
  const state = world.getResource('state');
  const dungeon = world.getResource('dungeon');
  const player = world.getResource('player');
  const visibility = world.getResource('visibility');
  const input = world.getResource('input');

  if (!dungeon.initialized) return;

  clearCanvas(ctx, COLOR_BG);

  // Restart handling
  if (state.gameOver && consumeAction(input, 'restart')) {
    state.score = 0;
    state.gameOver = false;
    state.floor = 1;
    state.turnCount = 0;
    state.message = 'Explore the dungeon';
    player.stats = null;
    dungeon.initialized = false;
    return;
  }

  const visSet = new Set(visibility.visible);
  const expSet = new Set(visibility.explored);

  // Viewport centered on player
  const pxy = idxToXY(player.idx, MAP_W);
  const halfView = Math.floor(VIEW_TILES / 2);
  const camX = Math.max(0, Math.min(MAP_W - VIEW_TILES, pxy.x - halfView));
  const camY = Math.max(0, Math.min(MAP_H - VIEW_TILES, pxy.y - halfView));

  const mapOX = Math.floor((CANVAS_W - VIEW_TILES * TILE_PX) / 2);
  const mapOY = HUD_H + 4;

  // Draw map tiles
  for (let vy = 0; vy < VIEW_TILES; vy++) {
    for (let vx = 0; vx < VIEW_TILES; vx++) {
      const mx = camX + vx;
      const my = camY + vy;
      if (mx >= MAP_W || my >= MAP_H) continue;

      const idx = xyToIdx(mx, my, MAP_W);
      const px = mapOX + vx * TILE_PX;
      const py = mapOY + vy * TILE_PX;
      const tile = dungeon.grid[idx];

      const isVisible = visSet.has(idx);
      const isExplored = expSet.has(idx);

      if (!isExplored) {
        // Unexplored — dark
        ctx.fillStyle = COLOR_UNEXPLORED;
        ctx.fillRect(px, py, TILE_PX, TILE_PX);
        continue;
      }

      // Pick tile color based on visibility
      let color;
      if (tile === WALL) {
        color = isVisible ? COLOR_WALL_VIS : COLOR_WALL_EXP;
      } else if (tile === DOOR) {
        color = isVisible ? COLOR_DOOR_VIS : COLOR_DOOR_EXP;
      } else if (tile === STAIRS) {
        color = isVisible ? COLOR_STAIRS_VIS : COLOR_STAIRS_EXP;
      } else {
        color = isVisible ? COLOR_FLOOR_VIS : COLOR_FLOOR_EXP;
      }

      ctx.fillStyle = color;
      ctx.fillRect(px, py, TILE_PX, TILE_PX);

      // Draw subtle grid lines on floors
      if (tile !== WALL && isVisible) {
        ctx.strokeStyle = 'rgba(255,255,255,0.05)';
        ctx.lineWidth = 0.5;
        ctx.strokeRect(px, py, TILE_PX, TILE_PX);
      }

      // Stairs glyph
      if (tile === STAIRS && isExplored) {
        drawTextCell(ctx, '>', px, py, TILE_PX, TILE_PX, {
          color: isVisible ? '#ffffff' : '#6688aa',
          fontSize: 18,
          fontWeight: 'bold',
        });
      }
    }
  }

  // Draw monsters
  for (const monster of dungeon.monsters) {
    if (!monster.alive) continue;
    const mxy = idxToXY(monster.idx, MAP_W);
    const vx = mxy.x - camX;
    const vy = mxy.y - camY;
    if (vx < 0 || vx >= VIEW_TILES || vy < 0 || vy >= VIEW_TILES) continue;
    if (!visSet.has(monster.idx)) continue;

    const px = mapOX + vx * TILE_PX;
    const py = mapOY + vy * TILE_PX;

    drawTextCell(ctx, monster.glyph, px, py, TILE_PX, TILE_PX, {
      color: COLOR_MONSTER,
      fontSize: 20,
      fontWeight: 'bold',
    });

    // Mini HP bar above monster
    const barW = TILE_PX - 4;
    const hpFrac = monster.hp / monster.maxHp;
    ctx.fillStyle = COLOR_HP_BG;
    ctx.fillRect(px + 2, py + 1, barW, 3);
    ctx.fillStyle = COLOR_HP_BAR;
    ctx.fillRect(px + 2, py + 1, Math.round(barW * hpFrac), 3);
  }

  // Draw player
  {
    const vx = pxy.x - camX;
    const vy = pxy.y - camY;
    if (vx >= 0 && vx < VIEW_TILES && vy >= 0 && vy < VIEW_TILES) {
      const px = mapOX + vx * TILE_PX;
      const py = mapOY + vy * TILE_PX;

      drawTextCell(ctx, '@', px, py, TILE_PX, TILE_PX, {
        color: COLOR_PLAYER,
        fontSize: 22,
        fontWeight: 'bold',
      });
    }
  }

  // ── HUD ─────────────────────────────────────────────────────────
  const stats = player.stats;
  if (stats) {
    const hudY = 6;
    const hudX = mapOX;
    const hudW = VIEW_TILES * TILE_PX;

    // HP bar
    const hpBarX = hudX;
    const hpBarW = Math.floor(hudW * 0.45);
    const hpFrac = stats.hp / stats.maxHp;

    drawLabel(ctx, `HP`, hpBarX, hudY + 12, { color: '#ccc', fontSize: 11 });
    ctx.fillStyle = COLOR_HP_BG;
    drawRoundedRect(ctx, hpBarX + 22, hudY + 2, hpBarW, 14, 3, COLOR_HP_BG);
    drawRoundedRect(ctx, hpBarX + 22, hudY + 2, Math.max(0, Math.round(hpBarW * hpFrac)), 14, 3, COLOR_HP_BAR);
    drawLabel(ctx, `${stats.hp}/${stats.maxHp}`, hpBarX + 26, hudY + 13, { color: '#fff', fontSize: 10 });

    // XP bar
    const xpBarX = hpBarX + hpBarW + 30;
    const xpBarW = Math.floor(hudW * 0.25);
    const xpNeeded = stats.level * 100;
    const xpFrac = stats.xp / xpNeeded;

    drawLabel(ctx, `XP`, xpBarX, hudY + 12, { color: '#ccc', fontSize: 11 });
    drawRoundedRect(ctx, xpBarX + 22, hudY + 2, xpBarW, 14, 3, COLOR_XP_BG);
    drawRoundedRect(ctx, xpBarX + 22, hudY + 2, Math.max(0, Math.round(xpBarW * xpFrac)), 14, 3, COLOR_XP_BAR);

    // Level and floor
    const infoX = xpBarX + xpBarW + 30;
    drawLabel(ctx, `Lv${stats.level}`, infoX, hudY + 12, { color: '#fdd835', fontSize: 12 });
    drawLabel(ctx, `F${state.floor}`, infoX + 40, hudY + 12, { color: '#4fc3f7', fontSize: 12 });

    // Stats line
    drawLabel(ctx, `ATK:${stats.atk} DEF:${stats.def}`, hudX, hudY + 28, { color: '#aaa', fontSize: 10 });
    drawLabel(ctx, `Score:${state.score}`, hudX + 120, hudY + 28, { color: '#aaa', fontSize: 10 });

    // Alive monsters count
    const alive = dungeon.monsters.filter(m => m.alive).length;
    drawLabel(ctx, `Monsters:${alive}`, hudX + 220, hudY + 28, { color: '#aaa', fontSize: 10 });
  }

  // Message line below map
  const msgY = mapOY + VIEW_TILES * TILE_PX + 14;
  drawLabel(ctx, state.message, mapOX, msgY, { color: '#bbb', fontSize: 12 });

  // Game over overlay
  if (state.gameOver) {
    const mapW = VIEW_TILES * TILE_PX;
    const mapH = VIEW_TILES * TILE_PX;
    drawGameOver(ctx, mapOX, mapOY, mapW, mapH, {
      title: 'YOU DIED',
      titleColor: '#ef5350',
      subtitle: `Floor ${state.floor} | Score: ${state.score} | Press R`,
    });
  }

  drawTouchOverlay(ctx, CANVAS_W, CANVAS_H);
});

export default game;
