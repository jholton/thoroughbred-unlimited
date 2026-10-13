<?php
/**
 * Assignment form handler for Thoroughbred Unlimited, Inc.
 *
 * Runs on GoDaddy Linux (cPanel) shared hosting, which ships with PHP.
 * No third-party form service and no JavaScript required.
 *
 * ---------------------------------------------------------------------------
 * SETTINGS — the only part that needs editing
 * ---------------------------------------------------------------------------
 */

// Where assignment notifications are delivered. Can be any address, including
// a Gmail or Outlook one.
$TO = 'info@thoroughbredunlimited.com';

// The address mail is sent *from*. This MUST be a mailbox on the site's own
// domain, or GoDaddy's servers will fail SPF and the mail will land in spam.
// Create it in cPanel under Email Accounts first. It never receives replies —
// the visitor's own address is set as Reply-To below.
$FROM = 'noreply@thoroughbredunlimited.com';

$SUBJECT_PREFIX = 'Website assignment';

/* ------------------------------------------------------------------------- */

// Shared hosting often defaults to UTC, which makes the timestamp in the
// notification misleading. Louisville is Eastern.
date_default_timezone_set('America/New_York');

// Only accept POST. A direct GET of this URL goes back to the form.
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Location: contact.html', true, 303);
    exit;
}

/**
 * Strip CR/LF from any value used in a mail header. Without this, a newline in
 * the name or email field lets a spammer append their own headers (Bcc:, etc.)
 * and relay mail through this form.
 */
function header_safe(string $value): string {
    return trim(str_replace(["\r", "\n", "\0", '%0a', '%0d'], '', $value));
}

function field(string $key): string {
    $raw = $_POST[$key] ?? '';
    return is_string($raw) ? trim($raw) : '';
}

// Honeypot: a field hidden from people but filled in by most bots. Pretend the
// submission succeeded so the bot does not retry with a different strategy.
if (field('website') !== '') {
    header('Location: thank-you.html', true, 303);
    exit;
}

$name     = field('name');
$company  = field('company');
$email    = field('email');
$phone    = field('phone');
$type     = field('type');
$location = field('location');
$message  = field('message');

// Validate. The browser checks these too, but a POST can arrive without
// ever touching the browser's validation.
$errors = [];
if ($name === '')    { $errors[] = 'a name'; }
if ($message === '') { $errors[] = 'a description of the loss'; }
if ($email === '' || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
    $errors[] = 'a valid email address';
}
if (mb_strlen($message) > 20000) { $errors[] = 'a shorter description'; }

if ($errors) {
    show_error('We need ' . natural_list($errors) . ' before we can send this.');
}

$body = "New assignment enquiry from the Thoroughbred Unlimited website.\n\n"
      . "Name:             {$name}\n"
      . "Company:          {$company}\n"
      . "Email:            {$email}\n"
      . "Phone:            {$phone}\n"
      . "Assignment type:  {$type}\n"
      . "Loss location:    {$location}\n\n"
      . "Description of loss\n"
      . "-------------------\n"
      . "{$message}\n\n"
      . "-- \n"
      . 'Submitted ' . date('j F Y, g:ia T') . "\n"
      . 'IP ' . ($_SERVER['REMOTE_ADDR'] ?? 'unknown') . "\n";

// Plain hyphen, not an em dash: a Subject header must be ASCII unless it is
// MIME-encoded, and mojibake in an inbox looks like a broken website.
$subject = $SUBJECT_PREFIX;
if ($type !== '')     { $subject .= ': ' . $type; }
if ($location !== '') { $subject .= ' - ' . $location; }

$headers = [
    'From: Thoroughbred Unlimited Website <' . header_safe($FROM) . '>',
    'Reply-To: ' . reply_to($name, $email),
    'Content-Type: text/plain; charset=UTF-8',
    'MIME-Version: 1.0',
    'X-Mailer: PHP/' . phpversion(),
];

$sent = @mail(
    header_safe($TO),
    mime_header(header_safe($subject)),
    $body,
    implode("\r\n", $headers),
    '-f' . header_safe($FROM)   // envelope sender, so SPF passes on GoDaddy
);

if (!$sent) {
    // show_error() escapes for us — do not escape twice here.
    show_error(
        'Something went wrong sending your message. Please call 832-470-3852, '
        . 'or email us directly at ' . $TO . '.'
    );
}

// Post/Redirect/Get: refreshing the thank-you page must not resend the form.
header('Location: thank-you.html', true, 303);
exit;


/**
 * Build a Reply-To with a display name. The name is quoted because an
 * unquoted comma ("Smith, John <a@b.com>") would be read as two addresses,
 * and embedded quotes or backslashes are dropped rather than escaped.
 */
function reply_to(string $name, string $email): string {
    $email = header_safe($email);
    $name  = header_safe(str_replace(['"', '\\'], '', $name));
    if ($name === '') {
        return $email;
    }
    return mime_header($name, true) . ' <' . $email . '>';
}

/**
 * Encode a header value as MIME when it contains non-ASCII, so accented
 * names and typographic punctuation survive instead of arriving as mojibake.
 */
function mime_header(string $value, bool $quote = false): string {
    if (preg_match('/[^\x20-\x7E]/', $value)) {
        if (function_exists('mb_encode_mimeheader')) {
            return mb_encode_mimeheader($value, 'UTF-8', 'B');
        }
        return '=?UTF-8?B?' . base64_encode($value) . '?=';
    }
    return $quote ? '"' . $value . '"' : $value;
}

function natural_list(array $items): string {
    if (count($items) === 1) { return $items[0]; }
    $last = array_pop($items);
    return implode(', ', $items) . ' and ' . $last;
}

/** Render a styled error page using the site's own stylesheet. */
function show_error(string $detail): void {
    http_response_code(422);
    $safe = htmlspecialchars($detail, ENT_QUOTES, 'UTF-8');
    echo <<<HTML
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Message not sent — Thoroughbred Unlimited, Inc.</title>
<link rel="icon" href="assets/img/favicon-32.png" sizes="32x32">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Marcellus&display=swap" rel="stylesheet">
<link rel="stylesheet" href="assets/css/styles.css">
</head>
<body>
<main id="main">
  <section class="section">
    <div class="shell shell--narrow" style="text-align:center">
      <p class="eyebrow eyebrow--center">Message not sent</p>
      <h1>That didn't go through.</h1>
      <p class="lede" style="margin-inline:auto">{$safe}</p>
      <div class="btn-row" style="justify-content:center">
        <a class="btn btn--dark" href="contact.html">Back to the form</a>
        <a class="btn btn--outline" href="tel:+18324703852">Call 832-470-3852</a>
      </div>
    </div>
  </section>
</main>
</body>
</html>
HTML;
    exit;
}
