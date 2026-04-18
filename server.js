// ═══════════════════════════════════════════════════════════════════════════
// SERVEUR PRINCIPAL — Application Visio
// ═══════════════════════════════════════════════════════════════════════════
require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const helmet     = require('helmet');

const db         = require('./src/database');
const { router: authRouter } = require('./src/auth');
const sallesRouter = require('./src/rooms');
const stripeRouter = require('./src/stripe');
const signaling  = require('./src/signaling');

const app    = express();
const server = http.createServer(app);

// ─── Socket.io ────────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
    methods: ['GET', 'POST']
  },
  pingTimeout:  60000,
  pingInterval: 25000
});

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  credentials: true
}));

// Le webhook Stripe doit recevoir le body brut — le monter AVANT express.json()
app.use('/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// ─── Routes API ───────────────────────────────────────────────────────────────
app.use('/auth',    authRouter);
app.use('/salles',  sallesRouter);
app.use('/stripe',  stripeRouter);

// Santé du serveur
app.get('/ping', (req, res) => res.json({ statut: 'ok', heure: new Date().toISOString() }));

// ─── Signalisation WebRTC ─────────────────────────────────────────────────────
signaling.configurer(io);

// ─── Nettoyage périodique ─────────────────────────────────────────────────────
setInterval(async () => {
  try {
    await db.nettoyerSallesExpirees();
  } catch (err) {
    console.error('Erreur nettoyage:', err.message);
  }
}, 10 * 60 * 1000); // toutes les 10 minutes

// ─── Gestion des erreurs ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Erreur non gérée:', err.message);
  res.status(500).json({ erreur: 'Erreur serveur interne' });
});

// ─── Démarrage ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
  console.log(`Environnement : ${process.env.NODE_ENV || 'development'}`);
  // Nettoyage au démarrage
  db.nettoyerSallesExpirees().catch(console.error);
});

module.exports = { app, server };
