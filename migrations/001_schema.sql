-- ═══════════════════════════════════════════════════════════════════════════
-- SCHEMA BASE DE DONNÉES — APPLICATION VISIO
-- Exécuter une seule fois lors du premier déploiement
-- ═══════════════════════════════════════════════════════════════════════════

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─── ENTREPRISES ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS entreprises (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  nom                 VARCHAR(255) NOT NULL,
  email_admin         VARCHAR(255) UNIQUE NOT NULL,
  stripe_customer_id  VARCHAR(255),
  trial_ends_at       TIMESTAMPTZ,
  actif               BOOLEAN DEFAULT TRUE,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ─── ABONNEMENTS ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS abonnements (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  entreprise_id           UUID REFERENCES entreprises(id) ON DELETE CASCADE,
  stripe_subscription_id  VARCHAR(255) UNIQUE,
  nombre_licences         INTEGER NOT NULL DEFAULT 1,
  statut                  VARCHAR(50) DEFAULT 'trial',
  -- statuts: trial, active, past_due, canceled
  periode_fin             TIMESTAMPTZ,
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_at              TIMESTAMPTZ DEFAULT NOW()
);

-- ─── UTILISATEURS (journalistes) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS utilisateurs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  entreprise_id   UUID REFERENCES entreprises(id) ON DELETE CASCADE,
  email           VARCHAR(255) UNIQUE NOT NULL,
  mot_de_passe    VARCHAR(255) NOT NULL,
  nom             VARCHAR(255) NOT NULL,
  role            VARCHAR(50) DEFAULT 'journaliste',
  -- roles: admin, journaliste
  actif           BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─── SALLES (visioconférences) ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS salles (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code_salle            VARCHAR(64) UNIQUE NOT NULL,
  entreprise_id         UUID REFERENCES entreprises(id) ON DELETE CASCADE,
  cree_par              UUID REFERENCES utilisateurs(id),
  nom_interviewe        VARCHAR(255) NOT NULL,
  email_interviewe      VARCHAR(255),          -- nullable : email OU téléphone
  telephone_interviewe  VARCHAR(50),           -- nullable : téléphone OU email
  statut                VARCHAR(50) DEFAULT 'en_attente',
  -- statuts: en_attente, active, terminee, expiree
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  expires_at            TIMESTAMPTZ DEFAULT NOW() + INTERVAL '24 hours',
  started_at            TIMESTAMPTZ,
  ended_at              TIMESTAMPTZ,
  CONSTRAINT contact_requis CHECK (
    email_interviewe IS NOT NULL OR telephone_interviewe IS NOT NULL
  )
);

-- ─── APPELS ACTIFS (licences en cours d'utilisation) ──────────────────────────
CREATE TABLE IF NOT EXISTS appels_actifs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  salle_id        UUID REFERENCES salles(id) ON DELETE CASCADE,
  entreprise_id   UUID REFERENCES entreprises(id) ON DELETE CASCADE,
  started_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─── HISTORIQUE INTERVIEWS ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS historique_interviews (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  entreprise_id     UUID REFERENCES entreprises(id) ON DELETE CASCADE,
  journaliste_id    UUID REFERENCES utilisateurs(id),
  nom_interviewe    VARCHAR(255),
  email_interviewe  VARCHAR(255),
  duree_secondes    INTEGER,
  date_interview    TIMESTAMPTZ DEFAULT NOW()
);

-- ─── INDEX ────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_salles_code ON salles(code_salle);
CREATE INDEX IF NOT EXISTS idx_appels_entreprise ON appels_actifs(entreprise_id);
CREATE INDEX IF NOT EXISTS idx_utilisateurs_email ON utilisateurs(email);
CREATE INDEX IF NOT EXISTS idx_abonnements_entreprise ON abonnements(entreprise_id);
CREATE INDEX IF NOT EXISTS idx_historique_entreprise ON historique_interviews(entreprise_id);

-- ─── NETTOYAGE AUTOMATIQUE ────────────────────────────────────────────────────
-- Supprimer les salles expirées (à appeler via un cron ou au démarrage)
CREATE OR REPLACE FUNCTION nettoyer_salles_expirees()
RETURNS void AS $$
BEGIN
  UPDATE salles
  SET statut = 'expiree'
  WHERE statut = 'en_attente'
    AND expires_at < NOW();

  DELETE FROM appels_actifs
  WHERE salle_id IN (
    SELECT id FROM salles WHERE statut IN ('terminee', 'expiree')
  );
END;
$$ LANGUAGE plpgsql;

SELECT 'Schema créé avec succès.' AS message;
