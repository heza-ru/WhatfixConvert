// lib/converter.js — Browser-only ODARC converter (ESM, dynamic-import only)
// Depends on: jszip (npm), pdfmake, browser APIs (DOMParser, Blob, FileReader, fetch)

import JSZip from 'jszip';

// ── Logo cache ─────────────────────────────────────────────────────
let _logoPromise = null;
export function getLogoB64() {
  if (!_logoPromise) {
    _logoPromise = fetch('/Whatfix_logo.png')
      .then(r => r.ok ? r.blob() : null)
      .then(blob => blob ? new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.onerror = rej;
        fr.readAsDataURL(blob);
      }) : null)
      .catch(() => null);
  }
  return _logoPromise;
}

// ── Layout / rendering constants ───────────────────────────────────
const PRINT_DISPLAY_W   = 600;   // pixel width for screenshot in print HTML
const TOOLTIP_BUBBLE_W  = 280;   // max tooltip bubble width in print overlay (px)
const DKP_FALLBACK_W    = 1024;  // default DKP slide width when metadata is absent
const DKP_FALLBACK_H    = 672;   // default DKP slide height when metadata is absent

// ── XML helpers ────────────────────────────────────────────────────
function normalizeXml(str) {
  return str
    .replace(/^\uFEFF/, '')
    .replace(/\s+xmlns(?::\w+)?="[^"]*"/g, '')
    .replace(/(<\/?\s*)\w+:/g, '$1')
    .replace(/\b\w+:(\w+)=/g, '$1=');
}

function parseXml(xmlString) {
  const doc = new DOMParser().parseFromString(normalizeXml(xmlString), 'application/xml');
  const err = doc.querySelector('parsererror');
  if (err) throw new Error('XML parse error: ' + err.textContent.slice(0, 120));
  return doc;
}

// ── Text helpers ───────────────────────────────────────────────────
function escHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function stripHtmlToText(html) {
  if (!html) return '';
  // Collapse block tags to newlines before stripping
  const blocked = html
    .replace(/<\/?(p|div|br|li|tr|h[1-6])[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return blocked.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

// Detects DKP internal IDs / file references that should never be shown to users
// e.g. "group!GR_644CCA0ADB47A194:E3F7A25CC25BC89D", "CTL3F7A25CC25BC89D", "SL_XXXX", "el_0"
function isInternalRef(str) {
  if (!str) return true;
  return /[!:]/.test(str)                                         // group!GR_..., SL_xxx:yyy
    || /\.(png|jpg|jpeg|gif|svg|xml|js)$/i.test(str)             // file paths
    || /^(GR_|SL_|CTL|TXT|IMG|OBJ|CTRL|el_\d)/i.test(str)       // known internal prefixes
    || /^[A-Z0-9]{12,}$/.test(str);                              // long hex-style ID
}

function extractSegments(btEl) {
  const segments = [];
  for (const p of btEl.querySelectorAll('p')) {
    const segs = [];
    for (const fmt of p.querySelectorAll('fmt')) {
      const text = fmt.textContent || '';
      if (!text.trim()) continue;
      const sty = fmt.getAttribute('sty') || '';
      segs.push({ text, bold: sty.includes('b'), italic: sty.includes('i'), underline: sty.includes('u'), color: fmt.getAttribute('clr') || null });
    }
    if (segs.length) segments.push({ type: 'line', segs });
    else if (segments.length) segments.push({ type: 'br' });
  }
  return segments;
}

function extractBubbleData(bubbleEl) {
  if (!bubbleEl) return null;
  const bt = bubbleEl.querySelector('BubbleText');
  if (!bt) return null;
  return { bgColor: bt.getAttribute('BgColor') || '#C0FFFF', segments: extractSegments(bt) };
}

function segmentsToHtml(segments) {
  return (segments || []).map(seg => {
    if (seg.type === 'br') return '<br>';
    return seg.segs.map(s => {
      let t = escHtml(s.text);
      if (s.bold)      t = `<strong>${t}</strong>`;
      if (s.italic)    t = `<em>${t}</em>`;
      if (s.underline) t = `<u>${t}</u>`;
      if (s.color)     t = `<span style="color:${s.color}">${t}</span>`;
      return t;
    }).join('');
  }).filter(Boolean).join('');
}

// ── Interaction hints ──────────────────────────────────────────────
const EVENT_VERB  = { LClick1:'Click', LClick2:'Click', RClick1:'Right-click', DClick1:'Double-click', Type:'Type in', Drag:'Drag' };
const ROLE_SUFFIX = { ROLE_SYSTEM_BUTTONMENU:'menu', ROLE_SYSTEM_PUSHBUTTON:'button', ROLE_SYSTEM_LINK:'link', ROLE_SYSTEM_TEXT:'field', ROLE_SYSTEM_LISTITEM:'option', ROLE_SYSTEM_COMBOBOX:'dropdown', ROLE_SYSTEM_MENUITEM:'menu item', ROLE_SYSTEM_CHECKBOX:'checkbox', ROLE_SYSTEM_RADIOBUTTON:'radio button' };

function buildInteractionHint(eventType, objName, objType) {
  const verb   = EVENT_VERB[eventType]  || 'Interact with';
  const suffix = ROLE_SUFFIX[objType]   || '';
  const name   = objName ? `"${objName}"` : 'the highlighted area';
  if (!objName && !eventType) return null;
  return suffix ? `${verb} the ${name} ${suffix}` : `${verb} ${name}`;
}

// ── Frame ordering ─────────────────────────────────────────────────
function orderFrames(frameMap, firstId) {
  const ordered = [], visited = new Set();
  let cur = firstId;
  while (cur && !visited.has(cur)) {
    visited.add(cur);
    const frame = frameMap[cur];
    if (!frame) break;
    ordered.push(frame);
    cur = frame.nextId;
  }
  return ordered;
}

// ── Image to base64 ────────────────────────────────────────────────
async function zipEntryToB64(zip, path) {
  const entry = zip.file(path);
  if (!entry) return null;
  try {
    const ab = await entry.async('arraybuffer');
    const bytes = new Uint8Array(ab);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 8192)
      bin += String.fromCharCode(...bytes.subarray(i, Math.min(i + 8192, bytes.length)));
    const ext  = path.split('.').pop().toLowerCase();
    const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    return `data:${mime};base64,${btoa(bin)}`;
  } catch { return null; }
}

// ── Manifest parser ────────────────────────────────────────────────
function parseManifest(xmlString) {
  const doc = parseXml(xmlString);
  return [...doc.querySelectorAll('Document')].map(d => ({
    folder: d.querySelector('ImportFolder')?.textContent?.trim() || '',
    id:     d.querySelector('ID')?.textContent?.trim()           || '',
    title:  d.querySelector('Title')?.textContent?.trim()        || '',
    schema: d.querySelector('SchemaNamespace')?.textContent?.trim() || '',
  }));
}

// ── Topic parser ───────────────────────────────────────────────────
async function parseTopic(xmlString, folder, zip) {
  const doc     = parseXml(xmlString);
  const topicEl = doc.querySelector('Topic');
  const srEl    = topicEl?.querySelector('ScreenResolution');
  const screenW = parseInt(srEl?.getAttribute('Width')  || '1280', 10);
  const screenH = parseInt(srEl?.getAttribute('Height') || '1024', 10);

  let intro = null;
  const introEl = topicEl?.querySelector('IntroFrame > Bubble');
  if (introEl) { const d = extractBubbleData(introEl); if (d?.segments?.length) intro = d; }

  const frameEls = [...(topicEl?.querySelectorAll('Frames > Frame') || [])];
  const frameMap = {};

  for (const f of frameEls) {
    const id = f.getAttribute('ID'), type = f.getAttribute('Type');
    const imgName = f.querySelector('Screenshot')?.getAttribute('href') || null;
    const act = f.querySelector('Actions > Action');
    let bubble = null, hotspot = null, bubblePos = null, pointer = null;
    let evtType = null, objName = '', objType = null;

    if (act) {
      const hs = act.querySelector('Hotspots > Hotspot');
      if (hs) {
        const top = parseInt(hs.getAttribute('Top'), 10), left = parseInt(hs.getAttribute('Left'), 10);
        hotspot = { top, left, bottom: parseInt(hs.getAttribute('Bottom'), 10), right: parseInt(hs.getAttribute('Right'), 10), isNextBtn: top === 492 && left === 620 };
      }
      const ab = act.querySelector('ActionBubble');
      if (ab) {
        bubblePos = { x: parseInt(ab.getAttribute('PosX'), 10), y: parseInt(ab.getAttribute('PosY'), 10) };
        pointer   = ab.getAttribute('Pointer') || 'None';
        bubble    = extractBubbleData(ab.querySelector('Bubble'));
      }
      evtType = act.querySelector('Event')?.getAttribute('Type') || null;
      objName = act.querySelector('Object > Name')?.textContent?.trim() || '';
      objType = act.querySelector('Object > Type')?.textContent?.trim() || null;
    }

    const nextId = (act?.getAttribute('TargetFrame') || '').replace(/^\//, '') || null;

    if (!bubble?.segments?.some(s => s.type === 'line') && (evtType || objName)) {
      const hint = buildInteractionHint(evtType, objName, objType);
      if (hint) bubble = { bgColor: '#FFF3CD', segments: [{ type: 'line', segs: [{ text: hint, bold: false, italic: false, underline: false, color: null }] }], isAutoHint: true };
    }

    frameMap[id] = { id, type, imgName, bubble, hotspot, bubblePos, pointer, nextId, interaction: { evtType, objName, objType } };
  }

  const ordered = orderFrames(frameMap, frameEls[0]?.getAttribute('ID'));
  const steps = [];
  let stepNum = 0;
  for (const frame of ordered) {
    if (frame.type === 'End') continue;
    if (!frame.bubble?.segments?.length && !frame.imgName) continue;
    stepNum++;
    const imageB64 = frame.imgName ? await zipEntryToB64(zip, `${folder}/${frame.imgName}`) : null;
    steps.push({ stepNum, frameType: frame.type, imageB64, hotspot: frame.hotspot, bubble: frame.bubble, bubblePos: frame.bubblePos, pointer: frame.pointer, screenW, screenH, interaction: frame.interaction });
  }
  return { intro, steps, screenW, screenH };
}

// ── Public: inspect (manifest only) ───────────────────────────────
export async function inspectOdarc(file) {
  const zip = await JSZip.loadAsync(file);
  const mEntry = zip.file('manifest.xml');
  if (!mEntry) throw new Error('No manifest.xml found in archive');
  const docs = parseManifest(await mEntry.async('string'));
  return docs.filter(d => d.schema === 'urn:topic-v1').map(d => ({ id: d.id, title: d.title }));
}

// ── Public: full extraction ────────────────────────────────────────
export async function extractTopics(file, allowedIds = null, onProgress = null) {
  const zip = await JSZip.loadAsync(file);
  const mEntry = zip.file('manifest.xml');
  if (!mEntry) throw new Error('No manifest.xml found');
  let docs = parseManifest(await mEntry.async('string')).filter(d => d.schema === 'urn:topic-v1');
  if (allowedIds?.length) docs = docs.filter(d => allowedIds.includes(d.id));
  if (!docs.length) throw new Error('No matching topics found');

  const topics = [];
  for (const doc of docs) {
    onProgress?.(`Parsing: ${doc.title}…`);
    const tEntry = zip.file(`${doc.folder}/topic.xml`);
    if (!tEntry) continue;
    topics.push({ title: doc.title, ...await parseTopic(await tEntry.async('string'), doc.folder, zip) });
  }
  return topics;
}

// ── CSS helpers ────────────────────────────────────────────────────
function bubbleCss(step, dispW, dispH) {
  if (!step.bubblePos) return null;
  const sx = dispW / step.screenW, sy = dispH / step.screenH;
  const px = Math.round(step.bubblePos.x * sx), py = Math.round(step.bubblePos.y * sy);
  const bw = TOOLTIP_BUBBLE_W, ptr = (step.pointer || 'None').toLowerCase();
  let left, top, arrowClass;
  if      (ptr === 'topright')                       { left = Math.max(4, px - bw);      top = py;                   arrowClass = 'arrow-top-right'; }
  else if (ptr === 'topleft')                        { left = px;                         top = py;                   arrowClass = 'arrow-top-left';  }
  else if (ptr === 'righttop' || ptr === 'right')    { left = Math.max(4, px - bw - 12); top = Math.max(4, py - 20); arrowClass = 'arrow-right'; }
  else if (ptr === 'lefttop'  || ptr === 'left')     { left = px + 12;                   top = Math.max(4, py - 20); arrowClass = 'arrow-left';  }
  else                                               { left = Math.max(4, px - bw / 2);  top = Math.max(4, py - 40); arrowClass = ''; }
  return { left: Math.min(Math.max(4, left), dispW - bw - 8), top: Math.max(4, top), arrowClass, bw };
}

function hotspotCss(step, dispW, dispH) {
  if (!step.hotspot || step.hotspot.isNextBtn) return null;
  const sx = dispW / step.screenW, sy = dispH / step.screenH;
  return { left: Math.round(step.hotspot.left * sx), top: Math.round(step.hotspot.top * sy), width: Math.round((step.hotspot.right - step.hotspot.left) * sx), height: Math.round((step.hotspot.bottom - step.hotspot.top) * sy) };
}

// ── Public: print HTML ─────────────────────────────────────────────
export function generatePrintHtml(allTopics, logoB64 = null, includeTooltips = true, brandKit = null) {
  const PRIMARY      = brandKit?.primaryColor || '#FF6B18';
  const DARK         = brandKit?.accentColor  || '#25223B';
  const DARK2        = brandKit?.accentColor  ? brandKit.accentColor : '#3a3660';
  const COMPANY      = brandKit?.companyName  || 'Whatfix';
  const FOOTER_TEXT  = brandKit?.footerText   || 'Confidential';

  const DISP_W = PRINT_DISPLAY_W;
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const totalStepsAll = allTopics.reduce((n, t) => n + t.steps.length, 0);
  const docTitle = allTopics[0]?.title || 'Guide';

  const logoHtml = logoB64
    ? `<img src="${logoB64}" alt="Logo" style="height:36px;display:block;margin-bottom:32px;filter:brightness(0) invert(1);" />`
    : `<div style="font-size:20px;font-weight:800;color:#fff;letter-spacing:-.5px;margin-bottom:32px;">${escHtml(COMPANY)}</div>`;

  // ── TOC ──
  const tocRows = allTopics.map((t, i) => {
    const stepCount = t.steps.length;
    return `<div class="toc-row">
      <span class="toc-num">${i + 1}</span>
      <span class="toc-label">${escHtml(t.title)}</span>
      <span class="toc-dots"></span>
      <span class="toc-meta">${stepCount} step${stepCount !== 1 ? 's' : ''}</span>
    </div>`;
  }).join('');

  // ── Sections ──
  let figCounter = 0;
  const sections = allTopics.map((topic, ti) => {
    const DISP_H = Math.round(DISP_W * topic.screenH / topic.screenW);
    const introHtml = topic.intro?.segments?.length
      ? `<div class="intro-block"><div class="intro-icon-wrap"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="6.2" stroke="#2b7be5" stroke-width="1.3"/><path d="M7 6v4.5" stroke="#2b7be5" stroke-width="1.5" stroke-linecap="round"/><circle cx="7" cy="4" r=".85" fill="#2b7be5"/></svg></div><div class="intro-body">${segmentsToHtml(topic.intro.segments)}</div></div>`
      : '';

    const stepsHtml = topic.steps.map((step, si) => {
      figCounter++;
      const figNum = figCounter;
      const bPos = (includeTooltips && step.bubble) ? bubbleCss(step, DISP_W, DISP_H) : null;
      const hPos = includeTooltips ? hotspotCss(step, DISP_W, DISP_H) : null;
      const bgC = step.bubble?.bgColor || '#C0FFFF';
      const isHint = step.bubble?.isAutoHint;
      const hotspotEl = hPos
        ? `<div class="hs-box" style="left:${hPos.left}px;top:${hPos.top}px;width:${hPos.width}px;height:${hPos.height}px;"></div>`
        : '';
      let bubbleEl = '';
      if (bPos && step.bubble?.segments?.length) {
        const bCls = `b${ti}s${step.stepNum}`;
        const ac = bPos.arrowClass;
        const arrowCssProp = (ac === 'arrow-top-right' || ac === 'arrow-top-left') ? `border-bottom-color:${bgC}` : ac === 'arrow-right' ? `border-left-color:${bgC}` : ac === 'arrow-left' ? `border-right-color:${bgC}` : '';
        const arrowSt = arrowCssProp ? `<style>.${bCls}::after{${arrowCssProp}!important}</style>` : '';
        const hintIconHtml = isHint ? '<span class="hint-icon"><svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M1.5 1L9 4.5 5 5.2 4.3 9z" fill="#777" stroke="#555" stroke-width=".4" stroke-linejoin="round"/></svg></span>' : '';
        bubbleEl = `${arrowSt}<div class="bubble ${bCls} ${ac}${isHint ? ' hint' : ''}" style="left:${bPos.left}px;top:${bPos.top}px;width:${bPos.bw}px;background:${bgC};">${hintIconHtml}${segmentsToHtml(step.bubble.segments)}</div>`;
      }
      // DKP element highlights
      let dkpElementsHtml = '';
      if (includeTooltips && step.elements?.length) {
        const sx = DISP_W / step.screenW, sy = DISP_H / step.screenH;
        dkpElementsHtml = step.elements.filter(e => e.type !== 'image' && e.size.width > 8 && e.size.height > 8).map((e, ei) => {
          const l = Math.round(e.position.x * sx), t = Math.round(e.position.y * sy);
          const ew = Math.round(e.size.width * sx), eh = Math.round(e.size.height * sy);
          if (l < 0 || t < 0 || ew < 8 || eh < 8) return '';
          const isNav = e.actions?.length > 0 || e.interactive;
          const borderColor = isNav ? '#FF6B18' : '#3b82f6';
          const bg = isNav ? 'rgba(255,107,24,.08)' : 'rgba(59,130,246,.06)';
          const badge = isNav ? `<div style="position:absolute;top:-7px;right:-7px;min-width:14px;height:14px;border-radius:99px;background:#FF6B18;color:#fff;font-size:8px;font-weight:700;display:flex;align-items:center;justify-content:center;padding:0 2px;">${ei + 1}</div>` : '';
          return `<div style="position:absolute;left:${l}px;top:${t}px;width:${ew}px;height:${eh}px;border:1.5px solid ${borderColor};border-radius:2px;background:${bg};">${badge}</div>`;
        }).join('');
      }
      const imgEl = step.imageB64
        ? `<img src="${step.imageB64}" width="${DISP_W}" height="${DISP_H}" />`
        : `<div style="width:${DISP_W}px;height:${DISP_H}px;background:#f3f4f6;display:flex;align-items:center;justify-content:center;color:#9ca3af;font-size:11px;">No screenshot</div>`;
      const figCaption = `<div class="fig-caption">Figure ${figNum}${step.slideTitle ? ' — ' + escHtml(step.slideTitle) : ''}</div>`;
      // Instruction box (caption)
      const instrHtml = (step.bubble?.segments?.length)
        ? `<div class="instr-box${isHint ? ' instr-hint' : ''}">
            <div class="instr-icon">${isHint
              ? '<svg width="12" height="12" viewBox="0 0 10 10" fill="none"><path d="M1.5 1L9 4.5 5 5.2 4.3 9z" fill="#f59e0b" stroke="#e08a00" stroke-width=".4" stroke-linejoin="round"/></svg>'
              : '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 1L7.5 4.5H11L8.25 6.75L9.25 10.5L6 8.25L2.75 10.5L3.75 6.75L1 4.5H4.5Z" stroke="#FF6B18" stroke-width="1" stroke-linejoin="round"/></svg>'
            }</div>
            <div class="instr-body">${segmentsToHtml(step.bubble.segments)}</div>
          </div>`
        : '';
      // Branch pills
      const branches = step.navigation?.branches;
      const branchHtml = (branches?.length > 0)
        ? `<div class="branch-row"><span class="branch-label">Leads to:</span>${branches.map(b => `<span class="branch-tag"><svg width="9" height="9" viewBox="0 0 9 9" fill="none" style="vertical-align:middle;margin-right:2px;"><path d="M2 4.5h5M5 2l2 2.5L5 7" stroke="#92400e" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>${escHtml((b.targetTitle || b.label || 'Linked Slide').slice(0, 55))}</span>`).join('')}</div>`
        : '';
      // Step header bar
      const stepMeta = `STEP ${step.stepNum} OF ${topic.steps.length}`;
      const stepTitle = step.slideTitle ? escHtml(step.slideTitle) : `Step ${step.stepNum}`;
      return `<div class="step-card">
        <div class="step-header">
          <div class="step-badge">${step.stepNum}</div>
          <div class="step-title-group">
            <div class="step-title">${stepTitle}</div>
            <div class="step-counter">${stepMeta}</div>
          </div>
        </div>
        <div class="step-body">
          <div class="fig-wrap">
            <div class="sc" style="width:${DISP_W}px;height:${DISP_H}px;">${imgEl}${hotspotEl}${bubbleEl}${dkpElementsHtml}</div>
            ${figCaption}
          </div>
          ${instrHtml}${branchHtml}
        </div>
      </div>`;
    }).join('');

    // Navigation Flow table (DKP)
    let flowHtml = '';
    if (topic.isDkpFlow) {
      const branchSteps = topic.steps.filter(s => s.navigation?.branches?.length);
      if (branchSteps.length) {
        const rows = branchSteps.map(s => {
          const targets = s.navigation.branches.map(b => {
            const name = (b.targetTitle || b.label || 'Linked Slide').slice(0, 55);
            return `<span class="flow-target-tag">${escHtml(name)}</span>`;
          }).join('');
          return `<tr><td class="flow-td flow-td-num">${s.stepNum}</td><td class="flow-td flow-td-slide">${escHtml(s.slideTitle || '')}</td><td class="flow-td flow-td-leads">${targets}</td></tr>`;
        }).join('');
        flowHtml = `<div class="flow-section">
          <div class="flow-heading">
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><circle cx="2.5" cy="2.5" r="1.8" stroke="#6b7280" stroke-width="1.1"/><circle cx="10.5" cy="6.5" r="1.8" stroke="#6b7280" stroke-width="1.1"/><circle cx="2.5" cy="10.5" r="1.8" stroke="#6b7280" stroke-width="1.1"/><path d="M4.2 3l5 3M4.2 10l5-3" stroke="#9ca3af" stroke-width="1"/></svg>
            Navigation Flow
          </div>
          <table class="flow-table">
            <thead><tr><th class="flow-th">Step</th><th class="flow-th">Slide</th><th class="flow-th">Leads To</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
      }
    }

    const sectionBreak = ti > 0 ? ' page-break' : '';
    return `<div class="topic-section${sectionBreak}">
      <div class="section-header">
        <div class="section-accent"></div>
        <div class="section-inner">
          <span class="section-num">${ti + 1}</span>
          <h2 class="section-title">${escHtml(topic.title)}</h2>
          <span class="section-steps-count">${topic.steps.length} step${topic.steps.length !== 1 ? 's' : ''}</span>
        </div>
      </div>
      ${introHtml}${stepsHtml}${flowHtml}
    </div>`;
  }).join('');

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<title>${escHtml(docTitle)}</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;}
  body{font-family:'Segoe UI',system-ui,Arial,sans-serif;font-size:11px;color:#1e293b;background:#fff;line-height:1.55;padding-bottom:72px;}

  /* ── Print action bar ── */
  .print-bar{position:fixed;bottom:0;left:0;right:0;padding:11px 24px;background:#25223B;display:flex;align-items:center;justify-content:space-between;gap:12px;z-index:9999;border-top:2.5px solid #FF6B18;}
  .print-bar span{color:#c8cdd9;font-size:11.5px;}
  .print-btn{background:#FF6B18;color:#fff;border:none;border-radius:5px;padding:8px 22px;font-size:12.5px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:7px;letter-spacing:.1px;}
  .print-btn:hover{background:#e05a0d;}
  /* ── @page: 14 mm top/bottom margins give every page consistent breathing room.     */
  /*    position:fixed running bars cannot create per-page spacing (they only affect   */
  /*    the first page), so we hide them and let @page margins do the job.             */
  @page{size:A4 portrait;margin:14mm 15mm 12mm 15mm;}
  @media print{
    .print-bar{display:none!important;}
    /* @page margins handle all spacing — no extra body padding needed */
    body{margin:0!important;padding:0!important;}
    /* Fixed header/footer are replaced by @page margins — hide them */
    .run-header,.run-footer{display:none!important;}
    /* Explicit page breaks between topics */
    .page-break{page-break-before:always;break-before:page;}
    /* Cover always on its own page */
    .cover{overflow:visible!important;page-break-after:always;break-after:page;}
    /* ── Page-break control ────────────────────────────────────────────────────── */
    /* overflow:hidden on these elements prevents break-inside:avoid from working   */
    /* in Chromium — clear it for print so the browser can honour the hint.         */
    .step-card{break-inside:avoid;page-break-inside:avoid;overflow:visible!important;box-shadow:none!important;}
    .sc{overflow:visible!important;box-shadow:none!important;}
    .section-header{break-after:avoid;page-break-after:avoid;overflow:visible!important;}
    .flow-section{break-inside:avoid;page-break-inside:avoid;overflow:visible!important;}
    /* Keep header glued to its screenshot */
    .step-header{break-after:avoid;page-break-after:avoid;}
    /* Keep screenshot + caption in one block */
    .fig-wrap{break-inside:avoid;page-break-inside:avoid;}
    /* Keep instruction, branch, intro, toc, and flow blocks intact */
    .instr-box,.branch-row,.intro-block,.toc{break-inside:avoid;page-break-inside:avoid;}
  }
  .run-header{display:none;position:fixed;top:0;left:0;right:0;height:32px;background:#fff;border-bottom:1px solid #e2e8f0;z-index:100;padding:0 36px;align-items:center;justify-content:space-between;}
  .run-header-left{font-size:8.5px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.6px;}
  .run-header-right{font-size:8.5px;color:#94a3b8;}
  .run-footer{display:none;position:fixed;bottom:0;left:0;right:0;height:28px;border-top:1px solid #e2e8f0;background:#fff;z-index:100;padding:0 36px;display:flex;align-items:center;justify-content:space-between;}
  .run-footer-left{font-size:8px;color:#94a3b8;}
  .run-footer-right{font-size:8px;color:#94a3b8;}

  /* ── Cover page ── */
  .cover{background:linear-gradient(145deg,#3a3660 0%,#25223B 60%,#1a1830 100%);color:#fff;padding:56px 48px 52px;margin-bottom:0;min-height:300px;position:relative;overflow:hidden;}
  .cover::before{content:'';position:absolute;top:-60px;right:-80px;width:320px;height:320px;border-radius:50%;background:rgba(255,107,24,.07);pointer-events:none;}
  .cover::after{content:'';position:absolute;bottom:-40px;left:-40px;width:200px;height:200px;border-radius:50%;background:rgba(255,255,255,.03);pointer-events:none;}
  .cover-eyebrow{font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#FF6B18;margin-bottom:14px;}
  .cover-title{font-size:30px;font-weight:800;line-height:1.18;margin-bottom:6px;color:#fff;max-width:600px;}
  .cover-divider{width:48px;height:3px;background:#FF6B18;border-radius:2px;margin:18px 0;}
  .cover-meta-table{border-collapse:collapse;margin-top:4px;}
  .cover-meta-table td{font-size:10.5px;padding:3px 16px 3px 0;color:rgba(255,255,255,.75);vertical-align:top;}
  .cover-meta-table td:first-child{font-weight:600;color:rgba(255,255,255,.45);font-size:9px;letter-spacing:.5px;text-transform:uppercase;white-space:nowrap;padding-right:12px;}

  /* ── Table of contents ── */
  .toc{padding:24px 48px 28px;border-bottom:1px solid #e5e7eb;background:#fafbfc;}
  .toc-heading{font-size:11px;font-weight:700;color:#25223B;text-transform:uppercase;letter-spacing:1.2px;border-bottom:2px solid #FF6B18;display:inline-block;padding-bottom:4px;margin-bottom:14px;}
  .toc-row{display:flex;align-items:center;gap:10px;padding:5px 0;font-size:11px;color:#374151;}
  .toc-num{width:20px;height:20px;background:#FF6B18;color:#fff;border-radius:50%;font-size:9px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
  .toc-label{flex:1;color:#1e293b;font-weight:500;}
  .toc-dots{flex:1;border-bottom:1.5px dotted #d1d5db;margin:0 8px;min-width:20px;}
  .toc-meta{font-size:10px;color:#94a3b8;white-space:nowrap;}

  /* ── Section header ── */
  .topic-section{padding:0 0 28px;}
  .section-header{display:flex;align-items:stretch;margin-bottom:18px;overflow:hidden;border-radius:5px;}
  .section-accent{width:5px;background:#FF6B18;flex-shrink:0;}
  .section-inner{display:flex;align-items:center;gap:12px;background:linear-gradient(90deg,#25223B,#3a3660);padding:12px 20px;flex:1;}
  .section-num{width:28px;height:28px;border:2px solid rgba(255,107,24,.6);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#fff;flex-shrink:0;}
  .section-title{font-size:14px;font-weight:700;color:#fff;flex:1;line-height:1.3;}
  .section-steps-count{font-size:9.5px;color:rgba(255,255,255,.45);white-space:nowrap;}

  /* ── Intro block ── */
  .intro-block{display:flex;gap:10px;align-items:flex-start;background:#f0f7ff;border-left:3px solid #2b7be5;border-radius:0 4px 4px 0;padding:10px 14px;margin:0 0 16px;font-size:11px;color:#1a3a5c;line-height:1.6;}
  .intro-icon-wrap{flex-shrink:0;margin-top:1px;}.intro-body{flex:1;}

  /* ── Step card ── */
  .step-card{border:1px solid #e2e8f0;border-radius:6px;margin-bottom:20px;overflow:hidden;break-inside:avoid;box-shadow:0 1px 4px rgba(0,0,0,.05);}
  .step-header{display:flex;align-items:center;gap:0;background:#f8f9fb;border-bottom:1px solid #e2e8f0;}
  .step-badge{width:40px;min-height:40px;background:#FF6B18;color:#fff;font-size:13px;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
  .step-title-group{display:flex;align-items:baseline;justify-content:space-between;flex:1;padding:9px 14px;gap:10px;}
  .step-title{font-size:12px;font-weight:700;color:#1e293b;line-height:1.3;flex:1;}
  .step-counter{font-size:9px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;white-space:nowrap;}
  .step-body{padding:14px 16px 12px;}

  /* ── Screenshot figure ── */
  .fig-wrap{margin-bottom:10px;}
  .sc{position:relative;overflow:hidden;border:1px solid #d1d5db;border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,.08);}
  .sc img{display:block;width:100%;height:100%;object-fit:contain;background:#f8f9fb;}
  .fig-caption{font-size:9px;color:#94a3b8;margin-top:4px;padding-left:2px;font-style:italic;}

  /* ── Hotspot & bubble overlays ── */
  .hs-box{position:absolute;border:2.5px solid #FF6B18;border-radius:3px;box-shadow:0 0 0 3px rgba(255,107,24,.22);}
  .bubble{position:absolute;border-radius:5px;padding:7px 10px;font-size:10px;line-height:1.55;color:#111;box-shadow:0 2px 10px rgba(0,0,0,.22);border:1px solid rgba(0,0,0,.12);}
  .bubble.hint{border:1.5px dashed rgba(0,0,0,.2);}
  .hint-icon{margin-right:4px;vertical-align:middle;}
  .bubble::after{content:'';position:absolute;border:7px solid transparent;}
  .arrow-top-right::after{top:-14px;right:12px;}.arrow-top-left::after{top:-14px;left:12px;}.arrow-right::after{right:-14px;top:10px;}.arrow-left::after{left:-14px;top:10px;}

  /* ── Instruction box ── */
  .instr-box{display:flex;gap:10px;align-items:flex-start;background:#fffaf7;border-left:3px solid #FF6B18;border-radius:0 4px 4px 0;padding:9px 12px;margin-bottom:8px;font-size:11px;color:#374151;line-height:1.6;}
  .instr-box.instr-hint{background:#fffbf0;border-left-color:#f59e0b;}
  .instr-icon{flex-shrink:0;margin-top:1px;}
  .instr-body{flex:1;}

  /* ── Branch pills ── */
  .branch-row{display:flex;flex-wrap:wrap;align-items:center;gap:5px;margin-top:4px;}
  .branch-label{font-size:9.5px;font-weight:600;color:#6b7280;margin-right:2px;text-transform:uppercase;letter-spacing:.4px;}
  .branch-tag{font-size:10px;color:#92400e;background:#fff7ed;border:1px solid #fed7aa;border-radius:99px;padding:2px 9px;white-space:nowrap;display:inline-flex;align-items:center;}

  /* ── Navigation Flow table ── */
  .flow-section{margin:24px 0 8px;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden;break-inside:avoid;}
  .flow-heading{background:#f8f9fb;border-bottom:1px solid #e5e7eb;padding:8px 14px;font-size:11px;font-weight:700;color:#374151;display:flex;align-items:center;gap:7px;}
  .flow-table{width:100%;border-collapse:collapse;}
  .flow-th{padding:6px 12px;font-size:9.5px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;background:#f8f9fb;border-bottom:1px solid #e5e7eb;text-align:left;}
  .flow-td{padding:7px 12px;font-size:10.5px;color:#1f2937;border-bottom:1px solid #f0f0f0;vertical-align:top;}
  .flow-td:last-child{border-right:none;}
  tr:last-child .flow-td{border-bottom:none;}
  .flow-td-num{width:52px;font-weight:700;color:#FF6B18;text-align:center;border-right:1px solid #f0f0f0;}
  .flow-td-slide{width:200px;border-right:1px solid #f0f0f0;}
  .flow-target-tag{display:inline-flex;align-items:center;gap:3px;font-size:10px;color:#1d4ed8;background:#eff6ff;border:1px solid #bfdbfe;border-radius:4px;padding:2px 8px;margin:2px 3px 2px 0;white-space:nowrap;}
  .flow-target-tag::before{content:'→';color:#3b82f6;font-weight:700;margin-right:2px;}
</style>
<style>
  /* Brand Kit overrides */
  .section-accent{background:${PRIMARY}!important;}
  .toc-num{background:${PRIMARY}!important;}
  .step-badge{background:${PRIMARY}!important;}
  .hs-box{border-color:${PRIMARY}!important;box-shadow:0 0 0 3px ${PRIMARY}33!important;}
  .instr-box{border-left-color:${PRIMARY}!important;}
  .flow-td-num{color:${PRIMARY}!important;}
  .cover-divider{background:${PRIMARY}!important;}
  .section-inner{background:linear-gradient(90deg,${DARK},${DARK2})!important;}
  .cover{background:linear-gradient(150deg,${DARK} 60%,${DARK2})!important;}
  .print-btn{background:${PRIMARY}!important;}
</style>
</head><body>

<div class="run-header" aria-hidden="true">
  <span class="run-header-left">${escHtml(docTitle)}</span>
  <span class="run-header-right">Version 1.0 &nbsp;·&nbsp; ${dateStr}</span>
</div>
<div class="run-footer" aria-hidden="true">
  <span class="run-footer-left">${escHtml(COMPANY)} &mdash; Standard Operating Procedure</span>
  <span class="run-footer-right">${escHtml(FOOTER_TEXT)}</span>
</div>

<div class="print-bar">
  <span>Open your browser&rsquo;s <strong>Print</strong> dialog &rarr; choose <strong>Save as PDF</strong>.</span>
  <button class="print-btn" onclick="window.print()">
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 5V2h8v3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><rect x="1" y="5" width="12" height="6" rx="1" stroke="currentColor" stroke-width="1.2"/><path d="M3 9h8v4H3z" stroke="currentColor" stroke-width="1.2"/><circle cx="11.5" cy="7.5" r=".6" fill="currentColor"/></svg>
    Print / Save PDF
  </button>
</div>

<!-- Cover -->
<div class="cover">
  ${logoHtml}
  <div class="cover-eyebrow">Standard Operating Procedure</div>
  <div class="cover-title">${escHtml(docTitle)}</div>
  <div class="cover-divider"></div>
  <table class="cover-meta-table">
    <tr><td>Date</td><td>${dateStr}</td></tr>
    <tr><td>Version</td><td>1.0</td></tr>
    <tr><td>Sections</td><td>${allTopics.length}</td></tr>
    <tr><td>Total Steps</td><td>${totalStepsAll}</td></tr>
  </table>
</div>

<!-- Table of Contents -->
${allTopics.length > 0 ? `<div class="toc"><div class="toc-heading">Contents</div>${tocRows}</div>` : ''}

<!-- Sections -->
${sections}

</body></html>`;
}

// ── Public: structured PDF via pdfmake ────────────────────────────
export async function generatePdf(topics, docTitle, logoB64 = null, includeTooltips = true, brandKit = null) {
  const [{ default: pdfMake }, { default: pdfFonts }] = await Promise.all([
    import('pdfmake/build/pdfmake'),
    import('pdfmake/build/vfs_fonts'),
  ]);
  pdfMake.vfs = pdfFonts.pdfMake?.vfs ?? pdfFonts;

  const ORANGE    = brandKit?.primaryColor || '#FF6B18';
  const COVER_BG  = brandKit?.accentColor  || '#25223B';
  const DARK      = '#1f2937';
  const GRAY      = '#6b7280';
  const BLUE   = '#1d4ed8';

  const FONTS = {
    Roboto: {
      normal:      'Roboto-Regular.ttf',
      bold:        'Roboto-Medium.ttf',
      italics:     'Roboto-Italic.ttf',
      bolditalics: 'Roboto-MediumItalic.ttf',
    },
  };

  // Shared border layout helpers
  const noBorder   = [false, false, false, false];
  const bottomOnly = [false, false, false, true];

  function noLines() {
    return { hLineWidth: () => 0, vLineWidth: () => 0, paddingLeft: () => 0, paddingRight: () => 0, paddingTop: () => 0, paddingBottom: () => 0 };
  }
  function hairlines(color = '#e5e7eb') {
    return { hLineWidth: () => 0.5, vLineWidth: () => 0.5, hLineColor: () => color, vLineColor: () => color, paddingLeft: () => 0, paddingRight: () => 0, paddingTop: () => 0, paddingBottom: () => 0 };
  }

  // Rich-text segments → pdfmake inline array
  function richText(segments) {
    if (!segments?.length) return '';
    const parts = [];
    for (const seg of segments) {
      if (seg.type === 'br') { parts.push('\n'); continue; }
      for (const s of (seg.segs || [])) {
        if (!s.text) continue;
        const p = { text: s.text };
        if (s.bold)      p.bold       = true;
        if (s.italic)    p.italics    = true;
        if (s.underline) p.decoration = 'underline';
        if (s.color)     p.color      = s.color;
        parts.push(p);
      }
    }
    return parts.length ? parts : '';
  }

  // Orange-accented caption block — fillColor auto-sizes the stripe with content height
  function captionBlock(rt) {
    return {
      table: {
        widths: [4, '*'],
        dontBreakRows: true,
        body: [[
          { border: noBorder, fillColor: ORANGE, text: '' },
          { border: noBorder, fillColor: '#fafafa', text: rt, fontSize: 10, color: DARK, margin: [8, 6, 8, 6], lineHeight: 1.5 },
        ]],
      },
      layout: noLines(),
      margin: [0, 0, 0, 6],
    };
  }

  // Blue-accented intro block — fillColor auto-sizes the stripe with content height
  function introBlock(rt) {
    return {
      table: {
        widths: [4, '*'],
        dontBreakRows: true,
        body: [[
          { border: noBorder, fillColor: '#2b7be5', text: '' },
          { border: noBorder, fillColor: '#f0f7ff', text: rt, fontSize: 10, color: '#1a3a5c', margin: [8, 7, 8, 7], lineHeight: 1.55 },
        ]],
      },
      layout: noLines(),
      margin: [0, 0, 0, 14],
    };
  }

  // Screenshot in a hairline-bordered container
  // Uses widths: ['*'] so pdfmake computes available width from its context — avoids
  // overflow when nested inside the step-card table.  fit: [maxW, maxH] lets pdfmake
  // scale from the image's actual pixel dimensions, maintaining true aspect ratio.
  function screenshotBlock(imageB64) {
    const maxW = 509;  // 515 content width − 2×3 pt for hairline borders + cell padding
    const maxH = 340;
    return {
      table: {
        widths: ['*'],
        dontBreakRows: true,
        body: [[{
          image: imageB64,
          fit: [maxW, maxH],
          alignment: 'center',
          border: noBorder,
          margin: [3, 3, 3, 3],
        }]],
      },
      layout: hairlines('#d1d5db'),
      margin: [0, 4, 0, 4],
    };
  }

  // Step header row: coloured badge + slide title on a tinted bar
  function stepHeader(stepNum, totalSteps, slideTitle) {
    const badge = { text: `${stepNum}`, bold: true, fontSize: 9, color: '#fff', fillColor: ORANGE, border: noBorder, alignment: 'center', margin: [8, 5, 8, 5] };
    const titleCell = {
      border: noBorder, fillColor: '#f8f9fa',
      columns: [
        { text: slideTitle || `Step ${stepNum}`, bold: true, fontSize: 10, color: DARK },
        { text: `${stepNum} / ${totalSteps}`, fontSize: 8, color: GRAY, alignment: 'right' },
      ],
      margin: [8, 5, 8, 5],
    };
    return {
      table: { widths: ['auto', '*'], body: [[badge, titleCell]] },
      layout: noLines(),
      margin: [0, 0, 0, 0],
    };
  }

  // DKP branch pills row
  function branchRow(branches) {
    const pills = branches.map(b => ({
      text: ` → ${(b.targetTitle || b.label || 'Linked Slide').slice(0, 45)} `,
      fontSize: 9, color: '#92400e', background: '#fff7ed',
    }));
    return { text: pills, margin: [0, 6, 0, 0], lineHeight: 1.8 };
  }

  // Topic section header: orange stripe + numbered circle + dark bar + title
  function topicHeader(title, idx) {
    const numCell  = { text: `${idx + 1}`, bold: true, fontSize: 10, color: '#fff', fillColor: ORANGE, border: noBorder, alignment: 'center', margin: [10, 8, 10, 8] };
    const titleCell = { text: title, bold: true, fontSize: 13, color: '#fff', fillColor: COVER_BG, border: noBorder, margin: [8, 8, 8, 8] };
    return {
      table: { widths: ['auto', '*'], body: [[numCell, titleCell]] },
      layout: noLines(),
      margin: [0, 0, 0, 14],
    };
  }

  // Navigation Flow table (DKP)
  function navFlowTable(branchSteps) {
    const headerRow = [
      { text: 'Step', bold: true, fontSize: 9, color: GRAY, fillColor: '#f3f4f6', border: bottomOnly },
      { text: 'Slide', bold: true, fontSize: 9, color: GRAY, fillColor: '#f3f4f6', border: bottomOnly },
      { text: 'Leads To', bold: true, fontSize: 9, color: GRAY, fillColor: '#f3f4f6', border: bottomOnly },
    ];
    const rows = branchSteps.map(s => [
      { text: `${s.stepNum}`, bold: true, fontSize: 9, color: ORANGE, border: bottomOnly, alignment: 'center' },
      { text: s.slideTitle || '', fontSize: 9, color: DARK, border: bottomOnly },
      {
        ul: s.navigation.branches.map(b => ({ text: b.targetTitle || b.label || 'Linked Slide', fontSize: 9, color: BLUE })),
        border: bottomOnly,
      },
    ]);
    return {
      table: { widths: [30, 180, '*'], headerRows: 1, body: [headerRow, ...rows] },
      layout: {
        hLineWidth: (i, node) => (i === 0 || i === node.table.body.length) ? 0 : 0.5,
        vLineWidth: () => 0,
        hLineColor: () => '#e5e7eb',
        paddingLeft: (i) => i === 0 ? 4 : 8,
        paddingRight: () => 8,
        paddingTop: () => 5,
        paddingBottom: () => 5,
      },
      margin: [0, 0, 0, 20],
    };
  }

  // ── Build content ───────────────────────────────────────────────
  const content = [];

  // Cover (rendered on dark background via doc.background)
  content.push({
    stack: [
      logoB64 ? { image: logoB64, width: 100, margin: [0, 0, 0, 28] } : { text: 'Whatfix', fontSize: 22, bold: true, color: '#fff', margin: [0, 0, 0, 28] },
      { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 3, lineColor: ORANGE }], margin: [0, 0, 0, 24] },
      { text: docTitle, fontSize: 30, bold: true, color: '#fff', lineHeight: 1.2, margin: [0, 0, 0, 12] },
      { text: `Generated ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`, fontSize: 10, color: '#94a3b8', margin: [0, 0, 0, 36] },
      ...(topics.length > 1 ? [
        { text: 'Contents', fontSize: 12, bold: true, color: ORANGE, margin: [0, 0, 0, 10] },
        ...topics.map((t, i) => ({
          table: { widths: ['auto', '*'], body: [[
            { text: `${i + 1}`, bold: true, fontSize: 9, color: '#fff', fillColor: ORANGE, border: noBorder, alignment: 'center', margin: [6, 3, 6, 3] },
            { text: t.title, fontSize: 11, color: '#e2e8f0', border: noBorder, margin: [8, 2, 0, 2] },
          ]]},
          layout: noLines(),
          margin: [0, 0, 0, 6],
        })),
      ] : []),
    ],
    margin: [0, 60, 0, 0],
  });
  content.push({ text: '', pageBreak: 'after' });

  // Topics
  for (let ti = 0; ti < topics.length; ti++) {
    const topic = topics[ti];

    content.push(topicHeader(topic.title, ti));

    if (topic.intro?.segments?.length) {
      const rt = richText(topic.intro.segments);
      if (rt) content.push(introBlock(rt));
    }

    for (const step of topic.steps) {
      const stepElems = [];

      // Header
      stepElems.push(stepHeader(step.stepNum, topic.steps.length, step.slideTitle));

      // Screenshot
      if (step.imageB64) {
        stepElems.push(screenshotBlock(step.imageB64));
      }

      // Caption
      if (includeTooltips && step.bubble?.segments?.length) {
        const rt = richText(step.bubble.segments);
        if (rt) stepElems.push(captionBlock(rt));
      }

      // DKP branches
      const branches = step.navigation?.branches;
      if (branches?.length) stepElems.push(branchRow(branches));

      // Wrap the whole step in a subtle card.
      // dontBreakRows prevents pdfmake from splitting the card across pages mid-screenshot.
      // Cell border is intentionally omitted — the layout function controls all border rendering.
      content.push({
        table: {
          widths: ['*'],
          dontBreakRows: true,
          body: [[{ stack: stepElems, margin: [0, 0, 0, 0] }]],
        },
        layout: {
          hLineWidth: () => 0.5, vLineWidth: () => 0.5,
          hLineColor: () => '#e5e7eb', vLineColor: () => '#e5e7eb',
          paddingLeft: () => 0, paddingRight: () => 0, paddingTop: () => 0, paddingBottom: () => 0,
        },
        margin: [0, 0, 0, 14],
      });
    }

    // Navigation Flow (DKP)
    if (topic.isDkpFlow) {
      const branchSteps = topic.steps.filter(s => s.navigation?.branches?.length);
      if (branchSteps.length) {
        content.push({ canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.5, lineColor: '#e5e7eb' }], margin: [0, 4, 0, 10] });
        content.push({ text: 'Navigation Flow', fontSize: 11, bold: true, color: DARK, margin: [0, 0, 0, 6] });
        content.push(navFlowTable(branchSteps));
      }
    }

    if (ti < topics.length - 1) content.push({ text: '', pageBreak: 'after' });
  }

  const dd = {
    pageSize: 'A4',
    pageMargins: [40, 60, 40, 48],
    fonts: FONTS,
    // Dark cover background on page 1 only
    background: (page, pageSize) => page !== 1 ? null : {
      canvas: [{ type: 'rect', x: 0, y: 0, w: pageSize.width, h: pageSize.height, color: COVER_BG }],
    },
    header: (page) => page <= 1 ? null : {
      table: { widths: ['*', 'auto'], body: [[
        { text: docTitle, fontSize: 8, color: GRAY, border: noBorder, margin: [40, 16, 0, 0] },
        { text: `Page ${page}`, fontSize: 8, color: GRAY, alignment: 'right', border: noBorder, margin: [0, 16, 40, 0] },
      ]]},
      layout: noLines(),
    },
    // Footer separator: use a layout-function top border rather than a canvas line.
    // The canvas approach caused a 40pt overflow because margin + x2=515 exceeded the
    // column width.  The layout hLineWidth for i===0 draws the line at the table top edge
    // and is automatically clipped to the column bounds.
    footer: (page, pages) => page <= 1 ? null : {
      margin: [40, 0, 40, 0],
      table: {
        widths: ['*', 'auto'],
        body: [[
          { text: ' ', fontSize: 8, border: noBorder },
          { text: `${page} / ${pages}`, fontSize: 8, color: '#cbd5e1', alignment: 'right', border: noBorder },
        ]],
      },
      layout: {
        hLineWidth: (i) => i === 0 ? 0.5 : 0,
        vLineWidth: () => 0,
        hLineColor: () => '#e5e7eb',
        paddingLeft: () => 0,
        paddingRight: () => 0,
        paddingTop: () => 6,
        paddingBottom: () => 0,
      },
    },
    content,
    defaultStyle: { font: 'Roboto', fontSize: 10, color: DARK, lineHeight: 1.4 },
  };

  return pdfMake.createPdf(dd).getBlob();
}

// ── Public: preview HTML ───────────────────────────────────────────
export function generatePreviewHtml(topics, docTitle, logoB64 = null) {
  const hasDkp = topics.some(t => t.isDkpFlow);
  const dkpEntry = topics.find(t => t.isDkpFlow)?.entryPointId || null;
  // For DKP, use the book caption (topic[0].title) as the cover title — the caller's
  // docTitle is built from concatenated slide names which floods the cover.
  const coverTitle = hasDkp
    ? (topics.find(t => t.isDkpFlow)?.title || docTitle || 'Interactive Simulation')
    : (docTitle || topics[0]?.title || 'Guide');
  const slides = [{ type: 'cover', title: coverTitle, topics: topics.map(t => t.title), isDkp: hasDkp, entryPointId: dkpEntry }];
  for (const topic of topics) {
    if (topic.intro?.segments?.length) slides.push({ type: 'intro', topic: topic.title, intro: topic.intro });
    for (const step of topic.steps) {
      const isDkpStep = topic.isDkpFlow || false;
      slides.push({ type: 'step', topic: topic.title, stepNum: step.stepNum, totalSteps: topic.steps.length, frameType: step.frameType, imageB64: step.imageB64, bubble: step.bubble, bubblePos: step.bubblePos, pointer: step.pointer, hotspot: step.hotspot, screenW: step.screenW, screenH: step.screenH, slideTitle: step.slideTitle || null, slideType: step.slideType || null, slideId: step.slideId || null, branches: step.navigation?.branches || null, isDkp: isDkpStep,
        // For DKP: keep any element with content or interaction regardless of size (size-less
        // controls get a fallback render size in applyOverlays). For ODARC: require min size.
        elements: step.elements?.length ? step.elements.filter(e => {
          if (e.type === 'image') return false;
          if (!e.content && !e.interactive) return false;
          if (isDkpStep) return true;
          return e.size.width > 8 && e.size.height > 8;
        }) : null });
    }
  }

  const coverLogo = logoB64
    ? `<img class="cover-logo" src="${logoB64}" alt="Whatfix" />`
    : '<div style="font-size:24px;font-weight:800;margin-bottom:28px;">Whatfix</div>';
  const tbLogo = logoB64
    ? `<img class="tb-logo" src="${logoB64}" alt="Whatfix" />`
    : '<span class="tb-name">Whatfix</span>';

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>${escHtml(docTitle || 'Preview')}</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  html,body{width:100%;height:100%;background:#0f111a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;overflow:hidden;color:#fff;}
  #app{width:100vw;height:100vh;display:flex;flex-direction:column;}
  #topbar{height:52px;flex-shrink:0;background:#1b1f2e;border-bottom:1px solid rgba(255,255,255,.08);display:flex;align-items:center;justify-content:space-between;padding:0 20px;gap:16px;}
  .tb-brand{display:flex;align-items:center;gap:10px;}.tb-logo{height:22px;display:block;filter:brightness(0) invert(1);}.tb-name{font-size:14px;font-weight:700;}
  .tb-sep{width:1px;height:20px;background:rgba(255,255,255,.15);}.tb-topic{font-size:12.5px;color:#8a92a6;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .tb-progress{display:flex;align-items:center;gap:10px;font-size:12px;color:#8a92a6;}.tb-bar{width:120px;height:3px;background:rgba(255,255,255,.12);border-radius:2px;overflow:hidden;}.tb-bar-fill{height:100%;background:#FF6B18;border-radius:2px;transition:width .3s ease;}
  #stage{flex:1;display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden;padding:16px 80px;}
  #screenshot-container{position:relative;overflow:hidden;border-radius:6px;box-shadow:0 20px 60px rgba(0,0,0,.6);max-width:100%;max-height:100%;transition:opacity .18s ease,transform .18s ease;}
  #screenshot-img{display:block;max-width:100%;max-height:100%;height:auto;}
  .hotspot-box{position:absolute;border:2.5px solid #FF6B18;border-radius:4px;pointer-events:none;animation:pulseHS 1.8s ease-in-out infinite;}
  @keyframes pulseHS{0%,100%{box-shadow:0 0 0 2px rgba(255,107,24,.6),0 0 0 6px rgba(255,107,24,.2);}50%{box-shadow:0 0 0 4px rgba(255,107,24,.8),0 0 0 10px rgba(255,107,24,.1);}}
  .tooltip-bubble{position:absolute;width:280px;border-radius:6px;padding:10px 13px;font-size:12px;line-height:1.6;color:#111;box-shadow:0 4px 20px rgba(0,0,0,.35);border:1px solid rgba(0,0,0,.15);animation:bubbleIn .25s ease;cursor:grab;user-select:none;}
  .tooltip-bubble:active,.tooltip-bubble.dragging{cursor:grabbing;box-shadow:0 8px 28px rgba(0,0,0,.45);opacity:.95;}
  .bubble-drag-handle{display:flex;justify-content:center;margin-bottom:6px;opacity:.35;pointer-events:none;line-height:1;}
  @keyframes bubbleIn{from{opacity:0;transform:scale(.93);}to{opacity:1;transform:scale(1);}}
  .tooltip-bubble.hint-bubble{border:1.5px dashed rgba(0,0,0,.25)!important;font-style:italic;}.hint-icon{margin-right:5px;font-style:normal;}
  .tooltip-bubble::after{content:'';position:absolute;border:8px solid transparent;}
  .tooltip-bubble.arrow-top-right::after{top:-16px;right:16px;border-bottom-width:8px;}.tooltip-bubble.arrow-top-left::after{top:-16px;left:16px;border-bottom-width:8px;}
  .tooltip-bubble.arrow-right::after{right:-16px;top:14px;border-left-width:8px;}.tooltip-bubble.arrow-left::after{left:-16px;top:14px;border-right-width:8px;}
  .cover-slide{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:40px;min-width:500px;}
  .cover-logo{height:44px;display:block;margin-bottom:28px;filter:brightness(0) invert(1);}
  .cover-slide h1{font-size:26px;font-weight:700;line-height:1.3;max-width:520px;margin-bottom:16px;}
  .cover-slide .toc-list{list-style:none;margin-top:20px;}.cover-slide .toc-list li{display:flex;align-items:center;gap:10px;padding:6px 0;font-size:13px;color:#c8cdd9;border-bottom:1px solid rgba(255,255,255,.07);}
  .cover-slide .toc-num{width:22px;height:22px;background:rgba(255,107,24,.2);border:1px solid #FF6B18;color:#FF6B18;border-radius:50%;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
  .cover-btn{margin-top:28px;background:#FF6B18;color:#fff;border:none;border-radius:6px;padding:11px 28px;font-size:14px;font-weight:600;cursor:pointer;}.cover-btn:hover{background:#e05a0d;}
  .intro-slide{max-width:540px;padding:32px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:10px;}
  .intro-slide .topic-pill{display:inline-block;background:rgba(255,107,24,.15);color:#FF6B18;border:1px solid rgba(255,107,24,.3);padding:3px 10px;border-radius:99px;font-size:11px;font-weight:600;margin-bottom:14px;}
  .intro-slide h2{font-size:18px;font-weight:700;margin-bottom:12px;}.intro-slide .intro-body{font-size:13px;color:#c8cdd9;line-height:1.7;}.intro-slide .intro-body strong{color:#fff;}
  .nav-arrow{position:absolute;top:50%;transform:translateY(-50%);width:44px;height:44px;border-radius:50%;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);color:#fff;cursor:pointer;font-size:18px;display:flex;align-items:center;justify-content:center;transition:all .15s;z-index:20;}
  .nav-arrow:hover{background:rgba(255,255,255,.16);}.nav-arrow:disabled{opacity:.2;cursor:not-allowed;}#nav-prev{left:16px;}#nav-next{right:16px;}
  #bottombar{height:56px;flex-shrink:0;background:#1b1f2e;border-top:1px solid rgba(255,255,255,.08);display:flex;align-items:center;justify-content:center;gap:8px;padding:0 20px;}
  .dot-nav{width:7px;height:7px;border-radius:50%;background:rgba(255,255,255,.2);cursor:pointer;transition:all .2s;border:none;padding:0;}.dot-nav.active{background:#FF6B18;width:22px;border-radius:4px;}.dot-nav:hover:not(.active){background:rgba(255,255,255,.4);}
  .frame-badge{position:absolute;top:10px;left:10px;font-size:10px;font-weight:600;padding:3px 8px;border-radius:99px;letter-spacing:.4px;}.frame-badge.normal{background:rgba(255,107,24,.85);color:#fff;}.frame-badge.explanation{background:rgba(43,123,229,.85);color:#fff;}
  .step-chip{position:absolute;bottom:10px;right:10px;font-size:10px;font-weight:600;padding:3px 9px;border-radius:99px;background:rgba(0,0,0,.55);color:#fff;}
  .key-hint{position:absolute;bottom:10px;left:50%;transform:translateX(-50%);font-size:10px;color:rgba(255,255,255,.3);}
  /* DKP interactive element highlights */
  .dkp-hl{position:absolute;border-radius:3px;cursor:default;transition:background .15s,border-color .15s,box-shadow .15s;z-index:10;}
  @keyframes dkpPulse{0%,100%{box-shadow:0 0 0 0 rgba(255,180,30,.5);}60%{box-shadow:0 0 0 5px rgba(255,180,30,0);}}
  .dkp-hl.dkp-nav{cursor:pointer;background:rgba(255,180,30,.12);border:1.5px solid rgba(255,180,30,.65);animation:dkpPulse 2.2s ease-out infinite;}
  .dkp-hl.dkp-nav:hover{background:rgba(255,180,30,.28);border-color:rgba(255,180,30,.95);box-shadow:0 0 0 3px rgba(255,180,30,.2);animation:none;}
  .dkp-hl.dkp-btn{cursor:pointer;background:rgba(255,107,24,.12);border:1.5px solid rgba(255,107,24,.55);}
  .dkp-hl.dkp-btn:hover{background:rgba(255,107,24,.25);border-color:rgba(255,107,24,.9);box-shadow:0 0 0 3px rgba(255,107,24,.18);}
  /* DKP side panel — absolutely positioned so it never disturbs the screenshot layout */
  #dkp-side-panel{position:absolute;right:10px;top:50%;transform:translateY(-50%);width:198px;max-height:82%;background:rgba(13,15,26,.93);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:12px 10px;display:none;flex-direction:column;gap:10px;overflow-y:auto;z-index:30;}
  #dkp-side-panel.has-content{display:flex;}
  .sp-section{display:flex;flex-direction:column;gap:5px;}
  .sp-title{font-size:9.5px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.6px;padding-bottom:4px;border-bottom:1px solid rgba(255,255,255,.06);}
  .sp-item{display:flex;align-items:center;gap:8px;padding:6px 9px;border-radius:6px;font-size:11.5px;color:#c8cdd9;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);cursor:pointer;transition:all .15s;text-decoration:none;border-left:2.5px solid rgba(59,130,246,.5);}
  .sp-item.sp-nav{border-left-color:rgba(255,107,24,.6);}
  .sp-item:hover{background:rgba(255,255,255,.09);color:#fff;border-color:rgba(255,255,255,.18);}
  .sp-item-icon{flex-shrink:0;opacity:.65;font-style:normal;}
  .sp-item-label{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.3;}
  .dkp-badge{position:absolute;top:-8px;right:-8px;min-width:16px;height:16px;border-radius:99px;font-size:9px;font-weight:700;display:flex;align-items:center;justify-content:center;padding:0 3px;pointer-events:none;z-index:12;}
  .dkp-badge.nav-badge{background:#FF6B18;color:#fff;}
  .dkp-badge.nav-badge::after{content:'→';margin-left:1px;}
  .dkp-badge.info-badge{background:rgba(59,130,246,.85);color:#fff;}
  .dkp-hl-tip{position:absolute;bottom:calc(100% + 7px);left:50%;transform:translateX(-50%);background:rgba(10,12,22,.94);color:#e5e7eb;font-size:11px;line-height:1.5;padding:6px 11px;border-radius:6px;min-width:120px;max-width:240px;text-align:center;white-space:normal;word-break:break-word;pointer-events:none;opacity:0;transition:opacity .14s;z-index:40;border:1px solid rgba(255,255,255,.1);box-shadow:0 4px 16px rgba(0,0,0,.45);}
  .dkp-hl-tip .tip-action{font-size:10px;color:#FF6B18;margin-top:3px;font-weight:600;}
  .dkp-hl-tip::after{content:'';position:absolute;top:100%;left:50%;transform:translateX(-50%);border:5px solid transparent;border-top-color:rgba(10,12,22,.94);}
  .dkp-hl:hover .dkp-hl-tip{opacity:1;}
  /* ODARC step number marker */
  .hs-step-badge{position:absolute;top:-9px;left:-9px;width:18px;height:18px;border-radius:50%;background:#FF6B18;color:#fff;font-size:9px;font-weight:700;display:flex;align-items:center;justify-content:center;z-index:12;border:1.5px solid rgba(255,255,255,.7);}
  /* Paths panel — actionable navigation branches */
  #paths-panel{position:absolute;bottom:34px;left:50%;transform:translateX(-50%);display:flex;gap:6px;flex-wrap:wrap;justify-content:center;z-index:25;max-width:78%;pointer-events:auto;}
  .path-btn{background:rgba(255,107,24,.15);border:1px solid rgba(255,107,24,.5);color:#FF6B18;border-radius:6px;padding:5px 13px;font-size:11.5px;font-weight:600;cursor:pointer;transition:all .15s;white-space:nowrap;max-width:220px;overflow:hidden;text-overflow:ellipsis;}
  .path-btn:hover{background:rgba(255,107,24,.28);border-color:#FF6B18;box-shadow:0 0 0 2px rgba(255,107,24,.15);}
  .path-btn[disabled]{opacity:.38;cursor:not-allowed;}
  /* DKP app-simulation mode */
  .dkp-mode #nav-prev,.dkp-mode #nav-next{display:none!important;}
  .dkp-mode #tb-progress{display:none!important;}
  .dkp-mode #stage{padding:16px;}
  .dkp-nav-bar{display:none;align-items:center;gap:6px;}
  .dkp-nav-btn{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);color:#c8cdd9;border-radius:6px;padding:5px 12px;font-size:11.5px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:4px;transition:all .15s;white-space:nowrap;}
  .dkp-nav-btn:hover:not(:disabled){background:rgba(255,255,255,.16);color:#fff;}
  .dkp-nav-btn:disabled{opacity:.3;cursor:not-allowed;}
  .dkp-sim-badge{display:none;background:rgba(255,180,30,.15);color:#FFB41E;border:1px solid rgba(255,180,30,.3);border-radius:99px;font-size:10px;font-weight:700;padding:2px 8px;letter-spacing:.4px;white-space:nowrap;}
  .dkp-bottombar-hint{font-size:11px;color:#6b7280;text-align:center;padding:0 16px;}
  .dkp-debug{position:absolute;top:6px;right:6px;background:rgba(0,0,0,.6);color:#aaa;font-size:9px;padding:2px 6px;border-radius:4px;pointer-events:none;z-index:50;font-family:monospace;display:none;}
</style></head><body>
<div id="app">
  <div id="topbar">
    <div class="tb-brand">${tbLogo}<div class="tb-sep"></div><span class="tb-topic" id="tb-topic"></span><span class="dkp-sim-badge" id="dkp-sim-badge">Simulation</span></div>
    <div class="dkp-nav-bar" id="dkp-nav-bar">
      <button class="dkp-nav-btn" id="dkp-back-btn" onclick="dkpBack()" disabled>&#8592; Back</button>
      <button class="dkp-nav-btn" id="dkp-home-btn" onclick="dkpHome()">&#8962; Menu</button>
      <button class="dkp-nav-btn" id="dkp-cont-btn" style="display:none">Continue &#8594;</button>
    </div>
    <div class="tb-progress" id="tb-progress"><span id="tb-label"></span><div class="tb-bar"><div class="tb-bar-fill" id="tb-fill"></div></div></div>
  </div>
  <div id="stage" style="position:relative;">
    <div id="screenshot-container"></div>
    <div id="dkp-side-panel">
      <div class="sp-section" id="sp-ext-section" style="display:none">
        <div class="sp-title">&#127760; External Links</div>
        <div id="sp-ext-list"></div>
      </div>
      <div class="sp-section" id="sp-nav-section" style="display:none">
        <div class="sp-title">&#8594; Also Navigate To</div>
        <div id="sp-nav-list"></div>
      </div>
    </div>
    <button class="nav-arrow" id="nav-prev" onclick="go(-1)">&#8592;</button>
    <button class="nav-arrow" id="nav-next" onclick="go(1)">&#8594;</button>
    <div id="paths-panel"></div>
    <span class="key-hint" id="key-hint">&#8592; &#8594; to navigate</span>
    <div class="dkp-debug" id="dkp-debug"></div>
  </div>
  <div id="bottombar"></div>
</div>
<script>
const SLIDES=${JSON.stringify(slides).replace(/</g,'\\u003c').replace(/>/g,'\\u003e')};
const COVER=${JSON.stringify(coverLogo).replace(/</g,'\\u003c').replace(/>/g,'\\u003e')};
const DKP_FW=${DKP_FALLBACK_W};const DKP_FH=${DKP_FALLBACK_H};
let cur=0;

// ── DKP simulation globals ──────────────────────────────────────────
const IS_DKP=SLIDES.some(s=>s.isDkp);
const DKP_ENTRY=SLIDES[0]?.entryPointId||null;
const dkpHist=[];// history stack of slide indices for back navigation

if(IS_DKP){
  document.getElementById('app').classList.add('dkp-mode');
  document.getElementById('dkp-nav-bar').style.display='flex';
  document.getElementById('dkp-sim-badge').style.display='';
  const kh=document.getElementById('key-hint');
  if(kh)kh.textContent='Click highlighted areas to navigate \u2022 Esc to close';
}

function dkpGo(targetId){
  if(!targetId)return;
  // External URL — open in new tab, don't change slide
  if(/^https?:\\/\\//i.test(targetId)){window.open(targetId,'_blank','noopener,noreferrer');return;}
  const i=slideIdMap[targetId];
  if(i==null)return;
  dkpHist.push(cur);
  render(i);
}
function dkpBack(){
  if(!dkpHist.length)return;
  render(dkpHist.pop());
}
function dkpHome(){
  dkpHist.length=0;
  render(0);
}
function dkpStart(){
  dkpHist.length=0;
  if(DKP_ENTRY&&slideIdMap[DKP_ENTRY]!=null)render(slideIdMap[DKP_ENTRY]);
  else render(1);
}

// Make a positioned element draggable within its offset parent
function makeDraggable(el){
  el.addEventListener('mousedown',function(e){
    if(e.button!==0)return;
    e.preventDefault();
    const startX=e.clientX,startY=e.clientY;
    const origLeft=parseInt(el.style.left)||0,origTop=parseInt(el.style.top)||0;
    el.classList.add('dragging');
    // Remove arrow after first drag — position is now user-defined
    function onMove(e){
      const parent=el.offsetParent||el.parentElement;
      const pw=parent?parent.offsetWidth:window.innerWidth;
      const ph=parent?parent.offsetHeight:window.innerHeight;
      const newL=Math.max(0,Math.min(origLeft+(e.clientX-startX),pw-el.offsetWidth));
      const newT=Math.max(0,Math.min(origTop+(e.clientY-startY),ph-el.offsetHeight));
      el.style.left=newL+'px';el.style.top=newT+'px';
    }
    function onUp(){
      el.classList.remove('dragging');
      document.removeEventListener('mousemove',onMove);
      document.removeEventListener('mouseup',onUp);
    }
    document.addEventListener('mousemove',onMove);
    document.addEventListener('mouseup',onUp);
  });
}

// Detect internal DKP IDs / file paths that should never be shown to users
function isIntRef(s){return!s||/[!:]/.test(s)||/\\.(png|jpg|jpeg|gif|svg)$/i.test(s)||/^(GR_|SL_|CTL|TXT|IMG|OBJ|el_\\d)/i.test(s)||/^[A-Z0-9]{12,}$/.test(s);}
// Build slide ID → index map for non-linear DKP navigation
const slideIdMap={};
SLIDES.forEach((s,i)=>{if(s.slideId)slideIdMap[s.slideId]=i;});
function renderById(id){const i=slideIdMap[id];render(i!=null?i:cur+1);}

function h(s){if(!s)return'';return s.map(seg=>{if(seg.type==='br')return'<br>';return(seg.segs||[]).map(s=>{let t=s.text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');if(s.bold)t='<strong>'+t+'</strong>';if(s.italic)t='<em>'+t+'</em>';if(s.underline)t='<u>'+t+'</u>';if(s.color)t='<span style="color:'+s.color+'">'+t+'</span>';return t;}).join('');}).filter(Boolean).join('');}

function render(i){cur=Math.max(0,Math.min(SLIDES.length-1,i));const slide=SLIDES[cur];const c=document.getElementById('screenshot-container');c.style.opacity='0';c.style.transform='scale(0.98)';setTimeout(()=>{c.innerHTML=buildHtml(slide);applyOverlays(slide,c);c.style.opacity='1';c.style.transform='scale(1)';updateUI(slide);},180);}

function buildHtml(s){
  if(s.type==='cover'){const n=s.topics.length;let tocHtml='';if(n>1){const show=s.topics.slice(0,5);const more=n-5;tocHtml='<ul class="toc-list">'+show.map((t,i)=>'<li><span class="toc-num">'+(i+1)+'</span><span>'+t.replace(/</g,'&lt;')+'</span></li>').join('')+(more>0?'<li style="opacity:.45;font-style:italic;padding:6px 0 0 32px;font-size:12px;border-bottom:none;">+'+more+' more\u2026</li>':'')+'</ul>';}const startFn=IS_DKP?'dkpStart()':'go(1)';const startLabel=IS_DKP?'Launch Simulation \u2192':'Start \u2192';return'<div class="cover-slide">'+COVER+'<h1>'+s.title.replace(/</g,'&lt;')+'</h1>'+tocHtml+'<button class="cover-btn" onclick="'+startFn+'">'+startLabel+'</button></div>';}
  if(s.type==='intro')return'<div class="intro-slide"><span class="topic-pill">'+s.topic.replace(/</g,'&lt;')+'</span><h2>In this tutorial</h2><div class="intro-body">'+h(s.intro.segments)+'</div></div>';
  const img=s.imageB64?'<img id="screenshot-img" src="'+s.imageB64+'" draggable="false" />':'<div style="width:640px;height:480px;background:#25223B;display:flex;align-items:center;justify-content:center;color:#6b7280;">No screenshot</div>';
  // DKP simulation: slide title chip; Continue button when slide has no interactive elements
  if(s.isDkp){
    const chipLabel=(s.slideTitle||'Slide').replace(/</g,'&lt;');
    return img+'<span class="step-chip">'+chipLabel+'</span>';
  }
  const typeBadge=s.slideType?s.slideType:(s.frameType==='Explanation'?'Explanation':'Action');
  const chipLabel=s.slideTitle?s.slideTitle.replace(/</g,'&lt;'):'Step '+s.stepNum+' / '+s.totalSteps;
  return img+'<span class="frame-badge '+((s.frameType||'').toLowerCase())+'">'+typeBadge+'</span><span class="step-chip">'+chipLabel+'</span>';
}

function applyOverlays(s,c){
  if(s.type!=='step'||!s.imageB64)return;
  const img=c.querySelector('#screenshot-img');if(!img)return;
  // Disconnect any previous resize observer from a prior render
  if(c._dkpRO){c._dkpRO.disconnect();delete c._dkpRO;}
  function doOverlay(){
    // naturalWidth/naturalHeight must be available — if not, the image hasn't
    // decoded yet. Use img.decode() to defer until it's ready, then retry.
    if(!img.naturalWidth||!img.naturalHeight){
      if(img.decode)img.decode().then(doOverlay);
      else img.addEventListener('load',doOverlay,{once:true});
      return;
    }
    const dW=img.offsetWidth,dH=img.offsetHeight;if(!dW||!dH)return;
    // Element positions are in slide-canvas space (s.screenW × s.screenH).
    // Prefer the parsed canvas size; fall back to PNG natural dimensions when
    // screenW is zero or was never found in the file (left at the fallback constant).
    // Use parsed canvas dimensions when available; image natural size as fallback.
    // Previously we ignored screenW when it equalled the fallback constant — that was wrong
    // because an actual 1024-wide canvas would be treated as "no size found."
    const canvasW=(s.screenW&&s.screenW>0)?s.screenW:(img.naturalWidth||DKP_FW);
    const canvasH=(s.screenH&&s.screenH>0)?s.screenH:(img.naturalHeight||DKP_FH);
    const sx=dW/canvasW,sy=dH/canvasH;

    // ── DKP: interactive element highlight regions ─────────────────
    if(s.elements&&s.elements.length){
      c.querySelectorAll('.dkp-hl').forEach(n=>n.remove());
      // Populate side panel with external links (only on first doOverlay call, not resize)
      const spExt=document.getElementById('sp-ext-list');
      const spExtSec=document.getElementById('sp-ext-section');
      const spPanel=document.getElementById('dkp-side-panel');
      if(spExt&&!c._dkpRO){
        // Reset panel so stale content from the previous slide doesn't linger
        if(spPanel){spPanel.classList.remove('has-content');}
        if(spExtSec)spExtSec.style.display='none';
        spExt.innerHTML='';
        const extItems=[];
        for(const el of s.elements){
          const extAct=el.actions?.find(a=>/^https?:\\/\\//i.test(a.target));
          if(!extAct)continue;
          const label=(el.content&&!isIntRef(el.content)?el.content:null)||extAct.target.replace(/^https?:\\/\\//,'').replace(/\\/.*$/,'').slice(0,40);
          if(extItems.some(e=>e.url===extAct.target))continue;
          extItems.push({url:extAct.target,label});
        }
        if(extItems.length){
          for(const {url,label} of extItems){
            const a=document.createElement('a');a.className='sp-item';a.href=url;a.target='_blank';a.rel='noopener noreferrer';
            a.innerHTML='<span class="sp-item-icon">&#8599;</span><span class="sp-item-label" title="'+url+'">'+label+'</span>';
            spExt.appendChild(a);
          }
          if(spExtSec)spExtSec.style.display='';
          if(spPanel)spPanel.classList.add('has-content');
        } else {
          if(spExtSec)spExtSec.style.display='none';
        }
      }

      // ── DEBUG overlay ──────────────────────────────────────────────
      console.log('[DKP·overlay] slide',s.slideId,'elements:',s.elements.length,
        'canvasW:',canvasW,'canvasH:',canvasH,'imgNatW:',img.naturalWidth,'imgNatH:',img.naturalHeight,
        'displayW:',dW,'displayH:',dH,'sx:',sx.toFixed(3),'sy:',sy.toFixed(3));
      const _dbgSkip={posInferred:0,noAction:0,extOnly:0,badRect:0,rendered:0};
      // ──────────────────────────────────────────────────────────────

      let navIdx=0;
      for(const el of s.elements){
        if(el.positionInferred){_dbgSkip.posInferred++;console.log('  SKIP posInferred:',el.id,el.type,'actions:',el.actions?.map(a=>a.target));continue;}
        const l=Math.round(el.position.x*sx),t=Math.round(el.position.y*sy);
        let ew=Math.round(el.size.width*sx),eh=Math.round(el.size.height*sy);
        const sizeInferred=(ew<4||eh<4);
        if(sizeInferred&&(el.interactive||el.actions?.length)){ew=Math.round(140*sx);eh=Math.round(44*sy);}
        if(l<0||t<0||ew<8||eh<8){_dbgSkip.badRect++;console.log('  SKIP bad rect:',el.id,{l,t,ew,eh},'origPos:',el.position,'origSize:',el.size);continue;}

        const internalAct=el.actions?.find(a=>slideIdMap[a.target]!=null);
        const externalOnly=!internalAct&&el.actions?.length>0&&el.actions.every(a=>/^https?:\\/\\//i.test(a.target));
        if(!el.interactive&&!el.actions?.length){_dbgSkip.noAction++;continue;}
        if(externalOnly){_dbgSkip.extOnly++;continue;}

        const div=document.createElement('div');
        div.className='dkp-hl '+(internalAct?'dkp-nav':'dkp-btn');
        div.style.cssText='left:'+l+'px;top:'+t+'px;width:'+ew+'px;height:'+eh+'px;';
        div.setAttribute('role','button');div.setAttribute('tabindex','0');
        navIdx++;
        const badge=document.createElement('div');badge.className='dkp-badge nav-badge';badge.textContent=navIdx;
        div.appendChild(badge);

        const targetId=internalAct?internalAct.target:(el.actions?.[0]?.target||null);
        div.onclick=()=>{
          if(!targetId)return;
          if(/^https?:\\/\\//i.test(targetId)){window.open(targetId,'_blank','noopener,noreferrer');return;}
          if(IS_DKP)dkpGo(targetId);else renderById(targetId);
        };
        div.onkeydown=(e)=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();div.onclick();}};

        // Tooltip: destination slide title preferred, then element label
        const destTitle=internalAct?(SLIDES[slideIdMap[internalAct.target]]?.slideTitle||''):'';
        const tipLabel=destTitle||(el.content&&!isIntRef(el.content)?el.content.slice(0,120):'');
        if(tipLabel){
          const tip=document.createElement('div');tip.className='dkp-hl-tip';
          if(t<70)tip.style.cssText='top:calc(100% + 7px);bottom:auto;';
          const tn=document.createElement('div');tn.textContent=tipLabel;tip.appendChild(tn);
          const act=document.createElement('div');act.className='tip-action';act.textContent='\u2192 Click to navigate';
          tip.appendChild(act);div.appendChild(tip);
        }
        _dbgSkip.rendered++;
        c.appendChild(div);
      }
      console.log('[DKP·overlay] result — rendered:',_dbgSkip.rendered,'skipped:',
        'posInferred='+_dbgSkip.posInferred,'noAction='+_dbgSkip.noAction,
        'extOnly='+_dbgSkip.extOnly,'badRect='+_dbgSkip.badRect);
      if(typeof ResizeObserver!=='undefined'&&!c._dkpRO){
        const ro=new ResizeObserver(()=>doOverlay());
        ro.observe(img);
        c._dkpRO=ro;
      }
      return;
    }

    // ── ODARC: pulsing hotspot box with step number badge ──────────
    const hs=s.hotspot;
    if(hs&&!hs.isNextBtn){
      const el=document.createElement('div');el.className='hotspot-box';
      el.style.cssText='left:'+Math.round(hs.left*sx)+'px;top:'+Math.round(hs.top*sy)+'px;width:'+Math.round((hs.right-hs.left)*sx)+'px;height:'+Math.round((hs.bottom-hs.top)*sy)+'px;';
      el.setAttribute('role','img');el.setAttribute('aria-label','Interaction area');
      const badge=document.createElement('div');badge.className='hs-step-badge';badge.textContent=s.stepNum;
      el.appendChild(badge);
      c.appendChild(el);
    }

    // ── ODARC: floating tooltip bubble ────────────────────────────
    const bub=s.bubble,bp=s.bubblePos;
    if(bub&&bp&&bub.segments&&bub.segments.length){
      const px=Math.round(bp.x*sx),py=Math.round(bp.y*sy),bw=Math.min(280,dW*0.38),bgC=bub.bgColor||'#C0FFFF';
      let left,top,ac;const ptr=(s.pointer||'None').toLowerCase();
      if(ptr==='topright'){left=Math.max(4,px-bw);top=py;ac='arrow-top-right';}
      else if(ptr==='topleft'){left=px;top=py;ac='arrow-top-left';}
      else if(ptr==='righttop'||ptr==='right'){left=Math.max(4,px-bw-12);top=Math.max(4,py-20);ac='arrow-right';}
      else if(ptr==='lefttop'||ptr==='left'){left=px+12;top=Math.max(4,py-20);ac='arrow-left';}
      else{left=Math.max(4,px-bw/2);top=Math.max(4,py-40);ac='';}
      left=Math.max(4,Math.min(left,dW-bw-4));top=Math.max(4,Math.min(top,dH-60));
      const isHint=!!(bub.isAutoHint);
      const bEl=document.createElement('div');bEl.className='tooltip-bubble '+ac+(isHint?' hint-bubble':'');bEl.style.cssText='left:'+left+'px;top:'+top+'px;width:'+bw+'px;background:'+bgC+';';
      const cls='b'+Math.random().toString(36).slice(2,8);bEl.classList.add(cls);
      const st=document.createElement('style');
      if(ac==='arrow-top-right'||ac==='arrow-top-left')st.textContent='.'+cls+'::after{border-bottom-color:'+bgC+'!important;}';
      else if(ac==='arrow-right')st.textContent='.'+cls+'::after{border-left-color:'+bgC+'!important;}';
      else if(ac==='arrow-left')st.textContent='.'+cls+'::after{border-right-color:'+bgC+'!important;}';
      document.head.appendChild(st);
      bEl.innerHTML='<div class="bubble-drag-handle">&#8942;&#8942;&#8942;</div>'+(isHint?'<span class="hint-icon"><svg width="10" height="10" viewBox="0 0 10 10" fill="none" style="vertical-align:middle;"><path d="M1.5 1L9 4.5 5 5.2 4.3 9z" fill="#777" stroke="#555" stroke-width=".4" stroke-linejoin="round"/></svg></span>':'')+h(bub.segments);
      c.appendChild(bEl);
      makeDraggable(bEl);
    }
  }
  if(img.complete)doOverlay();else img.addEventListener('load',doOverlay,{once:true});
}

function updatePaths(s){
  const panel=document.getElementById('paths-panel');if(!panel)return;
  panel.innerHTML='';
  if(s.type!=='step'||!s.branches||!s.branches.length)return;
  for(const b of s.branches){
    const btn=document.createElement('button');btn.className='path-btn';
    const label=(b.targetTitle||b.label||'Linked Slide').trim().slice(0,60);
    btn.textContent='\u2192 '+label;
    btn.title='Go to: '+(b.label||b.target||'');
    const reachable=slideIdMap[b.target]!=null;
    if(!reachable){btn.disabled=true;btn.title='Target slide not included in current view';}
    else{btn.onclick=()=>{if(IS_DKP)dkpGo(b.target);else renderById(b.target);};}
    panel.appendChild(btn);
  }
}
function updateUI(s){
  document.getElementById('tb-topic').textContent=(s.slideTitle||s.topic)||(s.type==='cover'?s.title:'');
  const bar=document.getElementById('bottombar');bar.innerHTML='';
  if(IS_DKP){
    // Reset side panel state — applyOverlays populates ext links; we add nav links here
    const spPanel=document.getElementById('dkp-side-panel');
    const spNavSec=document.getElementById('sp-nav-section');
    const spNavList=document.getElementById('sp-nav-list');
    const spExtSec=document.getElementById('sp-ext-section');
    if(s.type!=='step'){
      // Cover/intro: hide side panel entirely
      if(spPanel){spPanel.classList.remove('has-content');}
      if(spNavSec)spNavSec.style.display='none';
      if(spExtSec)spExtSec.style.display='none';
    }
    // Clear paths-panel (path buttons removed in DKP mode)
    const pp=document.getElementById('paths-panel');if(pp)pp.innerHTML='';

    const bb=document.getElementById('dkp-back-btn');if(bb)bb.disabled=dkpHist.length===0;
    const contBtnEl=document.getElementById('dkp-cont-btn');if(contBtnEl)contBtnEl.style.display='none';
    if(s.type==='step'){
      // Count overlays that will render (mirrors applyOverlays logic)
      const navCount=s.elements?s.elements.filter(e=>{
        if(e.positionInferred)return false;
        if(!e.interactive&&!e.actions?.length)return false;
        const externalOnly=e.actions?.length>0&&e.actions.every(a=>/^https?:\\/\\//i.test(a.target));
        return !externalOnly;
      }).length:0;

      // Add unresolved branch targets to side panel nav section
      // (branches whose source element couldn't be positioned, so no overlay was drawn)
      if(spNavList&&spNavSec){
        spNavList.innerHTML='';
        // Only elements that actually rendered an overlay count as "positioned"
        const positionedTargets=new Set((s.elements||[]).filter(e=>!e.positionInferred&&(e.interactive||e.actions?.length)).flatMap(e=>e.actions?.filter(a=>slideIdMap[a.target]!=null).map(a=>a.target)||[]));
        const navBranches=(s.branches||[]).filter(b=>slideIdMap[b.target]!=null&&!positionedTargets.has(b.target));
        if(navBranches.length){
          for(const b of navBranches){
            const btn=document.createElement('button');btn.className='sp-item sp-nav';
            btn.innerHTML='<span class="sp-item-icon">&#8594;</span><span class="sp-item-label" title="'+(b.targetTitle||b.target)+'">'+((b.targetTitle||b.label||'Linked Slide').slice(0,50))+'</span>';
            btn.onclick=()=>dkpGo(b.target);
            spNavList.appendChild(btn);
          }
          spNavSec.style.display='';
          if(spPanel)spPanel.classList.add('has-content');
        } else {
          spNavSec.style.display='none';
        }
      }

      const nextIdx=cur+1<SLIDES.length?cur+1:-1;
      if(contBtnEl){
        if(navCount===0&&nextIdx>=0){contBtnEl.style.display='';contBtnEl.onclick=()=>render(nextIdx);}
        else{contBtnEl.style.display='none';contBtnEl.onclick=null;}
      }

      const hint=document.createElement('span');hint.className='dkp-bottombar-hint';
      if(navCount>0)hint.textContent='Click highlighted areas to navigate \u2022 Back to return';
      else hint.textContent='No interactive areas on this slide \u2014 use Continue or Back to proceed';
      bar.appendChild(hint);
    }
  } else {
    document.getElementById('tb-fill').style.width=(SLIDES.length>1?Math.round(cur/(SLIDES.length-1)*100):100)+'%';
    document.getElementById('tb-label').textContent=s.type==='step'?'Step '+s.stepNum+' of '+s.totalSteps:(s.type==='cover'?'Overview':'Introduction');
    document.getElementById('nav-prev').disabled=cur===0;document.getElementById('nav-next').disabled=cur===SLIDES.length-1;
    for(let i=0;i<Math.min(SLIDES.length,40);i++){const d=document.createElement('button');d.className='dot-nav'+(i===cur?' active':'');d.setAttribute('title',SLIDES[i].slideTitle||SLIDES[i].topic||('Slide '+(i+1)));d.onclick=()=>render(i);bar.appendChild(d);}
    updatePaths(s);
  }
}
function go(d){render(cur+d);}
document.addEventListener('keydown',e=>{
  if(IS_DKP){
    if(e.key==='ArrowLeft'){e.preventDefault();dkpBack();}
    if(e.key==='Escape'){if(window.parent!==window)window.parent.postMessage('preview:close','*');}
    return;
  }
  if(e.key==='ArrowRight'||e.key===' '){e.preventDefault();go(1);}
  if(e.key==='ArrowLeft'){e.preventDefault();go(-1);}
  if(e.key==='Escape'&&window.parent!==window)window.parent.postMessage('preview:close','*');
});
render(0);
</script></body></html>`;
}

// ── DKP helpers ────────────────────────────────────────────────────

// Strip "slide!", "book!", or "topic!" scheme prefixes from SAP Enable Now refs
// e.g. "slide!SL_456" → "SL_456", "book!BO_001" → "BO_001"
function normalizeSlideRef(ref) {
  if (!ref || typeof ref !== 'string') return ref;
  return ref.replace(/^(?:slide|book|topic|page)!/i, '').trim();
}

async function dkpBookInfo(zip) {
  // Support multiple books — find every book/*/entity.xml in the archive
  const bookKeys = Object.keys(zip.files).filter(n => n.startsWith('book/') && n.endsWith('/entity.xml'));
  if (!bookKeys.length) throw new Error('No book entity.xml found in .dkp archive');

  const books = [];
  for (const bookKey of bookKeys) {
    const xml = await zip.file(bookKey).async('string');
    const doc = parseXml(xml.replace(/^\uFEFF/, ''));
    const bookEl = doc.querySelector('book');

    // Build a caption lookup from <Assets> — all slides with their human-readable titles
    const captionMap = {};
    for (const r of doc.querySelectorAll('Ref[class="slide"], Ref[class="book"]')) {
      const uid = r.getAttribute('uid');
      const cap = r.getAttribute('caption') || uid || '';
      if (uid) captionMap[uid] = cap;
    }

    // <Dependencies> defines the ENTRY POINT slides for this book.
    // Use the first dependency's slide caption as the book name — it is more
    // specific (e.g. "Welcome to the Learning Center") than the generic book
    // caption (e.g. "Learning Center").
    const depIds = [];
    for (const dep of doc.querySelectorAll('Dependencies > Dependency, Dependency')) {
      const raw = (dep.textContent || '').trim();
      const m = raw.match(/^slide!([\w]+)/);
      if (m) depIds.push(m[1]);
    }
    const caption = bookEl?.getAttribute('caption') || 'Untitled';

    // All slide refs from <Assets> — used for slide title resolution during parsing
    const refs = [...doc.querySelectorAll('Ref[class="slide"]')].map(r => ({
      id:    r.getAttribute('uid')     || '',
      title: r.getAttribute('caption') || r.getAttribute('uid') || '',
    })).filter(r => r.id);

    const bookW = parseInt(bookEl?.getAttribute('contentWidth') || bookEl?.getAttribute('slideWidth') || '0', 10);
    const bookH = parseInt(bookEl?.getAttribute('contentHeight') || bookEl?.getAttribute('slideHeight') || '0', 10);
    const bookScreenSize = (bookW > 100 && bookH > 100) ? { w: bookW, h: bookH } : null;

    const rawEntry = bookEl?.getAttribute('content_slide') || bookEl?.getAttribute('contentSlide') || bookEl?.getAttribute('startSlide') || bookEl?.getAttribute('start') || '';
    const entryPointId = rawEntry ? normalizeSlideRef(rawEntry) : (depIds[0] || null);

    books.push({ caption, refs, bookScreenSize, entryPointId, depIds });
  }

  // Backwards-compat: callers that destructure a single result still work
  // (primary = first book). Full multi-book list available via .books.
  return { ...books[0], books };
}

// Parse slide.xml — extract visual elements with positions and content
function parseDkpSlideXml(xmlString) {
  let doc;
  try { doc = parseXml(xmlString); } catch { return { elements: [], screenW: 0, screenH: 0 }; }
  const root = doc.documentElement;

  // Screen dimensions from root element or a nested props/format/size element
  function readDim(el, wAttrs, hAttrs) {
    for (const a of wAttrs) { const v = parseInt(el?.getAttribute(a) || '0', 10); if (v > 100) return { w: v, h: parseInt(el.getAttribute(hAttrs[wAttrs.indexOf(a)]) || '0', 10) }; }
    return null;
  }
  const dimSrc = readDim(root, ['width','contentWidth','slideWidth','w'], ['height','contentHeight','slideHeight','h'])
    || readDim(doc.querySelector('format,size,props,dimensions,resolution'), ['width','w'], ['height','h'])
    || null;
  const screenW = dimSrc?.w || 0;
  const screenH = dimSrc?.h || 0;

  // Collect all candidate element nodes; try tags used by SAP Enable Now / WPB.
  // XML is case-sensitive so querySelectorAll('control') won't match <Control>.
  // Walk all elements and match against lowercase tag names instead.
  const candidateTags = new Set(['object','control','widget','element','textbox','label','button','image','bitmap','input','component','hrefarea','hotspot','shape','link']);
  const seen = new WeakSet();
  const rawEls = [];
  for (const el of doc.querySelectorAll('*')) {
    if (candidateTags.has(el.tagName.toLowerCase()) && !seen.has(el)) {
      seen.add(el);
      rawEls.push(el);
    }
  }

  const elements = [];
  rawEls.forEach((el, idx) => {
    const parsed = parseDkpXmlElement(el, idx);
    if (parsed) elements.push(parsed);
  });
  return { elements, screenW, screenH };
}

function parseDkpXmlElement(el, idx) {
  // Skip invisible elements
  const vis = el.getAttribute('visible') ?? el.getAttribute('visibility') ?? 'true';
  if (vis === 'false' || vis === 'hidden' || vis === '0') return null;
  // Skip explicitly hidden elements (hidden="true")
  const hiddenAttr = el.getAttribute('hidden');
  if (hiddenAttr === 'true' || hiddenAttr === '1') return null;

  const id = el.getAttribute('id') || el.getAttribute('uid') || el.getAttribute('name') || `el_${idx}`;

  // Position — try multiple attribute naming conventions
  // Track whether position attributes were explicitly present (vs defaulting to 0,0)
  const xRaw = el.getAttribute('x') || el.getAttribute('left') || el.getAttribute('posX') || el.getAttribute('pos-x') || el.getAttribute('X');
  const yRaw = el.getAttribute('y') || el.getAttribute('top')  || el.getAttribute('posY') || el.getAttribute('pos-y') || el.getAttribute('Y');
  const positionInferred = !xRaw && !yRaw;
  const x = parseInt(xRaw || '0', 10);
  const y = parseInt(yRaw || '0', 10);
  // cx/cy are used by SAP Enable Now for width/height
  const w = parseInt(el.getAttribute('w') || el.getAttribute('width')  || el.getAttribute('cx') || el.getAttribute('size-w') || '0', 10);
  const h = parseInt(el.getAttribute('h') || el.getAttribute('height') || el.getAttribute('cy') || el.getAttribute('size-h') || '0', 10);

  // Type — derive from class / type attribute / tag name
  const raw = (el.getAttribute('class') || el.getAttribute('type') || el.tagName || '').toLowerCase();
  let type = 'container';
  if (/text|label|caption|title|heading|paragraph/.test(raw)) type = 'text';
  else if (/button|btn|action|click|hrefarea|hotspot|clickarea/.test(raw)) type = 'button';
  else if (/image|img|picture|bitmap|photo|graphic/.test(raw)) type = 'image';
  else if (/input|field|textbox|entry|edit/.test(raw))         type = 'input';

  // Content — look in child elements first, then direct textContent
  const contentEl = el.querySelector('text,content,label,value,caption,title');
  let raw_content = contentEl
    ? (contentEl.innerHTML || contentEl.textContent || '')
    : (type !== 'container' ? (el.getAttribute('text') || el.getAttribute('caption') || el.getAttribute('value') || '') : '');

  // Also check for inline text attribute shorthand
  if (!raw_content && el.getAttribute('text')) raw_content = el.getAttribute('text');

  const content = stripHtmlToText(raw_content).trim();

  // Keep elements that carry a navigation attribute even when they have no text content.
  // (DKP hub tiles often have href="slide!SL_xxx" with no text — they're clickable images.)
  const NAV_ATTRS = ['href','action','navigateTo','goTo','onClick','link','targetId','linkedPage','destination'];
  const hasNavAttr = NAV_ATTRS.some(a => el.getAttribute(a));

  // Skip pure containers with no content and no navigation
  if (type === 'container' && !content && !hasNavAttr) return null;
  // Skip truly empty non-image, non-nav elements
  if (type !== 'image' && !content && !hasNavAttr) return null;

  // Style hints
  const style = {};
  const bg = el.getAttribute('bgColor') || el.getAttribute('backgroundColor') || el.getAttribute('bg') || el.getAttribute('fill');
  const fg = el.getAttribute('fgColor') || el.getAttribute('foregroundColor') || el.getAttribute('color') || el.getAttribute('fg');
  const fs = el.getAttribute('fontSize') || el.getAttribute('font-size');
  const fw = el.getAttribute('fontWeight') || el.getAttribute('font-weight') || (el.getAttribute('bold') === 'true' ? 'bold' : null);
  if (bg) style.background = bg;
  if (fg) style.color = fg;
  if (fs) style.fontSize = fs;
  if (fw) style.fontWeight = fw;

  // Navigation / interaction actions from XML attributes
  const actions = [];
  const actionAttrs = ['action','href','onClick','navigateTo','goTo','link','target','targetId',
    'linkedPage','destination','url','navigate','onselect','command','onActivate'];
  for (const attr of actionAttrs) {
    const v = el.getAttribute(attr);
    if (!v) continue;
    const m = v.match(/goToSlide\s*\(\s*['"]([^'"]+)['"]\s*\)/i);
    const t = normalizeSlideRef(m ? m[1] : v.trim());
    if (t && !actions.some(a => a.target === t)) actions.push({ event: 'click', target: t, type: 'navigate' });
    // no break — process all attributes; a control can carry multiple navigation targets
  }
  // Also scan all remaining XML attributes for anything that looks like a slide ref
  for (const attr of el.attributes) {
    if (actionAttrs.includes(attr.name)) continue;
    const v = attr.value && attr.value.trim();
    if (!v || v.length < 4) continue;
    if (/^(slide|book|topic|page)!/i.test(v) || /^SL_[\w]{4,}$/i.test(v)) {
      const t = normalizeSlideRef(v);
      if (t && !actions.some(a => a.target === t)) actions.push({ event: 'click', target: t, type: 'navigate' });
    }
  }
  // Also check child <action>, <link>, <navigate> elements
  for (const actEl of el.querySelectorAll('action,link,navigate,handler,target')) {
    const raw = actEl.getAttribute('target') || actEl.getAttribute('href') || actEl.getAttribute('targetId') || actEl.textContent.trim();
    if (raw) {
      const m = raw.match(/goToSlide\s*\(\s*['"]([^'"]+)['"]\s*\)/i);
      const t = normalizeSlideRef(m ? m[1] : raw.trim());
      if (t && !actions.some(a => a.target === t)) {
        actions.push({ event: actEl.getAttribute('event') || 'click', target: t, type: actEl.getAttribute('type') || 'navigate' });
      }
    }
  }

  const interactive = actions.length > 0 || /button|hotspot|input/.test(type);
  const name = el.getAttribute('name') || el.getAttribute('caption') || '';
  // onenter="CTLxxx.show" — extract the control ID for companion-position lookup
  const onenterRaw = el.getAttribute('onenter') || el.getAttribute('onEnter') || '';
  const onenterRef = onenterRaw.match(/^([\w!]+)\./)?.[1] || '';
  const z = parseInt(el.getAttribute('z') || el.getAttribute('zIndex') || el.getAttribute('z-index') || '0', 10);
  return { id, type, content: content.trim(), position: { x, y }, size: { width: w, height: h }, style, actions, interactive, positionInferred, name, onenterRef, z };
}

// Extract the first balanced {...} block starting at or after `offset`.
// Handles nesting correctly; ignores braces inside strings.
function extractBalancedJson(str, offset = 0) {
  const start = str.indexOf('{', offset);
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false, quote = '';
  for (let i = start; i < str.length; i++) {
    const c = str[i];
    if (esc) { esc = false; continue; }
    if (c === '\\' && inStr) { esc = true; continue; }
    if (!inStr && (c === '"' || c === "'")) { inStr = true; quote = c; continue; }
    if (inStr && c === quote) { inStr = false; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return str.slice(start, i + 1); }
  }
  return null;
}

// Parse slide.js — handles JSON data files and extracts controls, navigation, dimensions
function parseDkpSlideJs(jsText) {
  if (!jsText) return { controls: {}, navigation: {}, screenW: 0, screenH: 0 };
  const clean = jsText.replace(/^\uFEFF/, '');

  let data = null;
  // 1. Pure JSON
  try { data = JSON.parse(clean); } catch { /* try other forms */ }
  // 2. var/let/const name = {...}
  if (!data) {
    const m = clean.match(/(?:var|let|const)\s+[\w$.]+\s*=/);
    if (m) { const blob = extractBalancedJson(clean, m.index); if (blob) try { data = JSON.parse(blob); } catch {} }
  }
  // 3. AMD define(function(){ return {...}; }) or define([deps], function(){ return {...}; })
  //    SAP Enable Now WPB uses: define(function(){return{...}})
  if (!data) {
    const retIdx = clean.search(/\breturn\s*\{/);
    if (retIdx !== -1) {
      const blobStart = clean.indexOf('{', retIdx);
      const blob = extractBalancedJson(clean, blobStart);
      if (blob) try { data = JSON.parse(blob); } catch {}
    }
  }
  // 4. Any function call with a single object arg: funcName({...}) or obj.method({...})
  if (!data) {
    const m = clean.match(/[\w$.]+\s*\(\s*\{/);
    if (m) { const blob = extractBalancedJson(clean, m.index); if (blob) try { data = JSON.parse(blob); } catch {} }
  }
  // 5. Last-resort: first balanced {...} in the whole file
  if (!data) {
    const blob = extractBalancedJson(clean);
    if (blob) try { data = JSON.parse(blob); } catch {}
  }

  if (data) {
    // pageData is the SAP Enable Now outer wrapper — unwrap one level if present.
    // Template slides (non-delta) often have { page: { width, height, Symbols: {...} } }
    // with NO pageData wrapper, so after unwrap d = { page: { ... } } and controls
    // live at d.page.Symbols, not d.Symbols. Check both levels.
    const d = data.pageData || data;
    // "page" sub-object used by SAP Enable Now for the slide body
    const pg = d.page && typeof d.page === 'object' && !d.page.template ? d.page : null;

    const screenW = parseInt(d.width || d.screenWidth || d.contentWidth || d.size?.width
      || pg?.width || pg?.screenWidth || pg?.contentWidth || 0, 10);
    const screenH = parseInt(d.height || d.screenHeight || d.contentHeight || d.size?.height
      || pg?.height || pg?.screenHeight || pg?.contentHeight || 0, 10);

    // SAP Enable Now uses "Symbols" (capitalised) as the control map; check both
    // the top-level d and the nested page sub-object.
    let controls = d.controls || d.Symbols || d.symbols || d.objects || d.elements || d.items
      || pg?.controls || pg?.Symbols || pg?.symbols || pg?.objects || pg?.elements || pg?.items || {};

    // Generic controls-map discovery: if the named wrapper keys above found nothing,
    // scan every sub-object of d (and pg) looking for a map whose values are all/mostly
    // plain objects — that structure is universally what a controls map looks like.
    if (!Object.keys(controls).length) {
      const NON_CTL = new Set(['navigation','nav','page','meta','info','config','settings',
        'style','theme','locale','translation','manifest','header','footer','animation','event']);
      const isCtrlMap = v => {
        if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
        const vals = Object.values(v);
        if (vals.length === 0) return false;
        const objCount = vals.filter(vv => vv && typeof vv === 'object' && !Array.isArray(vv)).length;
        return objCount >= Math.ceil(vals.length * 0.6);
      };
      const sources = [d, pg].filter(Boolean);
      outer: for (const src of sources) {
        for (const [k, v] of Object.entries(src)) {
          if (NON_CTL.has(k)) continue;
          if (isCtrlMap(v)) { controls = v; break outer; }
        }
        // Also treat src itself as the map when all its values are objects
        if (isCtrlMap(src) && src !== d) { controls = src; break; }
      }
      // Last resort: d itself (flat structure with control IDs as top-level keys)
      if (!Object.keys(controls).length && isCtrlMap(d)) controls = d;
    }

    const navSrc = data.navigation || data.nav || {};
    const navigation = {
      next:     navSrc.next     || navSrc.nextSlide || data.nextSlide || data.next     || null,
      previous: navSrc.prev     || navSrc.previous  || data.prevSlide || data.previous || null,
    };
    const rawTmpl = (d.page?.template) || (data.page?.template) || null;
    const templateRef = rawTmpl ? normalizeSlideRef(rawTmpl) : null;

    // ── DEBUG ──────────────────────────────────────────────────────────
    const ctlCount = Object.keys(controls).length;
    if (ctlCount === 0) {
      console.warn('[DKP·parse] ❌ NO controls found.',
        '\n  data top-keys:', Object.keys(data).slice(0, 12),
        '\n  d top-keys:', Object.keys(d).slice(0, 12),
        '\n  pg top-keys:', pg ? Object.keys(pg).slice(0, 12) : 'none',
        '\n  templateRef:', templateRef,
        '\n  raw(first300):', jsText ? jsText.slice(0, 300) : '(empty)');
    } else {
      const [firstId, firstCtl] = Object.entries(controls)[0];
      const sample = typeof firstCtl === 'object' && firstCtl ? firstCtl : {};
      console.log(`[DKP·parse] ✅ controls=${ctlCount} screenW=${screenW} screenH=${screenH} templateRef=${templateRef}`,
        `\n  firstCtl[${firstId}] keys:`, Object.keys(sample).slice(0, 12),
        '\n  pos:', { x: sample.x, y: sample.y, left: sample.left, top: sample.top, cx: sample.cx, cy: sample.cy });
    }
    // ──────────────────────────────────────────────────────────────────

    return { controls, navigation, screenW, screenH, templateRef };
  }

  // Fallback: regex extraction for actual JS function-call files
  const navigation = {};
  if (/goToNextSlide\s*\(\s*\)/i.test(clean)) navigation.hasNext = true;
  const nextMatch = clean.match(/goToSlide\s*\(\s*['"]([^'"]+)['"]\s*\)/i);
  if (nextMatch) navigation.next = nextMatch[1];
  const wMatch = clean.match(/(?:width|screenWidth|contentWidth)\s*[:=]\s*(\d+)/i);
  const hMatch = clean.match(/(?:height|screenHeight|contentHeight)\s*[:=]\s*(\d+)/i);
  return { controls: {}, navigation, screenW: wMatch ? parseInt(wMatch[1], 10) : 0, screenH: hMatch ? parseInt(hMatch[1], 10) : 0 };
}

// Extract per-control navigation actions — tries every known SAP Enable Now / WPB property pattern
function dkpExtractControlActions(ctl) {
  if (!ctl || typeof ctl !== 'object') return [];
  const actions = [];
  const seen = new Set();

  function add(event, rawTarget, type = 'navigate') {
    if (!rawTarget || typeof rawTarget !== 'string') return;
    const m = rawTarget.match(/goToSlide\s*\(\s*['"]([^'"]+)['"]\s*\)/i);
    const target = normalizeSlideRef(m ? m[1] : rawTarget).trim();
    if (!target || seen.has(target)) return;
    seen.add(target);
    actions.push({ event, target, type });
  }

  // Direct scalar properties — covers WPB JSON and SAP Enable Now Symbols format
  // SAP EN uses lowercase "link" for the target slide ID string
  for (const k of ['navigateTo','goTo','href','link','Link','target','targetSlide','targetId','slideTarget','destination','pageId','linkedPage','NavigateTo','GoTo','Href']) {
    if (ctl[k] && typeof ctl[k] === 'string') add('click', ctl[k]);
  }

  // Scalar action/onClick properties (string form: "SL_xxx" or "goToSlide('SL_xxx')")
  for (const k of ['action','onClick','onClicked','click','handler','navigate','command']) {
    const v = ctl[k];
    if (!v) continue;
    if (typeof v === 'string') add('click', v);
    else if (typeof v === 'object' && !Array.isArray(v)) {
      const t = v.target || v.targetId || v.href || v.slideId || v.navigateTo || v.pageId;
      if (t) add(v.event || v.trigger || 'click', t, v.type || 'navigate');
    }
  }

  // Array-form actions / events
  for (const k of ['actions','events','handlers','transitions','links','clicks']) {
    const arr = ctl[k];
    if (!Array.isArray(arr)) continue;
    for (const a of arr) {
      const t = a.target || a.targetId || a.href || a.slideId || a.navigateTo || a.to || a.pageId;
      add(a.event || a.trigger || a.type || 'click', t, a.actionType || a.kind || 'navigate');
    }
  }

  // SAP Enable Now "link" sub-object
  const linkObj = ctl.link || ctl.linkedPage || ctl.linkedSlide || ctl.linkTarget;
  if (linkObj) {
    if (typeof linkObj === 'string') add('click', linkObj);
    else if (typeof linkObj === 'object') add('click', linkObj.id || linkObj.uid || linkObj.target || linkObj.href || '');
  }

  // Universal fallback: scan every remaining property for anything that looks like a
  // slide reference. This catches custom or version-specific property names without
  // requiring an exhaustive hardcoded list.
  const _PROP_SKIP = new Set(['id','uid','name','type','class','kind','controlType','elementType',
    'text','content','caption','label','value','description','title','body','displayText',
    'background','color','fill','opacity','visible','hidden','disabled','tabIndex',
    'fontColor','fontSize','fontWeight','bold','italic','underline','fontFamily','font',
    'width','height','w','h','x','y','cx','cy','left','top','z','zIndex',
    'bgColor','backgroundColor','fgColor','foregroundColor','textColor','fillColor',
    'onenter','onEnter','on_enter','template','templateRef','slideType','frameType']);
  const _looksLikeSlideRef = s => {
    if (!s || typeof s !== 'string') return false;
    const t = s.trim();
    if (t.length < 3 || /^https?:\/\//i.test(t)) return false;
    // Has a slide scheme prefix (slide!, book!, topic!, page!)
    if (/^(slide|book|topic|page)!/i.test(t)) return true;
    // Bare SL_ ID
    if (/^SL_[\w]{4,}$/i.test(t)) return true;
    // Long alphanumeric that normalizeSlideRef would transform
    const norm = normalizeSlideRef(t);
    return norm !== t && norm.length >= 4;
  };
  for (const [k, v] of Object.entries(ctl)) {
    if (_PROP_SKIP.has(k)) continue;
    if (typeof v === 'string' && _looksLikeSlideRef(v)) {
      add('click', v);
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      // One level deep: look for target-like keys inside nested objects
      for (const [sk, sv] of Object.entries(v)) {
        if (typeof sv === 'string' && _looksLikeSlideRef(sv)) add('click', sv);
      }
    }
  }

  return actions;
}

// Strip recognised prefix words from a control name so "Hotspot Folder 7" and
// "Folder 7" both normalise to "folder 7" and can be matched against each other.
function _dkpNormName(name) {
  if (!name) return '';
  return name.toLowerCase()
    .replace(/^(hotspot|hover|click|button|action|navigate|nav|area|zone)\s+/i, '')
    .trim();
}

// Fill in positions for elements that have nav actions but no explicit coordinates.
// Operates in priority order:
//   1. onenter companion  — el.onenterRef → find positioned element with that id, copy x/y/w/h
//   2. name-pattern match — strip "Hotspot" prefix from el.name, find positioned element
//                           whose normalised name equals the stripped name, copy x/y/w/h
//   3. z-proximity        — nearest positioned interactive neighbour by z-layer distance
//                           (weak heuristic; only applies when z-distance ≤ 8)
// Mutates elements in place; returns the same array for chaining.
function dkpInferMissingPositions(elements, jsControls = {}) {
  // ── Build lookup tables ────────────────────────────────────────────
  const byId   = {};
  const byName = {};
  const byZ    = new Map();

  for (const el of elements) {
    if (el.z) byZ.set(el.z, el);
    if (el.positionInferred) continue;
    // Exclude only truly empty elements (no position AND no size) — (0,0) with a real
    // size is a valid top-left element and must be in the lookup table.
    if (el.position.x === 0 && el.position.y === 0 && el.size.width === 0 && el.size.height === 0) continue;
    byId[el.id] = el;
    const n = _dkpNormName(el.name);
    if (n && !byName[n]) byName[n] = el;
  }

  // Extend byZ with raw jsControls entries that aren't already in elements.
  // Icon companions (e.g. "Icon Folder 7") are filtered out of elements because
  // they carry no text content and no navigation — but their x values are essential
  // for the icon z-companion strategy (Strategy 0) below.
  for (const [ctlId, ctl] of Object.entries(jsControls)) {
    if (!ctl || typeof ctl !== 'object') continue;
    const z = parseInt(ctl.z || 0, 10);
    if (!z || byZ.has(z)) continue;
    const xRaw = ctl.x ?? ctl.left ?? null;
    const yRaw = ctl.y ?? ctl.top  ?? null;
    byZ.set(z, {
      id: ctlId, z,
      position: { x: parseInt(xRaw ?? 0, 10), y: parseInt(yRaw ?? 0, 10) },
      size: { width: parseInt(ctl.w ?? ctl.width ?? ctl.cx ?? 0, 10), height: parseInt(ctl.h ?? ctl.height ?? ctl.cy ?? 0, 10) },
      positionInferred: xRaw === null && yRaw === null,
      interactive: false,
      actions: [],
      name: ctl.name || '',
    });
  }

  // ── Derive icon offset from known complete tile sets ──────────────
  // In SAP Enable Now, each hotspot has a non-interactive icon at z-1
  // positioned at tile_x + OFFSET, tile_y + OFFSET2.
  // Derive OFFSET from any known complete pair (positioned hotspot + positioned icon at z-1).
  // Derive icon-to-tile x offset from any known positioned hotspot + its icon at z-1.
  let iconXOffset = null;
  for (const el of elements) {
    if (el.positionInferred || !el.interactive || !el.actions?.length || !el.z) continue;
    const iconEl = byZ.get(el.z - 1);
    if (!iconEl || iconEl.positionInferred || iconEl.interactive || iconEl.actions?.length) continue;
    const dx = iconEl.position.x - el.position.x;
    if (dx > 0 && dx < 300) { iconXOffset = dx; break; }
  }

  // ── Derive known row y-values from positioned interactive elements ─
  const rowYSet = new Set();
  for (const el of elements) {
    if (!el.positionInferred && el.interactive && el.actions?.length && el.position.y > 0) {
      rowYSet.add(el.position.y);
    }
  }
  const knownRowYs = [...rowYSet].sort((a, b) => a - b);

  // ── Detect additional rows from horizontal guide elements ──────────
  // Pull guide y-values from both the element list AND raw jsControls —
  // on the non-template path, guides live only in jsControls and never
  // reach the elements array via dkpMergeJsActionsIntoElements.
  const knownBottoms = new Set(knownRowYs.map(y => {
    const sample = elements.find(e => !e.positionInferred && e.interactive && e.position.y === y && e.size.height > 0);
    return sample ? y + sample.size.height : y + 82;
  }));
  const guideYsFromElements = elements
    .filter(e => /guide/i.test(e.name || '') && e.position.y > 0 && !e.positionInferred)
    .map(e => e.position.y);
  const guideYsFromJs = Object.values(jsControls)
    .filter(c => c && typeof c === 'object' && /guide/i.test(c.name || '') && (c.y ?? c.top) != null)
    .map(c => parseInt(c.y ?? c.top ?? 0, 10))
    .filter(y => y > 0);
  const allGuideYs = [...new Set([...guideYsFromElements, ...guideYsFromJs])].sort((a, b) => a - b);
  const maxKnownBottom = Math.max(0, ...[...knownBottoms]);
  // A guide y above all known row bottoms and not a bottom itself marks a new row top.
  const newRowTops = allGuideYs.filter(y => !knownBottoms.has(y) && y > maxKnownBottom);

  // Build ordered row y list: known rows + guide-detected new rows
  const allRowYs = [...knownRowYs];
  for (const top of newRowTops) {
    if (!allRowYs.includes(top)) allRowYs.push(top);
  }
  allRowYs.sort((a, b) => a - b);
  // Extend by uniform spacing if still under-populated
  if (allRowYs.length >= 2) {
    const spacing = allRowYs[1] - allRowYs[0];
    while (allRowYs.length < 3) allRowYs.push(allRowYs[allRowYs.length - 1] + spacing);
  }

  // ── Assign row y to a missing hotspot ────────────────────────────
  // All 6 missing hotspots have z values LOWER than every known positioned
  // nav element (authored earlier in the project). When all known nav z > el.z,
  // the element belongs to the last (newest) inferred row.
  const posNavByZ = elements
    .filter(e => !e.positionInferred && e.interactive && e.actions?.length && e.z)
    .sort((a, b) => a.z - b.z);

  function inferRowY(el) {
    if (!allRowYs.length) return 0;
    if (!posNavByZ.length)  return allRowYs[allRowYs.length - 1];
    const allKnownAbove = posNavByZ.every(c => (c.z || 0) > (el.z || 0));
    if (allKnownAbove) return allRowYs[allRowYs.length - 1]; // last row
    // Find nearest known positioned nav by z distance
    let best = posNavByZ[0], bestDist = Math.abs((best.z || 0) - (el.z || 0));
    for (const cand of posNavByZ) {
      const d = Math.abs((cand.z || 0) - el.z);
      if (d < bestDist) { bestDist = d; best = cand; }
    }
    return best.position.y;
  }

  // ── Apply inference strategies ─────────────────────────────────────
  const needsPos = elements.filter(el => el.positionInferred && el.interactive && el.actions?.length);

  for (const el of needsPos) {

    // ── Strategy 0: icon z-companion ──────────────────────────────
    if (iconXOffset !== null && el.z) {
      const iconEl = byZ.get(el.z - 1);
      if (iconEl && !iconEl.positionInferred && iconEl.position.x > 0) {
        const tileX = iconEl.position.x - iconXOffset;
        if (tileX >= 0) {
          el.position.x = tileX;
          // Pick the first row y that doesn't already have a positioned nav element at
          // this column — each column can only hold one nav tile per row.
          let rowY = 0;
          for (const ry of allRowYs) {
            const collision = elements.find(
              e => !e.positionInferred && e.interactive && e.actions?.length
                && e.position.x === tileX && e.position.y === ry
            );
            if (!collision) { rowY = ry; break; }
          }
          if (!rowY) rowY = inferRowY(el); // fallback to z-proximity heuristic
          el.position.y = rowY;
          if (el.size.width < 1) {
            // Derive tile size from a positioned nav element at same x-column, or use icon companion's element
            const sameCol = elements.find(e => !e.positionInferred && e.interactive && e.position.x === tileX && e.size.width > 0);
            el.size = sameCol ? { ...sameCol.size } : { width: 164, height: 82 };
          }
          el.positionInferred = false;
          continue;
        }
      }
    }

    // ── Strategy 1: onenter companion ─────────────────────────────
    if (el.onenterRef) {
      const companion = byId[el.onenterRef];
      if (companion) {
        el.position = { ...companion.position };
        if (el.size.width < 1 || el.size.height < 1) el.size = { ...companion.size };
        el.positionInferred = false;
        continue;
      }
    }

    // ── Strategy 2: name-pattern match ────────────────────────────
    if (el.name) {
      const base = _dkpNormName(el.name);
      if (base) {
        const companion = byName[base]
          || Object.values(byName).find(c => _dkpNormName(c.name).includes(base) || base.includes(_dkpNormName(c.name)));
        if (companion) {
          el.position = { ...companion.position };
          if (el.size.width < 1 || el.size.height < 1) el.size = { ...companion.size };
          el.positionInferred = false;
          continue;
        }
      }
    }

    // ── Strategy 3: z-proximity (narrow threshold) ────────────────
    if (el.z) {
      let best = null, bestDist = Infinity;
      for (const cand of Object.values(byId)) {
        if (!cand.interactive || !cand.actions?.length) continue;
        const dist = Math.abs((cand.z || 0) - el.z);
        if (dist < bestDist) { bestDist = dist; best = cand; }
      }
      if (best && bestDist <= 50) {
        el.position = { ...best.position };
        if (el.size.width < 1 || el.size.height < 1) el.size = { ...best.size };
        el.positionInferred = false;
      }
    }
  }

  return elements;
}

// Merge a delta control onto a base (template) control without letting zero/null
// delta values overwrite real template geometry. Position and size keys from the
// delta are only applied when they carry a genuinely non-zero value.
function dkpSmartMerge(base, delta) {
  const result = { ...base };
  const POS  = new Set(['x','y','left','top','posX','posY','X','Y']);
  const SIZE = new Set(['w','h','width','height','cx','cy','sizeW','sizeH']);
  for (const [k, v] of Object.entries(delta)) {
    if ((POS.has(k) || SIZE.has(k)) && (v === null || v === undefined || v === 0 || v === '0' || v === '')) {
      // Only skip if the base already has a meaningful value for this key
      if (result[k] != null && result[k] !== 0 && result[k] !== '0' && result[k] !== '') continue;
    }
    result[k] = v;
  }
  return result;
}

// Convert slide.js controls → normalized elements (includes rich styling + actions)
function dkpControlsToElements(controls) {
  const elements = [];
  let idx = 0;
  for (const [id, ctl] of Object.entries(controls || {})) {
    if (!ctl || typeof ctl !== 'object') continue;

    const raw = ctl.text || ctl.content || ctl.caption || ctl.label || ctl.value || ctl.Caption || '';
    const content = stripHtmlToText(raw).trim();

    const xRaw = ctl.x ?? ctl.left ?? ctl.posX ?? ctl.X ?? ctl.position?.x ?? ctl.bounds?.x ?? ctl.bounds?.left ?? ctl.rect?.x ?? ctl.rect?.left ?? null;
    const yRaw = ctl.y ?? ctl.top  ?? ctl.posY ?? ctl.Y ?? ctl.position?.y ?? ctl.bounds?.y ?? ctl.bounds?.top  ?? ctl.rect?.y ?? ctl.rect?.top  ?? null;
    const positionInferred = xRaw === null && yRaw === null;
    const x = parseInt(xRaw ?? 0, 10);
    const y = parseInt(yRaw ?? 0, 10);
    // SAP Enable Now uses cx/cy for width/height; also check bounds/rect nested objects
    const w = parseInt(ctl.width  || ctl.w || ctl.cx || ctl.size?.width  || ctl.bounds?.width  || ctl.bounds?.w  || ctl.rect?.width  || 0, 10);
    const h = parseInt(ctl.height || ctl.h || ctl.cy || ctl.size?.height || ctl.bounds?.height || ctl.bounds?.h  || ctl.rect?.height || 0, 10);

    const rawKind = (ctl.type || ctl.class || ctl.kind || ctl.controlType || ctl.Type || '').toLowerCase();
    let type = 'text';
    if      (/button|btn|pushbutton/.test(rawKind))              type = 'button';
    else if (/image|img|picture|bitmap|graphic/.test(rawKind))   type = 'image';
    else if (/input|field|textbox|entry|edit|form/.test(rawKind)) type = 'input';
    else if (/hotspot|clickarea|clickable|area|zone/.test(rawKind)) type = 'hotspot';

    const actions = dkpExtractControlActions(ctl);
    const interactive = actions.length > 0 || /button|hotspot|input/.test(type);
    const name = ctl.name || ctl.caption || ctl.label || ctl.Caption || '';

    // Skip truly empty non-interactive, non-image elements
    // BUT keep horizontal guide elements — their y-position is used for row inference
    const isGuide = /guide/i.test(name);
    if (!content && !interactive && type !== 'image' && !isGuide) continue;

    // Rich style extraction
    const style = {};
    const bg = ctl.bgColor || ctl.backgroundColor || ctl.bg || ctl.fill || ctl.background;
    const fg = ctl.fgColor || ctl.foregroundColor || ctl.color || ctl.fg || ctl.fontColor || ctl.textColor;
    const fs = ctl.fontSize || ctl['font-size'] || ctl.textSize;
    const fw = ctl.fontWeight || (ctl.bold ? 'bold' : null);
    const opacity = ctl.opacity;
    if (bg)      style.background  = bg;
    if (fg)      style.color       = fg;
    if (fs)      style.fontSize    = String(fs);
    if (fw)      style.fontWeight  = fw;
    if (opacity !== undefined) style.opacity = opacity;
    const onenterStr = typeof (ctl.onenter || ctl.onEnter || ctl.on_enter) === 'string'
      ? (ctl.onenter || ctl.onEnter || ctl.on_enter) : '';
    const onenterRef = onenterStr.match(/^([\w!]+)\./)?.[1] || '';
    const z = parseInt(ctl.z || ctl.zIndex || ctl['z-index'] || 0, 10);
    elements.push({ id: id || `el_${idx}`, type, content, position: { x, y }, size: { width: w, height: h }, style, actions, interactive, positionInferred, name, onenterRef, z });
    idx++;
  }
  elements.sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);
  return elements;
}

// Merge slide.js geometry and slide.xml navigation using direct control ID matching.
// slide.js (jsControls) is keyed by control ID and provides box geometry (x,y,w,h).
// slide.xml (xmlElements) elements carry their control ID and href navigation target.
// Same ID → direct match; no position/content heuristics needed.
function dkpMergeJsActionsIntoElements(xmlElements, jsControls) {
  const controls = jsControls || {};

  // Build ID → geometry map from jsControls
  // Each key in jsControls is a control ID (e.g. "CTL649328B7319C7DAA")
  const jsById = {};
  for (const [ctlId, ctl] of Object.entries(controls)) {
    if (!ctl || typeof ctl !== 'object') continue;
    jsById[ctlId] = ctl;
  }

  // Merge: for each XML element, look up its ID in jsControls to apply geometry
  const merged = xmlElements.map(el => {
    const ctl = jsById[el.id];
    if (!ctl) return el; // no JS counterpart — return as-is

    // Apply geometry from JS when XML element is missing position or size
    const xRaw = ctl.x ?? ctl.left ?? ctl.posX ?? ctl.X ?? ctl.position?.x ?? ctl.bounds?.x ?? ctl.bounds?.left ?? ctl.rect?.x ?? null;
    const yRaw = ctl.y ?? ctl.top  ?? ctl.posY ?? ctl.Y ?? ctl.position?.y ?? ctl.bounds?.y ?? ctl.bounds?.top  ?? ctl.rect?.y ?? null;
    const wRaw = ctl.w ?? ctl.width  ?? ctl.cx ?? ctl.sizeW ?? ctl.bounds?.width  ?? ctl.rect?.width  ?? null;
    const hRaw = ctl.h ?? ctl.height ?? ctl.cy ?? ctl.sizeH ?? ctl.bounds?.height ?? ctl.rect?.height ?? null;

    const hasJsPos  = xRaw !== null && yRaw !== null;
    const hasJsSize = wRaw !== null && hRaw !== null;

    // JS controls are the authoritative coordinate source in SAP Enable Now.
    // Always prefer JS position over XML — XML often has default x=0 y=0 that
    // isn't a real position, while JS Symbols carry the actual layout geometry.
    const newPosition = hasJsPos
      ? { x: parseInt(xRaw, 10), y: parseInt(yRaw, 10) }
      : el.position;
    const newPositionInferred = hasJsPos ? false : el.positionInferred;

    // Apply size from JS: prefer JS when it has a real value, otherwise keep XML
    const jsW = hasJsSize ? parseInt(wRaw, 10) : 0;
    const jsH = hasJsSize ? parseInt(hRaw, 10) : 0;
    const newSize = (jsW > 0 && jsH > 0)
      ? { width: jsW, height: jsH }
      : (el.size.width > 0 || el.size.height > 0 ? el.size : { width: jsW || 0, height: jsH || 0 });

    // Merge JS actions: combine both XML and JS actions rather than preferring one
    const jsActs = dkpExtractControlActions(ctl);
    const combined = [...(el.actions || [])];
    for (const a of jsActs) {
      if (!combined.some(x => x.target === a.target)) combined.push(a);
    }
    const newActions = combined;
    const newInteractive = newActions.length > 0 || el.interactive;

    return { ...el, position: newPosition, size: newSize, actions: newActions, interactive: newInteractive, positionInferred: newPositionInferred };
  });

  // Also add JS-only controls that have navigation and no XML counterpart
  // (controls defined only in slide.js, not in slide.xml)
  const xmlIds = new Set(xmlElements.map(el => el.id));
  let extraIdx = xmlElements.length;
  for (const [ctlId, ctl] of Object.entries(controls)) {
    if (!ctl || typeof ctl !== 'object') continue;
    if (xmlIds.has(ctlId)) continue; // already merged above

    const acts = dkpExtractControlActions(ctl);
    if (!acts.length) continue; // only care about nav controls

    const xRaw = ctl.x ?? ctl.left ?? ctl.posX ?? ctl.X ?? ctl.position?.x ?? ctl.bounds?.x ?? ctl.bounds?.left ?? ctl.rect?.x ?? null;
    const yRaw = ctl.y ?? ctl.top  ?? ctl.posY ?? ctl.Y ?? ctl.position?.y ?? ctl.bounds?.y ?? ctl.bounds?.top  ?? ctl.rect?.y ?? null;
    const positionInferred = xRaw === null && yRaw === null;
    const x = parseInt(xRaw ?? 0, 10);
    const y = parseInt(yRaw ?? 0, 10);
    const w = parseInt(ctl.w ?? ctl.width  ?? ctl.cx ?? ctl.bounds?.width  ?? ctl.rect?.width  ?? 0, 10);
    const h = parseInt(ctl.h ?? ctl.height ?? ctl.cy ?? ctl.bounds?.height ?? ctl.rect?.height ?? 0, 10);

    const name = ctl.name || ctl.caption || ctl.label || ctl.Caption || '';
    const onenterStr = typeof (ctl.onenter || ctl.onEnter || ctl.on_enter) === 'string'
      ? (ctl.onenter || ctl.onEnter || ctl.on_enter) : '';
    const onenterRef = onenterStr.match(/^([\w!]+)\./)?.[1] || '';
    const z = parseInt(ctl.z || ctl.zIndex || ctl['z-index'] || 0, 10);

    merged.push({
      id: ctlId,
      type: 'button',
      content: stripHtmlToText(ctl.text || ctl.content || ctl.caption || '').trim(),
      position: { x, y },
      size: { width: w, height: h },
      style: {},
      actions: acts,
      interactive: true,
      positionInferred,
      name,
      onenterRef,
      z,
    });
    extraIdx++;
  }

  return merged;
}

// Infer step type: 'tooltip' (small overlay), 'modal' (centered panel), 'page' (full layout)
function inferDkpStepType(elements, screenW, screenH) {
  const sw = screenW || DKP_FALLBACK_W, sh = screenH || DKP_FALLBACK_H;
  const positioned = elements.filter(e => e.size.width > 0 || e.size.height > 0);
  if (!positioned.length) return 'page';
  const minX = Math.min(...positioned.map(e => e.position.x));
  const minY = Math.min(...positioned.map(e => e.position.y));
  const maxX = Math.max(...positioned.map(e => e.position.x + e.size.width));
  const maxY = Math.max(...positioned.map(e => e.position.y + e.size.height));
  const bboxW = maxX - minX, bboxH = maxY - minY;
  if (bboxW < sw * 0.4 && bboxH < sh * 0.45) return 'tooltip';
  const centerX = sw / 2, elemCX = (minX + maxX) / 2;
  if (Math.abs(elemCX - centerX) < sw * 0.2 && bboxW < sw * 0.75) return 'modal';
  return 'page';
}

// Build a bubble from extracted text elements (sorted by reading order)
function dkpBubbleFromElements(elements) {
  const textEls = elements
    .filter(e => e.type === 'text' && e.content.length > 3)
    .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);
  // Deduplicate identical adjacent content
  const unique = textEls.filter((e, i) => e.content !== textEls[i - 1]?.content);
  if (!unique.length) return null;
  const segments = [];
  for (let i = 0; i < unique.length; i++) {
    if (i > 0) segments.push({ type: 'br' });
    for (const line of unique[i].content.split('\n')) {
      const l = line.trim();
      if (l) segments.push({ type: 'line', segs: [{ text: l, bold: false, italic: false, underline: false, color: null }] });
    }
  }
  return segments.length ? { bgColor: '#EFF6FF', segments } : null;
}

// Determine bubble anchor position (center-top of the primary text element)
function dkpBubblePosFromElements(elements, screenW, screenH) {
  const sw = screenW || DKP_FALLBACK_W, sh = screenH || DKP_FALLBACK_H;
  const textEls = elements
    .filter(e => e.type === 'text' && e.content.length > 3 && e.size.width > 0)
    .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);
  if (!textEls.length) return null;
  const el = textEls[0];
  // Clamp to safe area
  const x = Math.min(Math.max(el.position.x + el.size.width / 2, 40), sw - 40);
  const y = Math.min(Math.max(el.position.y, 20), sh - 40);
  return { x, y };
}

// DKP bubbles represent content (not hotspot pointers), so no directional arrow needed
function dkpBubblePointer() { return 'None'; }

// ── Public: inspect .dkp ──────────────────────────────────────────
export async function inspectDkp(file) {
  const zip = await JSZip.loadAsync(file);
  const { refs } = await dkpBookInfo(zip);
  return refs.map(r => ({ id: r.id, title: r.title }));
}

// Parse a slide's own entity.xml — gives caption, preview path, and
// a classified dependency list (slide / group / book / template refs).
// Returns { caption, preview, deps: [{type,id,raw}], templateRef }
function parseDkpSlideEntityXml(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  const root = doc.documentElement;
  const caption = root.getAttribute('caption') || root.getAttribute('title') || '';
  const preview = root.getAttribute('preview') || 'preview.png';

  const deps = [];
  for (const dep of root.querySelectorAll('Dependencies > Dependency, dependency')) {
    const raw = (dep.textContent || '').trim();
    if (!raw) continue;
    const m = raw.match(/^([\w]+)!([\w]+)/);
    if (!m) continue;
    const type = m[1].toLowerCase(); // 'slide', 'group', 'book', etc.
    const id   = m[2];
    deps.push({ type, id, raw });
  }
  return { caption, preview, deps };
}

// ── Public: extract .dkp topics ───────────────────────────────────
// Returns one topic per book found in the archive.
export async function extractDkpTopics(file, allowedIds = null, onProgress = null) {
  const zip = await JSZip.loadAsync(file);
  const { books } = await dkpBookInfo(zip);

  const allTopics = [];

  for (const { caption: bookCaption, refs: allRefs, bookScreenSize, entryPointId } of books) {
  const refs = allowedIds?.length ? allRefs.filter(r => allowedIds.includes(r.id)) : allRefs;
  if (!refs.length) continue;

  const steps = [];

  for (let ri = 0; ri < refs.length; ri++) {
    const ref = refs[ri];
    onProgress?.(`Parsing slide ${ri + 1}/${refs.length}: ${ref.title}…`);
    const folder = `slide/${ref.id}`;

    // ── 1. Screenshot ──────────────────────────────────────────────
    const imageB64 = await zipEntryToB64(zip, `${folder}/preview.png`);

    // ── 1b. Read slide entity.xml (caption + dependency graph) ────
    let slideCaption = ref.title || '';
    const slideEntityEntry = zip.file(`${folder}/entity.xml`);
    if (slideEntityEntry) {
      try {
        const entityResult = parseDkpSlideEntityXml(await slideEntityEntry.async('string'));
        if (entityResult.caption) slideCaption = entityResult.caption;
      } catch { /* non-fatal */ }
    }

    // ── 2. Parse slide.xml for element positions and content ───────
    let xmlElements = [], xmlScreenW = 0, xmlScreenH = 0;
    for (const xmlName of [`${folder}/slide.xml`, `${folder}/entity.xml`]) {
      const xmlEntry = zip.file(xmlName);
      if (!xmlEntry) continue;
      try {
        const result = parseDkpSlideXml(await xmlEntry.async('string'));
        // Merge: prefer the source with more elements; take non-zero dimensions
        if (result.elements.length > xmlElements.length) xmlElements = result.elements;
        if (!xmlScreenW && result.screenW) xmlScreenW = result.screenW;
        if (!xmlScreenH && result.screenH) xmlScreenH = result.screenH;
      } catch {
        // non-fatal: try next source
      }
    }

    // ── 3. Parse slide.js for navigation and supplemental data ─────
    let jsControls = {}, jsNavigation = {}, jsScreenW = 0, jsScreenH = 0;
    let usedTemplate = false; // track whether template inheritance was applied
    const jsEntry = zip.file(`${folder}/slide.js`);
    if (jsEntry) {
      try {
        const result = parseDkpSlideJs(await jsEntry.async('string'));
        jsControls  = result.controls;
        jsNavigation = result.navigation;
        jsScreenW   = result.screenW;
        jsScreenH   = result.screenH;

        // ── Template inheritance ────────────────────────────────────
        // SAP Enable Now delta slides only carry property overrides; the full
        // layout (positions, sizes, navigation targets) lives in the template.
        // Merge: template is the base; current slide controls override by key.
        if (result.templateRef) {
          usedTemplate = true;
          const tmplFolder = `slide/${result.templateRef}`;
          let tmplXmlElements = [], tmplJsControls = {}, tmplJsW = 0, tmplJsH = 0;

          // Template slide.xml for positioned elements
          for (const tmplXmlName of [`${tmplFolder}/slide.xml`, `${tmplFolder}/entity.xml`]) {
            const tmplXmlEntry = zip.file(tmplXmlName);
            if (!tmplXmlEntry) continue;
            try {
              const r = parseDkpSlideXml(await tmplXmlEntry.async('string'));
              if (r.elements.length > tmplXmlElements.length) tmplXmlElements = r.elements;
              if (!tmplJsW && r.screenW) tmplJsW = r.screenW;
              if (!tmplJsH && r.screenH) tmplJsH = r.screenH;
            } catch { /* non-fatal */ }
          }

          // Template slide.js for navigation wiring
          const tmplJsEntry = zip.file(`${tmplFolder}/slide.js`);
          if (tmplJsEntry) {
            try {
              const r = parseDkpSlideJs(await tmplJsEntry.async('string'));
              tmplJsControls = r.controls;
              if (!tmplJsW && r.screenW) tmplJsW = r.screenW;
              if (!tmplJsH && r.screenH) tmplJsH = r.screenH;
            } catch { /* non-fatal */ }
          }

          // If the template slide isn't in the archive (no XML elements, no JS controls),
          // treat this slide as non-template so we use the slide's own XML (which often
          // contains fully-positioned hrefarea controls with correct geometry).
          if (!tmplXmlElements.length && !Object.keys(tmplJsControls).length) {
            usedTemplate = false;
          }

          // Deep-merge per control: template is the base object; delta props are
          // overlaid on top. A delta entry like {opacity:100} must NOT wipe out
          // the template's {x, y, width, height, href, ...} — it only updates the
          // properties it explicitly carries. Use a property-level merge per ID.
          const mergedControls = { ...tmplJsControls };
          for (const [id, deltaCtl] of Object.entries(jsControls)) {
            mergedControls[id] = dkpSmartMerge(tmplJsControls[id] || {}, deltaCtl);
          }
          jsControls = mergedControls;
          // Prefer template XML when it has more positioned elements than the
          // current slide's XML (delta slides often have sparse or empty XML)
          if (tmplXmlElements.length > xmlElements.length) {
            xmlElements = tmplXmlElements;
          }
          // Adopt template screen dimensions when slide has none
          if (!jsScreenW && tmplJsW) jsScreenW = tmplJsW;
          if (!jsScreenH && tmplJsH) jsScreenH = tmplJsH;
          if (!xmlScreenW && tmplJsW) xmlScreenW = tmplJsW;
          if (!xmlScreenH && tmplJsH) xmlScreenH = tmplJsH;

          // ── DEBUG template merge ──────────────────────────────────────
          const firstInteractive = Object.values(mergedControls).find(c => dkpExtractControlActions(c).length > 0);
          const deltaCtlCount = Object.keys(jsControls).length; // before reassignment
          console.log(`[DKP·tmpl] ${ref.id} → template ${result.templateRef}`,
            `\n  tmplXml=${tmplXmlElements.length} tmplJs=${Object.keys(tmplJsControls).length} delta=${deltaCtlCount} merged=${Object.keys(mergedControls).length}`,
            firstInteractive
              ? `\n  firstInteractiveMerged keys=[${Object.keys(firstInteractive).join(',')}]` +
                ` x=${firstInteractive.x} y=${firstInteractive.y} cx=${firstInteractive.cx} cy=${firstInteractive.cy} left=${firstInteractive.left} top=${firstInteractive.top}`
              : '\n  ❌ NO interactive ctrl after merge — template may have no actions or action extraction failed');
          // ─────────────────────────────────────────────────────────────
        }
      } catch {
        // non-fatal: navigation data unavailable, continue without it
      }
    }

    // ── 4. Build elements ─────────────────────────────────────────────
    // For template-based slides, jsControls already has full position+navigation
    // after the deep merge — build directly from JS to avoid position-matching
    // fragility. For regular slides, prefer XML (richer text content) and
    // supplement with JS actions via position/content matching.
    let elements;
    if (usedTemplate) {
      // JS controls are authoritative: they carry template positions + delta overrides
      elements = dkpControlsToElements(jsControls);
      // If JS gave nothing useful, fall back to XML with JS action merge
      if (!elements.some(e => e.interactive) && xmlElements.length > 0) {
        elements = dkpMergeJsActionsIntoElements(xmlElements, jsControls);
      }
    } else {
      elements = xmlElements.length > 0
        ? dkpMergeJsActionsIntoElements(xmlElements, jsControls)
        : dkpControlsToElements(jsControls);
    }

    // ── 4b. Infer positions for unpositioned nav elements ────────────
    dkpInferMissingPositions(elements, jsControls);

    // ── DEBUG element build ───────────────────────────────────────────
    {
      const interactive = elements.filter(e => e.interactive || e.actions?.length);
      const withPos  = interactive.filter(e => !e.positionInferred);
      const noPos    = interactive.filter(e =>  e.positionInferred);
      console.log(`[DKP·elems] ${ref.id} "${ref.title}"`,
        `\n  usedTemplate=${usedTemplate} xmlEl=${xmlElements.length} jsCtl=${Object.keys(jsControls).length}`,
        `\n  elements=${elements.length} interactive=${interactive.length} withPos=${withPos.length} posInferred=${noPos.length}`,
        withPos.length ? `\n  sample withPos: id=${withPos[0].id} x=${withPos[0].position.x} y=${withPos[0].position.y} w=${withPos[0].size.width} actions=${JSON.stringify(withPos[0].actions?.map(a=>a.target))}` : '',
        noPos.length   ? `\n  sample posInferred: id=${noPos[0].id} actions=${JSON.stringify(noPos[0].actions?.map(a=>a.target))}` : '');
    }
    // ─────────────────────────────────────────────────────────────────

    // ── 5. Screen resolution ───────────────────────────────────────
    // PNG natural dimensions (read from IHDR during extraction) are the most
    // reliable fallback — they match the coordinate space of the slide controls.
    const screenW = xmlScreenW || jsScreenW || bookScreenSize?.w || DKP_FALLBACK_W;
    const screenH = xmlScreenH || jsScreenH || bookScreenSize?.h || DKP_FALLBACK_H;

    // ── 6. Infer slide type and build text bubble (for PDF caption) ─
    const slideType = inferDkpStepType(elements, screenW, screenH);
    const bubble    = dkpBubbleFromElements(elements);

    // ── 7. Build navigation graph ──────────────────────────────────
    // Collect every unique target slide referenced by any element action
    const branches = [];
    const seenTargets = new Set();
    for (const el of elements) {
      for (const act of (el.actions || [])) {
        if (!act.target || seenTargets.has(act.target)) continue;
        seenTargets.add(act.target);
        const targetRef = allRefs.find(r => r.id === act.target);
        if (!targetRef) continue; // control ID or unknown target — not a slide, skip
        const rawLabel = el.content && !isInternalRef(el.content) ? el.content.slice(0, 80) : null;
        branches.push({ sourceId: el.id, label: rawLabel, event: act.event, target: act.target, targetTitle: targetRef.title });
      }
    }
    // Slide-level next from JS (default/sequential path)
    const navNext = jsNavigation.next || (ri < refs.length - 1 ? refs[ri + 1].id : null);
    const navPrev = jsNavigation.previous || (ri > 0 ? refs[ri - 1].id : null);

    steps.push({
      stepNum:    ri + 1,
      frameType:  slideType === 'tooltip' ? 'Action' : 'Explanation',
      imageB64,
      hotspot:    null,
      bubble,
      bubblePos:  null,   // DKP uses element highlight regions — no floating bubble
      pointer:    'None',
      screenW,
      screenH,
      // DKP-specific enrichment
      elements,
      navigation: { next: navNext, previous: navPrev, branches },
      slideId:    ref.id,
      slideTitle: slideCaption,
      slideType,
    });
  }

  // Determine dominant screen size from first step
  const domW = steps[0]?.screenW || DKP_FALLBACK_W;
  const domH = steps[0]?.screenH || DKP_FALLBACK_H;

  allTopics.push({
    title:        bookCaption,
    intro:        null,
    screenW:      domW,
    screenH:      domH,
    isDkpFlow:    true,
    entryPointId: entryPointId || refs[0]?.id || null,
    steps,
  });
  } // end per-book loop

  if (!allTopics.length) throw new Error('No matching slides found');
  return allTopics;
}

// ── Public: Seek Instructions PDF (print-ready HTML) ─────────────
const SEEK_ACTION_TYPE = { LClick1:'click', LClick2:'click', DClick1:'double_click', RClick1:'right_click', Type:'type', Drag:'drag' };
const SEEK_ROLE        = { ROLE_SYSTEM_BUTTONMENU:'menu', ROLE_SYSTEM_PUSHBUTTON:'button', ROLE_SYSTEM_LINK:'link', ROLE_SYSTEM_TEXT:'text_field', ROLE_SYSTEM_LISTITEM:'list_item', ROLE_SYSTEM_COMBOBOX:'dropdown', ROLE_SYSTEM_MENUITEM:'menu_item', ROLE_SYSTEM_CHECKBOX:'checkbox', ROLE_SYSTEM_RADIOBUTTON:'radio_button' };
const SEEK_ACTION_LABEL = { click:'Click', double_click:'Double Click', right_click:'Right Click', type:'Type', drag:'Drag', navigate:'Navigate', interact:'Interact' };
const SEEK_ACTION_COLOR = { click:'#FF6B18', double_click:'#e05a0d', right_click:'#6b7280', type:'#2563eb', drag:'#7c3aed', navigate:'#059669', interact:'#374151' };

function seekBubbleText(bubble) {
  if (!bubble?.segments) return '';
  return bubble.segments
    .filter(s => s.type === 'line')
    .map(s => s.segs.map(seg => seg.text).join(''))
    .filter(Boolean)
    .join(' ')
    .trim();
}

function seekNorm(v, total) { return total > 0 ? parseFloat((v / total).toFixed(4)) : 0; }

// Returns annotated data URI (or falls back to original) — Canvas spotlight + label
function seekAnnotateImage(imageB64, region, actionType, targetName) {
  if (!imageB64) return Promise.resolve(null);
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const cw = img.naturalWidth || img.width;
      const ch = img.naturalHeight || img.height;
      if (!cw || !ch) return resolve(imageB64);
      const canvas = document.createElement('canvas');
      canvas.width = cw; canvas.height = ch;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);

      if (region && region.width > 0 && region.height > 0) {
        const pad = 4;
        const rx = Math.round(region.x * cw);
        const ry = Math.round(region.y * ch);
        const rw = Math.max(4, Math.round(region.width  * cw));
        const rh = Math.max(4, Math.round(region.height * ch));

        // Spotlight: dim everything outside the anchor
        ctx.fillStyle = 'rgba(0,0,0,0.42)';
        ctx.fillRect(0,            0,          cw, Math.max(0, ry - pad));
        ctx.fillRect(0,            ry + rh + pad, cw, Math.max(0, ch - ry - rh - pad));
        ctx.fillRect(0,            ry - pad,   Math.max(0, rx - pad),            rh + pad * 2);
        ctx.fillRect(rx + rw + pad, ry - pad, Math.max(0, cw - rx - rw - pad), rh + pad * 2);

        // Anchor border
        ctx.strokeStyle = '#FF6B18';
        ctx.lineWidth   = Math.max(2, Math.round(cw / 300));
        ctx.strokeRect(rx, ry, rw, rh);

        // Label badge above anchor (or below if near top)
        const fs  = Math.max(12, Math.min(16, Math.round(cw / 80)));
        const lbl = [
          actionType ? actionType.replace(/_/g, ' ').toUpperCase() : null,
          targetName ? `"${targetName.slice(0, 50)}"` : null,
        ].filter(Boolean).join('  ');
        if (lbl) {
          ctx.font = `bold ${fs}px Arial,sans-serif`;
          const tw = ctx.measureText(lbl).width;
          const lh = fs + 10;
          const lx = Math.max(2, Math.min(rx, cw - tw - 16));
          const ly = ry >= lh + 8 ? ry - lh - 4 : Math.min(ry + rh + 4, ch - lh - 2);
          ctx.fillStyle = '#FF6B18';
          ctx.fillRect(lx, ly, tw + 14, lh);
          ctx.fillStyle = '#fff';
          ctx.fillText(lbl, lx + 7, ly + fs + 2);
        }
      }

      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => resolve(imageB64);
    img.src = imageB64;
  });
}

// Build OdArc/DKP action object from a step
function seekBuildAction(step) {
  const sw = step.screenW || 1280;
  const sh = step.screenH || 1024;

  if (step.interaction) {
    const { evtType, objName, objType } = step.interaction;
    if (evtType || objName) {
      const type = SEEK_ACTION_TYPE[evtType] || 'interact';
      const role = SEEK_ROLE[objType] || null;
      let region = null;
      if (step.hotspot && !step.hotspot.isNextBtn) {
        region = {
          x:      seekNorm(step.hotspot.left, sw),
          y:      seekNorm(step.hotspot.top,  sh),
          width:  seekNorm(step.hotspot.right  - step.hotspot.left, sw),
          height: seekNorm(step.hotspot.bottom - step.hotspot.top,  sh),
        };
      }
      return { type, ...(objName && { target: objName }), ...(role && { role }), ...(region && { region }) };
    }
  }

  if (step.elements?.length) {
    const el = step.elements.find(e => e.interactive && e.type !== 'image')
            || step.elements.find(e => e.type !== 'image');
    if (el) {
      const type = el.type === 'input'                             ? 'type'
                 : el.type === 'button' || el.type === 'hotspot'   ? 'click'
                 : el.actions?.length                               ? 'navigate'
                 : 'interact';
      const region = el.size.width > 0 && el.size.height > 0 ? {
        x: seekNorm(el.position.x, sw), y: seekNorm(el.position.y, sh),
        width: seekNorm(el.size.width, sw), height: seekNorm(el.size.height, sh),
      } : null;
      return {
        type,
        ...(el.content              && { target: el.content.slice(0, 120) }),
        role: el.type,
        ...(region                  && { region }),
        ...(el.actions?.[0]?.target && { navigateTo: el.actions[0].target }),
      };
    }
  }

  return null;
}

export async function generateSeekInstructions(allTopics, logoB64 = null) {
  // ── Resolve step data & annotate images ──────────────────────────
  const flows = [];
  for (let ti = 0; ti < allTopics.length; ti++) {
    const topic = allTopics[ti];
    const steps = [];
    for (const step of topic.steps) {
      const description = seekBubbleText(step.bubble);
      const action      = seekBuildAction(step);
      const title = step.slideTitle
        || (action?.target
            ? `${SEEK_ACTION_LABEL[action.type] || action.type} "${action.target}"`
            : description?.split(/[.!?\n]/)[0]?.trim().slice(0, 80)
            || `Step ${step.stepNum}`);
      const annotatedSrc = await seekAnnotateImage(step.imageB64, action?.region, action?.type, action?.target);
      steps.push({ stepNum: step.stepNum, title, description, imageSrc: annotatedSrc, action });
    }
    flows.push({ title: topic.title, steps });
  }

  // ── Build HTML ────────────────────────────────────────────────────
  const docTitle  = allTopics.map(t => t.title).join(' · ');
  const dateStr   = new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });
  const logoHtml  = logoB64
    ? `<img src="${logoB64}" alt="Whatfix" style="height:26px;display:block;margin-bottom:18px;filter:brightness(0) invert(1);" />`
    : `<div style="font-size:20px;font-weight:800;color:#fff;margin-bottom:18px;">Whatfix</div>`;

  const tocHtml = flows.length > 1
    ? `<div class="toc"><div class="toc-title">Flows in this document</div>${
        flows.map((f, i) => `<div class="toc-item"><span class="toc-dot">${i+1}</span><span>${escHtml(f.title)}</span><span class="toc-steps">${f.steps.length} step${f.steps.length !== 1 ? 's' : ''}</span></div>`).join('')
      }</div>` : '';

  const flowsHtml = flows.map((flow, fi) => {
    const stepsHtml = flow.steps.map(s => {
      const ac = s.action;
      const color = SEEK_ACTION_COLOR[ac?.type] || '#374151';
      const label = SEEK_ACTION_LABEL[ac?.type] || (ac?.type || '');

      const imgHtml = s.imageSrc
        ? `<div class="sc"><img src="${s.imageSrc}" alt="Step ${s.stepNum} screenshot" /></div>`
        : `<div class="sc sc-empty">No screenshot available</div>`;

      const roleHtml   = ac?.role   ? `<span class="meta-chip">${escHtml(ac.role)}</span>` : '';
      const targetHtml = ac?.target ? `<span class="meta-target">"${escHtml(ac.target)}"</span>${roleHtml}` : roleHtml;
      const navHtml    = ac?.navigateTo ? `<div class="meta-nav">Navigates to: <code>${escHtml(ac.navigateTo)}</code></div>` : '';

      const actionBlock = ac ? `
        <div class="action-row">
          <span class="action-pill" style="background:${color}">${escHtml(label)}</span>
          ${targetHtml}
        </div>${navHtml}` : '';

      const descHtml = s.description
        ? `<p class="step-desc">${escHtml(s.description)}</p>` : '';

      return `
        <div class="step-card">
          <div class="step-header">
            <span class="step-num">Step ${s.stepNum}</span>
            <span class="step-title">${escHtml(s.title)}</span>
          </div>
          ${imgHtml}
          <div class="step-meta">
            ${actionBlock}
            ${descHtml}
          </div>
        </div>`;
    }).join('');

    return `
      <div class="flow-section${fi > 0 ? ' page-break' : ''}">
        <div class="flow-header">
          <span class="flow-num">${fi + 1}</span>
          <div>
            <div class="flow-label">Flow</div>
            <div class="flow-title">${escHtml(flow.title)}</div>
          </div>
          <span class="flow-badge">${flow.steps.length} step${flow.steps.length !== 1 ? 's' : ''}</span>
        </div>
        ${stepsHtml}
      </div>`;
  }).join('');

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<title>Seek Instructions — ${escHtml(docTitle)}</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;}
  body{font-family:'Segoe UI',Arial,sans-serif;font-size:13px;color:#111;background:#fff;line-height:1.5;padding-bottom:72px;}

  /* Print bar */
  .print-bar{position:fixed;bottom:0;left:0;right:0;padding:11px 20px;background:#25223B;display:flex;align-items:center;justify-content:space-between;gap:12px;z-index:9999;border-top:2px solid #FF6B18;}
  .print-bar span{color:#c8cdd9;font-size:12px;}
  .print-btn{background:#FF6B18;color:#fff;border:none;border-radius:5px;padding:8px 20px;font-size:13px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:6px;}
  .print-btn:hover{background:#e05a0d;}
  @media print{.print-bar{display:none!important;}body{padding-bottom:0!important;}}

  /* Cover */
  .cover{background:linear-gradient(135deg,#3a3660,#25223B);color:#fff;padding:48px 40px 40px;}
  .cover-eyebrow{font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:rgba(255,255,255,.45);margin-bottom:10px;}
  .cover h1{font-size:24px;font-weight:700;line-height:1.3;margin-bottom:8px;}
  .cover-date{font-size:11px;color:rgba(255,255,255,.4);margin-top:6px;}

  /* Table of contents */
  .toc{padding:18px 40px 22px;border-bottom:1px solid #e5e7eb;}
  .toc-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:#9ca3af;margin-bottom:10px;}
  .toc-item{display:flex;align-items:center;gap:10px;padding:4px 0;font-size:12px;color:#374151;}
  .toc-dot{width:18px;height:18px;background:#FF6B18;color:#fff;border-radius:50%;font-size:9px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
  .toc-steps{margin-left:auto;font-size:11px;color:#9ca3af;}

  /* Flow section */
  .flow-section{padding:0 32px 24px;}
  .page-break{page-break-before:always;}
  .flow-header{display:flex;align-items:center;gap:14px;background:linear-gradient(90deg,#3a3660,#25223B);padding:14px 18px;border-radius:6px;margin:24px 0 16px;color:#fff;}
  .flow-num{width:28px;height:28px;border:2px solid rgba(255,255,255,.3);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0;}
  .flow-label{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:rgba(255,255,255,.4);}
  .flow-title{font-size:15px;font-weight:700;}
  .flow-badge{margin-left:auto;font-size:11px;font-weight:600;padding:3px 10px;border-radius:99px;background:rgba(255,255,255,.12);color:rgba(255,255,255,.7);white-space:nowrap;}

  /* Step card */
  .step-card{margin-bottom:24px;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;break-inside:avoid;}
  .step-header{display:flex;align-items:center;gap:10px;padding:10px 14px;background:#f9fafb;border-bottom:1px solid #e5e7eb;}
  .step-num{font-size:10px;font-weight:700;color:#FF6B18;text-transform:uppercase;letter-spacing:.5px;white-space:nowrap;}
  .step-title{font-size:13px;font-weight:600;color:#111;line-height:1.4;}

  /* Screenshot */
  .sc{border-bottom:1px solid #e5e7eb;}
  .sc img{display:block;width:100%;height:auto;}
  .sc-empty{padding:32px;text-align:center;color:#9ca3af;font-size:12px;background:#f9fafb;}

  /* Action meta */
  .step-meta{padding:11px 14px;display:flex;flex-direction:column;gap:7px;}
  .action-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
  .action-pill{display:inline-block;font-size:10px;font-weight:700;letter-spacing:.5px;color:#fff;padding:3px 9px;border-radius:99px;}
  .meta-target{font-size:12px;font-weight:600;color:#111;}
  .meta-chip{display:inline-block;font-size:10px;font-weight:500;background:#f3f4f6;color:#6b7280;border:1px solid #e5e7eb;border-radius:99px;padding:1px 7px;margin-left:4px;}
  .meta-nav{font-size:11px;color:#6b7280;}
  .meta-nav code{font-family:monospace;font-size:11px;background:#f3f4f6;padding:1px 5px;border-radius:3px;}
  .step-desc{font-size:12px;color:#374151;line-height:1.6;padding-top:4px;border-top:1px solid #f3f4f6;}
</style>
</head><body>
<div class="print-bar">
  <span>Open your browser's <strong>Print</strong> dialog and choose <strong>Save as PDF</strong>.</span>
  <button class="print-btn" onclick="window.print()">
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 5V2h8v3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><rect x="1" y="5" width="12" height="6" rx="1" stroke="currentColor" stroke-width="1.2"/><path d="M3 9h8v4H3z" stroke="currentColor" stroke-width="1.2"/><circle cx="11.5" cy="7.5" r=".6" fill="currentColor"/></svg>
    Print / Save as PDF
  </button>
</div>
<div class="cover">
  ${logoHtml}
  <div class="cover-eyebrow">Seek Instructions</div>
  <h1>${escHtml(docTitle)}</h1>
  <div class="cover-date">Generated ${dateStr}</div>
</div>
${tocHtml}
${flowsHtml}
</body></html>`;
}

// ── Helper: base64 data-URI → Uint8Array ───────────────────────────
function dataUriToUint8Array(dataUri) {
  const base64 = dataUri.split(',')[1];
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

// ── Public: generate DOCX ─────────────────────────────────────────
export async function generateDocx(topics, docName, logoB64 = null, includeTooltips = true, brandKit = null) {
  const { Document, Paragraph, TextRun, ImageRun, HeadingLevel, Packer, BorderStyle, ShadingType } = await import('docx');

  const ORANGE = (brandKit?.primaryColor || '#FF6B18').replace('#', '');
  const NAVY   = (brandKit?.accentColor  || '#25223B').replace('#', '');
  const FONT   = brandKit?.fontFamily || 'Segoe UI';
  const children = [];

  // Cover heading
  children.push(new Paragraph({
    children: [new TextRun({ text: docName || topics.map(t => t.title).join(' · '), bold: true, size: 48, color: NAVY })],
    heading: HeadingLevel.TITLE,
    spacing: { after: 240 },
  }));
  children.push(new Paragraph({
    children: [new TextRun({ text: `Generated ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`, size: 20, color: '6b7280' })],
    spacing: { after: 600 },
  }));

  for (const topic of topics) {
    // Topic heading
    children.push(new Paragraph({
      children: [new TextRun({ text: topic.title, bold: true, size: 32, color: NAVY })],
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 480, after: 200 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: ORANGE } },
    }));

    if (topic.intro?.segments?.length) {
      const introText = topic.intro.segments.filter(s => s.type === 'line').flatMap(s => s.segs).map(s => s.text).join('');
      children.push(new Paragraph({
        children: [new TextRun({ text: introText, italics: true, size: 20, color: '374151' })],
        spacing: { after: 200 },
        shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'EFF6FF' },
      }));
    }

    for (const step of topic.steps) {
      // Step label
      children.push(new Paragraph({
        children: [new TextRun({ text: `Step ${step.stepNum}`, bold: true, size: 18, color: ORANGE, allCaps: true })],
        spacing: { before: 240, after: 80 },
      }));

      // Screenshot image
      if (step.imageB64) {
        try {
          const imgData = dataUriToUint8Array(step.imageB64);
          const ext = step.imageB64.split(';')[0].split('/')[1];
          const imgType = ext === 'jpeg' || ext === 'jpg' ? 'jpg' : 'png';
          children.push(new Paragraph({
            children: [new ImageRun({ data: imgData, transformation: { width: 580, height: Math.round(580 * step.screenH / step.screenW) }, type: imgType })],
            spacing: { after: 120 },
          }));
        } catch { /* skip if image fails */ }
      }

      // Bubble text caption
      if (step.bubble?.segments?.length) {
        const bubbleText = step.bubble.segments.filter(s => s.type === 'line').flatMap(s => s.segs).map(s => s.text).join(' ');
        if (bubbleText.trim()) {
          children.push(new Paragraph({
            children: [new TextRun({ text: bubbleText, size: 19, color: '1f2937' })],
            spacing: { after: 200 },
            shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'F9F9F2' },
            border: { left: { style: BorderStyle.SINGLE, size: 12, color: ORANGE } },
            indent: { left: 180 },
          }));
        }
      }
    }
  }

  const doc = new Document({
    styles: { default: { document: { run: { font: FONT } } } },
    sections: [{ children }],
  });
  return Packer.toBlob(doc);
}

// ── Public: generate PPTX ─────────────────────────────────────────
export async function generatePptx(topics, docName, logoB64 = null, includeTooltips = true, coverOptions = {}, brandKit = null) {
  const PRIMARY = (brandKit?.primaryColor || '#FF6B18').replace('#', '');
  const DARK    = (brandKit?.accentColor  || '#25223B').replace('#', '');
  const FONT    = brandKit?.fontFamily || 'Segoe UI';

  const PptxGenJS = (await import('pptxgenjs')).default;
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE'; // 13.33" x 7.5"

  // Cover slide
  const cover = pptx.addSlide();
  cover.background = { color: DARK };
  cover.addShape('rect', { x: 0, y: 6.8, w: 13.33, h: 0.06, fill: { color: PRIMARY } });
  if (logoB64) {
    cover.addImage({ data: logoB64, x: 0.6, y: 0.6, w: 2.2, h: 0.62 });
  }
  cover.addText(docName || topics.map(t => t.title).join(' · '), { x: 0.6, y: 2.0, w: 12, h: 1.6, fontSize: 32, bold: true, color: 'FFFFFF', fontFace: FONT, wrap: true });
  if (coverOptions.subtitle) {
    cover.addText(coverOptions.subtitle, { x: 0.6, y: 3.7, w: 12, h: 0.7, fontSize: 18, color: 'CBD5E1', fontFace: FONT, wrap: true });
  }
  const metaY = coverOptions.subtitle ? 4.55 : 4.0;
  const metaParts = [];
  if (coverOptions.author) metaParts.push(coverOptions.author);
  metaParts.push(new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }));
  cover.addText(metaParts.join('  ·  '), { x: 0.6, y: metaY, w: 10, h: 0.4, fontSize: 13, color: '9ca3af', fontFace: FONT });

  for (const topic of topics) {
    // Section title slide
    const titleSlide = pptx.addSlide();
    titleSlide.background = { color: 'F9F9F2' };
    titleSlide.addShape('rect', { x: 0, y: 0, w: 0.07, h: 7.5, fill: { color: PRIMARY } });
    titleSlide.addText(topic.title, { x: 0.4, y: 2.8, w: 12.5, h: 1.2, fontSize: 28, bold: true, color: DARK, fontFace: FONT, wrap: true });
    if (topic.intro?.segments?.length) {
      const introText = topic.intro.segments.filter(s => s.type === 'line').flatMap(s => s.segs).map(s => s.text).join(' ');
      titleSlide.addText(introText, { x: 0.4, y: 4.2, w: 12.5, h: 1.4, fontSize: 14, color: '374151', fontFace: FONT, wrap: true });
    }

    for (const step of topic.steps) {
      const slide = pptx.addSlide();
      slide.background = { color: 'FFFFFF' };

      // Header bar
      slide.addShape('rect', { x: 0, y: 0, w: 13.33, h: 0.55, fill: { color: DARK } });
      slide.addText(`${topic.title}  ·  Step ${step.stepNum} of ${topic.steps.length}`, { x: 0.2, y: 0, w: 10, h: 0.55, fontSize: 11, color: 'FFFFFF', fontFace: FONT, valign: 'middle' });
      slide.addShape('rect', { x: 0, y: 0.55, w: 13.33, h: 0.04, fill: { color: PRIMARY } });

      // Screenshot — maintain aspect ratio, center in available area
      if (step.imageB64) {
        try {
          const availW = 12.93;   // slide width minus side padding
          const availH = 5.75;    // from y=0.65 to y=6.4 (above bubble text)
          const aspect = step.screenW / step.screenH;
          let imgW, imgH;
          if (aspect >= availW / availH) {
            imgW = availW;
            imgH = availW / aspect;
          } else {
            imgH = availH;
            imgW = availH * aspect;
          }
          const imgX = 0.2 + (availW - imgW) / 2;
          const imgY = 0.65 + (availH - imgH) / 2;
          slide.addImage({ data: step.imageB64, x: imgX, y: imgY, w: imgW, h: imgH });
        } catch { /* skip */ }
      }

      // Bubble text
      if (step.bubble?.segments?.length) {
        const bubbleText = step.bubble.segments.filter(s => s.type === 'line').flatMap(s => s.segs).map(s => s.text).join(' ');
        if (bubbleText.trim()) {
          const bgColor = (step.bubble.bgColor || '#C0FFFF').replace('#', '');
          slide.addText(bubbleText, {
            x: 0.2, y: 6.5, w: 12.93, h: 0.8,
            fontSize: 11, color: '111827', fontFace: FONT, wrap: true,
            fill: { color: bgColor },
            line: { color: 'e5e7eb', width: 0.5 },
            inset: 0.08,
          });
        }
      }
    }
  }

  const ab = await pptx.write({ outputType: 'arraybuffer' });
  return new Blob([ab], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
}

// ── Public: Flow Chart HTML (DKP navigation tree, canvas → PNG download) ──
export function generateFlowchartHtml(topics, docTitle = 'Flow Chart', useImages = false) {
  const dkpTopics = (topics || []).filter(t => t.isDkpFlow && t.steps?.length);
  if (!dkpTopics.length) return `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px"><p>No DKP navigation flow found.</p></body></html>`;

  const charts = dkpTopics.map(topic => _buildFlowchartLayout(topic, useImages));
  // Safe JSON embedding: prevent </script> injection
  const chartsJson = JSON.stringify(charts)
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  const modeLabel  = useImages ? 'Image Flow Chart' : 'Flow Chart';
  const safeTitle  = escHtml(docTitle);
  const safeFile   = (docTitle || 'flowchart').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-') || 'flowchart';

  const sections = charts.map((c, i) => `
    <section class="fc-section">
      <h2 class="fc-title">${escHtml(c.topicTitle)}</h2>
      <div class="fc-wrap"><canvas id="fc-canvas-${i}"></canvas></div>
    </section>`).join('');

  // All drawing happens client-side on <canvas> so the full chart is captured
  const clientScript = `
const CHARTS=${chartsJson};
const USE_IMAGES=${JSON.stringify(useImages)};
const FILENAME=${JSON.stringify(safeFile)};

function rrect(c,x,y,w,h,r){
  c.beginPath();
  c.moveTo(x+r,y);c.lineTo(x+w-r,y);c.arcTo(x+w,y,x+w,y+r,r);
  c.lineTo(x+w,y+h-r);c.arcTo(x+w,y+h,x+w-r,y+h,r);
  c.lineTo(x+r,y+h);c.arcTo(x,y+h,x,y+h-r,r);
  c.lineTo(x,y+r);c.arcTo(x,y,x+r,y,r);
  c.closePath();
}

function drawEdge(c,e){
  const {x1,y1,x2,y2,midY,fwd}=e;
  const arrLen=6;
  const stubEnd=fwd?y2-arrLen:y2+arrLen;
  c.beginPath();c.strokeStyle='#94a3b8';c.lineWidth=1.5;
  c.moveTo(x1,y1);c.lineTo(x1,midY);c.lineTo(x2,midY);c.lineTo(x2,stubEnd);
  c.stroke();
  c.beginPath();c.fillStyle='#94a3b8';
  if(fwd){c.moveTo(x2-5,y2-6);c.lineTo(x2,y2);c.lineTo(x2+5,y2-6);}
  else   {c.moveTo(x2-5,y2+6);c.lineTo(x2,y2);c.lineTo(x2+5,y2+6);}
  c.fill();
}

function drawTitleNode(c,n,nW,nH){
  const{x,y,isEntry,title,stepNum}=n;
  if(!isEntry){c.shadowColor='rgba(0,0,0,0.09)';c.shadowBlur=10;c.shadowOffsetY=2;}
  c.fillStyle=isEntry?'#FF6B18':'#fff';
  rrect(c,x,y,nW,nH,8);c.fill();
  c.shadowColor='transparent';c.shadowBlur=0;c.shadowOffsetY=0;
  c.strokeStyle=isEntry?'#FF6B18':'#e2e8f0';c.lineWidth=isEntry?2.5:1.2;
  rrect(c,x,y,nW,nH,8);c.stroke();
  c.textAlign='center';c.textBaseline='middle';
  c.font='9px "Segoe UI",Arial,sans-serif';
  c.fillStyle=isEntry?'rgba(255,255,255,0.75)':'#94a3b8';
  c.fillText('Step '+stepNum,x+nW/2,y+nH*0.34);
  c.font='600 11.5px "Segoe UI",Arial,sans-serif';
  c.fillStyle=isEntry?'#fff':'#1e293b';
  c.fillText(title,x+nW/2,y+nH*0.68);
}

async function drawImageNode(c,n,nW,nH){
  const{x,y,isEntry,title,imageB64}=n;
  const tH=30,iH=nH-tH;
  c.save();rrect(c,x,y,nW,nH,7);c.clip();
  if(imageB64){
    await new Promise(res=>{
      const img=new Image();
      img.onload=()=>{c.drawImage(img,x,y,nW,iH);res();};
      img.onerror=()=>{c.fillStyle='#e2e8f0';c.fillRect(x,y,nW,iH);res();};
      img.src=imageB64;
    });
  }else{c.fillStyle='#e2e8f0';c.fillRect(x,y,nW,iH);}
  c.fillStyle=isEntry?'#FF6B18':'#f1f5f9';
  c.fillRect(x,y+iH,nW,tH);
  c.restore();
  c.textAlign='center';c.textBaseline='middle';
  c.font=(isEntry?'600':'500')+' 10.5px "Segoe UI",Arial,sans-serif';
  c.fillStyle=isEntry?'#fff':'#374151';
  c.fillText(title,x+nW/2,y+iH+tH/2);
  rrect(c,x,y,nW,nH,7);
  c.strokeStyle=isEntry?'#FF6B18':'#d1d5db';c.lineWidth=isEntry?2.5:1.2;c.stroke();
}

async function drawChart(el,chart){
  const{nodes,edges,width,height,nodeW,nodeH}=chart;
  const dpr=window.devicePixelRatio||1;
  el.width=Math.ceil(width*dpr);el.height=Math.ceil(height*dpr);
  el.style.width=width+'px';el.style.height=height+'px';
  const c=el.getContext('2d');c.scale(dpr,dpr);
  c.fillStyle='#fff';c.fillRect(0,0,width,height);
  await document.fonts.ready;
  for(const e of edges)drawEdge(c,e);
  for(const n of nodes){
    if(USE_IMAGES)await drawImageNode(c,n,nodeW,nodeH);
    else drawTitleNode(c,n,nodeW,nodeH);
  }
}

async function downloadAllPng(){
  const btn=document.getElementById('dl-btn');
  btn.disabled=true;btn.textContent='Preparing\u2026';
  try{
    const els=[...document.querySelectorAll('[id^="fc-canvas-"]')];
    for(let i=0;i<els.length;i++){
      const a=document.createElement('a');
      a.download=FILENAME+(els.length>1?'-'+(i+1):'')+'-flowchart.png';
      a.href=els[i].toDataURL('image/png');a.click();
      if(i<els.length-1)await new Promise(r=>setTimeout(r,400));
    }
  }catch(e){alert('PNG export failed: '+e.message);}
  btn.disabled=false;btn.textContent='\u2193 Download PNG';
}

window.addEventListener('DOMContentLoaded',async()=>{
  const els=[...document.querySelectorAll('[id^="fc-canvas-"]')];
  for(let i=0;i<Math.min(els.length,CHARTS.length);i++)await drawChart(els[i],CHARTS[i]);
});`;

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<title>${safeTitle} \u2014 ${escHtml(modeLabel)}</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:'Segoe UI',system-ui,Arial,sans-serif;background:#f0f2f5;color:#1e293b;padding-bottom:68px;}
  .fc-section{padding:28px 24px 16px;}
  .fc-title{font-size:15px;font-weight:700;color:#25223B;margin-bottom:14px;padding-left:10px;border-left:3px solid #FF6B18;}
  .fc-wrap{background:#fff;border-radius:12px;box-shadow:0 1px 6px rgba(0,0,0,0.09);padding:20px;overflow-x:auto;}
  .fc-wrap canvas{display:block;}
  .bar{position:fixed;bottom:0;left:0;right:0;padding:10px 24px;background:#25223B;display:flex;align-items:center;justify-content:space-between;gap:12px;z-index:9999;border-top:2.5px solid #FF6B18;}
  .bar span{color:#c8cdd9;font-size:11.5px;}
  #dl-btn{background:#FF6B18;color:#fff;border:none;border-radius:5px;padding:8px 22px;font-size:12.5px;font-weight:600;cursor:pointer;}
  #dl-btn:hover{background:#e05a0d;}
  #dl-btn:disabled{opacity:0.6;cursor:default;}
</style></head>
<body>
${sections}
<div class="bar">
  <span>${safeTitle} &mdash; ${escHtml(modeLabel)}</span>
  <button id="dl-btn" onclick="downloadAllPng()">&#8595; Download PNG</button>
</div>
<script>${clientScript}<\/script>
</body></html>`;
}

function _buildFlowchartLayout(topic, useImages) {
  const steps   = topic.steps;
  const stepMap = new Map(steps.map(s => [s.slideId, s]));
  const entryId = topic.entryPointId || steps[0]?.slideId;

  // Outgoing edges: deduplicated, no self-loops
  const outEdges = new Map(steps.map(s => [s.slideId, new Set()]));
  for (const step of steps) {
    for (const b of (step.navigation?.branches || [])) {
      if (stepMap.has(b.target) && b.target !== step.slideId)
        outEdges.get(step.slideId).add(b.target);
    }
  }

  // BFS from entry — track each node's first-discovered parent
  const levelOf    = new Map();
  const levelNodes = [];
  const parentOf   = new Map(); // childId → parentId
  levelOf.set(entryId, 0);
  levelNodes[0] = [entryId];
  const queue = [entryId];
  while (queue.length) {
    const id = queue.shift();
    const lv = levelOf.get(id);
    for (const tgt of (outEdges.get(id) || [])) {
      if (!levelOf.has(tgt)) {
        levelOf.set(tgt, lv + 1);
        parentOf.set(tgt, id);
        if (!levelNodes[lv + 1]) levelNodes[lv + 1] = [];
        levelNodes[lv + 1].push(tgt);
        queue.push(tgt);
      }
    }
  }
  // Orphaned slides (unreachable from entry) at the bottom
  for (const step of steps) {
    if (!levelOf.has(step.slideId)) {
      const lv = levelNodes.length;
      levelOf.set(step.slideId, lv);
      if (!levelNodes[lv]) levelNodes[lv] = [];
      levelNodes[lv].push(step.slideId);
    }
  }

  const nodeW = useImages ? 200 : 190;
  const nodeH = useImages ? 145 : 66;
  const hgap  = 36;
  const vgap  = useImages ? 80 : 70;
  const padX  = 48;
  const padY  = 40;

  const maxPerRow = Math.max(...levelNodes.map(ns => ns.length));
  const canvasW   = Math.max(700, maxPerRow * (nodeW + hgap) - hgap + padX * 2);
  const canvasH   = levelNodes.length * (nodeH + vgap) - vgap + padY * 2;

  // Assign positions level-by-level.
  // KEY: before placing each level, sort its nodes by their parent's centre X.
  // This keeps children of left-side parents on the left and children of
  // right-side parents on the right — which is exactly what eliminates the
  // tangled / reversed hierarchy on either side of the tree.
  const pos = new Map();
  for (let lv = 0; lv < levelNodes.length; lv++) {
    const ns = levelNodes[lv];
    if (lv > 0) {
      ns.sort((a, b) => {
        const pA = pos.get(parentOf.get(a));
        const pB = pos.get(parentOf.get(b));
        const ax = pA ? pA.x + nodeW / 2 : canvasW / 2;
        const bx = pB ? pB.x + nodeW / 2 : canvasW / 2;
        return ax - bx;
      });
    }
    const rowW   = ns.length * (nodeW + hgap) - hgap;
    const startX = (canvasW - rowW) / 2;
    const y      = padY + lv * (nodeH + vgap);
    ns.forEach((id, i) => pos.set(id, { x: startX + i * (nodeW + hgap), y }));
  }

  // ── Edge routing: spread exits AND entries, stagger midY per level-pair ──
  // Pre-compute incoming edges per target so we can spread entry points too
  const incomingByTgt = new Map(); // tgtId -> [{srcId, srcCx}]
  for (const [srcId, targets] of outEdges) {
    const sp = pos.get(srcId);
    if (!sp) continue;
    for (const tgtId of targets) {
      if (!incomingByTgt.has(tgtId)) incomingByTgt.set(tgtId, []);
      incomingByTgt.get(tgtId).push({ srcId, srcCx: sp.x + nodeW / 2 });
    }
  }
  // Sort each target's incoming list left-to-right by source center
  for (const arr of incomingByTgt.values()) arr.sort((a, b) => a.srcCx - b.srcCx);

  // Collect raw edges (positions only, no midY yet)
  const rawEdges = [];
  const drawnCheck = new Set();
  for (const [srcId, targets] of outEdges) {
    if (!targets.size) continue;
    const sp = pos.get(srcId);
    if (!sp) continue;
    const srcLv = levelOf.get(srcId) ?? 0;
    // Sort targets left-to-right so exit-point spread order minimises crossings
    const sorted = [...targets].sort((a, b) => {
      const pa = pos.get(a), pb = pos.get(b);
      return (pa ? pa.x + nodeW / 2 : 0) - (pb ? pb.x + nodeW / 2 : 0);
    });
    const N = sorted.length;
    sorted.forEach((tgtId, exitIdx) => {
      const key = `${srcId}=>${tgtId}`;
      if (drawnCheck.has(key)) return;
      drawnCheck.add(key);
      const tp = pos.get(tgtId);
      if (!tp) return;
      const tgtLv   = levelOf.get(tgtId) ?? 0;
      const exitX   = sp.x + nodeW * (exitIdx + 1) / (N + 1);
      const exitY   = sp.y + nodeH;
      const inArr   = incomingByTgt.get(tgtId) || [];
      const entryIdx = inArr.findIndex(e => e.srcId === srcId);
      const entryX  = tp.x + nodeW * (entryIdx + 1) / (inArr.length + 1);
      const entryY  = tp.y;
      rawEdges.push({ exitX, exitY, entryX, entryY, srcLv, tgtLv, hMid: (exitX + entryX) / 2 });
    });
  }

  // Group by directed level pair; within each group stagger midY across the gap
  // so no two horizontal segments share the same Y — eliminating all overlap.
  const gapGroups = new Map();
  for (const e of rawEdges) {
    const key = `${e.srcLv}→${e.tgtLv}`;
    if (!gapGroups.has(key)) gapGroups.set(key, []);
    gapGroups.get(key).push(e);
  }
  const edges = [];
  for (const group of gapGroups.values()) {
    // Sort by horizontal midpoint → lanes assigned left-to-right consistently
    group.sort((a, b) => a.hMid - b.hMid);
    const n = group.length;
    group.forEach((e, i) => {
      const { exitX, exitY, entryX, entryY } = e;
      const fwd      = entryY >= exitY;
      const gapTop   = fwd ? exitY : entryY;
      const gapBot   = fwd ? entryY : exitY;
      const margin   = Math.min(12, (gapBot - gapTop) * 0.12);
      const rTop     = gapTop + margin;
      const rBot     = gapBot - margin;
      // Each edge in the group gets its own unique midY lane
      const midY = n === 1
        ? (rTop + rBot) / 2
        : rTop + (rBot - rTop) * (i + 1) / (n + 1);
      edges.push({ x1: exitX, y1: exitY, x2: entryX, y2: entryY, midY, fwd });
    });
  }

  const nodes = steps.map(step => {
    const p = pos.get(step.slideId);
    if (!p) return null;
    const raw   = step.slideTitle || `Step ${step.stepNum}`;
    const title = raw.length > 30 ? raw.slice(0, 29) + '\u2026' : raw;
    return {
      id: step.slideId, title, stepNum: step.stepNum,
      imageB64: useImages ? (step.imageB64 || null) : null,
      x: p.x, y: p.y,
      isEntry: step.slideId === entryId,
    };
  }).filter(Boolean);

  return { topicTitle: topic.title || 'Navigation Flow', nodes, edges, width: canvasW, height: canvasH, nodeW, nodeH };
}
