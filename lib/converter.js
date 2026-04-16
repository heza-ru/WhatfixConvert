// lib/converter.js — Browser-only ODARC converter (ESM, dynamic-import only)
// Depends on: jszip (npm), pdfmake, browser APIs (DOMParser, Blob, FileReader, fetch)

import JSZip from 'jszip';
import pdfMakeLib from 'pdfmake/build/pdfmake';
import pdfFonts   from 'pdfmake/build/vfs_fonts';
pdfMakeLib.vfs = pdfFonts;

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
export function generatePrintHtml(allTopics, logoB64 = null, includeTooltips = true) {
  const DISP_W = PRINT_DISPLAY_W;
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const totalStepsAll = allTopics.reduce((n, t) => n + t.steps.length, 0);
  const docTitle = allTopics[0]?.title || 'Guide';

  const logoHtml = logoB64
    ? `<img src="${logoB64}" alt="Logo" style="height:36px;display:block;margin-bottom:32px;filter:brightness(0) invert(1);" />`
    : `<div style="font-size:20px;font-weight:800;color:#fff;letter-spacing:-.5px;margin-bottom:32px;">Whatfix</div>`;

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
  @media print{
    .print-bar{display:none!important;}
    /* Body margins leave room for fixed running header + footer */
    body{padding-bottom:0!important;margin-top:40px!important;margin-bottom:36px!important;}
    /* Explicit page breaks between sections */
    .page-break{page-break-before:always;break-before:page;}
    /* Keep entire step card on one page when it fits */
    .step-card{break-inside:avoid;page-break-inside:avoid;}
    /* Never break immediately after the step header — keep it glued to the screenshot */
    .step-header{break-after:avoid;page-break-after:avoid;}
    /* Keep screenshot + caption together */
    .fig-wrap{break-inside:avoid;page-break-inside:avoid;}
    /* Keep instruction box intact */
    .instr-box{break-inside:avoid;page-break-inside:avoid;}
    /* Keep branch pills with whatever's above */
    .branch-row{break-inside:avoid;page-break-inside:avoid;}
    /* Never orphan a section header at the bottom of a page */
    .section-header{break-after:avoid;page-break-after:avoid;}
    /* Keep intro callout together */
    .intro-block{break-inside:avoid;page-break-inside:avoid;}
    /* Keep navigation flow table together */
    .flow-section{break-inside:avoid;page-break-inside:avoid;}
    /* TOC stays together */
    .toc{break-inside:avoid;page-break-inside:avoid;}
    /* Suppress box-shadow in print (avoids rendering artefacts on some browsers) */
    .step-card,.sc{box-shadow:none!important;}
    /* Running header/footer visible */
    .run-header,.run-footer{display:flex!important;}
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
  .sc img{display:block;width:100%;height:100%;object-fit:cover;}
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
</head><body>

<div class="run-header" aria-hidden="true">
  <span class="run-header-left">${escHtml(docTitle)}</span>
  <span class="run-header-right">Version 1.0 &nbsp;·&nbsp; ${dateStr}</span>
</div>
<div class="run-footer" aria-hidden="true">
  <span class="run-footer-left">Whatfix &mdash; Standard Operating Procedure</span>
  <span class="run-footer-right">Confidential</span>
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
export async function generatePdf(topics, docTitle, logoB64 = null, includeTooltips = true) {
  const pdfMake = pdfMakeLib;

  const ORANGE = '#FF6B18';
  const DARK   = '#1f2937';
  const GRAY   = '#6b7280';
  const COVER_BG = '#25223B';
  const COVER_BG2 = '#3a3660';
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

  // Orange-accented caption block
  function captionBlock(rt) {
    return {
      table: { widths: [3, '*'], body: [[
        { border: noBorder, canvas: [{ type: 'rect', x: 0, y: 0, w: 3, h: 60, color: ORANGE }] },
        { border: noBorder, fillColor: '#fafafa', text: rt, fontSize: 10, color: DARK, margin: [8, 6, 8, 6], lineHeight: 1.5 },
      ]]},
      layout: noLines(),
      margin: [0, 0, 0, 6],
    };
  }

  // Blue-accented intro block
  function introBlock(rt) {
    return {
      table: { widths: [3, '*'], body: [[
        { border: noBorder, canvas: [{ type: 'rect', x: 0, y: 0, w: 3, h: 60, color: '#2b7be5' }] },
        { border: noBorder, fillColor: '#f0f7ff', text: rt, fontSize: 10, color: '#1a3a5c', margin: [8, 7, 8, 7], lineHeight: 1.55 },
      ]]},
      layout: noLines(),
      margin: [0, 0, 0, 14],
    };
  }

  // Screenshot in a hairline-bordered container
  function screenshotBlock(imageB64, screenW, screenH) {
    const sw = screenW || 1024, sh = screenH || 672;
    const maxW = 515, maxH = 370;
    const fitH = Math.min(Math.round(maxW * sh / sw), maxH);
    return {
      table: { widths: [maxW], body: [[
        { image: imageB64, fit: [maxW, fitH], alignment: 'center', border: [true, true, true, true], margin: [0, 0, 0, 0] },
      ]]},
      layout: hairlines('#d1d5db'),
      margin: [0, 0, 0, 0],
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
        stepElems.push(screenshotBlock(step.imageB64, step.screenW, step.screenH));
      }

      // Caption
      if (includeTooltips && step.bubble?.segments?.length) {
        const rt = richText(step.bubble.segments);
        if (rt) stepElems.push(captionBlock(rt));
      }

      // DKP branches
      const branches = step.navigation?.branches;
      if (branches?.length) stepElems.push(branchRow(branches));

      // Wrap the whole step in a subtle card
      content.push({
        table: { widths: ['*'], body: [[{ stack: stepElems, border: [true, true, true, true], margin: [0, 0, 0, 0] }]] },
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
    footer: (page, pages) => page <= 1 ? null : {
      table: { widths: ['*', 'auto'], body: [[
        { canvas: [{ type: 'line', x1: 0, y1: 4, x2: 515, y2: 4, lineWidth: 0.5, lineColor: '#e5e7eb' }], border: noBorder, margin: [40, 0, 40, 0] },
        { text: `${page} / ${pages}`, fontSize: 8, color: '#cbd5e1', alignment: 'right', border: noBorder, margin: [0, 0, 40, 0] },
      ]]},
      layout: noLines(),
    },
    content,
    defaultStyle: { font: 'Roboto', fontSize: 10, color: DARK, lineHeight: 1.4 },
  };

  return pdfMake.createPdf(dd).getBlob();
}

// ── Public: preview HTML ───────────────────────────────────────────
export function generatePreviewHtml(topics, docTitle, logoB64 = null) {
  const slides = [{ type: 'cover', title: docTitle || topics[0]?.title || 'Guide', topics: topics.map(t => t.title) }];
  for (const topic of topics) {
    if (topic.intro?.segments?.length) slides.push({ type: 'intro', topic: topic.title, intro: topic.intro });
    for (const step of topic.steps) {
      slides.push({ type: 'step', topic: topic.title, stepNum: step.stepNum, totalSteps: topic.steps.length, frameType: step.frameType, imageB64: step.imageB64, bubble: step.bubble, bubblePos: step.bubblePos, pointer: step.pointer, hotspot: step.hotspot, screenW: step.screenW, screenH: step.screenH, slideTitle: step.slideTitle || null, slideType: step.slideType || null, slideId: step.slideId || null, branches: step.navigation?.branches || null, elements: step.elements?.length ? step.elements.filter(e => e.type !== 'image' && (e.content || e.interactive) && e.size.width > 8 && e.size.height > 8) : null });
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
  .tb-close{width:30px;height:30px;border-radius:6px;border:1px solid rgba(255,255,255,.12);background:none;color:#8a92a6;cursor:pointer;font-size:16px;display:flex;align-items:center;justify-content:center;transition:all .15s;}.tb-close:hover{background:rgba(255,255,255,.08);color:#fff;}
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
  .dkp-hl.dkp-nav{cursor:pointer;background:rgba(255,180,30,.1);border:1.5px solid rgba(255,180,30,.5);}
  .dkp-hl.dkp-nav:hover{background:rgba(255,180,30,.28);border-color:rgba(255,180,30,.95);box-shadow:0 0 0 3px rgba(255,180,30,.2);}
  .dkp-hl.dkp-info{background:rgba(59,130,246,.07);border:1.5px dashed rgba(59,130,246,.35);}
  .dkp-hl.dkp-btn{cursor:pointer;background:rgba(255,107,24,.12);border:1.5px solid rgba(255,107,24,.55);}
  .dkp-hl.dkp-btn:hover{background:rgba(255,107,24,.25);border-color:rgba(255,107,24,.9);box-shadow:0 0 0 3px rgba(255,107,24,.18);}
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
</style></head><body>
<div id="app">
  <div id="topbar">
    <div class="tb-brand">${tbLogo}<div class="tb-sep"></div><span class="tb-topic" id="tb-topic"></span></div>
    <div class="tb-progress"><span id="tb-label"></span><div class="tb-bar"><div class="tb-bar-fill" id="tb-fill"></div></div></div>
    <button class="tb-close" onclick="window.close()">✕</button>
  </div>
  <div id="stage" style="position:relative;">
    <div id="screenshot-container"></div>
    <button class="nav-arrow" id="nav-prev" onclick="go(-1)">&#8592;</button>
    <button class="nav-arrow" id="nav-next" onclick="go(1)">&#8594;</button>
    <div id="paths-panel"></div>
    <span class="key-hint">← → to navigate</span>
  </div>
  <div id="bottombar"></div>
</div>
<script>
const SLIDES=${JSON.stringify(slides)};
const COVER=${JSON.stringify(coverLogo)};
let cur=0;

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
function isIntRef(s){return!s||/[!:]/.test(s)||/\.(png|jpg|jpeg|gif|svg)$/i.test(s)||/^(GR_|SL_|CTL|TXT|IMG|OBJ|el_\d)/i.test(s)||/^[A-Z0-9]{12,}$/.test(s);}
// Build slide ID → index map for non-linear DKP navigation
const slideIdMap={};
SLIDES.forEach((s,i)=>{if(s.slideId)slideIdMap[s.slideId]=i;});
function renderById(id){const i=slideIdMap[id];render(i!=null?i:cur+1);}

function h(s){if(!s)return'';return s.map(seg=>{if(seg.type==='br')return'<br>';return(seg.segs||[]).map(s=>{let t=s.text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');if(s.bold)t='<strong>'+t+'</strong>';if(s.italic)t='<em>'+t+'</em>';if(s.underline)t='<u>'+t+'</u>';if(s.color)t='<span style="color:'+s.color+'">'+t+'</span>';return t;}).join('');}).filter(Boolean).join('');}

function render(i){cur=Math.max(0,Math.min(SLIDES.length-1,i));const slide=SLIDES[cur];const c=document.getElementById('screenshot-container');c.style.opacity='0';c.style.transform='scale(0.98)';setTimeout(()=>{c.innerHTML=buildHtml(slide);applyOverlays(slide,c);c.style.opacity='1';c.style.transform='scale(1)';updateUI(slide);},180);}

function buildHtml(s){
  if(s.type==='cover'){const n=s.topics.length;let tocHtml='';if(n>1){const show=s.topics.slice(0,5);const more=n-5;tocHtml='<ul class="toc-list">'+show.map((t,i)=>'<li><span class="toc-num">'+(i+1)+'</span><span>'+t.replace(/</g,'&lt;')+'</span></li>').join('')+(more>0?'<li style="opacity:.45;font-style:italic;padding:6px 0 0 32px;font-size:12px;border-bottom:none;">+'+more+' more…</li>':'')+'</ul>';}return'<div class="cover-slide">'+COVER+'<h1>'+s.title.replace(/</g,'&lt;')+'</h1>'+tocHtml+'<button class="cover-btn" onclick="go(1)">Start &#8594;</button></div>';}
  if(s.type==='intro')return'<div class="intro-slide"><span class="topic-pill">'+s.topic.replace(/</g,'&lt;')+'</span><h2>In this tutorial</h2><div class="intro-body">'+h(s.intro.segments)+'</div></div>';
  const img=s.imageB64?'<img id="screenshot-img" src="'+s.imageB64+'" draggable="false" />':'<div style="width:640px;height:480px;background:#25223B;display:flex;align-items:center;justify-content:center;color:#6b7280;">No screenshot</div>';
  const typeBadge=s.slideType?s.slideType:(s.frameType==='Explanation'?'Explanation':'Action');
  const chipLabel=s.slideTitle?s.slideTitle.replace(/</g,'&lt;'):'Step '+s.stepNum+' / '+s.totalSteps;
  return img+'<span class="frame-badge '+((s.frameType||'').toLowerCase())+'">'+typeBadge+'</span><span class="step-chip">'+chipLabel+'</span>';
}

function applyOverlays(s,c){
  if(s.type!=='step'||!s.imageB64)return;
  const img=c.querySelector('#screenshot-img');if(!img)return;
  function doOverlay(){
    const dW=img.offsetWidth,dH=img.offsetHeight;if(!dW||!dH)return;
    const sw=s.screenW||1024,sh=s.screenH||672;
    const sx=dW/sw,sy=dH/sh;

    // ── DKP: interactive element highlight regions ─────────────────
    if(s.elements&&s.elements.length){
      // Build a label → target map from branches for tooltip display
      const branchMap={};
      if(s.branches){for(const b of s.branches)branchMap[b.sourceId]=b;}
      let navIdx=0;
      for(const el of s.elements){
        const l=Math.round(el.position.x*sx),t=Math.round(el.position.y*sy);
        const ew=Math.round(el.size.width*sx),eh=Math.round(el.size.height*sy);
        if(l<0||t<0||ew<8||eh<8)continue;
        const firstAction=el.actions&&el.actions.length?el.actions[0]:null;
        const isNav=!!(firstAction||(el.interactive&&el.type!=='text'));
        const isBtn=el.type==='button'||el.type==='hotspot';
        const div=document.createElement('div');
        div.className='dkp-hl '+(isBtn?'dkp-btn':isNav?'dkp-nav':'dkp-info');
        div.style.cssText='left:'+l+'px;top:'+t+'px;width:'+ew+'px;height:'+eh+'px;';
        if(isNav||isBtn){
          div.setAttribute('role','button');div.setAttribute('tabindex','0');
          navIdx++;
          // Badge marker
          const badge=document.createElement('div');
          badge.className='dkp-badge '+(isBtn?'nav-badge':'nav-badge');
          badge.textContent=navIdx;
          div.appendChild(badge);
          // Click handler — navigate to specific target or fallback to next
          const targetId=firstAction?firstAction.target:null;
          div.onclick=()=>{ if(targetId)renderById(targetId);else go(1); };
          div.onkeydown=(e)=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();div.onclick();}};
        }
        // Tooltip
        const tipText=(!el.content||isIntRef(el.content))?'':el.content.slice(0,160);
        const tipAction=firstAction&&firstAction.target?'→ navigates to another slide':'';
        if(tipText||tipAction){
          const tip=document.createElement('div');tip.className='dkp-hl-tip';
          // Flip tooltip below element when near top edge
          if(t<70)tip.style.cssText='top:calc(100% + 7px);bottom:auto;';
          if(tipText)tip.appendChild(document.createTextNode(tipText));
          if(tipAction){const ta=document.createElement('div');ta.className='tip-action';ta.textContent=tipAction;tip.appendChild(ta);}
          div.appendChild(tip);
        }
        c.appendChild(div);
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
    else{btn.onclick=()=>renderById(b.target);}
    panel.appendChild(btn);
  }
}
function updateUI(s){
  document.getElementById('tb-topic').textContent=(s.slideTitle||s.topic)||(s.type==='cover'?s.title:'');
  document.getElementById('tb-fill').style.width=(SLIDES.length>1?Math.round(cur/(SLIDES.length-1)*100):100)+'%';
  document.getElementById('tb-label').textContent=s.type==='step'?'Step '+s.stepNum+' of '+s.totalSteps:(s.type==='cover'?'Overview':'Introduction');
  document.getElementById('nav-prev').disabled=cur===0;document.getElementById('nav-next').disabled=cur===SLIDES.length-1;
  const bar=document.getElementById('bottombar');bar.innerHTML='';
  for(let i=0;i<Math.min(SLIDES.length,40);i++){const d=document.createElement('button');d.className='dot-nav'+(i===cur?' active':'');d.setAttribute('title',SLIDES[i].slideTitle||SLIDES[i].topic||('Slide '+(i+1)));d.onclick=()=>render(i);bar.appendChild(d);}
  updatePaths(s);
}
function go(d){render(cur+d);}
document.addEventListener('keydown',e=>{if(e.key==='ArrowRight'||e.key===' '){e.preventDefault();go(1);}if(e.key==='ArrowLeft'){e.preventDefault();go(-1);}if(e.key==='Escape')window.close();});
render(0);
</script></body></html>`;
}

// ── DKP helpers ────────────────────────────────────────────────────
async function dkpBookInfo(zip) {
  const bookKey = Object.keys(zip.files).find(n => n.startsWith('book/') && n.endsWith('/entity.xml'));
  if (!bookKey) throw new Error('No book entity.xml found in .dkp archive');
  const xml = await zip.file(bookKey).async('string');
  const doc = parseXml(xml.replace(/^\uFEFF/, ''));
  const bookEl = doc.querySelector('book');
  const caption = bookEl?.getAttribute('caption') || 'Untitled';
  const refs = [...doc.querySelectorAll('Ref[class="slide"]')].map(r => ({
    id:    r.getAttribute('uid')     || '',
    title: r.getAttribute('caption') || r.getAttribute('uid') || '',
  })).filter(r => r.id);
  const bookW = parseInt(bookEl?.getAttribute('contentWidth') || bookEl?.getAttribute('slideWidth') || '0', 10);
  const bookH = parseInt(bookEl?.getAttribute('contentHeight') || bookEl?.getAttribute('slideHeight') || '0', 10);
  const bookScreenSize = (bookW > 100 && bookH > 100) ? { w: bookW, h: bookH } : null;
  return { caption, refs, bookScreenSize };
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

  // Collect all candidate element nodes; try tags used by SAP Enable Now / WPB
  const candidateTags = ['object','control','widget','element','textbox','label','button','image','bitmap','input','component'];
  const seen = new WeakSet();
  const rawEls = [];
  for (const tag of candidateTags) {
    for (const el of doc.querySelectorAll(tag)) {
      if (!seen.has(el)) { seen.add(el); rawEls.push(el); }
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

  const id = el.getAttribute('id') || el.getAttribute('uid') || el.getAttribute('name') || `el_${idx}`;

  // Position — try multiple attribute naming conventions
  const x = parseInt(el.getAttribute('x') || el.getAttribute('left') || el.getAttribute('posX') || el.getAttribute('pos-x') || '0', 10);
  const y = parseInt(el.getAttribute('y') || el.getAttribute('top')  || el.getAttribute('posY') || el.getAttribute('pos-y') || '0', 10);
  const w = parseInt(el.getAttribute('w') || el.getAttribute('width')  || el.getAttribute('size-w') || '0', 10);
  const h = parseInt(el.getAttribute('h') || el.getAttribute('height') || el.getAttribute('size-h') || '0', 10);

  // Type — derive from class / type attribute / tag name
  const raw = (el.getAttribute('class') || el.getAttribute('type') || el.tagName || '').toLowerCase();
  let type = 'container';
  if (/text|label|caption|title|heading|paragraph/.test(raw)) type = 'text';
  else if (/button|btn|action|click/.test(raw))               type = 'button';
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

  // Skip pure containers with no content
  if (type === 'container' && !content) return null;
  // Skip truly empty non-image elements
  if (type !== 'image' && !content) return null;

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
  const actionAttrs = ['action','href','onClick','navigateTo','goTo','link','target','targetId','linkedPage','destination'];
  for (const attr of actionAttrs) {
    const v = el.getAttribute(attr);
    if (!v) continue;
    const m = v.match(/goToSlide\s*\(\s*['"]([^'"]+)['"]\s*\)/i);
    const t = m ? m[1] : v.trim();
    if (t && !actions.some(a => a.target === t)) actions.push({ event: 'click', target: t, type: 'navigate' });
    break; // first matching attr wins
  }
  // Also check child <action>, <link>, <navigate> elements
  for (const actEl of el.querySelectorAll('action,link,navigate,handler,target')) {
    const t = actEl.getAttribute('target') || actEl.getAttribute('href') || actEl.getAttribute('targetId') || actEl.textContent.trim();
    if (t && !actions.some(a => a.target === t)) {
      const m = t.match(/goToSlide\s*\(\s*['"]([^'"]+)['"]\s*\)/i);
      actions.push({ event: actEl.getAttribute('event') || 'click', target: m ? m[1] : t.trim(), type: actEl.getAttribute('type') || 'navigate' });
    }
  }

  const interactive = actions.length > 0 || /button|hotspot|input/.test(type);
  return { id, type, content: content.trim(), position: { x, y }, size: { width: w, height: h }, style, actions, interactive };
}

// Parse slide.js — handles JSON data files and extracts controls, navigation, dimensions
function parseDkpSlideJs(jsText) {
  if (!jsText) return { controls: {}, navigation: {}, screenW: 0, screenH: 0 };
  const clean = jsText.replace(/^\uFEFF/, '');

  let data = null;
  try { data = JSON.parse(clean); } catch { /* try other forms */ }
  if (!data) {
    const m = clean.match(/(?:var|let|const)\s+\w+\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
    if (m) try { data = JSON.parse(m[1]); } catch { /* continue */ }
  }
  if (!data) {
    const m = clean.match(/(\{[\s\S]*\})\s*$/);
    if (m) try { data = JSON.parse(m[1]); } catch { /* continue */ }
  }

  if (data) {
    const screenW = parseInt(data.width || data.screenWidth || data.contentWidth || data.size?.width || 0, 10);
    const screenH = parseInt(data.height || data.screenHeight || data.contentHeight || data.size?.height || 0, 10);
    const controls = data.controls || data.objects || data.elements || data.items || {};
    const navSrc = data.navigation || data.nav || {};
    const navigation = {
      next:     navSrc.next     || navSrc.nextSlide || data.nextSlide || data.next     || null,
      previous: navSrc.prev     || navSrc.previous  || data.prevSlide || data.previous || null,
    };
    return { controls, navigation, screenW, screenH };
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
    const target = (m ? m[1] : rawTarget).trim();
    if (!target || seen.has(target)) return;
    seen.add(target);
    actions.push({ event, target, type });
  }

  // Direct scalar properties (most common in WPB JSON)
  for (const k of ['navigateTo','goTo','href','link','target','targetSlide','targetId','slideTarget','destination','pageId','linkedPage']) {
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

  return actions;
}

// Convert slide.js controls → normalized elements (includes rich styling + actions)
function dkpControlsToElements(controls) {
  const elements = [];
  let idx = 0;
  for (const [id, ctl] of Object.entries(controls || {})) {
    if (!ctl || typeof ctl !== 'object') continue;

    const raw = ctl.text || ctl.content || ctl.caption || ctl.label || ctl.value || '';
    const content = stripHtmlToText(raw).trim();

    const x = parseInt(ctl.x || ctl.left || ctl.posX || 0, 10);
    const y = parseInt(ctl.y || ctl.top  || ctl.posY || 0, 10);
    const w = parseInt(ctl.width  || ctl.w || ctl.size?.width  || 0, 10);
    const h = parseInt(ctl.height || ctl.h || ctl.size?.height || 0, 10);

    const rawKind = (ctl.type || ctl.class || ctl.kind || ctl.controlType || '').toLowerCase();
    let type = 'text';
    if      (/button|btn|pushbutton/.test(rawKind))              type = 'button';
    else if (/image|img|picture|bitmap|graphic/.test(rawKind))   type = 'image';
    else if (/input|field|textbox|entry|edit|form/.test(rawKind)) type = 'input';
    else if (/hotspot|clickarea|clickable|area|zone/.test(rawKind)) type = 'hotspot';

    const actions = dkpExtractControlActions(ctl);
    const interactive = actions.length > 0 || /button|hotspot|input/.test(type);

    // Skip truly empty non-interactive, non-image elements
    if (!content && !interactive && type !== 'image') continue;

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

    elements.push({ id: id || `el_${idx}`, type, content, position: { x, y }, size: { width: w, height: h }, style, actions, interactive });
    idx++;
  }
  elements.sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);
  return elements;
}

// After XML parse, merge in actions from the JS controls by matching on position or content
function dkpMergeJsActionsIntoElements(xmlElements, jsControls) {
  // Build lookup maps from JS controls that have actions
  const byPos = {}, byContent = {};
  for (const [id, ctl] of Object.entries(jsControls || {})) {
    const acts = dkpExtractControlActions(ctl);
    if (!acts.length) continue;
    const px = parseInt(ctl.x || ctl.left || 0, 10), py = parseInt(ctl.y || ctl.top || 0, 10);
    byPos[`${px},${py}`] = acts;
    const txt = stripHtmlToText(ctl.text || ctl.content || ctl.caption || '').trim().toLowerCase().slice(0, 60);
    if (txt.length > 3) byContent[txt] = acts;
  }
  return xmlElements.map(el => {
    if (el.actions?.length) return el;
    const posKey = `${el.position.x},${el.position.y}`;
    const acts = byPos[posKey] || byContent[el.content.toLowerCase().slice(0, 60)];
    return acts ? { ...el, actions: acts, interactive: true } : el;
  });
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

// ── Public: extract .dkp topics ───────────────────────────────────
// Returns ONE topic (the book) whose steps are the selected slides.
export async function extractDkpTopics(file, allowedIds = null, onProgress = null) {
  const zip = await JSZip.loadAsync(file);
  const { caption: bookCaption, refs: allRefs, bookScreenSize } = await dkpBookInfo(zip);

  const refs = allowedIds?.length ? allRefs.filter(r => allowedIds.includes(r.id)) : allRefs;
  if (!refs.length) throw new Error('No matching slides found');

  const steps = [];

  for (let ri = 0; ri < refs.length; ri++) {
    const ref = refs[ri];
    onProgress?.(`Parsing slide ${ri + 1}/${refs.length}: ${ref.title}…`);
    const folder = `slide/${ref.id}`;

    // ── 1. Screenshot ──────────────────────────────────────────────
    const imageB64 = await zipEntryToB64(zip, `${folder}/preview.png`);

    // ── 2. Parse slide.xml for element positions and content ───────
    let xmlElements = [], xmlScreenW = 0, xmlScreenH = 0;
    const xmlEntry = zip.file(`${folder}/slide.xml`);
    if (xmlEntry) {
      try {
        const result = parseDkpSlideXml(await xmlEntry.async('string'));
        xmlElements = result.elements;
        xmlScreenW  = result.screenW;
        xmlScreenH  = result.screenH;
      } catch (e) {
        console.warn(`[dkp] slide.xml parse failed for "${ref.title}":`, e.message);
      }
    }

    // ── 3. Parse slide.js for navigation and supplemental data ─────
    let jsControls = {}, jsNavigation = {}, jsScreenW = 0, jsScreenH = 0;
    const jsEntry = zip.file(`${folder}/slide.js`);
    if (jsEntry) {
      try {
        const result = parseDkpSlideJs(await jsEntry.async('string'));
        jsControls  = result.controls;
        jsNavigation = result.navigation;
        jsScreenW   = result.screenW;
        jsScreenH   = result.screenH;
      } catch (e) {
        console.warn(`[dkp] slide.js parse failed for "${ref.title}":`, e.message);
      }
    }

    // ── 4. Build elements: XML preferred, fallback to JS controls ─────
    let elements = xmlElements.length > 0
      ? dkpMergeJsActionsIntoElements(xmlElements, jsControls)
      : dkpControlsToElements(jsControls);

    // ── 5. Screen resolution ───────────────────────────────────────
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
      slideTitle: ref.title,
      slideType,
    });
  }

  // Determine dominant screen size from first step
  const domW = steps[0]?.screenW || DKP_FALLBACK_W;
  const domH = steps[0]?.screenH || DKP_FALLBACK_H;

  return [{
    title:      bookCaption,
    intro:      null,
    screenW:    domW,
    screenH:    domH,
    isDkpFlow:  true,
    steps,
  }];
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
export async function generateDocx(topics, docName, logoB64 = null, includeTooltips = true) {
  const { Document, Paragraph, TextRun, ImageRun, HeadingLevel, AlignmentType, Packer, BorderStyle, ShadingType } = await import('docx');

  const ORANGE = 'FF6B18', NAVY = '25223B';
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

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBlob(doc);
}

// ── Public: generate PPTX ─────────────────────────────────────────
export async function generatePptx(topics, docName, logoB64 = null, includeTooltips = true) {
  const PptxGenJS = (await import('pptxgenjs')).default;
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE'; // 13.33" x 7.5"

  // Cover slide
  const cover = pptx.addSlide();
  cover.background = { color: '25223B' };
  cover.addShape('rect', { x: 0, y: 6.8, w: 13.33, h: 0.06, fill: { color: 'FF6B18' } });
  if (logoB64) {
    cover.addImage({ data: logoB64, x: 0.6, y: 0.6, w: 2.2, h: 0.62 });
  }
  cover.addText(docName || topics.map(t => t.title).join(' · '), { x: 0.6, y: 2.2, w: 12, h: 1.6, fontSize: 32, bold: true, color: 'FFFFFF', fontFace: 'Segoe UI', wrap: true });
  cover.addText(new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }), { x: 0.6, y: 4.0, w: 8, h: 0.4, fontSize: 13, color: '9ca3af', fontFace: 'Segoe UI' });

  for (const topic of topics) {
    // Section title slide
    const titleSlide = pptx.addSlide();
    titleSlide.background = { color: 'F9F9F2' };
    titleSlide.addShape('rect', { x: 0, y: 0, w: 0.07, h: 7.5, fill: { color: 'FF6B18' } });
    titleSlide.addText(topic.title, { x: 0.4, y: 2.8, w: 12.5, h: 1.2, fontSize: 28, bold: true, color: '25223B', fontFace: 'Segoe UI', wrap: true });
    if (topic.intro?.segments?.length) {
      const introText = topic.intro.segments.filter(s => s.type === 'line').flatMap(s => s.segs).map(s => s.text).join(' ');
      titleSlide.addText(introText, { x: 0.4, y: 4.2, w: 12.5, h: 1.4, fontSize: 14, color: '374151', fontFace: 'Segoe UI', wrap: true });
    }

    for (const step of topic.steps) {
      const slide = pptx.addSlide();
      slide.background = { color: 'FFFFFF' };

      // Header bar
      slide.addShape('rect', { x: 0, y: 0, w: 13.33, h: 0.55, fill: { color: '25223B' } });
      slide.addText(`${topic.title}  ·  Step ${step.stepNum} of ${topic.steps.length}`, { x: 0.2, y: 0, w: 10, h: 0.55, fontSize: 11, color: 'FFFFFF', fontFace: 'Segoe UI', valign: 'middle' });
      slide.addShape('rect', { x: 0, y: 0.55, w: 13.33, h: 0.04, fill: { color: 'FF6B18' } });

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
            fontSize: 11, color: '111827', fontFace: 'Segoe UI', wrap: true,
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
