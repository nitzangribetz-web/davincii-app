const docusign = require('docusign-esign');
const { PDFDocument } = require('pdf-lib');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const W9_PDF_PATH = path.join(__dirname, '..', 'templates', 'fw9.pdf');

// ── JWT Auth ─────────────────────────────────────────────────────────────────
const OAUTH_BASE = 'account-d.docusign.com'; // sandbox; prod = account.docusign.com

function getDocuSignConfig() {
  const integrationKey = process.env.DS_INTEGRATION_KEY;
  const userId = process.env.DS_USER_ID;
  const baseUri = process.env.DS_BASE_URI;
  let rsaKey = process.env.DS_RSA_KEY;

  // Convert literal \n to real newlines
  if (rsaKey) rsaKey = rsaKey.replace(/\\n/g, '\n');

  return { integrationKey, userId, baseUri, rsaKey };
}

async function getDocuSignClient() {
  const { integrationKey, userId, baseUri, rsaKey } = getDocuSignConfig();

  if (!integrationKey) throw new Error('DS_INTEGRATION_KEY missing');
  if (!userId) throw new Error('DS_USER_ID missing');
  if (!rsaKey) throw new Error('DS_RSA_KEY missing');
  if (!baseUri) throw new Error('DS_BASE_URI missing');

  const apiClient = new docusign.ApiClient();
  apiClient.setOAuthBasePath(OAUTH_BASE);

  const scopes = ['signature', 'impersonation'];

  const results = await apiClient.requestJWTUserToken(
    integrationKey,
    userId,
    scopes,
    Buffer.from(rsaKey),
    3600
  );
  const accessToken = results.body.access_token;
  apiClient.addDefaultHeader('Authorization', 'Bearer ' + accessToken);
  apiClient.setBasePath(baseUri + '/restapi');
  return apiClient;
}

// ── JWT Diagnostic ──────────────────────────────────────────────────────────
// Builds the same JWT the SDK would build, decodes the payload, and attempts
// the token request. Returns a full diagnostic report without exposing secrets.
async function diagnoseJwtAuth() {
  const { integrationKey, userId, baseUri, rsaKey } = getDocuSignConfig();
  const report = {
    step: 'config',
    config: {
      oauthBase: OAUTH_BASE,
      oauthTokenUrl: `https://${OAUTH_BASE}/oauth/token`,
      apiBasePath: baseUri ? baseUri + '/restapi' : 'MISSING',
      integrationKey: integrationKey || 'MISSING',
      userId: userId || 'MISSING',
      rsaKeyPresent: !!rsaKey,
      rsaKeyStartsWith: rsaKey ? rsaKey.substring(0, 31) : 'N/A',
      rsaKeyEndsWith: rsaKey ? rsaKey.trim().slice(-29) : 'N/A',
      rsaKeyLineCount: rsaKey ? rsaKey.split('\n').length : 0,
      rsaKeyByteLength: rsaKey ? Buffer.from(rsaKey).length : 0,
    },
    jwtPayload: null,
    tokenRequest: null,
    error: null,
  };

  if (!integrationKey || !userId || !rsaKey || !baseUri) {
    report.error = 'Missing required env vars — see config above';
    return report;
  }

  // Build the JWT assertion manually to inspect payload
  report.step = 'jwt-build';
  const now = Math.floor(Date.now() / 1000);
  const jwtHeader = { alg: 'RS256', typ: 'JWT' };
  const jwtPayload = {
    iss: integrationKey,
    sub: userId,
    aud: OAUTH_BASE,
    iat: now,
    exp: now + 3600,
    scope: 'signature impersonation',
  };
  report.jwtPayload = jwtPayload;

  // Verify the RSA key can sign (without exposing it)
  report.step = 'rsa-verify';
  try {
    const sign = crypto.createSign('RSA-SHA256');
    sign.update('test');
    sign.sign(rsaKey);
    report.rsaKeyCanSign = true;
  } catch (e) {
    report.rsaKeyCanSign = false;
    report.rsaKeyError = e.message;
  }

  // Attempt the actual token request via SDK
  report.step = 'token-request';
  try {
    const apiClient = new docusign.ApiClient();
    apiClient.setOAuthBasePath(OAUTH_BASE);
    const results = await apiClient.requestJWTUserToken(
      integrationKey,
      userId,
      ['signature', 'impersonation'],
      Buffer.from(rsaKey),
      3600
    );
    report.tokenRequest = {
      success: true,
      tokenType: results.body.token_type,
      expiresIn: results.body.expires_in,
      // first 20 chars of token only
      accessTokenPreview: results.body.access_token
        ? results.body.access_token.substring(0, 20) + '...'
        : null,
    };
  } catch (err) {
    const respBody = err.response
      ? (err.response.body || err.response.data || null)
      : null;
    report.tokenRequest = {
      success: false,
      httpStatus: err.response ? err.response.status || err.response.statusCode : null,
      errorBody: respBody,
      errorMessage: err.message,
    };
    report.error = respBody || err.message;
  }

  return report;
}

// ── Fill W-9 PDF with pdf-lib ────────────────────────────────────────────────
// The IRS W-9 uses XFA forms which pdf-lib strips. Instead of filling form
// fields (which appear blank), we draw text directly onto the page.
async function fillW9Pdf(taxData) {
  const { rgb, StandardFonts } = require('pdf-lib');
  const pdfBytes = fs.readFileSync(W9_PDF_PATH);
  const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });

  // Remove all form fields so the XFA-stripped PDF is clean
  try {
    const form = pdfDoc.getForm();
    const fields = form.getFields();
    fields.forEach(f => {
      try { form.removeField(f); } catch (_) {}
    });
  } catch (_) {}

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const page = pdfDoc.getPages()[0];
  const fontSize = 10;
  const smallFont = 8;
  const color = rgb(0, 0, 0);

  // Helper to draw text at absolute coordinates (origin = bottom-left)
  const draw = (text, x, y, opts = {}) => {
    if (!text) return;
    page.drawText(String(text), {
      x, y,
      size: opts.size || fontSize,
      font: opts.bold ? boldFont : font,
      color,
    });
  };

  // Helper to draw a checkmark
  const check = (x, y) => {
    draw('X', x, y, { size: 10, bold: true });
  };

  // ── W-9 field positions (IRS Rev. Oct 2018, letter-size 612x792) ──
  // Line 1: Name
  draw(taxData.name || '', 42, 646);

  // Line 2: Business name
  draw(taxData.businessName || '', 42, 616);

  // Line 3: Tax classification checkboxes
  const classPositions = {
    individual: 42,
    cCorp:      150,
    sCorp:      195,
    partnership: 240,
    trustEstate: 295,
    llc:         355,
    other:       482,
  };
  if (taxData.taxClass && classPositions[taxData.taxClass]) {
    check(classPositions[taxData.taxClass], 586);
  }

  // LLC tax classification code
  if (taxData.llcTaxClass) {
    draw(taxData.llcTaxClass, 410, 586, { size: smallFont });
  }

  // Line 5: Address (street, apt)
  draw(taxData.addressStreet || '', 42, 530);

  // Line 6: City, state, ZIP
  draw(taxData.addressCityStateZip || '', 42, 500);

  // Part I — SSN (three boxes at top-right of Part I area)
  if (taxData.ssn) {
    const ssn = taxData.ssn.replace(/\D/g, '');
    draw(ssn.substring(0, 3), 440, 470, { size: 11 });
    draw(ssn.substring(3, 5), 495, 470, { size: 11 });
    draw(ssn.substring(5, 9), 530, 470, { size: 11 });
  }

  // Part I — EIN (two boxes)
  if (taxData.ein) {
    const ein = taxData.ein.replace(/\D/g, '');
    draw(ein.substring(0, 2), 440, 445, { size: 11 });
    draw(ein.substring(2, 9), 480, 445, { size: 11 });
  }

  return await pdfDoc.save();
}

// ── Create envelope + embedded signing ───────────────────────────────────────
async function createDocuSignEnvelope({ artist, legalName, taxData }) {
  if (!process.env.DS_INTEGRATION_KEY) throw new Error('DS_INTEGRATION_KEY missing');
  if (!process.env.DS_ACCOUNT_ID) throw new Error('DS_ACCOUNT_ID missing');

  const signerName = legalName || artist.name || artist.stage_name || artist.email || 'Artist';
  const signerEmail = artist.email;
  if (!signerEmail) throw new Error('Artist email missing');

  console.log('[docusign] filling W-9 PDF...');
  const filledPdf = await fillW9Pdf(taxData || {});
  const pdfBase64 = Buffer.from(filledPdf).toString('base64');

  console.log('[docusign] creating envelope...');
  let apiClient;
  try {
    apiClient = await getDocuSignClient();
    console.log('[docusign] JWT auth succeeded');
  } catch (authErr) {
    console.error('[docusign] JWT auth FAILED:', authErr.response ? JSON.stringify(authErr.response.body || authErr.response.data) : authErr.message);
    throw authErr;
  }
  const envelopesApi = new docusign.EnvelopesApi(apiClient);
  const accountId = process.env.DS_ACCOUNT_ID;

  // Signature tab position (Part II of W-9 — bottom of page 1)
  const signHere = docusign.SignHere.constructFromObject({
    anchorString: 'Signature of',
    anchorYOffset: '-10',
    anchorXOffset: '80',
    anchorUnits: 'pixels',
  });

  const dateSigned = docusign.DateSigned.constructFromObject({
    anchorString: 'Date',
    anchorYOffset: '-10',
    anchorXOffset: '20',
    anchorUnits: 'pixels',
  });

  const signer = docusign.Signer.constructFromObject({
    email: signerEmail,
    name: signerName,
    recipientId: '1',
    clientUserId: String(artist.id), // embedded signing
    routingOrder: '1',
    tabs: {
      signHereTabs: [signHere],
      dateSignedTabs: [dateSigned],
    },
  });

  const envelopeDefinition = docusign.EnvelopeDefinition.constructFromObject({
    emailSubject: 'W-9 Tax Form — Davincii',
    documents: [{
      documentBase64: pdfBase64,
      name: 'W-9 Tax Form',
      fileExtension: 'pdf',
      documentId: '1',
    }],
    recipients: { signers: [signer] },
    status: 'sent',
  });

  let envelope;
  try {
    envelope = await envelopesApi.createEnvelope(accountId, {
      envelopeDefinition,
    });
    console.log('[docusign] envelope created:', envelope.envelopeId);
  } catch (envErr) {
    console.error('[docusign] createEnvelope FAILED:', envErr.response ? JSON.stringify(envErr.response.body || envErr.response.data) : envErr.message);
    throw envErr;
  }

  // Generate embedded signing URL
  const appUrl = process.env.APP_URL || 'https://davincii.co';
  const viewRequest = docusign.RecipientViewRequest.constructFromObject({
    returnUrl: appUrl + '/api/tax/docusign-return?envelopeId=' + envelope.envelopeId,
    authenticationMethod: 'none',
    email: signerEmail,
    userName: signerName,
    clientUserId: String(artist.id),
    frameAncestors: ['https://davincii.co'],
    messageOrigins: ['https://davincii.co'],
  });

  console.log('[docusign] createRecipientView request:', JSON.stringify({
    accountId,
    envelopeId: envelope.envelopeId,
    email: signerEmail,
    userName: signerName,
    clientUserId: String(artist.id),
    returnUrl: appUrl + '/api/tax/docusign-return',
  }));

  let viewResult;
  try {
    viewResult = await envelopesApi.createRecipientView(accountId, envelope.envelopeId, {
      recipientViewRequest: viewRequest,
    });
    console.log('[docusign] signing URL generated');
  } catch (viewErr) {
    console.error('[docusign] createRecipientView FAILED:', viewErr.response ? JSON.stringify(viewErr.response.body || viewErr.response.data) : viewErr.message);
    throw viewErr;
  }

  return {
    envelopeId: envelope.envelopeId,
    signUrl: viewResult.url,
  };
}

module.exports = { createDocuSignEnvelope, getDocuSignClient, diagnoseJwtAuth };
