// Serverless function handler for Vercel / Netlify / Node hosting
import tls from 'node:tls';

// Helper to send email via Gmail SMTP using native TLS (port 465, zero npm dependencies)
function sendViaGmailSmtp(gmailUser, appPassword, toEmail, imageBase64) {
  return new Promise((resolve, reject) => {
    const cleanPassword = appPassword.replace(/\s+/g, '');
    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    const boundary = '----=_FroogiePart_' + Date.now();

    const socket = tls.connect({
      host: 'smtp.gmail.com',
      port: 465,
      timeout: 25000
    });

    let buffer = '';
    let step = 0;

    function send(line) {
      socket.write(line + '\r\n');
    }

    socket.setEncoding('utf8');

    socket.on('error', (err) => {
      reject(new Error(`Gmail SMTP error: ${err.message}`));
    });

    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('Gmail SMTP connection timed out after 25s'));
    });

    socket.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\r\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line) continue;
        const code = parseInt(line.substring(0, 3), 10);
        if (line.charAt(3) === '-') continue;

        if (code >= 400) {
          socket.end('QUIT\r\n');
          return reject(new Error(`Gmail SMTP error (${code}): ${line.substring(4)}`));
        }

        switch (step) {
          case 0:
            if (code === 220) {
              step++;
              send('EHLO localhost');
            }
            break;
          case 1:
            if (code === 250) {
              step++;
              send('AUTH LOGIN');
            }
            break;
          case 2:
            if (code === 334) {
              step++;
              send(Buffer.from(gmailUser).toString('base64'));
            }
            break;
          case 3:
            if (code === 334) {
              step++;
              send(Buffer.from(cleanPassword).toString('base64'));
            }
            break;
          case 4:
            if (code === 235) {
              step++;
              send(`MAIL FROM:<${gmailUser}>`);
            }
            break;
          case 5:
            if (code === 250) {
              step++;
              send(`RCPT TO:<${toEmail}>`);
            }
            break;
          case 6:
            if (code === 250) {
              step++;
              send('DATA');
            }
            break;
          case 7:
            if (code === 354) {
              step++;
              const base64Chunks = base64Data.match(/.{1,76}/g)?.join('\r\n') || base64Data;
              const encodedSubject = `=?UTF-8?B?${Buffer.from('Your Unfroogetably Sour! Froogie Selfie 🐸🍋').toString('base64')}?=`;
              const emailPayload = [
                `From: "Froogie Sour Selfie" <${gmailUser}>`,
                `To: <${toEmail}>`,
                `Subject: ${encodedSubject}`,
                `MIME-Version: 1.0`,
                `Content-Type: multipart/mixed; boundary="${boundary}"`,
                ``,
                `--${boundary}`,
                `Content-Type: text/html; charset=utf-8`,
                `Content-Transfer-Encoding: 8bit`,
                ``,
                `<div style="font-family: sans-serif; background: #f7fee7; padding: 24px; border-radius: 16px; color: #1e1b2e; max-width: 600px; margin: 0 auto; border: 3px solid #84cc16;">`,
                `  <h1 style="color: #4a044e; margin-top: 0; font-size: 26px;">Unfroogetably Sour! 🐸🍋</h1>`,
                `  <p style="font-size: 16px; line-height: 1.5;">Here is your Froogie selfie with the fruit leather tongue filter!</p>`,
                `  <p style="font-size: 14px; color: #4d7c0f; font-weight: bold;">Your high-res selfie is attached as <code>froogie-selfie.jpg</code>!</p>`,
                `  <hr style="border: 0; border-top: 1px solid #d9f99d; margin: 20px 0;">`,
                `  <p style="font-size: 13px; color: #65a30d;">Froogie Fruit & Veggie Strips — Tangy, Tasty, Unfroogetable!</p>`,
                `</div>`,
                ``,
                `--${boundary}`,
                `Content-Type: image/jpeg; name="froogie-selfie.jpg"`,
                `Content-Transfer-Encoding: base64`,
                `Content-Disposition: attachment; filename="froogie-selfie.jpg"`,
                ``,
                base64Chunks,
                ``,
                `--${boundary}--`,
                `.`
              ].join('\r\n');
              socket.write(emailPayload + '\r\n');
            }
            break;
          case 8:
            if (code === 250) {
              step++;
              socket.end('QUIT\r\n');
              resolve({ provider: 'Gmail SMTP', to: toEmail });
            }
            break;
        }
      }
    });
  });
}

// Serverless Handler
export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const { email, imageBase64 } = req.body || {};
    if (!email || !email.includes('@')) {
      return res.status(400).json({ success: false, error: 'A valid email address is required.' });
    }
    if (!imageBase64 || !imageBase64.startsWith('data:image/')) {
      return res.status(400).json({ success: false, error: 'Image data is required.' });
    }

    // 1. Try Gmail SMTP if configured
    const gmailUser = process.env.GMAIL_USER;
    const gmailAppPass = process.env.GMAIL_APP_PASSWORD;
    if (gmailUser && gmailAppPass) {
      const result = await sendViaGmailSmtp(gmailUser, gmailAppPass, email, imageBase64);
      return res.status(200).json({
        success: true,
        provider: 'Gmail',
        message: `Your Froogie selfie was successfully delivered to ${email} via Gmail!`,
        details: result
      });
    }

    // 2. Try Resend if configured
    const resendKey = process.env.RESEND_API_KEY;
    if (resendKey) {
      const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
      const from = process.env.EMAIL_FROM || 'Froogie <onboarding@resend.dev>';
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${resendKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from,
          to: [email],
          subject: 'Your Unfroogetably Sour! Froogie Selfie 🐸🍋',
          html: `
            <div style="font-family: sans-serif; background: #f7fee7; padding: 24px; border-radius: 16px; color: #1e1b2e; max-width: 600px; margin: 0 auto; border: 3px solid #84cc16;">
              <h1 style="color: #4a044e; margin-top: 0;">Unfroogetably Sour! 🐸🍋</h1>
              <p>Here is your Froogie fruit leather tongue selfie!</p>
              <img src="${imageBase64}" alt="Your Froogie Selfie" style="max-width: 100%; border-radius: 12px;" />
              <p style="font-size: 14px; color: #4d7c0f; font-weight: bold; margin-top: 16px;">Froogie Fruit & Veggie Strips — Tangy, Tasty, Unfroogetable!</p>
            </div>
          `,
          attachments: [
            {
              filename: 'froogie-selfie.jpg',
              content: base64Data
            }
          ]
        })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || 'Resend delivery failed');
      }
      return res.status(200).json({
        success: true,
        provider: 'Resend',
        message: `Your Froogie selfie was successfully sent to ${email}!`
      });
    }

    // 3. Fallback / simulated
    return res.status(200).json({
      success: true,
      simulated: true,
      message: `Your Froogie selfie was accepted for delivery! (Set GMAIL_USER and GMAIL_APP_PASSWORD in Vercel settings for live delivery)`
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message || 'Server error' });
  }
}
