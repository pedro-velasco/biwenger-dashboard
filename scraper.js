/**
 * Biwenger feed scraper — API-based, no browser required.
 *
 * Uses the /api/v2/league/{id}/board endpoint (paginated) to fetch all
 * financial events and saves them to transactions.json.
 *
 * Incremental mode: on each run, only fetches events newer than
 * metadata.last_fetched. On first run, fetches the full season history.
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
      notes: [
        'Clausula con seller explícito genera dos registros: comprador (−) y vendedor (+).',
        'Prima = bonus de jornada (ingreso).',
        'Salario = coste de plantilla por jornada (gasto).',
        'Importes en euros (enteros, sin puntos ni símbolo €).'
      ]
    },
    transactions: []
  };
}

function saveData(data) {
  if (data.transactions.length > 0) {
    data.metadata.last_fetched = data.transactions.map(t => t.date).sort().at(-1);
  }
  data.metadata.last_updated = new Date().toISOString();
  data.metadata.notes = (data.metadata.notes || []).filter(n => !n.startsWith('AVISO'));
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function txKey(t) {
  return `${t.date}|${t.type}|${t.player ?? ''}|${t.amount}|${t.participant}`;
}

function mergeTransactions(existing, incoming) {
  const seen = new Set(existing.map(txKey));
  const added = incoming.filter(t => !seen.has(txKey(t)));
  if (!added.length) return { merged: existing, addedCount: 0 };
  const merged = [...existing, ...added].sort((a, b) => b.date.localeCompare(a.date));
  return { merged, addedCount: added.length };
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
    'X-Lang': 'es',
    'X-Version': '631'
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

// ── Board → transaction mapping ────────────────────────────────────────────────
/**
 * Confirmed mapping (validated against Pedro's exact API balance):
 *
 * item.type === 'market', c.to = user      → Compra (purchase, balance -)
 * item.type === 'transfer', c.type not set, c.from = user → Venta (sale, balance +)
 * item.type === 'transfer', c.type === 'immediateSale', c.from = user → Venta (sale, balance +)
 * item.type === 'transfer', c.type === 'clause', c.from = seller → Clausula received (+)
 * item.type === 'transfer', c.type === 'clause', c.to   = buyer  → Clausula paid (-)
 * item.type === 'roundFinished', results[].bonus > 0 → Prima (bonus, balance +)
 * item.type === 'roundFinished', results[].salary > 0 → Salario (cost, balance -)
 */
function boardItemToTransactions(item, playerNames, todayISO) {
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
    for (const r of (item.content?.results ?? [])) {
      if (r.bonus) {
        txs.push({
          date, type: 'Prima', player: null,
          amount: r.bonus,
          participant: r.user.name,
          balance_effect: '+',
          note: round
        });
      }
      if (r.salary) {
        txs.push({
          date, type: 'Salario', player: null,
          amount: r.salary,
          participant: r.user.name,
          balance_effect: '-',
          note: round
        });
      }
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

  const data      = loadData();
  const todayISO  = new Date().toISOString().slice(0, 10);
  const stopDate  = data.metadata.last_fetched ?? SEASON_START;
  const stopTs    = new Date(stopDate).getTime() / 1000;
  const isFullRun = !data.metadata.last_fetched;

  console.log(`[scraper] mode: ${isFullRun ? 'FULL HISTORY from ' + SEASON_START : 'INCREMENTAL from ' + stopDate}`);
  console.log(`[scraper] existing transactions: ${data.transactions.length}`);

  // 1. Auth
  const token   = await getToken(email, password);
  const headers = makeHeaders(token);
  console.log('[scraper] authenticated');

  // 2. Fetch and save league config
  await getLeagueConfig(headers);
  console.log('[scraper] league config saved');

  // 3. Fetch board pages until we reach stopDate
  // In full mode: collect everything from SEASON_START onwards.
  // In incremental mode: collect items whose date >= stopDate and let
  // mergeTransactions dedup items that are already in the file.
  const boardItems = [];
  const cutoffDate = isFullRun ? SEASON_START : stopDate; // stop fetching pages older than this

  for (let offset = 0; ; offset += 100) {
    const page = await getBoardPage(headers, offset);
    if (!page.length) break;

    boardItems.push(...page);

    const oldestOnPage = page.at(-1).date;
    const oldestDate   = new Date(oldestOnPage * 1000).toISOString().slice(0, 10);
    console.log(`[scraper] page offset=${offset}: ${page.length} items, oldest=${oldestDate}`);

    // Stop once the oldest item on this page is strictly before the cutoff date
    if (oldestDate < cutoffDate) break;
  }

  console.log(`[scraper] board items to process: ${boardItems.length}`);

  // 4. Get player names
  const playerNames = await getPlayerNames();
  console.log(`[scraper] player names loaded: ${Object.keys(playerNames).length}`);

  // 5. Convert board items to transactions and filter by date range
  const incoming = [];
  for (const item of boardItems) {
    const txs = boardItemToTransactions(item, playerNames, todayISO);
    for (const tx of txs) {
      if (tx.date < cutoffDate) continue; // skip items outside the desired range
      incoming.push(tx);
    }
  }

  console.log(`[scraper] new transactions parsed: ${incoming.length}`);

  // 6. Merge and save
  const { merged, addedCount } = mergeTransactions(data.transactions, incoming);
  data.transactions = merged;

  if (addedCount > 0 || isFullRun) {
    saveData(data);
    console.log(`[scraper] ✓ saved ${addedCount} new transactions. Total: ${data.transactions.length}`);
  } else {
    saveData(data); // still update last_updated timestamp
    console.log('[scraper] no new transactions.');
  }
}

main().catch(err => { console.error('[scraper] fatal:', err); process.exit(1); });
