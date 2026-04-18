// ─── Connexion et requêtes PostgreSQL ────────────────────────────────────────
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false, max: 20 });
module.exports = { query: (t,p) => pool.query(t,p) };