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
async function fillW9Pdf(taxData) {
  const pdfBytes = fs.readFileSync(W9_PDF_PATH);
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const form = pdfDoc.getForm();

  const fields = form.getFields();
  console.log('[docusign] PDF form fields:', fields.map(f => f.getName()));

  // Try to fill known fields — IRS W-9 field names vary by PDF version
  const tryFill = (name, value) => {
    try {
      const field = form.getTextField(name);
      if (field && value) field.setText(value);
    } catch (e) { /* field not found, skip */ }
  };

  const tryCheck = (name, checked) => {
    try {
      const field = form.getCheckBox(name);
      if (field && checked) field.check();
    } catch (e) { /* field not found, skip */ }
  };

  // Standard IRS W-9 (Rev. Oct 2018+) field names
  tryFill('topmostSubform[0].Page1[0].f1_1[0]', taxData.name || '');
  tryFill('topmostSubform[0].Page1[0].f1_2[0]', taxData.businessName || '');
  tryFill('topmostSubform[0].Page1[0].Address[0].f1_7[0]', taxData.addressStreet || '');
  tryFill('topmostSubform[0].Page1[0].Address[0].f1_8[0]', taxData.addressCityStateZip || '');

  // SSN fields (3 parts)
  if (taxData.ssn) {
    const ssn = taxData.ssn.replace(/\D/g, '');
    tryFill('topmostSubform[0].Page1[0].SSN[0].f1_11[0]', ssn.substring(0, 3));
    tryFill('topmostSubform[0].Page1[0].SSN[0].f1_12[0]', ssn.substring(3, 5));
    tryFill('topmostSubform[0].Page1[0].SSN[0].f1_13[0]', ssn.substring(5, 9));
  }

  // EIN fields (2 parts)
  if (taxData.ein) {
    const ein = taxData.ein.replace(/\D/g, '');
    tryFill('topmostSubform[0].Page1[0].EmployerID[0].f1_14[0]', ein.substring(0, 2));
    tryFill('topmostSubform[0].Page1[0].EmployerID[0].f1_15[0]', ein.substring(2, 9));
  }

  // Tax classification checkboxes
  const classMap = {
    individual: 'topmostSubform[0].Page1[0].Checkbox3[0]',
    cCorp: 'topmostSubform[0].Page1[0].Checkbox4[0]',
    sCorp: 'topmostSubform[0].Page1[0].Checkbox5[0]',
    partnership: 'topmostSubform[0].Page1[0].Checkbox6[0]',
    trustEstate: 'topmostSubform[0].Page1[0].Checkbox7[0]',
    llc: 'topmostSubform[0].Page1[0].Checkbox8[0]',
    other: 'topmostSubform[0].Page1[0].Checkbox9[0]',
  };
  if (taxData.taxClass && classMap[taxData.taxClass]) {
    tryCheck(classMap[taxData.taxClass], true);
  }

  // LLC classification
  if (taxData.llcTaxClass) {
    tryFill('topmostSubform[0].Page1[0].f1_3[0]', taxData.llcTaxClass);
  }

  // Flatten so fields are no longer editable
  form.flatten();

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
    returnUrl: appUrl + '/api/tax/docusign-return',
    authenticationMethod: 'none',
    email: signerEmail,
    userName: signerName,
    clientUserId: String(artist.id),
    frameAncestors: [appUrl, 'https://davincii.co'],
    messageOrigins: [appUrl, 'https://davincii.co'],
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
