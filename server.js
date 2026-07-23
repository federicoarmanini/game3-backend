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

// ── HELPER: calcola token offline 
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
app.get('/health', (req
