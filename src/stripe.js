// ─── Intégration Stripe (abonnements et paiements) ────────────────────────────
const express = require('express');
const db      = require('./database');
const { verifierToken } = require('./auth');
const router  = express.Router();

let stripe;
const getStripe = () => {
  if (!stripe) stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  return stripe;
};

// Mapping: nombre de licences → Price IDs Stripe
const getPriceId = (nombreLicences, periodicite) => {
  const map = {
    '1_mensuel':  process.env.STRIPE_PRICE_1_LICENCE_MENSUEL,
    '1_annuel':   process.env.STRIPE_PRICE_1_LICENCE_ANNUEL,
    '3_mensuel':  process.env.STRIPE_PRICE_3_LICENCES_MENSUEL,
    '3_annuel':   process.env.STRIPE_PRICE_3_LICENCES_ANNUEL,
    '5_mensuel':  process.env.STRIPE_PRICE_5_LICENCES_MENSUEL,
    '5_annuel':   process.env.STRIPE_PRICE_5_LICENCES_ANNUEL,
  };
  return map[`${nombreLicences}_${periodicite}`];
};

// POST /stripe/creer-session — démarrer un checkout Stripe
router.post('/creer-session', verifierToken, async (req, res) => {
  try {
    const { nombre_licences, periodicite } = req.body;
    // nombre_licences: 1, 3 ou 5 — periodicite: 'mensuel' ou 'annuel'
    if (![1, 3, 5].includes(parseInt(nombre_licences)) ||
        !['mensuel', 'annuel'].includes(periodicite)) {
      return res.status(400).json({ erreur: 'Paramètres invalides' });
    }

    const priceId = getPriceId(nombre_licences, periodicite);
    if (!priceId) {
      return res.status(500).json({ erreur: 'Prix Stripe non configuré' });
    }

    const entrepriseResult = await db.getEntrepriseById(req.utilisateur.entreprise_id);
    const entreprise = entrepriseResult.rows[0];

    const stripeClient = getStripe();

    // Créer ou récupérer le customer Stripe
    let customerId = entreprise.stripe_customer_id;
    if (!customerId) {
      const customer = await stripeClient.customers.create({
        email: entreprise.email_admin,
        name:  entreprise.nom,
        metadata: { entreprise_id: entreprise.id }
      });
      customerId = customer.id;
      await db.query(
        'UPDATE entreprises SET stripe_customer_id = $1 WHERE id = $2',
        [customerId, entreprise.id]
      );
    }

    // Créer la session de checkout
    const session = await stripeClient.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.CLIENT_B_URL}/paiement-reussi?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${process.env.CLIENT_B_URL}/paiement-annule`,
      metadata: {
        entreprise_id:    entreprise.id,
        nombre_licences:  String(nombre_licences)
      }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Erreur Stripe session:', err.message);
    res.status(500).json({ erreur: 'Erreur lors de la création du paiement' });
  }
});

// GET /stripe/abonnement — état de l'abonnement courant
router.get('/abonnement', verifierToken, async (req, res) => {
  try {
    const result = await db.getAbonnement(req.utilisateur.entreprise_id);
    const entrepriseResult = await db.getEntrepriseById(req.utilisateur.entreprise_id);
    res.json({
      abonnement: result.rows[0] || null,
      trial_ends_at: entrepriseResult.rows[0]?.trial_ends_at
    });
  } catch (err) {
    res.status(500).json({ erreur: 'Erreur serveur' });
  }
});

// POST /stripe/webhook — événements Stripe (raw body nécessaire)
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = getStripe().webhooks.constructEvent(
      req.body, sig, process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature invalide:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const entrepriseId   = session.metadata.entreprise_id;
        const nombreLicences = parseInt(session.metadata.nombre_licences);
        const subscription   = await getStripe().subscriptions.retrieve(session.subscription);

        await db.creerAbonnement(
          entrepriseId,
          subscription.id,
          nombreLicences,
          new Date(subscription.current_period_end * 1000)
        );
        console.log(`[Stripe] Abonnement créé: ${entrepriseId} - ${nombreLicences} licences`);
        break;
      }

      case 'invoice.paid': {
        const invoice = event.data.object;
        const sub = await getStripe().subscriptions.retrieve(invoice.subscription);
        await db.mettreAJourAbonnement(
          sub.id, 'active',
          sub.items.data[0]?.quantity || 1,
          new Date(sub.current_period_end * 1000)
        );
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        await db.mettreAJourAbonnement(
          invoice.subscription, 'past_due', null, null
        );
        console.log(`[Stripe] Paiement échoué: ${invoice.subscription}`);
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await db.mettreAJourAbonnement(sub.id, 'canceled', 0, null);
        console.log(`[Stripe] Abonnement annulé: ${sub.id}`);
        break;
      }
    }
  } catch (err) {
    console.error('Erreur traitement webhook:', err.message);
  }

  res.json({ received: true });
});

module.exports = router;
