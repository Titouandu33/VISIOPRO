// ─── Signalisation WebRTC via Socket.io ──────────────────────────────────────
const jwt = require('jsonwebtoken');
const db  = require('./database');

// Map des salles actives en mémoire: codeSalle → { socketA, socketB, ... }
const sallesActives = new Map();
// Map des journalistes en attente de licence: entrepriseId → [socket]
const listeAttente  = new Map();

const configurer = (io) => {
  io.on('connection', (socket) => {

    // ─── Rejoindre une salle (Personne A ou B) ──────────────────────────────
    socket.on('rejoindre_salle', async ({ codeSalle, token, role }) => {
      try {
        // Vérifier la salle en base
        const salleResult = await db.getSalleByCode(codeSalle);
        if (!salleResult.rows.length) {
          socket.emit('erreur', { message: 'Salle introuvable' });
          return;
        }

        const salle = salleResult.rows[0];
        if (['expiree', 'terminee'].includes(salle.statut) ||
            new Date(salle.expires_at) < new Date()) {
          socket.emit('erreur', { message: 'Ce lien a expiré' });
          return;
        }

        // Personne A (journaliste) : vérifier le token JWT
        if (role === 'journaliste') {
          try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            // Vérifier les licences
            const licences = await db.getNombreLicencesDisponibles(decoded.entrepriseId);
            if (licences.disponibles <= 0) {
              socket.emit('licences_epuisees', {
                message: 'Toutes vos licences sont utilisées. Vous serez notifié dès qu\'un poste se libère.',
                licences
              });
              // Mettre en liste d'attente
              if (!listeAttente.has(decoded.entrepriseId)) {
                listeAttente.set(decoded.entrepriseId, []);
              }
              listeAttente.get(decoded.entrepriseId).push(socket.id);
              socket.data.entrepriseId = decoded.entrepriseId;
              socket.data.enAttente = true;
              return;
            }

            // Enregistrer l'appel actif + activer la salle
            const appel = await db.creerAppelActif(salle.id, decoded.entrepriseId);
            await db.activerSalle(codeSalle);

            socket.data = {
              codeSalle,
              role: 'journaliste',
              salleId: salle.id,
              entrepriseId: decoded.entrepriseId,
              journalisteId: decoded.userId,
              nomInterviewe: salle.nom_interviewe,
              appelActifId: appel.rows[0].id,
              joinedAt: Date.now()
            };
          } catch (e) {
            socket.emit('erreur', { message: 'Token invalide' });
            return;
          }
        } else {
          // Personne B (interviewé) — pas de token requis
          socket.data = {
            codeSalle,
            role: 'interviewe',
            salleId: salle.id,
            entrepriseId: salle.entreprise_id,
            nomInterviewe: salle.nom_interviewe
          };
        }

        // Rejoindre la room Socket.io
        socket.join(codeSalle);

        // Gérer la salle en mémoire
        if (!sallesActives.has(codeSalle)) {
          sallesActives.set(codeSalle, { sockets: new Set() });
        }
        sallesActives.get(codeSalle).sockets.add(socket.id);

        // Notifier les participants
        socket.emit('salle_rejointe', {
          codeSalle,
          role: socket.data.role,
          nomInterviewe: salle.nom_interviewe
        });

        // Notifier l'autre participant qu'un pair a rejoint
        socket.to(codeSalle).emit('pair_rejoint', {
          role: socket.data.role
        });

        console.log(`[${codeSalle}] ${socket.data.role} rejoint (${socket.id})`);
      } catch (err) {
        console.error('Erreur rejoindre_salle:', err.message);
        socket.emit('erreur', { message: 'Erreur serveur' });
      }
    });

    // ─── Signalisation WebRTC ────────────────────────────────────────────────
    // Transmettre l'offre SDP au pair
    socket.on('offre_webrtc', ({ codeSalle, offre }) => {
      socket.to(codeSalle).emit('offre_webrtc', { offre });
    });

    // Transmettre la réponse SDP au pair
    socket.on('reponse_webrtc', ({ codeSalle, reponse }) => {
      socket.to(codeSalle).emit('reponse_webrtc', { reponse });
    });

    // Transmettre les ICE candidates
    socket.on('ice_candidate', ({ codeSalle, candidate }) => {
      socket.to(codeSalle).emit('ice_candidate', { candidate });
    });

    // ─── Récupérer les serveurs TURN/STUN — Metered.ca (gratuit 500 MB/mois) ──
    // Le client utilise le pattern acknowledgment de Socket.io : socket.emit('demander_ice_servers', callback)
    // Le serveur répond via le callback, pas via socket.emit séparé.
    socket.on('demander_ice_servers', async (callback) => {
      if (typeof callback !== 'function') return;
      try {
        // Appel à l'API Metered.ca pour obtenir des credentials TURN éphémères
        const url = `https://${process.env.METERED_APP_NAME}.metered.live/api/v1/turn/credentials?apiKey=${process.env.METERED_API_KEY}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Metered HTTP ${response.status}`);
        const iceServers = await response.json();
        callback(iceServers);
      } catch (err) {
        console.warn('[ICE] Metered.ca indisponible, fallback STUN Google :', err.message);
        // Fallback : STUN publics de Google (suffisants si les deux pairs ne sont pas derrière un NAT strict)
        callback([
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' }
        ]);
      }
    });

    // ─── Fin d'appel ────────────────────────────────────────────────────────
    socket.on('terminer_appel', async ({ codeSalle }) => {
      await terminerAppel(socket, codeSalle, io);
    });

    // ─── Déconnexion ────────────────────────────────────────────────────────
    socket.on('disconnect', async () => {
      if (socket.data?.codeSalle) {
        const salle = sallesActives.get(socket.data.codeSalle);
        if (salle) {
          salle.sockets.delete(socket.id);
          if (salle.sockets.size === 0) {
            sallesActives.delete(socket.data.codeSalle);
          }
        }
        // Notifier le pair restant
        socket.to(socket.data.codeSalle).emit('pair_deconnecte', {
          role: socket.data.role
        });

        // Si c'était un journaliste, libérer la licence
        if (socket.data.role === 'journaliste') {
          await terminerAppel(socket, socket.data.codeSalle, io);
        }
      }

      // Retirer de la liste d'attente si applicable
      if (socket.data?.enAttente && socket.data?.entrepriseId) {
        const attente = listeAttente.get(socket.data.entrepriseId);
        if (attente) {
          const idx = attente.indexOf(socket.id);
          if (idx > -1) attente.splice(idx, 1);
        }
      }
    });
  });
};

// ─── Terminer un appel et libérer la licence ──────────────────────────────────
const terminerAppel = async (socket, codeSalle, io) => {
  try {
    if (!socket.data?.salleId) return;

    // Calculer la durée
    const duree = socket.data.joinedAt
      ? Math.floor((Date.now() - socket.data.joinedAt) / 1000)
      : 0;

    // Enregistrer dans l'historique
    await db.enregistrerInterview(
      socket.data.entrepriseId,
      socket.data.journalisteId,
      socket.data.nomInterviewe,
      null,
      duree
    );

    // Supprimer l'appel actif (libère la licence)
    await db.supprimerAppelActif(socket.data.salleId);
    await db.terminerSalle(codeSalle);

    // Notifier le pair que l'appel est terminé
    io.to(codeSalle).emit('appel_termine');

    // Notifier les journalistes en attente de la même entreprise
    const attente = listeAttente.get(socket.data.entrepriseId);
    if (attente && attente.length > 0) {
      const prochainSocketId = attente.shift();
      const prochainSocket = io.sockets.sockets.get(prochainSocketId);
      if (prochainSocket) {
        prochainSocket.emit('licence_disponible', {
          message: 'Une licence vient de se libérer. Vous pouvez maintenant démarrer votre interview.'
        });
      }
    }

    // Nettoyer les données du socket
    socket.data.salleId   = null;
    socket.data.joinedAt  = null;
    console.log(`[${codeSalle}] Appel terminé. Durée: ${duree}s`);
  } catch (err) {
    console.error('Erreur terminer appel:', err.message);
  }
};

module.exports = { configurer };
