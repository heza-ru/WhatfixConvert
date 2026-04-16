// lib/lms-connectors.js — LMS / Knowledge-Base platform registry + SCORM builder
// All non-SCORM uploads go through server-side API routes (/api/publish/[platform])
// to avoid CORS issues and keep credentials off the client network tab.

// ── Platform registry ─────────────────────────────────────────────────────────
// type: 'lms' | 'kb'
// formats: which file types can be uploaded to this platform
// fields: credential fields the user must supply

export const PUBLISH_PLATFORMS = [

  // ── LMS ──────────────────────────────────────────────────────────────────────

  {
    id: 'whatfix',
    type: 'lms',
    name: 'Whatfix Quickread',
    color: '#FF6B18',
    description: 'Upload directly to Whatfix content library',
    formats: ['pdf'],
    fields: [
      { key: 'accountId',      label: 'Account ID',      type: 'text' },
      { key: 'flowId',         label: 'Flow ID',         type: 'text' },
      { key: 'integrationKey', label: 'Integration Key', type: 'password' },
      { key: 'userEmail',      label: 'User Email',      type: 'email' },
      { key: 'region',         label: 'Region',          type: 'select',
        options: [
          { value: 'https://api.whatfix.com', label: 'Global — api.whatfix.com' },
          { value: 'https://whatfix.com',     label: 'whatfix.com' },
          { value: 'https://eu.whatfix.com',  label: 'EU — eu.whatfix.com' },
        ],
        defaultValue: 'https://api.whatfix.com',
      },
    ],
  },

  {
    id: 'workday',
    type: 'lms',
    name: 'Workday Learning',
    color: '#0875e1',
    description: 'HRIS-native LMS, dominant in Fortune 500',
    formats: ['pdf', 'pptx', 'docx'],
    fields: [
      { key: 'tenantUrl',    label: 'Tenant URL',    type: 'text',     placeholder: 'https://yourco.workday.com' },
      { key: 'clientId',     label: 'Client ID',     type: 'text' },
      { key: 'clientSecret', label: 'Client Secret', type: 'password' },
    ],
  },

  {
    id: 'successfactors',
    type: 'lms',
    name: 'SAP SuccessFactors',
    color: '#0070b8',
    description: 'Widely deployed at SAP-centric enterprises',
    formats: ['pdf', 'docx'],
    fields: [
      { key: 'baseUrl',   label: 'API Base URL', type: 'text',     placeholder: 'https://api10.successfactors.com' },
      { key: 'companyId', label: 'Company ID',   type: 'text' },
      { key: 'username',  label: 'Username',     type: 'text' },
      { key: 'password',  label: 'Password',     type: 'password' },
    ],
  },

  {
    id: 'cornerstone',
    type: 'lms',
    name: 'Cornerstone OnDemand',
    color: '#f47b20',
    description: 'Top choice for talent & compliance training',
    formats: ['pdf', 'pptx', 'docx'],
    fields: [
      { key: 'baseUrl',  label: 'Portal URL',        type: 'text',     placeholder: 'https://yourco.csod.com' },
      { key: 'apiKey',   label: 'API Key',            type: 'password' },
      { key: 'corpName', label: 'Corporation Code',   type: 'text' },
    ],
  },

  {
    id: 'docebo',
    type: 'lms',
    name: 'Docebo',
    color: '#00b4d4',
    description: 'API-first LMS with AI-powered learning paths',
    formats: ['pdf', 'pptx', 'docx'],
    fields: [
      { key: 'baseUrl',      label: 'Docebo URL',      type: 'text',     placeholder: 'https://yourco.docebo.com' },
      { key: 'clientId',     label: 'Client ID',       type: 'text' },
      { key: 'clientSecret', label: 'Client Secret',   type: 'password' },
    ],
  },

  {
    id: 'linkedin',
    type: 'lms',
    name: 'LinkedIn Learning Hub',
    color: '#0a66c2',
    description: 'LinkedIn-integrated enterprise skill building',
    formats: ['pdf'],
    fields: [
      { key: 'organizationId', label: 'Organization ID',    type: 'text' },
      { key: 'clientId',       label: 'OAuth Client ID',    type: 'text' },
      { key: 'clientSecret',   label: 'OAuth Client Secret',type: 'password' },
    ],
  },

  {
    id: '360learning',
    type: 'lms',
    name: '360Learning',
    color: '#ff5d39',
    description: 'Collaborative LMS for peer-driven learning',
    formats: ['pdf', 'pptx', 'docx'],
    fields: [
      { key: 'apiKey',        label: 'API Key',       type: 'password' },
      { key: 'companyDomain', label: 'Company Domain',type: 'text', placeholder: 'yourco' },
    ],
  },

  {
    id: 'absorb',
    type: 'lms',
    name: 'Absorb LMS',
    color: '#6c2dc7',
    description: 'Cloud-native LMS for enterprise onboarding',
    formats: ['pdf', 'pptx', 'docx'],
    fields: [
      { key: 'baseUrl', label: 'Absorb URL', type: 'text',     placeholder: 'https://yourco.myabsorb.com' },
      { key: 'apiKey',  label: 'API Key',    type: 'password' },
    ],
  },

  {
    id: 'degreed',
    type: 'lms',
    name: 'Degreed',
    color: '#2d6a4f',
    description: 'Skills-based LXP used across Fortune 500',
    formats: ['pdf'],
    fields: [
      { key: 'clientId',     label: 'Client ID',     type: 'text' },
      { key: 'clientSecret', label: 'Client Secret', type: 'password' },
    ],
  },

  // ── Knowledge Base ────────────────────────────────────────────────────────────

  {
    id: 'confluence',
    type: 'kb',
    name: 'Confluence',
    color: '#0052CC',
    description: 'Atlassian team wiki, ubiquitous in tech F500',
    formats: ['pdf', 'docx'],
    fields: [
      { key: 'baseUrl',  label: 'Confluence URL', type: 'text',     placeholder: 'https://yourco.atlassian.net' },
      { key: 'email',    label: 'Email',          type: 'email' },
      { key: 'apiToken', label: 'API Token',      type: 'password' },
      { key: 'spaceKey', label: 'Space Key',      type: 'text',     placeholder: 'TEAM' },
    ],
  },

  {
    id: 'sharepoint',
    type: 'kb',
    name: 'SharePoint / M365',
    color: '#038387',
    description: 'Microsoft 365 document & knowledge hub',
    formats: ['pdf', 'docx', 'pptx'],
    fields: [
      { key: 'tenantId',     label: 'Tenant ID',       type: 'text' },
      { key: 'clientId',     label: 'App (Client) ID', type: 'text' },
      { key: 'clientSecret', label: 'Client Secret',   type: 'password' },
      { key: 'siteId',       label: 'Site ID',         type: 'text', placeholder: 'yourco.sharepoint.com,site-guid,web-guid' },
      { key: 'driveId',      label: 'Drive ID (opt.)', type: 'text', optional: true },
    ],
  },

  {
    id: 'notion',
    type: 'kb',
    name: 'Notion',
    color: '#191919',
    description: 'All-in-one wiki adopted by modern F500 teams',
    formats: ['pdf', 'docx'],
    fields: [
      { key: 'integrationToken', label: 'Integration Secret', type: 'password', placeholder: 'secret_…' },
      { key: 'parentPageId',     label: 'Parent Page ID',     type: 'text',     placeholder: 'page-id from URL' },
    ],
  },

  {
    id: 'zendesk',
    type: 'kb',
    name: 'Zendesk Guide',
    color: '#03363D',
    description: 'Customer-facing knowledge base for support teams',
    formats: ['pdf', 'docx'],
    fields: [
      { key: 'subdomain', label: 'Subdomain',  type: 'text',     placeholder: 'yourco' },
      { key: 'email',     label: 'Email',      type: 'email' },
      { key: 'apiToken',  label: 'API Token',  type: 'password' },
      { key: 'sectionId', label: 'Section ID', type: 'text',     optional: true },
    ],
  },

  {
    id: 'servicenow',
    type: 'kb',
    name: 'ServiceNow Knowledge',
    color: '#81B5A1',
    description: 'IT & HR knowledge management at large enterprises',
    formats: ['pdf'],
    fields: [
      { key: 'instanceUrl', label: 'Instance URL',          type: 'text',     placeholder: 'https://yourco.service-now.com' },
      { key: 'username',    label: 'Username',              type: 'text' },
      { key: 'password',    label: 'Password',              type: 'password' },
      { key: 'kbSysId',     label: 'KB Sys ID (opt.)',      type: 'text',     optional: true },
    ],
  },

  {
    id: 'guru',
    type: 'kb',
    name: 'Guru',
    color: '#5c68e8',
    description: 'AI-powered company wiki growing in F500',
    formats: ['pdf', 'docx'],
    fields: [
      { key: 'userEmail',    label: 'Email',         type: 'email' },
      { key: 'apiToken',     label: 'API Token',     type: 'password' },
      { key: 'collectionId', label: 'Collection ID', type: 'text',     optional: true },
    ],
  },
];

// ── SCORM 1.2 package builder ─────────────────────────────────────────────────
export async function buildScormPackage(htmlContent, title) {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();

  const scormShim = `
<script>
(function(){
  function findAPI(w,d){if(d>7)return null;if(w.API)return w.API;if(w.parent&&w.parent!==w)return findAPI(w.parent,d+1);if(w.opener)return findAPI(w.opener,0);return null;}
  window.addEventListener('load',function(){var api=findAPI(window,0);if(!api)return;api.LMSInitialize('');api.LMSSetValue('cmi.core.lesson_status','completed');api.LMSSetValue('cmi.core.score.raw','100');api.LMSSetValue('cmi.core.score.min','0');api.LMSSetValue('cmi.core.score.max','100');api.LMSCommit('');});
  window.addEventListener('beforeunload',function(){var api=findAPI(window,0);if(!api)return;api.LMSSetValue('cmi.core.lesson_status','completed');api.LMSCommit('');api.LMSFinish('');});
})();
<\/script>`;

  const injected = htmlContent.includes('</body>')
    ? htmlContent.replace('</body>', `${scormShim}\n</body>`)
    : htmlContent + scormShim;

  zip.file('index.html', injected);
  zip.file('imsmanifest.xml', buildManifest(title));

  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 }, mimeType: 'application/zip' });
}

function buildManifest(title) {
  const id  = `whatfx_${Date.now()}`;
  const esc = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="${id}" version="1.0"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.imsproject.org/xsd/imscp_rootv1p1p2 imscp_rootv1p1p2.xsd http://www.adlnet.org/xsd/adlcp_rootv1p2 adlcp_rootv1p2.xsd">
  <metadata><schema>ADL SCORM</schema><schemaversion>1.2</schemaversion></metadata>
  <organizations default="org_${id}">
    <organization identifier="org_${id}">
      <title>${esc(title)}</title>
      <item identifier="item_${id}" identifierref="res_${id}">
        <title>${esc(title)}</title>
        <adlcp:masteryscore>80</adlcp:masteryscore>
      </item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="res_${id}" type="webcontent" adlcp:scormtype="sco" href="index.html">
      <file href="index.html"/>
    </resource>
  </resources>
</manifest>`;
}
