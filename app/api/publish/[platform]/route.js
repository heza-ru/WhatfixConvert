// app/api/publish/[platform]/route.js
// Server-side proxy for all LMS and Knowledge Base upload integrations.
// Keeps credentials out of browser network logs and bypasses CORS restrictions.
//
// Supported platforms:
//   LMS  — whatfix, workday, successfactors, cornerstone, docebo,
//           linkedin, 360learning, absorb, degreed
//   KB   — confluence, sharepoint, notion, zendesk, servicenow, guru

import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const maxDuration = 120; // large PPTX/SCORM packages can take 60-90 s

// ── Entry point ───────────────────────────────────────────────────────────────
export async function POST(request, { params }) {
  const platform = params.platform;

  let formData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Invalid multipart body' }, { status: 400 });
  }

  const file     = formData.get('file');       // Blob | File
  const filename = formData.get('filename') || 'document.pdf';
  const title    = formData.get('title')    || filename.replace(/\.[^.]+$/, '');

  if (!file) {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 });
  }

  // Reject oversized payloads (250 MB matches client-side limit)
  const MAX_BYTES = 250 * 1024 * 1024;
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: 'File exceeds 250 MB limit' }, { status: 413 });
  }

  // Collect all credential fields from the FormData
  const creds = {};
  for (const [key, val] of formData.entries()) {
    if (key !== 'file' && key !== 'filename' && key !== 'title' && key !== 'format') {
      creds[key] = val;
    }
  }

  try {
    switch (platform) {

      // ── LMS ──────────────────────────────────────────────────────────────────

      case 'whatfix':         return await uploadWhatfix(file, filename, title, creds);
      case 'workday':         return await uploadWorkday(file, filename, title, creds);
      case 'successfactors':  return await uploadSuccessFactors(file, filename, title, creds);
      case 'cornerstone':     return await uploadCornerstone(file, filename, title, creds);
      case 'docebo':          return await uploadDocebo(file, filename, title, creds);
      case 'linkedin':        return await uploadLinkedIn(file, filename, title, creds);
      case '360learning':     return await upload360Learning(file, filename, title, creds);
      case 'absorb':          return await uploadAbsorb(file, filename, title, creds);
      case 'degreed':         return await uploadDegreed(file, filename, title, creds);

      // ── Knowledge Base ────────────────────────────────────────────────────────

      case 'confluence':      return await uploadConfluence(file, filename, title, creds);
      case 'sharepoint':      return await uploadSharePoint(file, filename, title, creds);
      case 'notion':          return await uploadNotion(file, filename, title, creds);
      case 'zendesk':         return await uploadZendesk(file, filename, title, creds);
      case 'servicenow':      return await uploadServiceNow(file, filename, title, creds);
      case 'guru':            return await uploadGuru(file, filename, title, creds);

      default:
        return NextResponse.json({ error: `Unknown platform: ${platform}` }, { status: 400 });
    }
  } catch (err) {
    console.error(`[publish/${platform}]`, err);
    return NextResponse.json({ error: err.message || 'Upload failed' }, { status: 500 });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function b64(user, pass) {
  return Buffer.from(`${user}:${pass}`).toString('base64');
}

function require(creds, ...keys) {
  const missing = keys.filter(k => !creds[k]);
  if (missing.length) throw new Error(`Missing credentials: ${missing.join(', ')}`);
}

async function ok(res, label) {
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${label} responded ${res.status}${body ? ': ' + body.slice(0, 200) : ''}`);
  }
  return res;
}

// ── LMS handlers ─────────────────────────────────────────────────────────────

// Whatfix Quickread — PDF Upload API
// https://developer.whatfix.com/#tag/Pdf-Upload
async function uploadWhatfix(file, filename, title, creds) {
  require(creds, 'accountId', 'flowId', 'integrationKey', 'userEmail');

  const ALLOWED = ['https://api.whatfix.com', 'https://whatfix.com', 'https://eu.whatfix.com'];
  const region  = ALLOWED.includes(creds.region) ? creds.region : 'https://api.whatfix.com';
  const ts      = Date.now();
  const safe    = encodeURIComponent(filename.replace(/[^a-zA-Z0-9._\- ]/g, '_'));

  const url = `${region}/v1/accounts/${encodeURIComponent(creds.accountId)}/content/upload/cloud/pdf/${encodeURIComponent(creds.flowId)}/1/${ts}/${safe}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'x-whatfix-integration-key': creds.integrationKey,
      'x-whatfix-user':            creds.userEmail,
      'Content-Type':              'application/pdf',
    },
    body: file,
  });
  await ok(res, 'Whatfix');
  return NextResponse.json({ success: true, platform: 'whatfix' });
}

// Workday Learning — REST API (OAuth2 client_credentials)
// Endpoint: /api/learning/v1/uploadedContent
async function uploadWorkday(file, filename, title, creds) {
  require(creds, 'tenantUrl', 'clientId', 'clientSecret');

  // 1. Get token
  const tokenRes = await fetch(`${creds.tenantUrl}/ccx/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: creds.clientId, client_secret: creds.clientSecret }),
  });
  await ok(tokenRes, 'Workday auth');
  const { access_token } = await tokenRes.json();

  // 2. Upload content
  const fd = new FormData();
  fd.append('file', file, filename);
  fd.append('title', title);

  const upRes = await fetch(`${creds.tenantUrl}/api/learning/v1/uploadedContent`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${access_token}` },
    body: fd,
  });
  await ok(upRes, 'Workday upload');
  const data = await upRes.json().catch(() => ({}));
  return NextResponse.json({ success: true, platform: 'workday', id: data.id });
}

// SAP SuccessFactors Learning — OData REST API (Basic auth)
// Creates a CorpLearningItem record; attach file via content URL metadata
async function uploadSuccessFactors(file, filename, title, creds) {
  require(creds, 'baseUrl', 'companyId', 'username', 'password');

  const auth    = b64(`${creds.username}@${creds.companyId}`, creds.password);
  const itemId  = `wtfx-${Date.now()}`;

  // 1. Create learning item
  const createRes = await fetch(`${creds.baseUrl}/odata/v2/CorpLearningItem`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      objectId:       itemId,
      itemTitle:      title,
      revisionDate:   new Date().toISOString().split('T')[0],
      componentTypeID:'WBT',
    }),
  });
  await ok(createRes, 'SuccessFactors create item');

  // 2. Upload associated file via Learning Content Import endpoint
  const fd = new FormData();
  fd.append('file', file, filename);
  fd.append('itemId', itemId);

  const upRes = await fetch(`${creds.baseUrl}/learning/odatav4/v1/UserContent`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}` },
    body: fd,
  });
  await ok(upRes, 'SuccessFactors file upload');
  return NextResponse.json({ success: true, platform: 'successfactors', itemId });
}

// Cornerstone OnDemand — Extended Enterprise API
async function uploadCornerstone(file, filename, title, creds) {
  require(creds, 'baseUrl', 'apiKey', 'corpName');

  const fd = new FormData();
  fd.append('file', file, filename);
  fd.append('title', title);
  fd.append('description', `Uploaded via Whatfix Converter`);

  const res = await fetch(`${creds.baseUrl}/services/api/LoProxy/UploadFile`, {
    method: 'POST',
    headers: {
      'x-api-key':        creds.apiKey,
      'x-csod-corpname':  creds.corpName,
    },
    body: fd,
  });
  await ok(res, 'Cornerstone upload');
  const data = await res.json().catch(() => ({}));
  return NextResponse.json({ success: true, platform: 'cornerstone', data });
}

// Docebo — REST API (OAuth2 client_credentials)
// Creates a document-type learning object
async function uploadDocebo(file, filename, title, creds) {
  require(creds, 'baseUrl', 'clientId', 'clientSecret');

  // 1. Get OAuth token
  const tokenRes = await fetch(`${creds.baseUrl}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: creds.clientId, client_secret: creds.clientSecret }),
  });
  await ok(tokenRes, 'Docebo auth');
  const { access_token } = await tokenRes.json();

  // 2. Upload learning object (document type)
  const fd = new FormData();
  fd.append('file', file, filename);
  fd.append('name', title);
  fd.append('type_lo', 'document');
  fd.append('language', 'english');

  const upRes = await fetch(`${creds.baseUrl}/learn/v1/manage/learningobjects`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${access_token}` },
    body: fd,
  });
  await ok(upRes, 'Docebo upload');
  const data = await upRes.json().catch(() => ({}));
  return NextResponse.json({ success: true, platform: 'docebo', id: data.data?.id_learning_object });
}

// LinkedIn Learning Hub — Content at Scale API (OAuth2)
async function uploadLinkedIn(file, filename, title, creds) {
  require(creds, 'organizationId', 'clientId', 'clientSecret');

  // 1. Get access token
  const tokenRes = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: creds.clientId, client_secret: creds.clientSecret }),
  });
  await ok(tokenRes, 'LinkedIn auth');
  const { access_token } = await tokenRes.json();

  // 2. Register content asset
  const externalId = `whatfx-${Date.now()}`;
  const assetRes = await fetch(`https://api.linkedin.com/v2/learningAssets?action=import&organization=${encodeURIComponent(creds.organizationId)}`, {
    method: 'POST',
    headers: {
      Authorization:      `Bearer ${access_token}`,
      'Content-Type':     'application/json',
      'LinkedIn-Version': '202310',
    },
    body: JSON.stringify({
      contents: [{
        externalId,
        title:        { value: title, locale: 'en_US' },
        availability: 'AVAILABLE',
        contents:     [{ type: 'document', fileName: filename }],
      }],
    }),
  });
  await ok(assetRes, 'LinkedIn Learning upload');
  return NextResponse.json({ success: true, platform: 'linkedin', externalId });
}

// 360Learning — REST API (Bearer token)
async function upload360Learning(file, filename, title, creds) {
  require(creds, 'apiKey', 'companyDomain');

  const fd = new FormData();
  fd.append('file', file, filename);
  fd.append('title', title);

  const res = await fetch(`https://${creds.companyDomain}.360learning.com/api/v1/modules`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${creds.apiKey}` },
    body: fd,
  });
  await ok(res, '360Learning upload');
  const data = await res.json().catch(() => ({}));
  return NextResponse.json({ success: true, platform: '360learning', data });
}

// Absorb LMS — REST API (Bearer token)
async function uploadAbsorb(file, filename, title, creds) {
  require(creds, 'baseUrl', 'apiKey');

  const fd = new FormData();
  fd.append('file', file, filename);
  fd.append('Name', title);

  const res = await fetch(`${creds.baseUrl}/api/Rest/v2/online-courses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${creds.apiKey}` },
    body: fd,
  });
  await ok(res, 'Absorb upload');
  const data = await res.json().catch(() => ({}));
  return NextResponse.json({ success: true, platform: 'absorb', id: data.Id });
}

// Degreed — REST API (OAuth2 client_credentials)
async function uploadDegreed(file, filename, title, creds) {
  require(creds, 'clientId', 'clientSecret');

  // 1. Get token
  const tokenRes = await fetch('https://degreed.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: creds.clientId, client_secret: creds.clientSecret, scope: 'content:write' }),
  });
  await ok(tokenRes, 'Degreed auth');
  const { access_token } = await tokenRes.json();

  // 2. Create content article (Degreed v2 content API)
  const createRes = await fetch('https://api.degreed.com/api/v2/content/articles', {
    method: 'POST',
    headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      data: {
        type: 'articles',
        attributes: { title, format: 'article', summary: `Uploaded from Whatfix Converter` },
      },
    }),
  });
  await ok(createRes, 'Degreed content create');
  const data = await createRes.json().catch(() => ({}));
  return NextResponse.json({ success: true, platform: 'degreed', id: data.data?.id });
}

// ── Knowledge Base handlers ───────────────────────────────────────────────────

// Confluence Cloud — REST API v1 (Basic auth: email:api_token)
// Creates a page in the target space, then attaches the file
async function uploadConfluence(file, filename, title, creds) {
  require(creds, 'baseUrl', 'email', 'apiToken', 'spaceKey');

  const auth = b64(creds.email, creds.apiToken);
  const base = creds.baseUrl.replace(/\/$/, '');

  // 1. Create page
  const pageRes = await fetch(`${base}/wiki/rest/api/content`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type:  'page',
      title,
      space: { key: creds.spaceKey },
      body:  { storage: { value: `<p>Uploaded from Whatfix Converter</p>`, representation: 'storage' } },
    }),
  });
  await ok(pageRes, 'Confluence create page');
  const { id: pageId, _links } = await pageRes.json();

  // 2. Upload file as attachment
  const fd = new FormData();
  fd.append('file', file, filename);
  fd.append('comment', 'Whatfix Converter export');

  const attRes = await fetch(`${base}/wiki/rest/api/content/${pageId}/child/attachment`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'X-Atlassian-Token': 'no-check' },
    body: fd,
  });
  await ok(attRes, 'Confluence attach file');
  return NextResponse.json({ success: true, platform: 'confluence', pageId, pageUrl: _links?.webui });
}

// SharePoint / Microsoft 365 — Graph API (OAuth2 client_credentials)
// Uploads the file to the default SharePoint drive
async function uploadSharePoint(file, filename, title, creds) {
  require(creds, 'tenantId', 'clientId', 'clientSecret', 'siteId');

  // 1. Get Graph API token
  const tokenRes = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(creds.tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: creds.clientId, client_secret: creds.clientSecret, scope: 'https://graph.microsoft.com/.default' }),
  });
  await ok(tokenRes, 'SharePoint (Microsoft) auth');
  const { access_token } = await tokenRes.json();

  // 2. Upload file to drive root (or specific drive if driveId given)
  const driveSegment = creds.driveId ? `/drives/${creds.driveId}` : '/drive';
  const uploadUrl = `https://graph.microsoft.com/v1.0/sites/${encodeURIComponent(creds.siteId)}${driveSegment}/root:/${encodeURIComponent(filename)}:/content`;

  const upRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  });
  await ok(upRes, 'SharePoint file upload');
  const data = await upRes.json().catch(() => ({}));
  return NextResponse.json({ success: true, platform: 'sharepoint', webUrl: data.webUrl, id: data.id });
}

// Notion — REST API v1 (Bearer integration_token)
// Creates a new page under parentPageId; attaches PDF via file block
async function uploadNotion(file, filename, title, creds) {
  require(creds, 'integrationToken', 'parentPageId');

  // 1. Create the page with title + subtitle paragraph
  const pageRes = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      Authorization:    `Bearer ${creds.integrationToken}`,
      'Content-Type':   'application/json',
      'Notion-Version': '2022-06-28',
    },
    body: JSON.stringify({
      parent:     { page_id: creds.parentPageId },
      properties: { title: { title: [{ text: { content: title } }] } },
      children: [
        { object: 'block', type: 'callout', callout: { rich_text: [{ text: { content: `Exported from Whatfix Converter · ${filename}` } }], icon: { emoji: '📄' }, color: 'gray_background' } },
      ],
    }),
  });
  await ok(pageRes, 'Notion create page');
  const { id: pageId, url } = await pageRes.json();

  // 2. Upload file (Notion v1 file upload — retrieve a presigned URL then PUT)
  // Step 2a: create upload
  const uploadInitRes = await fetch('https://api.notion.com/v1/file-uploads', {
    method: 'POST',
    headers: {
      Authorization:    `Bearer ${creds.integrationToken}`,
      'Content-Type':   'application/json',
      'Notion-Version': '2022-06-28',
    },
    body: JSON.stringify({ name: filename, content_type: file.type || 'application/pdf', mode: 'single_part' }),
  });
  await ok(uploadInitRes, 'Notion file-upload init');
  const { id: fileUploadId, upload_url: uploadUrl } = await uploadInitRes.json();

  // Step 2b: PUT file content to presigned URL
  const putRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.type || 'application/pdf' },
    body: file,
  });
  await ok(putRes, 'Notion file PUT');

  // Step 2c: Append file block to the new page
  await fetch(`https://api.notion.com/v1/blocks/${pageId}/children`, {
    method: 'PATCH',
    headers: {
      Authorization:    `Bearer ${creds.integrationToken}`,
      'Content-Type':   'application/json',
      'Notion-Version': '2022-06-28',
    },
    body: JSON.stringify({
      children: [{
        object: 'block',
        type:   'file',
        file:   { type: 'file_upload', file_upload: { id: fileUploadId } },
      }],
    }),
  });

  return NextResponse.json({ success: true, platform: 'notion', pageId, url });
}

// Zendesk Guide — REST API (Basic auth: email/token:api_token)
// Uploads attachment first, then creates article with link
async function uploadZendesk(file, filename, title, creds) {
  require(creds, 'subdomain', 'email', 'apiToken');

  const auth = b64(`${creds.email}/token`, creds.apiToken);
  const base = `https://${creds.subdomain}.zendesk.com`;

  // 1. Upload attachment (unassociated first, then link in article)
  const fd = new FormData();
  fd.append('file', file, filename);
  fd.append('inline', 'false');

  const attRes = await fetch(`${base}/api/v2/help_center/articles/attachments`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}` },
    body: fd,
  });
  await ok(attRes, 'Zendesk attachment upload');
  const attData = await attRes.json();
  const fileUrl = attData.article_attachment?.content_url || '';

  // 2. Create article
  const articlePayload = {
    article: {
      title,
      body:   `<p><a href="${fileUrl}">${filename}</a></p><p>Exported from Whatfix Converter.</p>`,
      locale: 'en-us',
      draft:  true,
    },
  };
  const articleEndpoint = creds.sectionId
    ? `${base}/api/v2/help_center/sections/${creds.sectionId}/articles`
    : `${base}/api/v2/help_center/en-us/articles`;

  const artRes = await fetch(articleEndpoint, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(articlePayload),
  });
  await ok(artRes, 'Zendesk create article');
  const artData = await artRes.json();
  return NextResponse.json({ success: true, platform: 'zendesk', articleId: artData.article?.id, url: artData.article?.html_url });
}

// ServiceNow Knowledge Base — Table API + Attachment API (Basic auth)
async function uploadServiceNow(file, filename, title, creds) {
  require(creds, 'instanceUrl', 'username', 'password');

  const auth = b64(creds.username, creds.password);
  const base = creds.instanceUrl.replace(/\/$/, '');

  // 1. Create KB article (draft)
  const articleBody = {
    short_description: title,
    text:              `<p>Exported from Whatfix Converter — see attached file: <strong>${filename}</strong></p>`,
    workflow_state:    'draft',
    ...(creds.kbSysId ? { kb_knowledge_base: creds.kbSysId } : {}),
  };

  const artRes = await fetch(`${base}/api/now/table/kb_knowledge`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(articleBody),
  });
  await ok(artRes, 'ServiceNow create article');
  const artData = await artRes.json();
  const sysId   = artData.result?.sys_id;

  // 2. Attach file to the article
  const attRes = await fetch(
    `${base}/api/now/attachment/upload?table_name=kb_knowledge&table_sys_id=${sysId}&file_name=${encodeURIComponent(filename)}`,
    {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': file.type || 'application/pdf' },
      body: file,
    }
  );
  await ok(attRes, 'ServiceNow attach file');
  return NextResponse.json({ success: true, platform: 'servicenow', sysId });
}

// Guru — REST API (Basic auth: user_email:api_token)
// Creates a card with the file referenced in the content
async function uploadGuru(file, filename, title, creds) {
  require(creds, 'userEmail', 'apiToken');

  const auth = b64(creds.userEmail, creds.apiToken);

  const cardBody = {
    preferredPhrase: title,
    content: `<p><strong>${title}</strong></p><p>Exported from Whatfix Converter — see attached file: <em>${filename}</em></p>`,
    ...(creds.collectionId ? { collection: { id: creds.collectionId } } : {}),
  };

  const res = await fetch('https://api.getguru.com/api/v1/cards', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cardBody),
  });
  await ok(res, 'Guru create card');
  const data = await res.json().catch(() => ({}));

  // Attach file to the card if cardId returned
  const cardId = data.id;
  if (cardId) {
    const fd = new FormData();
    fd.append('file', file, filename);
    await fetch(`https://api.getguru.com/api/v1/cards/${cardId}/attachments`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}` },
      body: fd,
    }).catch(() => {/* attachment is best-effort */});
  }

  return NextResponse.json({ success: true, platform: 'guru', cardId });
}
