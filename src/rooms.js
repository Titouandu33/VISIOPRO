// ─── Gestion des salles et invitations ───────────────────────────────────────
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db      = require('./database');
const email   = require('./email');
const { verifierToken } = require('./auth');
const router  = express.Router();

// Générer un code de salle lisible (ex: abc-xyz-123)
const genererCode = () => {
  const partie = () => Math.random().toString(36).substring(2, 5);
  return `${partie()}-${partie()}-${partie()}`;
};

// POST /salles/creer — journaliste crée une invitation (email OU téléphone)
router.post('/creer', verifierToken, async (req, res) => {
  try {
    const {
      nom_interviewe,
      email_interviewe,
      telephone_interviewe,
      message_sms         // message SMS personnalisé (optionnel)
    } = req.body;

    // Validation : nom requis + au moins un contact
    if (!nom_interviewe || (!email_interviewe && !telephone_interviewe)) {
      return res.status(400).json({
        erreur: 'Le nom de l\'interviewé et au moins un moyen de contact (email ou téléphone) sont requis.'
      });
    }

    const entrepriseId = req.utilisateur.entreprise_id;

    // Vérifier les licences disponibles
    const licences = await db.getNombreLicencesDisponibles(entrepriseId);
    if (licences.disponibles <= 0) {
      return res.status(403).json({
        erreur: 'Toutes vos licences sont actuellement utilisées.',
        licences
      });
    }

    // Normaliser les champs de contact
    const emailNormalise    = email_interviewe     ? email_interviewe.toLowerCase().trim()  : null;
    const telephoneNormalise = telephone_interviewe ? telephone_interviewe.trim()            : null;

    // Créer la salle
    const codeSalle = genererCode();
    const salleResult = await db.creerSalle(
      codeSalle,
      entrepriseId,
      req.utilisateur.id,
      nom_interviewe.trim(),
      emailNormalise,
      telephoneNormalise
    );
    const salle = salleResult.rows[0];

    // Construire le lien
    const lienRejoindre = `${process.env.CLIENT_B_URL}/${codeSalle}`;

    // Envoyer l'invitation selon le mode choisi
    let destinataireAffiche;
    if (emailNormalise) {
      await email.envoyerInvitation({
        destinataire:   emailNormalise,
        nomInterviewe:  nom_interviewe.trim(),
        nomJournaliste: req.utilisateur.nom,
        lienRejoindre
      });
      destinataireAffiche = emailNormalise;
    } else {
      await email.envoyerSMS({
        telephone:          telephoneNormalise,
        nomInterviewe:      nom_interviewe.trim(),
        nomJournaliste:     req.utilisateur.nom,
        lienRejoindre,
        messagePersonnalise: message_sms
      });
      destinataireAffiche = telephoneNormalise;
    }

    res.status(201).json({
      salle: {
        id:             salle.id,
        code_salle:     codeSalle,
        lien_rejoindre: lienRejoindre,
        nom_interviewe: salle.nom_interviewe,
        expires_at:     salle.expires_at
      },
      mode_envoi: emailNormalise ? 'email' : 'sms',
      message: `Invitation envoyée à ${destinataireAffiche}`
    });
  } catch (err) {
    console.error('Erreur création salle:', err.message);
    res.status(500).json({ erreur: 'Erreur lors de la création de la salle' });
  }
});

// GET /salles/info/:code — infos d'une salle (pour page B)
router.get('/info/:code', async (req, res) => {
  try {
    const result = await db.getSalleByCode(req.params.code);
    if (!result.rows.length) {
      return res.status(404).json({ erreur: 'Salle introuvable ou lien expiré' });
    }

    const salle = result.rows[0];

    if (salle.statut === 'expiree' || new Date(salle.expires_at) < new Date()) {
      return res.status(410).json({ erreur: 'Ce lien a expiré.' });
    }
    if (salle.statut === 'terminee') {
      return res.status(410).json({ erreur: 'Cette visioconférence est terminée.' });
    }

    // Informations publiques uniquement (pas de données sensibles)
    res.json({
      code_salle: salle.code_salle,
      nom_interviewe: salle.nom_interviewe,
      statut: salle.statut
    });
  } catch (err) {
    res.status(500).json({ erreur: 'Erreur serveur' });
  }
});

// GET /salles/historique — historique pour l'admin
router.get('/historique', verifierToken, async (req, res) => {
  try {
    const result = await db.getHistorique(req.utilisateur.entreprise_id);
    res.json({ historique: result.rows });
  } catch (err) {
    res.status(500).json({ erreur: 'Erreur serveur' });
  }
});

// GET /salles/licences — état des licences
router.get('/licences', verifierToken, async (req, res) => {
  try {
    const licences = await db.getNombreLicencesDisponibles(req.utilisateur.entreprise_id);
    res.json(licences);
  } catch (err) {
    res.status(500).json({ erreur: 'Erreur serveur' });
  }
});

module.exports = router;
