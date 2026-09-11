import {
  ARTIFACT_PASSWORD_MAX_PLAINTEXT_BYTES,
  ARTIFACT_PASSWORD_NEUTRAL_NAME,
  ARTIFACT_PASSWORD_PBKDF2_ITERATIONS,
  ARTIFACT_PROTECTED_PAGE_MAX_BYTES
} from '../../../shared/fork-artifact-passwords/artifact-password-types'

export type ArtifactPasswordEnvelope = {
  version: 1
  kdf: 'PBKDF2-SHA-256'
  iterations: number
  cipher: 'AES-256-GCM'
  compression: 'gzip'
  salt: string
  iv: string
  plaintextBytes: number
  aad: string
  ciphertext: string
}

/** Canonicalizes every v1 envelope parameter authenticated by AES-GCM. */
export function artifactPasswordEnvelopeAad(
  envelope: Pick<
    ArtifactPasswordEnvelope,
    'version' | 'kdf' | 'iterations' | 'cipher' | 'compression' | 'salt' | 'iv' | 'plaintextBytes'
  >
): string {
  return JSON.stringify([
    envelope.version,
    envelope.kdf,
    envelope.iterations,
    envelope.cipher,
    envelope.compression,
    envelope.salt,
    envelope.iv,
    envelope.plaintextBytes
  ])
}

const UNLOCK_STYLES = `
:root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
* { box-sizing: border-box; }
body { min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 1.5rem; background: Canvas; color: CanvasText; }
main { width: min(100%, 26rem); padding: 1.5rem; border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 0.75rem; }
h1 { margin: 0 0 0.5rem; font-size: 1.25rem; line-height: 1.35; }
p { margin: 0 0 1rem; color: color-mix(in srgb, CanvasText 68%, transparent); font-size: 0.875rem; line-height: 1.5; }
label { display: block; margin-bottom: 0.4rem; font-size: 0.875rem; font-weight: 600; }
input, button { width: 100%; min-height: 2.5rem; border-radius: 0.45rem; font: inherit; }
input { padding: 0.55rem 0.7rem; border: 1px solid color-mix(in srgb, CanvasText 28%, transparent); background: Canvas; color: CanvasText; }
button { margin-top: 0.75rem; border: 0; padding: 0.55rem 0.9rem; background: AccentColor; color: AccentColorText; font-weight: 600; cursor: pointer; }
button:disabled { cursor: wait; opacity: 0.65; }
input:focus-visible, button:focus-visible { outline: 2px solid AccentColor; outline-offset: 2px; }
#error { min-height: 1.3rem; margin: 0.45rem 0 0; color: Mark; }
.notice { margin-top: 1rem; margin-bottom: 0; font-size: 0.75rem; }
`

const unlockScript = `(function () {
'use strict';
var envelopeNode = document.getElementById('orca-envelope');
var input = document.getElementById('passphrase');
var button = document.getElementById('unlock');
var status = document.getElementById('status');
var error = document.getElementById('error');
var panel = document.querySelector('main');
var busy = false;
var MAX_PLAINTEXT_BYTES = ${ARTIFACT_PASSWORD_MAX_PLAINTEXT_BYTES};
var MAX_CIPHERTEXT_BYTES = ${ARTIFACT_PROTECTED_PAGE_MAX_BYTES};
var ITERATIONS = ${ARTIFACT_PASSWORD_PBKDF2_ITERATIONS};

function supported() {
  return Boolean(window.crypto && window.crypto.subtle && window.TextEncoder &&
    window.TextDecoder && window.DecompressionStream && window.Blob);
}
function decodeBase64(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error('invalid envelope');
  }
  var decoded = atob(value);
  var bytes = new Uint8Array(decoded.length);
  for (var index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes;
}
function expectedAad(envelope) {
  return JSON.stringify([envelope.version, envelope.kdf, envelope.iterations, envelope.cipher,
    envelope.compression, envelope.salt, envelope.iv, envelope.plaintextBytes]);
}
function readEnvelope() {
  var envelope = JSON.parse(envelopeNode.textContent || 'null');
  if (!envelope || envelope.version !== 1 || envelope.kdf !== 'PBKDF2-SHA-256' ||
      envelope.iterations !== ITERATIONS || envelope.cipher !== 'AES-256-GCM' ||
      envelope.compression !== 'gzip' || !Number.isSafeInteger(envelope.plaintextBytes) ||
      envelope.plaintextBytes < 1 || envelope.plaintextBytes > MAX_PLAINTEXT_BYTES ||
      envelope.aad !== expectedAad(envelope)) throw new Error('invalid envelope');
  var salt = decodeBase64(envelope.salt);
  var iv = decodeBase64(envelope.iv);
  var ciphertext = decodeBase64(envelope.ciphertext);
  if (salt.byteLength !== 16 || iv.byteLength !== 12 || ciphertext.byteLength < 17 ||
      ciphertext.byteLength > MAX_CIPHERTEXT_BYTES) throw new Error('invalid envelope');
  return { envelope: envelope, salt: salt, iv: iv, ciphertext: ciphertext };
}
async function inflateBounded(compressed, expectedBytes) {
  var reader = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  var chunks = [];
  var total = 0;
  try {
    while (true) {
      var next = await reader.read();
      if (next.done) break;
      if (total + next.value.byteLength > MAX_PLAINTEXT_BYTES ||
          total + next.value.byteLength > expectedBytes) throw new Error('invalid plaintext length');
      chunks.push(next.value);
      total += next.value.byteLength;
    }
  } catch (cause) {
    await reader.cancel(cause).catch(function () {});
    throw cause;
  }
  if (total !== expectedBytes) throw new Error('invalid plaintext length');
  var plaintext = new Uint8Array(total);
  var offset = 0;
  chunks.forEach(function (chunk) { plaintext.set(chunk, offset); offset += chunk.byteLength; chunk.fill(0); });
  return plaintext;
}
async function unlock() {
  if (busy) return;
  var passphrase = input.value.normalize('NFKC').trim();
  if (!passphrase) { input.focus(); return; }
  busy = true;
  button.disabled = true;
  panel.setAttribute('aria-busy', 'true');
  input.setAttribute('aria-invalid', 'false');
  error.textContent = '';
  status.textContent = 'Unlocking…';
  var parsed;
  var passphraseBytes;
  var compressed;
  var plaintext;
  var material = null;
  var key = null;
  try {
    parsed = readEnvelope();
    passphraseBytes = new TextEncoder().encode(passphrase);
    passphrase = '';
    material = await crypto.subtle.importKey('raw', passphraseBytes, 'PBKDF2', false, ['deriveKey']);
    passphraseBytes.fill(0);
    key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt: parsed.salt, iterations: ITERATIONS },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    );
    material = null;
    compressed = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: parsed.iv, additionalData: new TextEncoder().encode(parsed.envelope.aad), tagLength: 128 },
      key,
      parsed.ciphertext
    ));
    key = null;
    plaintext = await inflateBounded(compressed, parsed.envelope.plaintextBytes);
    compressed.fill(0);
    var html = new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
    plaintext.fill(0);
    input.value = '';
    parsed.salt.fill(0); parsed.iv.fill(0); parsed.ciphertext.fill(0);
    parsed = null;
    envelopeNode.textContent = '';
    document.open();
    document.write(html);
    html = '';
    document.close();
    return;
  } catch (_) {
    if (passphraseBytes) passphraseBytes.fill(0);
    if (compressed) compressed.fill(0);
    if (plaintext) plaintext.fill(0);
    input.value = '';
    input.setAttribute('aria-invalid', 'true');
    error.textContent = 'Wrong passphrase.';
    status.textContent = 'Enter the passphrase to read this artifact.';
    input.focus();
  } finally {
    material = null;
    key = null;
    busy = false;
    button.disabled = false;
    panel.setAttribute('aria-busy', 'false');
  }
}
if (!supported()) {
  status.textContent = 'This browser cannot unlock protected Orca artifacts. Use a current version of Chrome, Edge, Firefox, or Safari.';
  input.disabled = true;
  button.disabled = true;
  return;
}
button.addEventListener('click', unlock);
input.addEventListener('keydown', function (event) {
  if (event.key === 'Enter') { event.preventDefault(); unlock(); }
});
input.focus();
})();`

/** Builds the neutral public page that decrypts one authenticated artifact envelope. */
export function renderArtifactPasswordUnlockPage(envelope: ArtifactPasswordEnvelope): string {
  const serializedEnvelope = JSON.stringify(envelope).replaceAll('<', '\\u003c')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta property="og:title" content="${ARTIFACT_PASSWORD_NEUTRAL_NAME}">
<meta property="og:description" content="A passphrase is required to read this encrypted file.">
<title>${ARTIFACT_PASSWORD_NEUTRAL_NAME}</title>
<style>${UNLOCK_STYLES}</style>
</head>
<body>
<main aria-busy="false">
<h1>${ARTIFACT_PASSWORD_NEUTRAL_NAME}</h1>
<p id="status">Enter the passphrase to read this artifact. JavaScript and a current browser are required.</p>
<label for="passphrase">Passphrase</label>
<input id="passphrase" type="password" maxlength="512" autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="error" aria-invalid="false">
<button id="unlock" type="button">Unlock artifact</button>
<p id="error" role="alert" aria-live="polite"></p>
<p class="notice">The encrypted file is publicly downloadable. The page host supplies this decryptor, so enter the passphrase only on the Orca share link you received. Decrypted HTML can run scripts from its publisher.</p>
<noscript><p>This artifact needs JavaScript to unlock. Use a current browser with JavaScript enabled.</p></noscript>
</main>
<script id="orca-envelope" type="application/json">${serializedEnvelope}</script>
<script>${unlockScript}</script>
</body>
</html>`
}
