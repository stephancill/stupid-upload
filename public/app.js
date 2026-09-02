'use strict';
// Stupid Upload browser flow. Loaded from /app.js (CSP: script-src 'self').
// The permanent path sends the exact x402 payment to a txlink wallet_sign
// request, renders a scannable QR, and polls until the wallet signs.

const form = document.querySelector('#upload-form');
const input = document.querySelector('#file');
const status = document.querySelector('#upload-status');
const result = document.querySelector('#upload-result');
const link = document.querySelector('#upload-link');
const wallet = document.querySelector('#wallet-result');
const walletLink = document.querySelector('#wallet-link');
const walletQr = document.querySelector('#wallet-qr');

const b64 = (value) => btoa(unescape(encodeURIComponent(value)));

function sha256hex(bytes) {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

function parseTxResult(result) {
  // txlink may return the signature as a JSON string or an already-parsed object.
  if (typeof result === 'string') {
    try {
      result = JSON.parse(result);
    } catch {
      /* maybe bare hex below */
    }
  }
  const nested = result?.result && typeof result.result === 'object' ? result.result : {};
  return {
    signature: result?.signature ?? nested?.signature ?? result,
    account: result?.account ?? nested?.account ?? result?.signer ?? undefined,
  };
}

function renderQr(qrDataUri) {
  walletQr.replaceChildren();
  const img = document.createElement('img');
  img.src = qrDataUri;
  img.alt = 'QR code to approve the payment';
  img.width = 180;
  img.height = 180;
  walletQr.appendChild(img);
}

function showResult(url, message) {
  link.href = url;
  link.textContent = url;
  result.hidden = false;
  status.textContent = message;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = input.files?.[0];
  if (!file) return;
  const retention = form.elements.retention.value;
  const limit = retention === 'perm' ? 104857600 : 1048576;
  if (file.size > limit) {
    status.textContent =
      retention === 'perm' ? 'Permanent uploads are limited to 100 MiB.' : 'Temporary uploads are limited to 1 MiB.';
    return;
  }

  form.querySelector('button').disabled = true;
  result.hidden = true;
  wallet.hidden = true;
  walletQr.replaceChildren();
  status.textContent = 'Preparing...';

  try {
    const bytes = await file.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const idempotencyKey = crypto.randomUUID().replaceAll('-', '');
    const meta = {
      filename: file.name,
      contentType: file.type || 'application/octet-stream',
      sizeBytes: file.size,
      sha256: sha256hex(digest),
    };

    if (retention === 'temp') {
      const res = await fetch('/v1/uploads/temporary', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
        body: JSON.stringify(meta),
      });
      const reservation = await res.json();
      if (!res.ok) throw new Error(reservation.error?.message || 'Could not reserve upload.');
      status.textContent = 'Uploading...';
      const uploaded = await fetch(reservation.uploadUrl, {
        method: 'PUT',
        headers: {
          authorization: 'Bearer ' + reservation.uploadToken,
          'content-type': 'application/octet-stream',
        },
        body: file,
      });
      if (uploaded.status !== 201) throw new Error('Could not upload file.');
      return showResult(
        reservation.publicUrl,
        'Upload complete. This link expires 24 hours after upload.',
      );
    }

    // Permanent: derive the exact payment, ask a wallet to sign via txlink
    // (shown as a link + scannable QR), then resubmit with PAYMENT-SIGNATURE.
    const pay = await (await fetch('/v1/payments/captured', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(meta),
    })).json();
    if (!pay.typedData || !pay.accepted) throw new Error('Could not quote payment.');

    const sigReq = await (await fetch('https://txlink.stupidtech.net/api/requests?qr=svg', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        method: 'wallet_sign',
        chainId: Number(pay.accepted.network.split(':')[1]),
        params: { version: '1.0', request: { type: '0x01', data: pay.typedData } },
      }),
    })).json();

    wallet.hidden = false;
    walletLink.href = sigReq.url;
    status.textContent = 'Approve the payment in your wallet (or scan the QR), then this page completes the upload.';
    renderQr(sigReq.qr);

    let resolution = null;
    for (let i = 0; i < 150; i += 1) {
      const state = await (await fetch(sigReq.statusUrl)).json();
      if (state.status === 'completed') {
        resolution = parseTxResult(state.result);
        break;
      }
      if (state.status === 'failed') throw new Error('Wallet approval failed.');
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!resolution?.signature || !resolution?.account) throw new Error('Wallet payment not completed.');

    // Splice the real payer + signature into the captured placeholder payload.
    const inner = pay.payload.payload;
    inner.signature = resolution.signature;
    if (String(inner.authorization.from).toLowerCase() === '0x' + 'a'.repeat(40)) {
      inner.authorization.from = resolution.account;
    }
    pay.payload.payload = inner;

    const signed = await fetch('/v1/uploads/permanent', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
        'payment-signature': b64(JSON.stringify(pay.payload)),
      },
      body: JSON.stringify(meta),
    });
    if (!signed.ok) {
      // The x402 middleware returns 402 with the facilitator's reason in the
      // PAYMENT-REQUIRED header (e.g. CDP "invalid_exact_evm_payload_signature").
      const prHeader = signed.headers.get('payment-required');
      let reason = null;
      if (prHeader) {
        try {
          const pr = JSON.parse(atob(prHeader));
          reason = pr.error || null;
        } catch {
          /* ignore non-JSON header */
        }
      }
      const body = await signed.json().catch(() => null);
      throw new Error(
        reason || body?.error?.message || 'Payment was not accepted. See the PAYMENT-REQUIRED header for the reason.',
      );
    }
    const reservation = await signed.json();

    status.textContent = 'Uploading...';
    const uploaded = await fetch(reservation.uploadUrl, {
      method: 'PUT',
      headers: {
        authorization: 'Bearer ' + reservation.uploadToken,
        'content-type': 'application/octet-stream',
      },
      body: file,
    });
    if (uploaded.status !== 201) throw new Error('Could not upload file.');
    return showResult(reservation.publicUrl, 'Upload complete. This link does not expire.');
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : 'Upload failed.';
  } finally {
    form.querySelector('button').disabled = false;
  }
});