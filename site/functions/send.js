/**
 * Assignment form handler — Cloudflare Pages Function.
 *
 * Replaces the earlier send.php. Routed at POST /send by virtue of living at
 * functions/send.js; the Pages project's root directory is this `site` folder.
 *
 * Mail goes out through Resend's HTTP API. Because the API takes structured
 * JSON fields rather than a raw header block, the header-injection class of
 * bug that plagues PHP contact forms cannot occur here — there is no header
 * block for a newline to break out of. Control characters are still stripped
 * from the display name so the rendered From/Reply-To stays clean.
 *
 * Required environment variables (Cloudflare dashboard → Settings → Variables):
 *   RESEND_API_KEY  secret, from resend.com
 *   TO_EMAIL        where assignment notifications are delivered
 *   FROM_EMAIL      sender; its domain must be verified in Resend
 * Optional:
 *   RESEND_API_BASE overrides the API origin; used by the local test suite
 */

const MAX_MESSAGE = 20000;

export async function onRequestPost({ request, env }) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return errorPage('We could not read that submission. Please try again.');
  }

  const field = (key) => {
    const value = form.get(key);
    return typeof value === 'string' ? value.trim() : '';
  };

  // Honeypot: hidden from people, filled in by most bots. Pretend it worked so
  // the bot does not retry with a different strategy.
  if (field('website') !== '') {
    return redirect('/thank-you');
  }

  const name = field('name');
  const company = field('company');
  const email = field('email');
  const phone = field('phone');
  const type = field('type');
  const location = field('location');
  const message = field('message');

  const missing = [];
  if (name === '') missing.push('a name');
  if (message === '') missing.push('a description of the loss');
  if (email === '' || !isEmail(email)) missing.push('a valid email address');
  if (message.length > MAX_MESSAGE) missing.push('a shorter description');

  if (missing.length) {
    return errorPage(`We need ${naturalList(missing)} before we can send this.`);
  }

  const to = env.TO_EMAIL;
  const from = env.FROM_EMAIL;
  if (!env.RESEND_API_KEY || !to || !from) {
    // Misconfiguration, not the visitor's fault — say so without blaming them.
    return errorPage(
      'This form is not finished being set up. Please call 832-470-3852.',
      500
    );
  }

  const text =
    'New assignment enquiry from the Thoroughbred Unlimited website.\n\n' +
    `Name:             ${name}\n` +
    `Company:          ${company}\n` +
    `Email:            ${email}\n` +
    `Phone:            ${phone}\n` +
    `Assignment type:  ${type}\n` +
    `Loss location:    ${location}\n\n` +
    'Description of loss\n' +
    '-------------------\n' +
    `${message}\n\n` +
    '-- \n' +
    `Submitted ${timestamp()}\n` +
    `IP ${request.headers.get('CF-Connecting-IP') || 'unknown'}\n`;

  let subject = 'Website assignment';
  if (type) subject += `: ${type}`;
  if (location) subject += ` - ${location}`;

  const base = env.RESEND_API_BASE || 'https://api.resend.com';

  let response;
  try {
    response = await fetch(`${base}/emails`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `Thoroughbred Unlimited Website <${from}>`,
        to: [to],
        reply_to: replyTo(name, email),
        subject: clean(subject),
        text,
      }),
    });
  } catch {
    return sendFailed(to);
  }

  if (!response.ok) {
    return sendFailed(to);
  }

  // Post/Redirect/Get: refreshing the thank-you page must not resend the form.
  // Extensionless, because Pages 308-redirects /thank-you.html to /thank-you —
  // going straight there saves a hop on the path that matters most.
  return redirect('/thank-you');
}

// A direct GET of /send belongs back at the form.
export async function onRequestGet() {
  return redirect('/contact.html');
}

/* -------------------------------------------------------------------------- */

function isEmail(value) {
  // Deliberately permissive: the real proof an address works is a reply to it.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
}

/** Strip control characters that would corrupt a rendered header. */
function clean(value) {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
}

/**
 * Display name plus address. The name is quoted because an unquoted comma
 * ("Smith, John <a@b.com>") reads as two addresses; embedded quotes and
 * backslashes are dropped rather than escaped.
 */
function replyTo(name, email) {
  const safeName = clean(name).replace(/["\\]/g, '');
  return safeName ? `"${safeName}" <${clean(email)}>` : clean(email);
}

function naturalList(items) {
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Louisville is Eastern; the Workers runtime is UTC by default. */
function timestamp() {
  return new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York',
    dateStyle: 'long',
    timeStyle: 'short',
  });
}

function redirect(path) {
  return new Response(null, { status: 303, headers: { Location: path } });
}

function sendFailed(to) {
  return errorPage(
    'Something went wrong sending your message. Please call 832-470-3852, ' +
      `or email us directly at ${to}.`,
    502
  );
}

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function errorPage(detail, status = 422) {
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Message not sent — Thoroughbred Unlimited, Inc.</title>
<link rel="icon" href="/assets/img/favicon-32.png" sizes="32x32">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Marcellus&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/css/styles.css">
</head>
<body>
<main id="main">
  <section class="section">
    <div class="shell shell--narrow" style="text-align:center">
      <p class="eyebrow eyebrow--center">Message not sent</p>
      <h1>That didn't go through.</h1>
      <p class="lede" style="margin-inline:auto">${escapeHtml(detail)}</p>
      <div class="btn-row" style="justify-content:center">
        <a class="btn btn--dark" href="/contact.html">Back to the form</a>
        <a class="btn btn--outline" href="tel:+18324703852">Call 832-470-3852</a>
      </div>
    </div>
  </section>
</main>
</body>
</html>`;

  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
