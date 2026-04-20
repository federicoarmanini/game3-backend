const express = require('express');
const cors    = require('cors');
const { ethers } = require('ethers');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// ── IN-MEMORY DATABASE (senza PostgreSQL per ora) ────────
// In produzione sostituire con PostgreSQL
const players = {};

// ── SIGNER (wallet admin con SIGNER_ROLE) ────────────────
// La chiave privata viene da variabile d'ambiente — mai nel codice
let signerWallet = null;
if (process.env.SIGNER_PRIVATE_KEY) {
  signerWallet = new ethers.Wallet(process.env.SIGNER_PRIVATE_KEY);
  console.log('Signer wallet:', signerWallet.address);
}

// ── HELPER: calcola token offline ────────────────────────
function calcOfflineTokens(player) {
  if (!player.lastSeen) return 0;
  const elapsed = Math.floor((Date.now() - player.lastSeen) / 1000);
  if (elapsed < 10) return 0;

  let gameRate = 0;
  if (player.grid) {
    const BUILDINGS = {
      miner: { game: 0.5 },
    };
    player.grid.forEach(cell => {
      if (!cell) return;
      if (BUILDINGS[cell.type] && BUILDINGS[cell.type].game) {
        gameRate += BUILDINGS[cell.type].game * cell.level * 0.1;
      }
    });
  }
  return gameRate * elapsed;
}

// ── ROUTES ────────────────────────────────────────────────

// GET /health — check server
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// POST /api/player/save — salva stato giocatore
app.post('/api/player/save', (req, res) => {
  const { address, state } = req.body;
  if (!address || !state) return res.status(400).json({ error: 'Missing address or state' });

  const addr = address.toLowerCase();
  const existing = players[addr] || {};

  players[addr] = {
    ...state,
    address: addr,
    lastSeen: Date.now(),
    totalPlaytime: (existing.totalPlaytime || 0) + (state.seconds || 0),
  };

  res.json({ success: true });
});

// POST /api/player/load — carica stato giocatore
app.post('/api/player/load', (req, res) => {
  const { address } = req.body;
  if (!address) return res.status(400).json({ error: 'Missing address' });

  const addr = address.toLowerCase();
  const player = players[addr];

  if (!player) return res.json({ exists: false });

  // Calcola token offline
  const offlineTokens = calcOfflineTokens(player);
  const elapsedSeconds = Math.floor((Date.now() - player.lastSeen) / 1000);

  // Aggiorna lastSeen
  players[addr].lastSeen = Date.now();
  players[addr].gameToken = (player.gameToken || 0) + offlineTokens;

  res.json({
    exists: true,
    state: players[addr],
    offlineTokens,
    elapsedSeconds,
  });
});

// POST /api/reward/sign — firma reward per claim on-chain
app.post('/api/reward/sign', async (req, res) => {
  const { address, amount } = req.body;

  if (!address || !amount) return res.status(400).json({ error: 'Missing params' });
  if (!signerWallet) return res.status(500).json({ error: 'Signer not configured' });

  const addr = address.toLowerCase();
  const player = players[addr];

  if (!player) return res.status(404).json({ error: 'Player not found' });
  if ((player.gameToken || 0) < amount) return res.status(400).json({ error: 'Insufficient tokens' });

  try {
    const amountWei = ethers.parseEther(String(Math.floor(amount)));
    const nonce     = BigInt(player.claimNonce || 0);
    const expiry    = BigInt(Math.floor(Date.now() / 1000) + 300);

    const msgHash = ethers.solidityPackedKeccak256(
      ['address', 'uint256', 'uint256', 'uint256'],
      [address, amountWei, nonce, expiry]
    );
    const signature = await signerWallet.signMessage(ethers.getBytes(msgHash));

    // Scala i token dal saldo
    players[addr].gameToken = (player.gameToken || 0) - amount;
    players[addr].claimNonce = (player.claimNonce || 0) + 1;

    res.json({ signature, nonce: nonce.toString(), expiry: expiry.toString(), amount: amountWei.toString() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Signing failed' });
  }
});

// GET /api/leaderboard — top 10 giocatori per gameToken
app.get('/api/leaderboard', (req, res) => {
  const top = Object.values(players)
    .sort((a, b) => (b.gameToken || 0) - (a.gameToken || 0))
    .slice(0, 10)
    .map(p => ({
      address: p.address.slice(0, 6) + '...' + p.address.slice(-4),
      gameToken: Math.floor(p.gameToken || 0),
      level: p.level || 1,
    }));
  res.json(top);
});

// ── START ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`GAME3 Backend running on port ${PORT}`));
