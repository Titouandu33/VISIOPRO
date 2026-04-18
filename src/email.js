// ─── Service d'envoi d'e-mails et SMS ────────────────────────────────────────
const nodemailer = require('nodemailer');
const twilio     = require('twilio');

// Client Twilio — initialisé à la demande pour éviter le crash au démarrage
function getTwilioClient() {
  const sid = process.env.TWILIO_ACCOUNT_SID || '';
  if (!sid.startsWith('AC')) return null;
  return twilio(sid, process.env.TWILIO_AUTH_TOKEN);
}

// Configurer le transporteur SMTP
// Supporte Gmail (SMTP_HOST=smtp.gmail.com) ou n'importe quel autre serveur SMTP.
// Pour Gmail : créez un "Mot de passe d'application" sur myaccount.google.com/apppasswords
const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST || 'smtp.gmail.com',
  port:   parseInt(process.env.SMTP_PORT) || 587,
  secure: false,   // STARTTLS sur le port 587
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// ─── Template e-mail d'invitation ─────────────────────────────────────────────
const templateInvitation = ({ nomInterviewe, nomJournaliste, lienRejoindre }) => `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Invitation à une visioconférence</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0"
             style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1);">
        <!-- En-tête -->
        <tr>
          <td style="background:#1A3A5C;padding:32px 40px;text-align:center;">
            <h1 style="color:#ffffff;margin:0;font-size:22px;font-weight:700;">
              Invitation à une visioconférence
            </h1>
          </td>
        </tr>
        <!-- Corps -->
        <tr>
          <td style="padding:40px;">
            <p style="color:#333;font-size:16px;line-height:1.6;margin:0 0 20px;">
              Bonjour <strong>${nomInterviewe}</strong>,
            </p>
            <p style="color:#333;font-size:16px;line-height:1.6;margin:0 0 24px;">
              <strong>${nomJournaliste}</strong> vous invite à rejoindre
              une visioconférence.
            </p>
            <p style="color:#555;font-size:15px;line-height:1.6;margin:0 0 32px;">
              Pour rejoindre, cliquez simplement sur le bouton ci-dessous.
              Aucune installation n'est nécessaire — votre navigateur suffit.
            </p>
            <!-- Bouton -->
            <table cellpadding="0" cellspacing="0" style="margin:0 auto;">
              <tr>
                <td align="center" style="background:#2E6DA4;border-radius:8px;">
                  <a href="${lienRejoindre}"
                     style="display:inline-block;padding:16px 40px;color:#ffffff;
                            font-size:17px;font-weight:700;text-decoration:none;
                            border-radius:8px;">
                    Rejoindre la visioconférence
                  </a>
                </td>
              </tr>
            </table>
            <!-- Lien texte -->
            <p style="color:#999;font-size:13px;text-align:center;margin:20px 0 0;">
              Ou copiez ce lien dans votre navigateur :<br>
              <a href="${lienRejoindre}" style="color:#2E6DA4;">${lienRejoindre}</a>
            </p>
          </td>
        </tr>
        <!-- Pied -->
        <tr>
          <td style="background:#f8f8f8;padding:20px 40px;border-top:1px solid #eee;">
            <p style="color:#aaa;font-size:12px;margin:0;text-align:center;">
              Ce lien est valable 24 heures et à usage unique.<br>
              Si vous n'attendiez pas ce message, ignorez cet e-mail.
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>
`;

const email = {
  // ─── Invitation par e-mail ───────────────────────────────────────────────
  envoyerInvitation: async ({ destinataire, nomInterviewe, nomJournaliste, lienRejoindre }) => {
    const html = templateInvitation({ nomInterviewe, nomJournaliste, lienRejoindre });
    await transporter.sendMail({
      from: process.env.EMAIL_FROM || `"Visio Média" <${process.env.SMTP_USER}>`,
      to: destinataire,
      subject: `${nomJournaliste} vous invite à une visioconférence`,
      html
    });
    console.log(`[Email] Invitation envoyée à ${destinataire}`);
  },

  // ─── Invitation par SMS (Twilio) ─────────────────────────────────────────
  envoyerSMS: async ({ telephone, nomInterviewe, nomJournaliste, lienRejoindre, messagePersonnalise }) => {
    // Message par défaut si aucun message personnalisé n'est fourni
    const corps = messagePersonnalise && messagePersonnalise.trim()
      ? messagePersonnalise.trim()
      : `Bonjour ${nomInterviewe}, ${nomJournaliste} vous invite à une visioconférence. Rejoignez ici : ${lienRejoindre}`;

    const clientTwilio = getTwilioClient();
    if (!clientTwilio) throw new Error('Twilio non configuré — vérifiez TWILIO_ACCOUNT_SID (doit commencer par AC)');
    await clientTwilio.messages.create({
      body: corps,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: telephone   // format E.164 attendu : +33XXXXXXXXX
    });
    console.log(`[SMS] Invitation envoyée au ${telephone}`);
  }
};

module.exports = email;
