const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// ── DATABASE (Neon) 
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Crea le tabelle se non esistono
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      address TEXT PRIMARY KEY,
      state JSONB NOT NULL DEFAULT '{}',
      game_token NUMERIC DEFAULT 0,
      level INTEGER DEFAULT 1,
      last_seen BIGINT,
      claim_nonce INTEGER DEFAULT 0,
      total_playtime INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('Database ready');
}
initDB().catch(console.error);

// ── SIGNER 
let signerWallet = null;
if (process.env.SIGNER_PRIVATE_KEY) {
  signerWallet = new ethers.Wallet(process.env.SIGNER_PRIVATE_KEY);
  console.log('Signer:', signerWallet.address);
}

// ── HELPER: calculates offline token 
function calcOfflineTokens(player) {
  if (!player.last_seen) return 0;
  const elapsed = Math.floor((Date.now() - player.last_seen) / 1000);
  if (elapsed < 15) return 0;

  let gameRate = 0;
  const grid = player.state?.grid || [];
  grid.forEach(cell => {
    if (cell && cell.type === 'miner') {
      gameRate += 0.5 * (cell.level || 1) * 0.1;
    }
  });
  return gameRate * elapsed;
}

// ── ROUTES

// Health
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: Date.now() });
});

// Salva stato giocatore
app.post('/api/player/save', async (req, res) => {
  try {
    const { address, state } = req.body;
    if (!address || !state) return res.status(400).json({ error: 'Missing data' });

    const addr = address.toLowerCase();

    await pool.query(`
      INSERT INTO players (address, state, game_token, level, last_seen, total_playtime)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (address) DO UPDATE SET
        state = $2,
        game_token = $3,
        level = $4,
        last_seen = $5,
        total_playtime = players.total_playtime + $6
    `, [
      addr,
      JSON.stringify(state),
      state.gameToken || 0,
      state.level || 1,
      Date.now(),
      state.seconds || 0
    ]);

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Save failed' });
  }
});

app.post('/api/player/load', async (req, res) => {
  try {
    const { address } = req.body;
    if (!address) return res.status(400).json({ error: 'Missing address' });

    const addr = address.toLowerCase();
    const result = await pool.query('SELECT * FROM players WHERE address = $1', [addr]);

    if (result.rows.length === 0) {
      return res.json({ exists: false });
    }

    const player = result.rows[0];
    const offlineTokens = calcOfflineTokens(player);
    const elapsedSeconds = Math.floor((Date.now() - (player.last_seen || Date.now())) / 1000);

    const newToken = parseFloat(player.game_token || 0) + offlineTokens;
    await pool.query(
      'UPDATE players SET last_seen = $1, game_token = $2 WHERE address = $3',
      [Date.now(), newToken, addr]
    );

    res.json({
      exists: true,
      state: {
        ...player.state,
        gameToken: newToken,
        level: player.level
      },
      offlineTokens,
      elapsedSeconds
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Load failed' });
  }
});

app.post('/api/reward/sign', async (req, res) => {
  try {
    const { address, amount } = req.body;
    if (!address || !amount) return res.status(400).json({ error: 'Missing params' });
    if (!signerWallet) return res.status(500).json({ error: 'Signer not configured' });

    const addr = address.toLowerCase();
    const result = await pool.query('SELECT * FROM players WHERE address = $1', [addr]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Player not found' });

    const player = result.rows[0];
    if (parseFloat(player.game_token) < amount) {
      return res.status(400).json({ error: 'Insufficient tokens' });
    }

    const amountWei = ethers.parseEther(String(Math.floor(amount)));
    const nonce = BigInt(player.claim_nonce || 0);
    const expiry = BigInt(Math.floor(Date.now() / 1000) + 300);

    const msgHash = ethers.solidityPackedKeccak256(
      ['address', 'uint256', 'uint256', 'uint256'],
      [address, amountWei, nonce, expiry]
    );
    const signature = await signerWallet.signMessage(ethers.getBytes(msgHash));

    await pool.query(
      'UPDATE players SET game_token = game_token - $1, claim_nonce = claim_nonce + 1 WHERE address = $2',
      [amount, addr]
    );

    res.json({
      signature,
      nonce: nonce.toString(),
      expiry: expiry.toString(),
      amount: amountWei.toString()
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Signing failed' });
  }
});

// Leaderboard
app.get('/api/leaderboard', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT address, game_token, level 
      FROM players 
      ORDER BY game_token DESC 
      LIMIT 10
    `);

    const top = result.rows.map(p => ({
      address: p.address.slice(0, 6) + '...' + p.address.slice(-4),
      gameToken: Math.floor(p.game_token || 0),
      level: p.level || 1
    }));

    res.json(top);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Leaderboard failed' });
  }
});

// ── START ────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`GAME3 Backend running on port ${PORT}`));
