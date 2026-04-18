// ─── Connexion et requêtes PostgreSQL ────────────────────────────────────────
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  console.error('Erreur pool PostgreSQL:', err.message);
});

const db = {
  query: (text, params) => pool.query(text, params),

  // ─── Entreprises ──────────────────────────────────────────────────────────
  getEntrepriseByEmail: (email) =>
    pool.query('SELECT * FROM entreprises WHERE email_admin = $1', [email]),

  getEntrepriseById: (id) =>
    pool.query('SELECT * FROM entreprises WHERE id = $1', [id]),

  creerEntreprise: (nom, emailAdmin, trialDays) =>
    pool.query(
      `INSERT INTO entreprises (nom, email_admin, trial_ends_at)
       VALUES ($1, $2, NOW() + INTERVAL '${parseInt(trialDays)} days')
       RETURNING *`,
      [nom, emailAdmin]
    ),

  // ─── Abonnements ──────────────────────────────────────────────────────────
  getAbonnement: (entrepriseId) =>
    pool.query(
      'SELECT * FROM abonnements WHERE entreprise_id = $1 ORDER BY created_at DESC LIMIT 1',
      [entrepriseId]
    ),

  creerAbonnement: (entrepriseId, stripeSubId, nombreLicences, periodeFin) =>
    pool.query(
      `INSERT INTO abonnements (entreprise_id, stripe_subscription_id, nombre_licences, statut, periode_fin)
       VALUES ($1, $2, $3, 'active', $4) RETURNING *`,
      [entrepriseId, stripeSubId, nombreLicences, periodeFin]
    ),

  mettreAJourAbonnement: (stripeSubId, statut, nombreLicences, periodeFin) =>
    pool.query(
      `UPDATE abonnements SET statut = $2, nombre_licences = $3, periode_fin = $4, updated_at = NOW()
       WHERE stripe_subscription_id = $1`,
      [stripeSubId, statut, nombreLicences, periodeFin]
    ),

  // ─── Utilisateurs ─────────────────────────────────────────────────────────
  getUserByEmail: (email) =>
    pool.query('SELECT * FROM utilisateurs WHERE email = $1 AND actif = TRUE', [email]),

  getUserById: (id) =>
    pool.query('SELECT * FROM utilisateurs WHERE id = $1 AND actif = TRUE', [id]),

  creerUtilisateur: (nom, email, hashMotDePasse, entrepriseId, role = 'utilisateur') =>
    pool.query(
      `INSERT INTO utilisateurs (nom, email, mot_de_passe, entreprise_id, role)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [nom, email, hashMotDePasse, entrepriseId, role]
    ),

  mettreAJourUtilisateur: (id, updates) => {
    const fields = Object.keys(updates);
    const values = Object.values(updates);
    const setClause = fields.map((f, i) => `${f} = $${i + 1}`).join(', ');
    return pool.query(
      `UPDATE utilisateurs SET ${setClause}, updated_at = NOW() WHERE id = $${fields.length + 1}`,
      [...values, id]
    );
  },

  // ─── Salles ──────────────────────────────────────────────────────────────
  creerSalle: (token, entrepriseId, options = {}) =>
    pool.query(
      `INSERT INTO salles (token, entreprise_id, expires_at,
                           background_url, duration_s, auto_close,
                           rec_enabled, live_enabled)
       VALUES ($1, $2, NOW() + INTERVAL '24 hours',
               $3, $4, $5, $6, $7) RETURNING *`,
      [
        token, entrepriseId,
        options.backgroundUrl  || null,
        options.durationSeconds || null,
        options.autoClose      || false,
        options.recEnabled     || false,
        options.liveEnabled    || false
      ]
    ),

  getSalleByToken: (token) =>
    pool.query('SELECT * FROM salles WHERE token = $1 AND expires_at > NOW()', [token]),

  marquerSalleUtilisee: (token) =>
    pool.query('UPDATE salles SET utilisee = TRUE, used_at = NOW() WHERE token = $1', [token]),

  // ─── Invitations ──────────────────────────────────────────────────────────
  sauvegarderInvitation: (salleId, entrepriseId, journalisteId, nomInterviewe, emailInterviewe) =>
    pool.query(
      `INSERT INTO invitations (salle_id, entreprise_id, journaliste_id, nom_interviewe, email_interviewe)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [salleId, entrepriseId, journalisteId, nomInterviewe, emailInterviewe]
    ),

  // ─── Historique Interviews ─────────────────────────────────────────────────
  sauvegarderInterview: (entrepriseId, journalisteId, nomInterviewe, emailInterviewe, dureeSecondes) =>
    pool.query(
      `INSERT INTO historique_interviews (entreprise_id, journaliste_id, nom_interviewe, email_interviewe, duree_secondes, date_interview)
       VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING *`,
      [entrepriseId, journalisteId, nomInterviewe, emailInterviewe, dureeSecondes]
    ),

  getHistorique: (entrepriseId, limit = 50) =>
    pool.query(
      `SELECT h.*, u.nom as nom_journaliste
       FROM historique_interviews h
       LEFT JOIN utilisateurs u ON u.id = h.journaliste_id
       WHERE h.entreprise_id = $1
       ORDER BY h.date_interview DESC LIMIT $2`,
      [entrepriseId, limit]
    ),

  // ─── Nettoyage ────────────────────────────────────────────────────────────
  nettoyerSallesExpirees: () =>
    pool.query('SELECT nettoyer_salles_expirees()'),
};

module.exports = db;
