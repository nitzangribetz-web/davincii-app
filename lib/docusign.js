const docusign = require('docusign-esign');
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

// ── Create envelope + embedded signing ───────────────────────────────────────
async function createDocuSignEnvelope({ artist, legalName, taxData }) {
  if (!process.env.DS_INTEGRATION_KEY) throw new Error('DS_INTEGRATION_KEY missing');
  if (!process.env.DS_ACCOUNT_ID) throw new Error('DS_ACCOUNT_ID missing');

  const signerName = legalName || artist.name || artist.stage_name || artist.email || 'Artist';
  const signerEmail = artist.email;
  if (!signerEmail) throw new Error('Artist email missing');

  // Load blank W-9 PDF (no pre-filling — DocuSign tabs handle data placement)
  console.log('[docusign] loading W-9 PDF...');
  const pdfBytes = fs.readFileSync(W9_PDF_PATH);
  const pdfBase64 = Buffer.from(pdfBytes).toString('base64');

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

  const td = taxData || {};

  // Coordinates extracted from PDF widget annotations via pdf-lib.
  // PDF origin = bottom-left; DocuSign origin = top-left.
  // Conversion: dsY = 792 - pdfY - fieldHeight.
  // Source: templates/fw9.pdf AcroForm field Rect values.
  const textTabs = [];
  const checkboxTabs = [];

  // f1_01: Name — pdf:(59,660,517x14) → ds:(59,118)
  if (td.name) {
    textTabs.push({
      xPosition: '59', yPosition: '118',
      pageNumber: '1', documentId: '1',
      value: td.name, locked: 'true',
      font: 'helvetica', fontSize: 'size12', bold: 'true', bold: 'true',
      tabLabel: 'name',
    });
  }

  // f1_02: Business name — pdf:(59,636,517x14) → ds:(59,142)
  if (td.businessName) {
    textTabs.push({
      xPosition: '59', yPosition: '142',
      pageNumber: '1', documentId: '1',
      value: td.businessName, locked: 'true',
      font: 'helvetica', fontSize: 'size12', bold: 'true', bold: 'true',
      tabLabel: 'businessName',
    });
  }

  // c1_1[0-6]: Tax classification checkboxes — from PDF widget Rects
  const classPositions = {
    individual:  { x: '73',  y: '180' }, // c1_1[0] pdf:(73,604,8x8)
    cCorp:       { x: '180', y: '180' }, // c1_1[1] pdf:(180,604,8x8)
    sCorp:       { x: '252', y: '180' }, // c1_1[2] pdf:(252,604,8x8)
    partnership: { x: '324', y: '180' }, // c1_1[3] pdf:(324,604,8x8)
    trustEstate: { x: '389', y: '180' }, // c1_1[4] pdf:(389,604,8x8)
    llc:         { x: '73',  y: '194' }, // c1_1[5] pdf:(73,590,8x8)
    other:       { x: '73',  y: '230' }, // c1_1[6] pdf:(73,554,8x8)
  };
  if (td.taxClass && classPositions[td.taxClass]) {
    checkboxTabs.push({
      xPosition: classPositions[td.taxClass].x,
      yPosition: classPositions[td.taxClass].y,
      pageNumber: '1', documentId: '1',
      selected: 'true', locked: 'true',
      tabLabel: 'taxClass',
    });
  }

  // f1_07: Address — pdf:(59,492,329x14) → ds:(59,286)
  if (td.addressStreet) {
    textTabs.push({
      xPosition: '59', yPosition: '286',
      pageNumber: '1', documentId: '1',
      value: td.addressStreet, locked: 'true',
      font: 'helvetica', fontSize: 'size12', bold: 'true', bold: 'true',
      tabLabel: 'addressStreet',
    });
  }

  // f1_08: City, state, ZIP — pdf:(59,468,329x14) → ds:(59,310)
  if (td.addressCityStateZip) {
    textTabs.push({
      xPosition: '59', yPosition: '310',
      pageNumber: '1', documentId: '1',
      value: td.addressCityStateZip, locked: 'true',
      font: 'helvetica', fontSize: 'size12', bold: 'true', bold: 'true',
      tabLabel: 'addressCityStateZip',
    });
  }

  // f1_11/12/13: SSN boxes — pdf Rects: (418,396,43x24), (475,396,29x24), (518,396,58x24)
  // → ds: (418,372), (475,372), (518,372)
  if (td.ssn) {
    const ssn = td.ssn.replace(/\D/g, '');
    textTabs.push({
      xPosition: '418', yPosition: '372',
      pageNumber: '1', documentId: '1',
      value: ssn.substring(0, 3), locked: 'true',
      font: 'helvetica', fontSize: 'size12', bold: 'true',
      tabLabel: 'ssn1',
    });
    textTabs.push({
      xPosition: '475', yPosition: '372',
      pageNumber: '1', documentId: '1',
      value: ssn.substring(3, 5), locked: 'true',
      font: 'helvetica', fontSize: 'size12', bold: 'true',
      tabLabel: 'ssn2',
    });
    textTabs.push({
      xPosition: '518', yPosition: '372',
      pageNumber: '1', documentId: '1',
      value: ssn.substring(5, 9), locked: 'true',
      font: 'helvetica', fontSize: 'size12', bold: 'true',
      tabLabel: 'ssn3',
    });
  }

  // f1_14/15: EIN boxes — pdf Rects: (418,348,29x24), (461,348,101x24)
  // → ds: (418,420), (461,420)
  if (td.ein) {
    const ein = td.ein.replace(/\D/g, '');
    textTabs.push({
      xPosition: '418', yPosition: '420',
      pageNumber: '1', documentId: '1',
      value: ein.substring(0, 2), locked: 'true',
      font: 'helvetica', fontSize: 'size12', bold: 'true',
      tabLabel: 'ein1',
    });
    textTabs.push({
      xPosition: '461', yPosition: '420',
      pageNumber: '1', documentId: '1',
      value: ein.substring(2, 9), locked: 'true',
      font: 'helvetica', fontSize: 'size12', bold: 'true',
      tabLabel: 'ein2',
    });
  }

  // Signature tab (Part II of W-9)
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
      textTabs: textTabs,
      checkboxTabs: checkboxTabs,
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
