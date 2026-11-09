/**
 * Biwenger feed scraper — API-based, no browser required.
 *
 * Uses the /api/v2/league/{id}/board endpoint (paginated) to fetch all
 * financial events and saves them to transactions.json.
 *
 * Each run rebuilds the full season from the board: postponed rounds report
 * cumulative bonuses, so primas can only be computed with every part in view.
 *
 * Usage:
 *   BIWENGER_EMAIL=x BIWENGER_PASSWORD=y node scraper.js
 */

const fs = require('fs');
const path = require('path');

const DATA_FILE   = path.join(__dirname, 'transactions.json');
const CONFIG_FILE = path.join(__dirname, 'league_config.json');
const LEAGUE_ID   = 92166;
const SEASON_START = '2026-07-20';

// ── Env loading ────────────────────────────────────────────────────────────────
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) {
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim();
      if (key && !process.env[key]) process.env[key] = val;
    }
  }
}

// ── Data helpers ───────────────────────────────────────────────────────────────
function loadData() {
  if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  return {
    metadata: {
      league_id: LEAGUE_ID,
      league_name: 'LIGA 26/27',
      initial_balance: 40000000,
      participants: ['carlos Heredia', 'Cristian', 'Jordi', 'Pedro', 'Víctor Peña', 'Victor Ramos', 'Victor Sanchez'],
      last_fetched: null,
      last_updated: null,
      notes: []
    },
    transactions: []
  };
}

const NOTES = [
  'Clausula con seller explícito genera dos registros: comprador (−) y vendedor (+).',
  'Prima = bonus de jornada (ingreso). En jornadas aplazadas Biwenger publica la prima acumulada; se registra solo la diferencia con lo ya cobrado en partes anteriores.',
  'Salario = coste de plantilla por jornada (gasto).',
  'Ajuste = bonus manual del administrador (+ o −).',
  'Importes en euros (enteros, sin puntos ni símbolo €).'
];

function saveData(data) {
  if (data.transactions.length > 0) {
    data.metadata.last_fetched = data.transactions.map(t => t.date).sort().at(-1);
  }
  data.metadata.last_updated = new Date().toISOString();
  data.metadata.notes = NOTES;
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ── API helpers ────────────────────────────────────────────────────────────────
async function getToken(email, password) {
  const res = await fetch('https://biwenger.as.com/api/v2/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const data = await res.json();
  if (!data.token) throw new Error('Login failed: ' + JSON.stringify(data));
  return data.token;
}

function makeHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'X-League': String(LEAGUE_ID),
    'X-User': '391541',
    'X-Lang': 'es'
  };
}

async function getLeagueConfig(headers) {
  const url = `https://biwenger.as.com/api/v2/league/${LEAGUE_ID}?fields=settings`;
  const res  = await fetch(url, { headers });
  const data = await res.json();
  const s    = data.data?.settings;
  if (!s) throw new Error('Could not fetch league settings');

  const config = {
    league_id:   LEAGUE_ID,
    league_name: 'LIGA 26/27',
    last_updated: new Date().toISOString(),
    plantilla: {
      tamano_maximo:          s.teamMaxSize,
      max_jugadores_mismo_club: s.teamMaxClubPlayers
    },
    mercado: {
      jugadores_diarios:      s.marketSize,
      duracion_dias:          s.marketTTL,
      velocidad:              s.marketSpeed,
      max_jugadores_en_venta: s.marketMaxUserSales,
      venta_inmediata_pct:    s.immediateSales,
      pujas_sobre_valor:      s.bidsOverMV,
      ofertas_usuarios:       s.userOffers,
      intercambios:           s.exchanges,
      modo_transferencias:    s.transfersMode
    },
    salarios: {
      fijo_por_jugador:       s.salariesFixed,
      variable_pct:           s.salariesVariable,
      intervalo:              s.salariesInterval,
      formula:                '(nº_jugadores × salariesFixed) + (valor_plantilla × salariesVariable / 100)'
    },
    clausulas: {
      tipo:                   s.clause,
      porcentaje_valor:       s.clauseRanges?.[0]?.[1] ?? null,
      deposito_permitido:     s.clauseIncrement > 0,
      horas_bloqueado_jornada: s.clauseRoundDisabledHours,
      retraso_activacion_dias: s.clauseActivationDelay
    },
    primas: {
      por_posicion_jornada:   (s.bonusRoundPosition ?? []).map(([pos, amount]) => ({ posicion: pos, importe: amount })),
      por_gol:                s.bonusGoal,
      por_porteria_cero:      s.bonusCleanSheet,
      negativas_permitidas:   s.bonusAllowNegative
    },
    alineacion: {
      capitan:                s.lineupCaptain,
      capitan_multiplicador_max: s.lineupCaptainMaxValue,
      goleador:               s.lineupStriker,
      goleador_multiplicador_max: s.lineupStrikerMaxValue,
      cambios_por_jornada:    s.lineupRoundChanges,
      reservas:               s.lineupReserves,
      entrenador:             s.lineupCoach
    }
  };

  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  return config;
}

async function getBoardPage(headers, offset, limit = 100) {
  const url = `https://biwenger.as.com/api/v2/league/${LEAGUE_ID}/board?limit=${limit}&offset=${offset}`;
  const res = await fetch(url, { headers });
  const data = await res.json();
  return data.data || [];
}

// Fetch player names from public endpoint (no auth required)
async function getPlayerNames() {
  const url = 'https://cf.biwenger.com/api/v2/competitions/la-liga/data?lang=es&score=2&fields=id,slug,name';
  try {
    const res = await fetch(url);
    const data = await res.json();
    const map = {};
    const players = data.data?.players ?? {};
    for (const [id, p] of Object.entries(players)) map[id] = p.name ?? p.slug;
    return map;
  } catch (e) {
    console.warn('[scraper] could not fetch player names:', e.message);
    return {};
  }
}

// Players no longer in La Liga are missing from the competition endpoint
async function fillMissingPlayerNames(playerNames, boardItems) {
  const ids = new Set();
  for (const item of boardItems) {
    if (!['market', 'transfer', 'clauseIncrement'].includes(item.type)) continue;
    for (const c of item.content) if (c.player && !playerNames[c.player]) ids.add(c.player);
  }
  for (const id of ids) {
    try {
      const res = await fetch(`https://cf.biwenger.com/api/v2/players/la-liga/${id}?lang=es&fields=id,name`);
      const name = (await res.json()).data?.name;
      if (name) playerNames[id] = name;
    } catch (e) {
      console.warn(`[scraper] could not fetch name for player ${id}:`, e.message);
    }
  }
}

const NON_FINANCIAL_TYPES = new Set([
  'roundStarted', 'roundLineupChanged', 'playerMovements', 'teamMovements', 'bettingPool',
  'adminText', 'text', 'article', 'poll', 'leagueSettings', 'leagueReset', 'userLeave', 'seasonFinished'
]);

// ── Board → transaction mapping ────────────────────────────────────────────────
/**
 * Confirmed mapping (validated against Pedro's exact API balance):
 *
 * item.type === 'market', c.to = user      → Compra (purchase, balance -)
 * item.type === 'transfer', c.type not set, c.from = user → Venta (sale, balance +)
 * item.type === 'transfer', c.type === 'immediateSale', c.from = user → Venta (sale, balance +)
 * item.type === 'transfer', c.type === 'clause', c.from = seller → Clausula received (+)
 * item.type === 'transfer', c.type === 'clause', c.to   = buyer  → Clausula paid (-)
 * item.type === 'roundFinished', results[].bonus → Prima (balance +), cumulative per jornada:
 *   a postponed round ("Jornada 6 (aplazada)", step 2, 3…) reports the total bonus for the
 *   whole jornada, so only the difference vs. earlier parts is paid (validated vs. real balances)
 * item.type === 'salaries', content[].amount      → Salario (cost, balance -) — one item per jornada, all participants
 * item.type === 'bonus', content[].amount (±)     → Ajuste (manual admin bonus/penalty)
 *
 * Items must be processed oldest-first so `primasPaid` holds earlier parts of each jornada.
 */
function boardItemToTransactions(item, playerNames, primasPaid) {
  const date = new Date(item.date * 1000).toISOString().slice(0, 10);
  const txs = [];

  if (item.type === 'market') {
    for (const c of item.content) {
      if (!c.to) continue;
      txs.push({
        date, type: 'Compra',
        player: playerNames[c.player] ?? `#${c.player}`,
        amount: c.amount,
        participant: c.to.name,
        balance_effect: '-'
      });
    }
    return txs;
  }

  if (item.type === 'transfer') {
    for (const c of item.content) {
      if (!c.type) {
        // User-to-user transfer: record both seller (+) and buyer (-)
        const player = playerNames[c.player] ?? `#${c.player}`;
        if (c.from) {
          txs.push({
            date, type: 'Venta', player, amount: c.amount,
            participant: c.from.name, balance_effect: '+',
            note: `Vendido a ${c.to?.name ?? '?'}`
          });
        }
        if (c.to) {
          txs.push({
            date, type: 'Compra', player, amount: c.amount,
            participant: c.to.name, balance_effect: '-',
            note: `Comprado a ${c.from?.name ?? '?'}`
          });
        }
      } else if (c.type === 'immediateSale') {
        // Immediate sale to market: only seller receives money (no buyer participant)
        if (!c.from) continue;
        txs.push({
          date, type: 'Venta',
          player: playerNames[c.player] ?? `#${c.player}`,
          amount: c.amount,
          participant: c.from.name,
          balance_effect: '+'
        });
      } else if (c.type === 'clause') {
        // Clause: from = seller (receives), to = buyer (pays)
        if (c.from) {
          txs.push({
            date, type: 'Clausula',
            player: playerNames[c.player] ?? `#${c.player}`,
            amount: c.amount,
            participant: c.from.name,
            balance_effect: '+',
            note: `Vendedor — cobró cláusula de ${c.to?.name ?? '?'}`
          });
        }
        if (c.to) {
          txs.push({
            date, type: 'Clausula',
            player: playerNames[c.player] ?? `#${c.player}`,
            amount: c.amount,
            participant: c.to.name,
            balance_effect: '-',
            note: `Comprador — pagó cláusula a ${c.from?.name ?? '?'}`
          });
        }
      }
    }
    return txs;
  }

  if (item.type === 'clauseIncrement') {
    for (const c of item.content) {
      if (!c.user) continue;
      txs.push({
        date, type: 'DepositoClausula',
        player: playerNames[c.player] ?? `#${c.player}`,
        amount: c.amount,
        participant: c.user.name,
        balance_effect: '-',
        note: `Nueva cláusula: ${c.releaseClause?.toLocaleString('es-ES')} €`
      });
    }
    return txs;
  }

  if (item.type === 'roundFinished') {
    const round = item.content?.round?.name ?? 'Jornada ?';
    const jornada = round.replace(/\s*\(aplazada\)$/, '');
    for (const r of (item.content?.results ?? [])) {
      const key = `${jornada}|${r.user.id}`;
      const delta = (r.bonus ?? 0) - (primasPaid[key] ?? 0);
      primasPaid[key] = r.bonus ?? 0;
      if (!delta) continue;
      txs.push({
        date, type: 'Prima', player: null,
        amount: Math.abs(delta),
        participant: r.user.name,
        balance_effect: delta > 0 ? '+' : '-',
        note: round
      });
    }
    return txs;
  }

  if (item.type === 'bonus') {
    for (const c of item.content) {
      if (!c.user || !c.amount) continue;
      txs.push({
        date, type: 'Ajuste', player: null,
        amount: Math.abs(c.amount),
        participant: c.user.name,
        balance_effect: c.amount > 0 ? '+' : '-',
        note: c.reason ?? 'Ajuste del administrador'
      });
    }
    return txs;
  }

  if (NON_FINANCIAL_TYPES.has(item.type)) return txs;

  // Salaries are a separate board item type (one per jornada, all participants)
  if (item.type === 'salaries') {
    for (const c of item.content) {
      if (!c.user || !c.amount) continue;
      txs.push({
        date, type: 'Salario', player: null,
        amount: c.amount,
        participant: c.user.name,
        balance_effect: '-'
      });
    }
    return txs;
  }

  // Log unrecognized item types so new cases can be mapped
  console.warn(`[scraper] UNKNOWN item type="${item.type}" date=${date} — raw:`, JSON.stringify(item).slice(0, 200));
  return txs;
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  loadEnv();

  const email    = process.env.BIWENGER_EMAIL;
  const password = process.env.BIWENGER_PASSWORD;
  if (!email || !password) {
    console.error('ERROR: BIWENGER_EMAIL and BIWENGER_PASSWORD must be set');
    process.exit(1);
  }

  const data    = loadData();
  const seasonTs = new Date(SEASON_START).getTime() / 1000;
  const previousCount = data.transactions.length;

  console.log(`[scraper] rebuilding season from ${SEASON_START} (existing transactions: ${previousCount})`);

  // 1. Auth
  const token   = await getToken(email, password);
  const headers = makeHeaders(token);
  console.log('[scraper] authenticated');

  // 2. Fetch and save league config
  await getLeagueConfig(headers);
  console.log('[scraper] league config saved');

  // 3. Fetch board pages back to the season start
  const boardItems = [];
  for (let offset = 0; ; offset += 100) {
    const page = await getBoardPage(headers, offset);
    if (!page.length) break;
    boardItems.push(...page.filter(i => i.date >= seasonTs));
    if (page.at(-1).date < seasonTs) break;
  }
  boardItems.sort((a, b) => a.date - b.date);
  console.log(`[scraper] board items this season: ${boardItems.length}`);

  // 4. Get player names
  const playerNames = await getPlayerNames();
  await fillMissingPlayerNames(playerNames, boardItems);
  console.log(`[scraper] player names loaded: ${Object.keys(playerNames).length}`);

  // 5. Convert board items (oldest first) to transactions
  const primasPaid = {};
  const transactions = boardItems.flatMap(item => boardItemToTransactions(item, playerNames, primasPaid));

  // 6. Save, newest first
  data.transactions = transactions.reverse();
  saveData(data);
  console.log(`[scraper] ✓ saved ${data.transactions.length} transactions (before: ${previousCount})`);
}

main().catch(err => { console.error('[scraper] fatal:', err); process.exit(1); });
