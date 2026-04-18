// ─── Authentification JWT ─────────────────────────────────────────────────────
const express  = require('express');
const bcrypt   = require('bcrypt');
const jwt      = require('jsonwebtoken');
const db       = require('./database');
const router   = express.Router();

const SALT_ROUNDS = 12;

// ─── Middleware de vérification du token ──────────────────────────────────────
const verifierToken = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ erreur: 'Token manquant' });
    }
    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const result = await db.getUserById(decoded.userId);
    if (!result.rows.length) {
      return res.status(401).json({ erreur: 'Utilisateur introuvable' });
    }
    req.utilisateur = result.rows[0];
    next();
  } catch (err) {
    return res.status(401).json({ erreur: 'Token invalide ou expiré' });
  }
};

// ─── Middleware admin ─────────────────────────────────────────────────────────
const verifierAdmin = (req, res, next) => {
  if (req.utilisateur.role !== 'admin') {
    return res.status(403).json({ erreur: 'Accès réservé aux administrateurs' });
  }
  next();
};

// POST /auth/connexion
router.post('/connexion', async (req, res) => {
  try {
    const { email, mot_de_passe } = req.body;
    if (!email || !mot_de_passe) {
      return res.status(400).json({ erreur: 'Email et mot de passe requis' });
    }

    const result = await db.getUserByEmail(email.toLowerCase().trim());
    if (!result.rows.length) {
      return res.status(401).json({ erreur: 'Identifiants incorrects' });
    }

    const utilisateur = result.rows[0];
    const mdpValide = await bcrypt.compare(mot_de_passe, utilisateur.mot_de_passe);
    if (!mdpValide) {
      return res.status(401).json({ erreur: 'Identifiants incorrects' });
    }

    // Vérifier que l'abonnement est actif
    const licences = await db.getNombreLicencesDisponibles(utilisateur.entreprise_id);
    if (licences.total === 0 && !licences.enTrial) {
      return res.status(403).json({ erreur: 'Abonnement expiré. Contactez votre administrateur.' });
    }

    const token = jwt.sign(
      { userId: utilisateur.id, entrepriseId: utilisateur.entreprise_id, role: utilisateur.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '30d' }
    );

    res.json({
      token,
      utilisateur: {
        id: utilisateur.id,
        email: utilisateur.email,
        nom: utilisateur.nom,
        role: utilisateur.role,
        entreprise_id: utilisateur.entreprise_id
      }
    });
  } catch (err) {
    console.error('Erreur connexion:', err.message);
    res.status(500).json({ erreur: 'Erreur serveur' });
  }
});

// GET /auth/moi — vérifier la session courante
router.get('/moi', verifierToken, async (req, res) => {
  const licences = await db.getNombreLicencesDisponibles(req.utilisateur.entreprise_id);
  res.json({
    utilisateur: {
      id: req.utilisateur.id,
      email: req.utilisateur.email,
      nom: req.utilisateur.nom,
      role: req.utilisateur.role,
      entreprise_id: req.utilisateur.entreprise_id
    },
    licences
  });
});

// POST /auth/creer-compte — créer une entreprise + admin (premier setup)
router.post('/creer-compte', async (req, res) => {
  try {
    const { nom_entreprise, email, mot_de_passe, nom_admin } = req.body;
    if (!nom_entreprise || !email || !mot_de_passe || !nom_admin) {
      return res.status(400).json({ erreur: 'Tous les champs sont requis' });
    }

    // Vérifier email unique
    const existant = await db.getUserByEmail(email.toLowerCase());
    if (existant.rows.length) {
      return res.status(409).json({ erreur: 'Un compte existe déjà avec cet email' });
    }

    // Créer l'entreprise (avec trial)
    const entrepriseResult = await db.creerEntreprise(
      nom_entreprise,
      email.toLowerCase(),
      process.env.TRIAL_DAYS || 14
    );
    const entreprise = entrepriseResult.rows[0];

    // Hasher le mot de passe
    const hash = await bcrypt.hash(mot_de_passe, SALT_ROUNDS);

    // Créer l'utilisateur admin
    const userResult = await db.creerUtilisateur(
      entreprise.id, email.toLowerCase(), hash, nom_admin, 'admin'
    );

    // Créer un abonnement trial
    await db.query(
      `INSERT INTO abonnements (entreprise_id, nombre_licences, statut, periode_fin)
       VALUES ($1, 1, 'trial', $2)`,
      [entreprise.id, entreprise.trial_ends_at]
    );

    const token = jwt.sign(
      { userId: userResult.rows[0].id, entrepriseId: entreprise.id, role: 'admin' },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '30d' }
    );

    res.status(201).json({ token, message: `Compte créé. Essai gratuit de ${process.env.TRIAL_DAYS || 14} jours activé.` });
  } catch (err) {
    console.error('Erreur création compte:', err.message);
    res.status(500).json({ erreur: 'Erreur serveur' });
  }
});

// POST /auth/creer-utilisateur — ajouter un journaliste (admin seulement)
router.post('/creer-utilisateur', verifierToken, verifierAdmin, async (req, res) => {
  try {
    const { email, mot_de_passe, nom } = req.body;
    if (!email || !mot_de_passe || !nom) {
      return res.status(400).json({ erreur: 'Email, mot de passe et nom requis' });
    }

    const existant = await db.getUserByEmail(email.toLowerCase());
    if (existant.rows.length) {
      return res.status(409).json({ erreur: 'Email déjà utilisé' });
    }

    const hash = await bcrypt.hash(mot_de_passe, SALT_ROUNDS);
    const result = await db.creerUtilisateur(
      req.utilisateur.entreprise_id, email.toLowerCase(), hash, nom, 'journaliste'
    );

    res.status(201).json({ utilisateur: result.rows[0] });
  } catch (err) {
    console.error('Erreur création utilisateur:', err.message);
    res.status(500).json({ erreur: 'Erreur serveur' });
  }
});

// GET /auth/utilisateurs — liste des journalistes (admin)
router.get('/utilisateurs', verifierToken, verifierAdmin, async (req, res) => {
  try {
    const result = await db.getUtilisateursDEntreprise(req.utilisateur.entreprise_id);
    res.json({ utilisateurs: result.rows });
  } catch (err) {
    res.status(500).json({ erreur: 'Erreur serveur' });
  }
});

module.exports = { router, verifierToken, verifierAdmin };
