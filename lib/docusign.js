const docusign = require('docusign-esign');
const { PDFDocument } = require('pdf-lib');
const fs = require('fs');
const path = require('path');

const W9_PDF_PATH = path.join(__dirname, '..', 'templates', 'fw9.pdf');

// ── JWT Auth ─────────────────────────────────────────────────────────────────
async function getDocuSignClient() {
  const apiClient = new docusign.ApiClient();
  apiClient.setOAuthBasePath('account-d.docusign.com'); // sandbox
  let rsaKey = process.env.DS_RSA_KEY;
  if (!rsaKey) throw new Error('DS_RSA_KEY missing');
  // Railway may store the key with literal \n — convert to real newlines
  rsaKey = rsaKey.replace(/\\n/g, '\n');

  const results = await apiClient.requestJWTUserToken(
    process.env.DS_INTEGRATION_KEY,
    process.env.DS_USER_ID,
    'signature',
    Buffer.from(rsaKey),
    3600
  );
  const accessToken = results.body.access_token;
  apiClient.addDefaultHeader('Authorization', 'Bearer ' + accessToken);
  apiClient.setBasePath(process.env.DS_BASE_URI + '/restapi');
  return apiClient;
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
  const viewRequest = docusign.RecipientViewRequest.constructFromObject({
    returnUrl: (process.env.APP_URL || 'https://davincii.app') + '/api/tax/docusign-return',
    authenticationMethod: 'none',
    email: signerEmail,
    userName: signerName,
    clientUserId: String(artist.id),
  });

  const viewResult = await envelopesApi.createRecipientView(accountId, envelope.envelopeId, {
    recipientViewRequest: viewRequest,
  });
  console.log('[docusign] signing URL generated');

  return {
    envelopeId: envelope.envelopeId,
    signUrl: viewResult.url,
  };
}

module.exports = { createDocuSignEnvelope, getDocuSignClient };
