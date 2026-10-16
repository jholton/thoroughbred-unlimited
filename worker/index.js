/**
 * Thoroughbred Unlimited — Worker entry point.
 *
 * The project is deployed as a Worker with static assets (see wrangler.jsonc).
 * Requests matching a file in ../site are served directly by the asset server
 * and never reach this code. Everything else arrives here: the /send form
 * handler, and unmatched paths, which are handed back to the asset binding so
 * not_found_handling can serve 404.html with a real 404 status.
 *
 * Mail goes out through Resend's HTTP API. Because that API takes structured
 * JSON fields rather than a raw header block, the header-injection class of
 * bug that plagues PHP contact forms cannot occur here — there is no header
 * block for a newline to break out of. Control characters are still stripped
 * from the display name so the rendered Reply-To stays clean.
 *
 * Required environment variables (Workers dashboard → Settings → Variables):
 *   RESEND_API_KEY  secret, from resend.com
 *   TO_EMAIL        where assignment notifications are delivered
 *   FROM_EMAIL      sender; its domain must be verified in Resend
 * Optional:
 *   RESEND_API_BASE overrides the API origin; used by the local test suite
 */

const MAX_MESSAGE = 20000;

/**
 * Attachment limits.
 *
 * Resend caps a message at 40MB *after* base64, which inflates by a third.
 * Gmail and Outlook refuse anything over 25MB on receipt, which is the real
 * ceiling — an email the recipient's provider bounces is worse than one the
 * sender was told to shrink. 10MB raw encodes to 13.3MB, leaving room for the
 * body and headers while staying well inside every provider's limit.
 */
const MAX_FILES = 8;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;

/**
 * Allowed by extension AND reported type: what an adjuster actually receives —
 * loss photographs, policies, estimates, schedules. Everything else is refused
 * with a message pointing at the phone number, rather than relaying an
 * arbitrary executable into his inbox.
 */
const ALLOWED = new Map([
  ['pdf', 'application/pdf'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['png', 'image/png'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['heic', 'image/heic'],
  ['heif', 'image/heif'],
  ['doc', 'application/msword'],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['xls', 'application/vnd.ms-excel'],
  ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['txt', 'text/plain'],
  ['csv', 'text/csv'],
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/send') {
      if (request.method === 'POST') return handleSend(request, env);
      // A direct GET of /send belongs back at the form.
      return redirect('/contact.html');
    }

    // Anything else that got this far matched no asset. Hand it to the asset
    // binding so not_found_handling returns 404.html with a 404 status.
    //
    // The asset server only speaks GET/HEAD and answers anything else with a
    // bare 405, which the browser renders as its own error page instead of
    // ours. A stale cached form posting to a retired URL is the likely cause,
    // so re-issue as a GET and let the visitor land somewhere recognizable.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return env.ASSETS.fetch(new Request(url, { method: 'GET' }));
    }

    return env.ASSETS.fetch(request);
  },
};

async function handleSend(request, env) {
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

  // Attachments are validated before anything is sent, and a failure rejects
  // the whole submission. Sending the message minus its documents would look
  // like success to the visitor while quietly losing what they attached.
  let attachments;
  try {
    attachments = await collectAttachments(form);
  } catch (problem) {
    return errorPage(problem.message);
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
    'New assignment inquiry from the Thoroughbred Unlimited website.\n\n' +
    `Name:             ${name}\n` +
    `Company:          ${company}\n` +
    `Email:            ${email}\n` +
    `Phone:            ${phone}\n` +
    `Assignment type:  ${type}\n` +
    `Loss location:    ${location}\n\n` +
    'Description of loss\n' +
    '-------------------\n' +
    `${message}\n\n` +
    (attachments.length
      ? `Attached (${attachments.length}): ` +
        attachments.map((a) => a.filename).join(', ') +
        '\n\n'
      : '') +
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
        // Outlook strips what it judges to be extra line breaks from
        // plain-text mail, which would run the aligned labels below together.
        // The HTML part is what Outlook actually renders; `text` remains the
        // fallback for anything that prefers it.
        html: buildHtml({ name, company, email, phone, type, location, message, attachments }),
        ...(attachments.length ? { attachments } : {}),
      }),
    });
  } catch {
    return sendFailed(to);
  }

  if (!response.ok) return sendFailed(to);

  // Post/Redirect/Get: refreshing the thank-you page must not resend the form.
  return redirect('/thank-you');
}

/* -------------------------------------------------------------------------- */

/**
 * The HTML part of the notification.
 *
 * Built for mail clients, not browsers: a table with inline styles, no
 * stylesheet, no web fonts, no flexbox. Every interpolated value is escaped —
 * these are strings a stranger typed into a public form.
 */
function buildHtml(data) {
  const row = (label, value, link) => {
    if (!value) return '';
    const shown = link
      ? `<a href="${escapeHtml(link)}" style="color:#8A6A12;text-decoration:none">${escapeHtml(value)}</a>`
      : escapeHtml(value);
    return `<tr>
      <td style="padding:6px 16px 6px 0;color:#5F5F69;font-size:13px;white-space:nowrap;vertical-align:top">${escapeHtml(label)}</td>
      <td style="padding:6px 0;color:#24242A;font-size:15px;vertical-align:top">${shown}</td>
    </tr>`;
  };

  const attachmentList = data.attachments.length
    ? `<p style="margin:0 0 6px;color:#5F5F69;font-size:13px">Attached (${data.attachments.length})</p>
       <ul style="margin:0 0 24px;padding-left:20px;color:#24242A;font-size:14px">
         ${data.attachments.map((a) => `<li>${escapeHtml(a.filename)}</li>`).join('')}
       </ul>`
    : '';

  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#F7F5F1;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif">
<div style="max-width:640px;margin:0 auto;background:#FFFFFF;border:1px solid #E3DED4;border-radius:3px;overflow:hidden">
  <div style="background:#0B0B0D;padding:18px 24px">
    <div style="color:#E7C86B;font-size:11px;letter-spacing:2px;text-transform:uppercase">New assignment inquiry</div>
    <div style="color:#FFFFFF;font-size:17px;margin-top:4px">Thoroughbred Unlimited website</div>
  </div>

  <div style="padding:24px">
    <table cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;margin-bottom:24px">
      ${row('Name', data.name)}
      ${row('Company', data.company)}
      ${row('Email', data.email)}
      ${row('Phone', data.phone, `tel:${String(data.phone).replace(/[^\d+]/g, '')}`)}
      ${row('Assignment', data.type)}
      ${row('Location', data.location)}
    </table>

    <div style="color:#5F5F69;font-size:13px;margin-bottom:6px">Description of loss</div>
    <div style="color:#24242A;font-size:15px;line-height:1.6;white-space:pre-wrap;padding:14px 16px;background:#F7F5F1;border-left:3px solid #C9A227;margin-bottom:24px">${escapeHtml(data.message)}</div>

    ${attachmentList}

    <div style="color:#5F5F69;font-size:12px;border-top:1px solid #E3DED4;padding-top:14px">
      Reply to this email to answer ${escapeHtml(data.name)} directly.
    </div>
  </div>
</div>
</body></html>`;
}

/**
 * Read, validate and base64-encode uploaded documents.
 * Throws with a visitor-facing message when something is not acceptable.
 */
async function collectAttachments(form) {
  const files = form
    .getAll('documents')
    .filter((entry) => entry && typeof entry === 'object' && entry.size > 0);

  if (files.length === 0) return [];

  if (files.length > MAX_FILES) {
    throw new Error(
      `Please attach no more than ${MAX_FILES} files. You attached ${files.length}.`
    );
  }

  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > MAX_TOTAL_BYTES) {
    throw new Error(
      `Those attachments come to ${megabytes(total)}MB, and the limit is ` +
        `${MAX_TOTAL_BYTES / 1024 / 1024}MB in total. Send the largest ones separately, ` +
        'or call 832-470-3852 and we will arrange another way to receive them.'
    );
  }

  const attachments = [];
  for (const file of files) {
    const filename = safeFilename(file.name);
    const extension = filename.split('.').pop().toLowerCase();

    if (!ALLOWED.has(extension)) {
      throw new Error(
        `We cannot accept "${filename}". Documents and photographs only — ` +
          'PDF, JPG, PNG, HEIC, Word, Excel, TXT or CSV.'
      );
    }

    // Buffer, not a String.fromCharCode + btoa loop: the loop costs ~37ms of
    // CPU for 10MB and the Free plan allows 10ms per request.
    const content = Buffer.from(await file.arrayBuffer()).toString('base64');

    attachments.push({
      filename,
      content,
      content_type: ALLOWED.get(extension),
    });
  }

  return attachments;
}

/** Strip any directory component and anything that is not plainly a filename. */
function safeFilename(raw) {
  const base = String(raw || 'attachment').split(/[\\/]/).pop();
  const cleaned = base.replace(/[\u0000-\u001F\u007F"]/g, '').trim();
  return (cleaned || 'attachment').slice(0, 120);
}

function megabytes(bytes) {
  return (bytes / 1024 / 1024).toFixed(1);
}

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
