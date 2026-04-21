'use client';

import { useState, useRef, useCallback, useEffect, memo, useReducer } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Upload, Settings2, Download, RefreshCw, Search, ChevronDown, X, CheckCircle2, AlertCircle, UploadCloud, Copy, Check, Play, Pencil, GripVertical, HelpCircle, Link, Palette, Clock, FileText, Layers, Eye, ExternalLink, Minimize2 } from 'lucide-react';

import ErrorBoundary from './error-boundary';
import { PUBLISH_PLATFORMS } from '../lib/lms-connectors';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip';
import { Magnetic } from '@/components/animate-ui/magnetic';
import { AnimTooltip } from '@/components/animate-ui/tooltip';
import { SpringCard } from '@/components/animate-ui/spring-card';
import { BeamBorder, GlowBorder } from '@/components/animate-ui/beam-border';
import { TextReveal } from '@/components/animate-ui/text-reveal';
import { IntegrationsManager } from '@/components/integrations-manager';
import { BrandKitManager } from '@/components/brand-kit-manager';
import { ContentEditor } from '@/components/content-editor';
import { IntegrationIcon } from '@/components/brand-icons';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { loadDecryptedConfig, hasConfig } from '@/lib/crypto';
import { loadBrandKit } from '@/lib/brand-kit';
import { cn } from '@/lib/utils';

let _converterPromise = null;
function getConverter() {
  if (!_converterPromise) _converterPromise = import('../lib/converter');
  return _converterPromise;
}

const MAX_FILE_BYTES = 250 * 1024 * 1024;
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const HISTORY_KEY = 'wtfx_history';

function itemsReducer(state, action) {
  switch (action.type) {
    case 'ADD':       return [action.item, ...state];
    case 'PATCH':     return state.map(it => it.id === action.id ? { ...it, ...action.patch } : it);
    case 'DELETE':    return state.filter(it => it.id !== action.id);
    case 'CLEAR_ALL': return [];
    default: return state;
  }
}

// ─── Stagger animation container ──────────────────────────────────────
const staggerContainer = {
  hidden: {},
  show: { transition: { staggerChildren: 0.07 } },
};
const staggerItem = {
  hidden: { opacity: 0, y: 16, filter: 'blur(4px)' },
  show:   { opacity: 1, y: 0,  filter: 'blur(0px)', transition: { type: 'spring', stiffness: 300, damping: 25 } },
};

export default function Page() {
  const [items, dispatch]               = useReducer(itemsReducer, []);
  const [pendingFiles, setPendingFiles] = useState([]);
  const [fileError, setFileError]       = useState(null);
  const [inspecting, setInspecting]     = useState(false);
  const [availTopics, setAvailTopics]   = useState([]);
  const [selected, setSelected]         = useState(new Set());
  const [fileFormat, setFileFormat]     = useState('odarc');
  const [dragging, setDragging]         = useState(false);
  const [loading, setLoading]           = useState(true);
  const [fading, setFading]             = useState(false);
  const [downloadingAll, setDownloadingAll] = useState(false);
  const [undoData, setUndoData]         = useState(null);
  const [previewState, setPreviewState] = useState(null);
  const [topicSearch, setTopicSearch]   = useState('');
  const [integrationsOpen, setIntegrationsOpen] = useState(false);
  const [brandKitOpen, setBrandKitOpen]   = useState(false);
  const [editorState, setEditorState]     = useState(null); // { itemId, topics }
  const [historyOpen, setHistoryOpen]     = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [orderedTopics, setOrderedTopics] = useState([]);
  const dragIndex = useRef(null);

  const [selectedFormats] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('wtfx_formats') || 'null');
      if (saved && typeof saved.docx === 'boolean') return saved;
    } catch {}
    return { docx: false, pptx: false };
  });

  const fileInputRef    = useRef(null);
  const blobUrlsRef     = useRef([]);
  const guideListRef    = useRef(null);
  const uploadZoneRef   = useRef(null);
  const tiltRAF         = useRef(null);
  const canConvertRef   = useRef(false);
  const handleConvertRef   = useRef(null);
  const availTopicsRef     = useRef([]);
  const selectedRef        = useRef(new Set());
  const handleFileListRef  = useRef(null);

  useEffect(() => {
    const fadeTimer = setTimeout(() => setFading(true), 1600);
    const hideTimer = setTimeout(() => setLoading(false), 2100);
    return () => { clearTimeout(fadeTimer); clearTimeout(hideTimer); };
  }, []);

  // Request notification permission on mount
  useEffect(() => {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }, []);

  // Sync orderedTopics when availTopics changes
  useEffect(() => { setOrderedTopics(availTopics); }, [availTopics]);

  useEffect(() => { localStorage.setItem('wtfx_formats', JSON.stringify(selectedFormats)); }, [selectedFormats]);
  useEffect(() => { document.body.style.overflow = previewState || integrationsOpen || brandKitOpen || editorState ? 'hidden' : ''; return () => { document.body.style.overflow = ''; }; }, [previewState, integrationsOpen, brandKitOpen, editorState]);
  useEffect(() => () => { for (const url of blobUrlsRef.current) try { URL.revokeObjectURL(url); } catch { /**/ } }, []);
  useEffect(() => () => { if (undoData?.timer) clearTimeout(undoData.timer); }, [undoData]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); if (canConvertRef.current) handleConvertRef.current?.(); return; }
      if ((e.metaKey || e.ctrlKey) && e.key === 'a' && availTopicsRef.current.length > 0) {
        e.preventDefault();
        const all = availTopicsRef.current; const sel = selectedRef.current;
        setSelected(sel.size === all.length ? new Set() : new Set(all.map(t => t.id)));
      }
      if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        setShortcutsOpen(o => !o);
      }
    };
    const onPaste = (e) => { const files = [...(e.clipboardData?.files || [])]; if (files.length) { e.preventDefault(); handleFileListRef.current?.(files); } };
    window.addEventListener('keydown', onKey);
    window.addEventListener('paste', onPaste);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('paste', onPaste); };
  }, []);

  // Upload zone 3-D tilt
  const onMouseMoveTilt = useCallback((e) => {
    if (pendingFiles.length > 0) return;
    const el = uploadZoneRef.current; if (!el) return;
    if (tiltRAF.current) cancelAnimationFrame(tiltRAF.current);
    tiltRAF.current = requestAnimationFrame(() => {
      const rect = el.getBoundingClientRect();
      const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const y = Math.max(0, Math.min(1, (e.clientY - rect.top)  / rect.height));
      el.style.setProperty('--tilt-x', `${(y - 0.5) * -12}deg`);
      el.style.setProperty('--tilt-y', `${(x - 0.5) *  12}deg`);
      el.style.setProperty('--shine-x', `${x * 100}%`);
      el.style.setProperty('--shine-y', `${y * 100}%`);
    });
  }, [pendingFiles.length]);

  const onMouseLeaveTilt = useCallback(() => {
    if (tiltRAF.current) cancelAnimationFrame(tiltRAF.current);
    const el = uploadZoneRef.current; if (!el) return;
    el.style.setProperty('--tilt-x', '0deg'); el.style.setProperty('--tilt-y', '0deg');
  }, []);

  useEffect(() => { if (pendingFiles.length > 0) onMouseLeaveTilt(); }, [pendingFiles.length, onMouseLeaveTilt]);

  const createTrackedBlobUrl = useCallback((blob) => { const url = URL.createObjectURL(blob); blobUrlsRef.current.push(url); return url; }, []);
  const revokeBlobUrl        = useCallback((url) => { if (!url) return; URL.revokeObjectURL(url); blobUrlsRef.current = blobUrlsRef.current.filter(u => u !== url); }, []);
  const downloadBlob         = useCallback((blob, filename) => { const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 3000); }, []);

  const handleFileList = useCallback(async (fileList) => {
    setFileError(null);
    const valid = [...fileList].filter(f => /\.(odarc|dkp)$/i.test(f.name));
    if (!valid.length) { setFileError('Unsupported file type. Please choose .odarc or .dkp files.'); return; }
    const oversized = valid.find(f => f.size > MAX_FILE_BYTES);
    if (oversized) { setFileError(`"${oversized.name}" is too large. Maximum is 250 MB.`); return; }
    // Duplicate detection
    const currentFiles = pendingFiles;
    const firstDup = valid.find(f => currentFiles.some(pf => pf.file.name === f.name && pf.file.size === f.size));
    if (firstDup) {
      setFileError(`"${firstDup.name}" is already queued.`);
      const nonDups = valid.filter(f => !currentFiles.some(pf => pf.file.name === f.name && pf.file.size === f.size));
      if (!nonDups.length) return;
      // Fall through with only non-duplicates
      const newPending = nonDups.map(f => ({ id: crypto.randomUUID(), file: f, format: /\.dkp$/i.test(f.name) ? 'dkp' : 'odarc' }));
      setPendingFiles(newPending); setAvailTopics([]); setSelected(new Set());
      if (nonDups.length === 1) {
        const f = nonDups[0]; const isDkp = /\.dkp$/i.test(f.name);
        setFileFormat(isDkp ? 'dkp' : 'odarc'); setInspecting(true);
        try {
          const conv = await getConverter();
          const topics = isDkp ? await conv.inspectDkp(f) : await conv.inspectOdarc(f);
          setAvailTopics(topics); setSelected(new Set(topics.map(t => t.id)));
        } catch { /**/ } finally { setInspecting(false); }
      }
      return;
    }
    const newPending = valid.map(f => ({ id: crypto.randomUUID(), file: f, format: /\.dkp$/i.test(f.name) ? 'dkp' : 'odarc' }));
    setPendingFiles(newPending); setAvailTopics([]); setSelected(new Set());
    if (valid.length === 1) {
      const f = valid[0]; const isDkp = /\.dkp$/i.test(f.name);
      setFileFormat(isDkp ? 'dkp' : 'odarc'); setInspecting(true);
      try {
        const conv = await getConverter();
        const topics = isDkp ? await conv.inspectDkp(f) : await conv.inspectOdarc(f);
        setAvailTopics(topics); setSelected(new Set(topics.map(t => t.id)));
      } catch { /**/ } finally { setInspecting(false); }
    }
  }, []);

  const handleRemoveFiles = useCallback((e) => {
    e?.stopPropagation(); if (!pendingFiles.length) return;
    const saved = { files: [...pendingFiles], topics: [...availTopics], selected: new Set(selected), format: fileFormat };
    if (undoData?.timer) clearTimeout(undoData.timer);
    const timer = setTimeout(() => setUndoData(null), 5000);
    setUndoData({ ...saved, timer });
    setPendingFiles([]); setAvailTopics([]); setSelected(new Set()); setFileError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [pendingFiles, availTopics, selected, fileFormat, undoData]);

  const handleUndo = useCallback(() => {
    if (!undoData) return; clearTimeout(undoData.timer);
    setPendingFiles(undoData.files); setAvailTopics(undoData.topics); setSelected(undoData.selected); setFileFormat(undoData.format);
    setUndoData(null);
  }, [undoData]);

  const clearPendingNoUndo = useCallback(() => {
    setPendingFiles([]); setAvailTopics([]); setSelected(new Set()); setFileFormat('odarc'); setFileError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  const runConversion = useCallback(async (id, fileObj, topicIds, itemName, autoFormats) => {
    const isDkp = /\.dkp$/i.test(fileObj.name);
    try {
      const { extractTopics, extractDkpTopics, generatePrintHtml, generateDocx, generatePptx, getLogoB64 } = await getConverter();
      const bk = loadBrandKit(); const logoB64 = bk.logoB64 || await getLogoB64();
      let prog = 8;
      const onProgress = (msg) => { prog = Math.round(prog + (88 - prog) * 0.35); dispatch({ type: 'PATCH', id, patch: { lastLog: msg, progress: prog } }); };
      const topics = isDkp ? await extractDkpTopics(fileObj, topicIds, onProgress) : await extractTopics(fileObj, topicIds, onProgress);
      dispatch({ type: 'PATCH', id, patch: { lastLog: 'Generating document…', progress: 93 } });
      const html = generatePrintHtml(topics, logoB64, true, bk); const htmlClean = generatePrintHtml(topics, logoB64, false, bk);
      const printUrl = createTrackedBlobUrl(new Blob([html], { type: 'text/html' }));
      const printUrlClean = createTrackedBlobUrl(new Blob([htmlClean], { type: 'text/html' }));
      const thumbnail = topics?.[0]?.steps?.[0]?.imageB64 || null;
      dispatch({ type: 'PATCH', id, patch: { status: 'done', progress: 100, printUrl, printUrlClean, topics, thumbnail, lastLog: 'Done!' } });
      // History tracking
      try {
        const existing = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
        const entry = { id, name: itemName, timestamp: Date.now(), format: isDkp ? 'dkp' : 'odarc' };
        const updated = [entry, ...existing].slice(0, 20);
        localStorage.setItem(HISTORY_KEY, JSON.stringify(updated));
      } catch { /**/ }
      // Browser notification
      if (document.hidden && Notification.permission === 'granted') {
        new Notification('Conversion complete', { body: itemName, icon: '/whatfix.com-13.svg' });
      }
      if (autoFormats?.docx) { dispatch({ type: 'PATCH', id, patch: { exportingDocx: true } }); try { downloadBlob(await generateDocx(topics, itemName, logoB64, true, bk), `${itemName}.docx`); } finally { dispatch({ type: 'PATCH', id, patch: { exportingDocx: false } }); } }
      if (autoFormats?.pptx) { dispatch({ type: 'PATCH', id, patch: { exportingPptx: true } }); try { downloadBlob(await generatePptx(topics, itemName, logoB64, true, {}, bk), `${itemName}.pptx`); } finally { dispatch({ type: 'PATCH', id, patch: { exportingPptx: false } }); } }
    } catch (err) {
      let message = err.message || 'Conversion failed.';
      if (message.includes('manifest'))         message = 'Could not read archive manifest — the file may be corrupted or unsupported.';
      else if (message.includes('No matching')) message = 'No topics found in the selected file.';
      else if (message.includes('XML parse'))   message = 'The archive contains malformed XML and could not be parsed.';
      dispatch({ type: 'PATCH', id, patch: { status: 'error', error: message } });
    }
  }, [createTrackedBlobUrl, downloadBlob]);

  const handleConvert = useCallback(async () => {
    if (!pendingFiles.length) return;
    const filesToConvert = [...pendingFiles]; const topicsSnapshot = [...orderedTopics]; const selectedSnapshot = new Set(selected); const autoFormats = { ...selectedFormats };
    clearPendingNoUndo();
    for (const pf of filesToConvert) {
      const topicIds = filesToConvert.length === 1 && topicsSnapshot.length > 1 ? [...selectedSnapshot] : null;
      const name = (() => {
        if (!topicsSnapshot.length || filesToConvert.length > 1) return pf.file.name.replace(/\.(odarc|dkp)$/i, '');
        const pool = topicIds ? topicsSnapshot.filter(t => topicIds.includes(t.id)) : topicsSnapshot;
        return pool.map(t => t.title).join(' · ') || pf.file.name.replace(/\.(odarc|dkp)$/i, '');
      })();
      const id = crypto.randomUUID();
      dispatch({ type: 'ADD', item: { id, name, status: 'converting', lastLog: '', progress: 8, printUrl: null, topics: null, error: null, exportingSeek: false, publishedTo: [], _file: pf.file, _topicIds: topicIds } });
      runConversion(id, pf.file, topicIds, name, autoFormats);
    }
    requestAnimationFrame(() => { guideListRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); });
  }, [pendingFiles, orderedTopics, selected, selectedFormats, clearPendingNoUndo, runConversion]);

  const hasFiles   = pendingFiles.length > 0;
  const isBatch    = pendingFiles.length > 1;
  const canConvert = hasFiles && !inspecting && (isBatch || orderedTopics.length === 0 || selected.size > 0);
  canConvertRef.current = canConvert; handleConvertRef.current = handleConvert;
  availTopicsRef.current = availTopics; selectedRef.current = selected; handleFileListRef.current = handleFileList;

  const handleRetry  = useCallback((item) => { dispatch({ type: 'PATCH', id: item.id, patch: { status: 'converting', lastLog: '', progress: 8, error: null } }); runConversion(item.id, item._file, item._topicIds, item.name, {}); }, [runConversion]);
  const handlePreview = useCallback(async (item) => {
    if (!item.topics) return;
    const { generatePreviewHtml, getLogoB64 } = await getConverter();
    const html = generatePreviewHtml(item.topics, item.name, await getLogoB64());
    setPreviewState({ html, name: item.name });
  }, []);
  const handleDocx = useCallback(async (item, withTooltips) => {
    if (!item.topics) return; const { generateDocx, getLogoB64 } = await getConverter();
    const bk = loadBrandKit(); const logoB64 = bk.logoB64 || await getLogoB64();
    dispatch({ type: 'PATCH', id: item.id, patch: { exportingDocx: true } });
    try { downloadBlob(await generateDocx(item.topics, item.name, logoB64, withTooltips, bk), `${item.name}${withTooltips ? '' : '-clean'}.docx`); } finally { dispatch({ type: 'PATCH', id: item.id, patch: { exportingDocx: false } }); }
  }, [downloadBlob]);
  const handlePptx = useCallback(async (item, withTooltips, coverOptions = {}) => {
    if (!item.topics) return; const { generatePptx, getLogoB64 } = await getConverter();
    const bk = loadBrandKit(); const logoB64 = bk.logoB64 || await getLogoB64();
    dispatch({ type: 'PATCH', id: item.id, patch: { exportingPptx: true } });
    try { downloadBlob(await generatePptx(item.topics, item.name, logoB64, withTooltips, coverOptions, bk), `${item.name}${withTooltips ? '' : '-clean'}.pptx`); } finally { dispatch({ type: 'PATCH', id: item.id, patch: { exportingPptx: false } }); }
  }, [downloadBlob]);
  const handlePrint  = useCallback((item, withTooltips) => { const url = withTooltips ? item.printUrl : item.printUrlClean; if (url) window.open(url, '_blank'); }, []);
  const handleSeek   = useCallback(async (item) => {
    if (!item.topics) return; const { generateSeekInstructions, getLogoB64 } = await getConverter();
    dispatch({ type: 'PATCH', id: item.id, patch: { exportingSeek: true } });
    try { window.open(createTrackedBlobUrl(new Blob([await generateSeekInstructions(item.topics, await getLogoB64())], { type: 'text/html' })), '_blank'); } finally { dispatch({ type: 'PATCH', id: item.id, patch: { exportingSeek: false } }); }
  }, [createTrackedBlobUrl]);
  const handleFlowChart = useCallback(async (item, useImages) => {
    if (!item.topics) return;
    const { generateFlowchartHtml } = await getConverter();
    const html = generateFlowchartHtml(item.topics, item.name, useImages);
    window.open(createTrackedBlobUrl(new Blob([html], { type: 'text/html' })), '_blank');
  }, [createTrackedBlobUrl]);
  const handleScorm  = useCallback(async (item) => {
    if (!item.topics) return;
    const { generatePrintHtml, getLogoB64 } = await getConverter(); const { buildScormPackage } = await import('../lib/lms-connectors');
    const bk = loadBrandKit(); const logoB64 = bk.logoB64 || await getLogoB64();
    downloadBlob(await buildScormPackage(generatePrintHtml(item.topics, logoB64, true, bk), item.name), `${item.name}-scorm.zip`);
  }, [downloadBlob]);
  const handlePublish = useCallback(async (item, platformId, format, config) => {
    if (!item.topics) return;
    const conv = await getConverter(); const bk = loadBrandKit(); const logoB64 = bk.logoB64 || await conv.getLogoB64();
    let blob, filename, mimeType;
    if (format === 'docx')      { blob = await conv.generateDocx(item.topics, item.name, logoB64, true, bk); filename = `${item.name}.docx`; mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'; }
    else if (format === 'pptx') { blob = await conv.generatePptx(item.topics, item.name, logoB64, true, {}, bk); filename = `${item.name}.pptx`; mimeType = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'; }
    else                        { blob = await conv.generatePdf(item.topics, item.name, logoB64, true, bk);  filename = `${item.name}.pdf`;  mimeType = 'application/pdf'; }
    const fd = new FormData();
    fd.append('file', new Blob([await blob.arrayBuffer()], { type: mimeType }), filename);
    fd.append('filename', filename); fd.append('title', item.name); fd.append('format', format);
    for (const [k, v] of Object.entries(config)) { if (v !== undefined && v !== '') fd.append(k, String(v)); }
    const res = await fetch(`/api/publish/${platformId}`, { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Upload to ${platformId} failed`);
    dispatch({ type: 'PATCH', id: item.id, patch: { publishedTo: [...(item.publishedTo || []), platformId] } });
    return data;
  }, []);
  const handleOpenEditor = useCallback((item) => {
    if (!item.topics) return;
    setEditorState({ itemId: item.id, topics: item.topics });
  }, []);

  const handleSaveEditor = useCallback(async (itemId, editedTopics) => {
    const oldItem = items.find(x => x.id === itemId);
    const oldPrintUrl = oldItem?.printUrl;
    const oldPrintUrlClean = oldItem?.printUrlClean;
    setEditorState(null);
    dispatch({ type: 'PATCH', id: itemId, patch: { topics: editedTopics } });
    try {
      const { generatePrintHtml, getLogoB64 } = await getConverter();
      const bk = loadBrandKit(); const logoB64 = bk.logoB64 || await getLogoB64();
      const printUrl      = createTrackedBlobUrl(new Blob([generatePrintHtml(editedTopics, logoB64, true, bk)],  { type: 'text/html' }));
      const printUrlClean = createTrackedBlobUrl(new Blob([generatePrintHtml(editedTopics, logoB64, false, bk)], { type: 'text/html' }));
      if (oldPrintUrl)      revokeBlobUrl(oldPrintUrl);
      if (oldPrintUrlClean) revokeBlobUrl(oldPrintUrlClean);
      dispatch({ type: 'PATCH', id: itemId, patch: { printUrl, printUrlClean } });
    } catch { /* leave stale blob urls */ }
  }, [items, createTrackedBlobUrl, revokeBlobUrl]);

  const handleDelete = useCallback((id) => {
    const it = items.find(x => x.id === id);
    if (it?.printUrl) revokeBlobUrl(it.printUrl); if (it?.printUrlClean) revokeBlobUrl(it.printUrlClean);
    dispatch({ type: 'DELETE', id });
  }, [items, revokeBlobUrl]);
  const handleDownloadAll = useCallback(async () => {
    const doneItems = items.filter(it => it.status === 'done' && it.printUrlClean); if (!doneItems.length) return;
    setDownloadingAll(true);
    try {
      const { default: JSZip } = await import('jszip'); const zip = new JSZip();
      for (const it of doneItems) { const res = await fetch(it.printUrlClean); zip.file(`${it.name}-guide.html`, await res.blob()); }
      downloadBlob(await zip.generateAsync({ type: 'blob' }), 'guides.zip');
    } finally { setDownloadingAll(false); }
  }, [items, downloadBlob]);

  const onDragOver  = useCallback((e) => { e.preventDefault(); setDragging(true); }, []);
  const onDragLeave = useCallback(() => setDragging(false), []);
  const onDrop      = useCallback((e) => { e.preventDefault(); setDragging(false); handleFileList(e.dataTransfer.files); }, [handleFileList]);

  const doneCount = items.filter(it => it.status === 'done').length;

  return (
    <TooltipProvider delayDuration={300}>
      <ErrorBoundary>
        {/* Preview modal */}
        <AnimatePresence>
          {previewState && (
            <PreviewModal html={previewState.html} name={previewState.name} onClose={() => setPreviewState(null)} />
          )}
        </AnimatePresence>

        {/* Integrations manager */}
        <IntegrationsManager open={integrationsOpen} onClose={() => setIntegrationsOpen(false)} />

        {/* Brand kit panel */}
        <BrandKitManager open={brandKitOpen} onClose={() => setBrandKitOpen(false)} />

        {/* Content editor */}
        <AnimatePresence>
          {editorState && (
            <ContentEditor
              itemName={items.find(x => x.id === editorState.itemId)?.name ?? ''}
              initialTopics={editorState.topics}
              onSave={(edited) => handleSaveEditor(editorState.itemId, edited)}
              onClose={() => setEditorState(null)}
            />
          )}
        </AnimatePresence>

        {/* Keyboard shortcuts dialog */}
        <Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Keyboard Shortcuts</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 text-sm">
              {[
                [`${isMac ? '⌘↵' : 'Ctrl+Enter'}`, 'Convert'],
                [`${isMac ? '⌘A' : 'Ctrl+A'}`, 'Select / deselect all slides'],
                [`${isMac ? '⌘V' : 'Ctrl+V'}`, 'Paste file'],
                ['Double-click guide name', 'Rename'],
                ['?', 'Toggle this dialog'],
              ].map(([key, desc]) => (
                <div key={key} className="flex items-center justify-between gap-4">
                  <span className="text-[#6b7280]">{desc}</span>
                  <kbd className="text-[11px] bg-[#f3f4f6] border border-[#e5e7eb] rounded px-2 py-0.5 font-mono shrink-0">{key}</kbd>
                </div>
              ))}
            </div>
          </DialogContent>
        </Dialog>

        {/* Loading splash */}
        <div className={`loading-screen${fading ? ' fading' : ''}`} role="status" aria-label="Loading">
          <img src="/whatfix-loader.gif" alt="" width="72" height="72" />
          <p className="loading-text">Software Clicks Smarter with Whatfix</p>
        </div>

        {!loading && <>
        {/* Header */}
        <motion.header
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.3, delay: 0.05 }}
          className="sticky top-0 z-30 border-b border-[#2e2c47]" style={{ backgroundColor: '#201f32' }}>
          <div className="max-w-5xl mx-auto px-6 h-14 flex items-center gap-4 pt-2">
            <img src="/whatfix.com-13.svg" alt="Whatfix" className="h-11 w-auto" />
            <Separator orientation="vertical" className="h-5 bg-white/20" />
            <span className="text-sm font-semibold text-white/90">OdArc &amp; DKP Converter</span>
            <div className="flex-1" />
            <AnimTooltip content="View past conversions from this session" side="bottom">
              <Magnetic strength={0.3}>
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-2 text-xs text-white/80 hover:text-white hover:bg-white/10 border border-white/25 hover:border-white/40"
                  onClick={() => setHistoryOpen(o => !o)}
                  aria-label="Conversion history"
                >
                  <Clock size={13} />
                  History
                </Button>
              </Magnetic>
            </AnimTooltip>
            <AnimTooltip content="Customise colours, font, and logo applied to all exports" side="bottom">
              <Magnetic strength={0.3}>
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-2 text-xs text-white/80 hover:text-white hover:bg-white/10 border border-white/25 hover:border-white/40"
                  onClick={() => setBrandKitOpen(true)}
                >
                  <Palette size={13} />
                  Brand Kit
                </Button>
              </Magnetic>
            </AnimTooltip>
            <AnimTooltip content="Configure API credentials for LMS & knowledge base platforms" side="bottom">
              <Magnetic strength={0.3}>
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-2 text-xs text-white/80 hover:text-white hover:bg-white/10 border border-white/25 hover:border-white/40"
                  onClick={() => setIntegrationsOpen(true)}
                >
                  <Settings2 size={13} />
                  Integrations
                  {PUBLISH_PLATFORMS.filter(p => hasConfig(p.id)).length > 0 && (
                    <Badge variant="success" className="text-[10px] h-4 px-1.5 py-0">
                      {PUBLISH_PLATFORMS.filter(p => hasConfig(p.id)).length}
                    </Badge>
                  )}
                </Button>
              </Magnetic>
            </AnimTooltip>
            <AnimTooltip content="Keyboard shortcuts" side="bottom">
              <Magnetic strength={0.3}>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-white/80 hover:text-white hover:bg-white/10 border border-white/25 hover:border-white/40"
                  onClick={() => setShortcutsOpen(true)}
                  aria-label="Keyboard shortcuts"
                >
                  <HelpCircle size={14} />
                </Button>
              </Magnetic>
            </AnimTooltip>
          </div>
        </motion.header>

        <motion.main
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: 'spring', stiffness: 280, damping: 28, delay: 0.15 }}
          className="max-w-5xl mx-auto px-6 pb-24 pt-10 space-y-8"
        >

          {/* Hero */}
          {!hasFiles && !items.length && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.5, ease: [0.25,0.46,0.45,0.94] }}
              className="text-center space-y-3 pt-2 pb-4"
            >
              <h1 className="text-3xl font-bold">
                <TextReveal text="Convert Oracle UPK & SAP Enable Now" className="bg-gradient-to-r from-foreground via-foreground/90 to-foreground bg-clip-text" />
              </h1>
              <p className="text-muted-foreground text-base max-w-lg mx-auto leading-relaxed">
                Transform .odarc and .dkp files into professional PDF, DOCX, PPTX, and SCORM packages — right in your browser.
              </p>
              <div className="flex justify-center gap-4 pt-2">
                {[['Oracle UPK', '.odarc'], ['SAP Enable Now', '.dkp'], ['No upload', 'browser-only']].map(([label, sub]) => (
                  <div key={label} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <CheckCircle2 size={12} className="text-emerald-400" />
                    <span>{label}</span>
                    <code className="bg-[#f3f4f6] px-1 rounded text-[10px]">{sub}</code>
                  </div>
                ))}
              </div>
            </motion.div>
          )}

          {/* ── Upload zone ── */}
          <BeamBorder active={dragging} className="rounded-2xl">
            <div
              ref={uploadZoneRef}
              className={cn(
                'upload-zone-3d relative rounded-2xl border-2 border-dashed cursor-pointer select-none overflow-hidden',
                'transition-all duration-300',
                dragging ? 'border-[#FF6B18] bg-[#FFE9DC]/30' : 'border-[#e5e7eb] hover:border-[#FF6B18]/40',
                hasFiles ? 'border-[#FF6B18]/30 bg-white' : 'bg-white',
              )}
              style={{ minHeight: hasFiles ? 'auto' : 180 }}
              onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}
              onClick={() => !hasFiles && fileInputRef.current?.click()}
              onMouseMove={onMouseMoveTilt} onMouseLeave={onMouseLeaveTilt}
              role={hasFiles ? undefined : 'button'} tabIndex={hasFiles ? undefined : 0}
              aria-label={hasFiles ? undefined : 'Upload .odarc or .dkp files'}
              onKeyDown={e => { if (!hasFiles && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); fileInputRef.current?.click(); } }}
            >
              {/* Shine overlay */}
              <div className="absolute inset-0 pointer-events-none rounded-2xl"
                style={{ background: 'radial-gradient(circle at var(--shine-x,50%) var(--shine-y,50%), rgba(255,255,255,0.04) 0%, transparent 60%)' }} />

              {hasFiles ? (
                <div className="p-5 space-y-3">
                  <div className="flex flex-wrap gap-2">
                    {pendingFiles.map(pf => (
                      <motion.div
                        key={pf.id}
                        initial={{ scale: 0.8, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        className="flex items-center gap-2 bg-[#f3f4f6] border border-[#e5e7eb] rounded-lg px-3 py-2 text-sm text-[#111827]"
                      >
                        <FileText size={13} className="text-brand-orange" />
                        <span className="font-medium truncate max-w-[200px]">{pf.file.name}</span>
                        <span className="text-xs text-muted-foreground">{(pf.file.size/1024/1024).toFixed(1)} MB</span>
                      </motion.div>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <Button variant="ghost" size="sm" className="text-xs h-7" onClick={e => { e.stopPropagation(); fileInputRef.current?.click(); }}>
                      <Upload size={11} /> Add more
                    </Button>
                    <Button variant="ghost" size="sm" className="text-xs h-7 text-muted-foreground" onClick={handleRemoveFiles}>
                      <X size={11} /> Remove
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center gap-4 p-10">
                  <motion.div
                    animate={{ y: [0, -6, 0] }}
                    transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
                    className="w-14 h-14 rounded-2xl bg-brand-orange/10 border border-brand-orange/20 flex items-center justify-center"
                  >
                    <UploadCloud size={26} className="text-brand-orange" />
                  </motion.div>
                  <div className="text-center space-y-1">
                    <p className="text-base font-medium text-foreground">
                      Drop <strong className="text-brand-orange">.odarc</strong> or <strong className="text-brand-orange">.dkp</strong> files here
                    </p>
                    <p className="text-sm text-muted-foreground">or click to browse · multiple files supported · max 250 MB</p>
                  </div>
                </div>
              )}
              <input ref={fileInputRef} type="file" accept=".odarc,.dkp" multiple className="hidden" onChange={e => handleFileList(e.target.files)} />
            </div>
          </BeamBorder>

          {/* File error */}
          <AnimatePresence>
            {fileError && (
              <motion.div initial={{ opacity:0, y:-8 }} animate={{ opacity:1, y:0 }} exit={{ opacity:0, y:-8 }}
                className="flex items-center gap-2.5 rounded-xl bg-destructive/10 border border-destructive/25 px-4 py-3 text-sm text-destructive" role="alert">
                <AlertCircle size={14} className="shrink-0" />{fileError}
              </motion.div>
            )}
          </AnimatePresence>

          {/* History panel */}
          <AnimatePresence>
            {historyOpen && (
              <motion.div
                initial={{ opacity:0, height:0, overflow:'hidden' }} animate={{ opacity:1, height:'auto', overflow:'visible' }} exit={{ opacity:0, height:0, overflow:'hidden' }}
                transition={{ duration:0.25, ease:'easeInOut' }}
              >
                <HistoryPanel onClose={() => setHistoryOpen(false)} />
              </motion.div>
            )}
          </AnimatePresence>

          {/* Undo toast */}
          <AnimatePresence>
            {undoData && (
              <motion.div initial={{ opacity:0, y:20, scale:0.95 }} animate={{ opacity:1, y:0, scale:1 }} exit={{ opacity:0, y:20, scale:0.95 }}
                className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-xl bg-white border border-[#e5e7eb] shadow-elevated px-4 py-3 text-sm text-[#111827]"
                role="status" aria-live="polite"
              >
                <span className="text-foreground">{undoData.files.length > 1 ? `${undoData.files.length} files` : `"${undoData.files[0].file.name}"`} removed.</span>
                <Button variant="glow" size="sm" className="h-7 text-xs" onClick={handleUndo}>Undo</Button>
              </motion.div>
            )}
          </AnimatePresence>

          {/* ── Configure section ── */}
          <AnimatePresence>
            {hasFiles && (
              <motion.div
                initial={{ opacity:0, height:0, overflow:'hidden' }} animate={{ opacity:1, height:'auto', overflow:'visible' }} exit={{ opacity:0, height:0, overflow:'hidden' }}
                className="space-y-5"
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-foreground">Configure</span>
                </div>

                {inspecting && (
                  <div className="flex items-center gap-2.5 text-sm text-muted-foreground" role="status">
                    <span className="spinner" /> Reading file structure…
                  </div>
                )}

                {/* Topic picker */}
                {!inspecting && !isBatch && orderedTopics.length > 1 && (() => {
                  const allSelected = selected.size === orderedTopics.length;
                  const filtered = topicSearch ? orderedTopics.filter(t => t.title.toLowerCase().includes(topicSearch.toLowerCase())) : orderedTopics;
                  return (
                    <SpringCard className="rounded-xl">
                      <fieldset className="rounded-xl border border-[#e5e7eb] bg-white p-4 space-y-3">
                        <div className="flex items-center justify-between flex-wrap gap-2">
                          <legend className="text-sm font-semibold text-foreground flex items-center gap-2">
                            <Layers size={14} className="text-brand-orange" />
                            {fileFormat === 'dkp' ? 'Slides to include' : 'Processes to include'}
                            <Badge variant={allSelected ? 'success' : 'secondary'} className="text-[10px]">
                              {selected.size}/{orderedTopics.length}
                            </Badge>
                          </legend>
                          <div className="flex gap-2">
                            <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => setSelected(new Set(orderedTopics.map(t => t.id)))}>All</Button>
                            <Button variant="ghost" size="sm" className="h-6 text-xs text-muted-foreground" onClick={() => setSelected(new Set())}>None</Button>
                            <kbd className="text-[10px] bg-[#f3f4f6] border border-[#e5e7eb] rounded px-1.5 py-0.5 text-[#6b7280]">{isMac ? '⌘A' : 'Ctrl+A'}</kbd>
                          </div>
                        </div>

                        {orderedTopics.length > 5 && (
                          <div className="relative">
                            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                            <input
                              className="w-full pl-8 pr-3 h-8 rounded-lg bg-[#f9fafb] border border-[#e5e7eb] text-sm text-[#111827] placeholder:text-[#9ca3af] focus:outline-none focus:ring-1 focus:ring-[#FF6B18]"
                              type="search" placeholder={`Filter ${orderedTopics.length} ${fileFormat === 'dkp' ? 'slides' : 'topics'}…`}
                              value={topicSearch} onChange={e => setTopicSearch(e.target.value)} aria-label="Filter topics"
                            />
                          </div>
                        )}

                        <div className="max-h-48 overflow-y-auto pr-1 scrollbar-thin">
                          <motion.div variants={staggerContainer} initial="hidden" animate="show" className="space-y-1 pr-1">
                            {filtered.map((t, i) => (
                              <motion.label key={t.id} variants={staggerItem}
                                className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-[#f3f4f6] cursor-pointer group transition-colors"
                                draggable
                                onDragStart={() => { dragIndex.current = orderedTopics.indexOf(t); }}
                                onDragOver={(e) => { e.preventDefault(); }}
                                onDrop={(e) => {
                                  e.preventDefault();
                                  const from = dragIndex.current;
                                  const to = orderedTopics.indexOf(t);
                                  if (from === null || from === to) return;
                                  const next = [...orderedTopics];
                                  const [moved] = next.splice(from, 1);
                                  next.splice(to, 0, moved);
                                  setOrderedTopics(next);
                                  dragIndex.current = null;
                                }}
                                onDragEnd={() => { dragIndex.current = null; }}
                              >
                                <AnimTooltip content="Drag to reorder" side="left" delayDuration={600}>
                                  <span className="shrink-0"><GripVertical size={13} className="text-muted-foreground cursor-grab opacity-40 group-hover:opacity-100 transition-opacity" /></span>
                                </AnimTooltip>
                                <input type="checkbox" checked={selected.has(t.id)} className="accent-brand-orange w-3.5 h-3.5"
                                  onChange={e => setSelected(prev => { const next = new Set(prev); e.target.checked ? next.add(t.id) : next.delete(t.id); return next; })} />
                                <span className="flex-1 text-sm text-foreground truncate">{t.title}</span>
                                <span className="text-xs text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity">
                                  {fileFormat === 'dkp' ? `Slide ${i+1}` : `#${i+1}`}
                                </span>
                              </motion.label>
                            ))}
                            {filtered.length === 0 && <p className="text-xs text-muted-foreground text-center py-4">No matches for "{topicSearch}"</p>}
                          </motion.div>
                        </div>
                      </fieldset>
                    </SpringCard>
                  );
                })()}
              </motion.div>
            )}
          </AnimatePresence>

          {/* ── Convert button ── */}
          <AnimatePresence>
            {hasFiles && (
              <motion.div initial={{ opacity:0, scale:0.95 }} animate={{ opacity:1, scale:1 }} exit={{ opacity:0, scale:0.95 }} transition={{ type:'spring', stiffness:300, damping:25 }}>
                <Magnetic strength={0.25}>
                  <Button
                    variant="glow"
                    size="xl"
                    className="w-full relative overflow-hidden group"
                    disabled={!canConvert}
                    onClick={handleConvert}
                    aria-disabled={!canConvert}
                  >
                    {isBatch ? `Convert ${pendingFiles.length} Files` : 'Convert'}
                    {canConvert && (
                      <kbd className="ml-2 text-[10px] bg-white/20 border border-white/30 rounded px-1.5 py-0.5">{isMac ? '⌘↵' : 'Ctrl↵'}</kbd>
                    )}
                    {/* Shimmer sweep on hover */}
                    <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
                      style={{ background: 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.12) 50%, transparent 100%)', backgroundSize:'200%', animation:'shimmer 1.5s linear infinite' }} />
                  </Button>
                </Magnetic>
              </motion.div>
            )}
          </AnimatePresence>

          {/* ── Results ── */}
          <AnimatePresence>
            {items.length > 0 && (
              <motion.section
                ref={guideListRef}
                initial={{ opacity:0, y:20 }} animate={{ opacity:1, y:0 }}
                aria-label="Conversion results"
                className="space-y-4"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-foreground">Results</span>
                    <Badge variant="secondary">{items.length}</Badge>
                  </div>
                  <div className="flex gap-2">
                    {doneCount >= 2 && (
                      <Button variant="glass" size="sm" className="text-xs gap-1.5" onClick={handleDownloadAll} disabled={downloadingAll}>
                        <Download size={12} />{downloadingAll ? 'Zipping…' : `Download all (${doneCount})`}
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={() => {
                      items.forEach(it => { if (it.printUrl) revokeBlobUrl(it.printUrl); if (it.printUrlClean) revokeBlobUrl(it.printUrlClean); });
                      dispatch({ type: 'CLEAR_ALL' });
                    }}>Clear all</Button>
                  </div>
                </div>

                <motion.div variants={staggerContainer} initial="hidden" animate="show" className="space-y-4">
                  {items.map(item => (
                    <motion.div key={item.id} variants={staggerItem}>
                      <GuideCard
                        item={item}
                        onPreview={() => handlePreview(item)}
                        onEdit={() => handleOpenEditor(item)}
                        onPrint={(wt) => handlePrint(item, wt)}
                        onDocx={(wt) => handleDocx(item, wt)}
                        onPptx={(wt) => handlePptx(item, wt)}
                        onSeek={() => handleSeek(item)}
                        onScorm={() => handleScorm(item)}
                        onFlowChart={(useImages) => handleFlowChart(item, useImages)}
                        onPublish={(platformId, format, cfg) => handlePublish(item, platformId, format, cfg)}
                        onRetry={() => handleRetry(item)}
                        onDelete={() => handleDelete(item.id)}
                        onRename={(newName) => dispatch({ type: 'PATCH', id: item.id, patch: { name: newName } })}
                      />
                    </motion.div>
                  ))}
                </motion.div>
              </motion.section>
            )}
          </AnimatePresence>
        </motion.main>
        </>}
      </ErrorBoundary>
    </TooltipProvider>
  );
}

// ─── Guide Card ──────────────────────────────────────────────────────
const GuideCard = memo(function GuideCard({ item, onPreview, onEdit, onPrint, onDocx, onPptx, onSeek, onScorm, onFlowChart, onPublish, onRetry, onDelete, onRename }) {
  const { status, name, lastLog, progress, error, exportingDocx, exportingPptx, exportingSeek, publishedTo, printUrlClean, thumbnail } = item;
  const isDkpFlow = item.topics?.some(t => t.isDkpFlow);
  const [withTooltips, setWithTooltips] = useState(true);
  const [copied, setCopied]             = useState(false);
  const [linkCopied, setLinkCopied]     = useState(false);
  const [isDeleting, setIsDeleting]     = useState(false);
  const [elapsed, setElapsed]           = useState(0);
  const [publishOpen, setPublishOpen]   = useState(false);
  const [isRenaming, setIsRenaming]     = useState(false);
  const [draftName, setDraftName]       = useState('');
  const [nameHover, setNameHover]       = useState(false);
  const [coverOpen, setCoverOpen]       = useState(false);
  const [coverSubtitle, setCoverSubtitle] = useState('');
  const [coverAuthor, setCoverAuthor]   = useState('');
  const elapsedRef  = useRef(null);
  const cardRef     = useRef(null);
  const renameRef   = useRef(null);

  useEffect(() => {
    if (status !== 'converting') { clearInterval(elapsedRef.current); setElapsed(0); return; }
    const start = Date.now();
    elapsedRef.current = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(elapsedRef.current);
  }, [status]);

  useEffect(() => { if (isRenaming) renameRef.current?.select(); }, [isRenaming]);

  const enterRename = useCallback(() => { setDraftName(name); setIsRenaming(true); }, [name]);
  const commitRename = useCallback(() => {
    const trimmed = draftName.trim();
    if (trimmed) onRename?.(trimmed);
    setIsRenaming(false);
  }, [draftName, onRename]);
  const cancelRename = useCallback(() => setIsRenaming(false), []);

  const handleCopyName = useCallback(() => {
    navigator.clipboard.writeText(name).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }).catch(() => {});
  }, [name]);

  const handleCopyLink = useCallback(() => {
    if (!printUrlClean) return;
    navigator.clipboard.writeText(printUrlClean).then(() => { setLinkCopied(true); setTimeout(() => setLinkCopied(false), 2000); }).catch(() => {});
  }, [printUrlClean]);

  const handleDelete = useCallback(() => { setIsDeleting(true); setTimeout(onDelete, 300); }, [onDelete]);

  const onCardMouseMove  = useCallback((e) => { const el = cardRef.current; if (!el) return; const r = el.getBoundingClientRect(); el.style.setProperty('--spot-x', `${e.clientX - r.left}px`); el.style.setProperty('--spot-y', `${e.clientY - r.top}px`); }, []);
  const onCardMouseLeave = useCallback(() => { const el = cardRef.current; if (el) { el.style.setProperty('--spot-x', '-200px'); el.style.setProperty('--spot-y', '-200px'); } }, []);

  return (
    <AnimatePresence>
      {!isDeleting && (
        <motion.div
          ref={cardRef}
          initial={{ opacity:0, scale:0.97 }} animate={{ opacity:1, scale:1 }} exit={{ opacity:0, scale:0.95, y:-8 }}
          transition={{ type:'spring', stiffness:400, damping:30 }}
          className="guide-card-spotlight relative rounded-2xl border border-[#e5e7eb] bg-white p-5 space-y-4 overflow-hidden shadow-card"
          onMouseMove={onCardMouseMove} onMouseLeave={onCardMouseLeave}
          role="article" aria-label={`Guide: ${name}`}
        >
          {/* Top row */}
          <div className="flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap" onMouseEnter={() => setNameHover(true)} onMouseLeave={() => setNameHover(false)}>
                {isRenaming ? (
                  <input
                    ref={renameRef}
                    value={draftName}
                    onChange={e => setDraftName(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commitRename(); } if (e.key === 'Escape') { e.preventDefault(); cancelRename(); } }}
                    className="font-semibold text-sm text-foreground bg-[#f9fafb] border border-[#FF6B18] rounded px-2 py-0.5 outline-none max-w-[360px] w-full"
                    aria-label="Rename guide"
                  />
                ) : (
                  <>
                    <span
                      className="font-semibold text-sm text-foreground truncate max-w-[360px] cursor-default"
                      onDoubleClick={enterRename}
                    >{name}</span>
                    <button
                      onClick={enterRename}
                      className={cn('text-muted-foreground hover:text-brand-orange transition-opacity p-0.5 rounded', nameHover ? 'opacity-100' : 'opacity-0')}
                      aria-label="Rename"
                    >
                      <Pencil size={11} />
                    </button>
                  </>
                )}
                {status === 'error'      && <Badge variant="destructive" className="text-[10px]"><AlertCircle size={9} /> Failed</Badge>}
                {status === 'converting' && <Badge variant="converting" className="text-[10px]"><span className="spinner" style={{width:8,height:8,borderWidth:1.5}} /> Converting</Badge>}
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" className={cn('h-7 w-7', copied && 'text-emerald-400')} onClick={handleCopyName} aria-label={copied ? 'Copied!' : 'Copy name'}>
                    {copied ? <Check size={12} /> : <Copy size={12} />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{copied ? 'Copied!' : 'Copy name'}</TooltipContent>
              </Tooltip>
              {status === 'done' && printUrlClean && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" className={cn('h-7 w-7', linkCopied && 'text-emerald-400')} onClick={handleCopyLink} aria-label={linkCopied ? 'Copied!' : 'Copy link'}>
                      {linkCopied ? <Check size={12} /> : <Link size={12} />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{linkCopied ? 'Copied!' : 'Copy download link'}</TooltipContent>
                </Tooltip>
              )}
              <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" onClick={handleDelete} aria-label="Remove">
                <X size={13} />
              </Button>
            </div>
          </div>

          {/* Converting progress */}
          {status === 'converting' && (
            <div className="space-y-2" aria-live="polite">
              <Progress value={progress} className="h-1.5" />
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">{lastLog || 'Starting…'}</p>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  {elapsed > 0 && <span>{elapsed}s</span>}
                  <span className="font-mono font-bold text-brand-orange">{progress}%</span>
                </div>
              </div>
            </div>
          )}

          {/* Error */}
          {status === 'error' && (
            <div className="rounded-xl bg-destructive/8 border border-destructive/20 p-3 flex items-start gap-3">
              <AlertCircle size={14} className="text-destructive shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0 space-y-2">
                {error && <p className="text-xs text-destructive/90">{error}</p>}
                <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5" onClick={onRetry}>
                  <RefreshCw size={11} /> Retry
                </Button>
              </div>
            </div>
          )}

          {/* Thumbnail strip */}
          {status === 'done' && thumbnail && (
            <div
              className="relative rounded-xl overflow-hidden border border-[#e5e7eb] cursor-pointer group"
              style={{ height: 120 }}
              onClick={onPreview}
              title="Click to preview"
            >
              <img
                src={thumbnail}
                alt="First slide preview"
                className="w-full h-full object-cover object-top"
              />
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-center justify-center">
                <span className="opacity-0 group-hover:opacity-100 transition-opacity bg-black/60 text-white text-xs px-3 py-1.5 rounded-full flex items-center gap-1.5">
                  <Play size={10} /> Preview
                </span>
              </div>
            </div>
          )}

          {/* Cover slide dialog */}
          <Dialog open={coverOpen} onOpenChange={setCoverOpen}>
            <DialogContent className="max-w-sm">
              <DialogHeader>
                <DialogTitle>Customise Cover Slide</DialogTitle>
              </DialogHeader>
              <div className="space-y-3 pt-1">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-[#374151]">Subtitle <span className="text-[#9ca3af] font-normal">(optional)</span></label>
                  <input
                    value={coverSubtitle}
                    onChange={e => setCoverSubtitle(e.target.value)}
                    placeholder="e.g. Onboarding Guide · Q2 2026"
                    className="w-full h-9 px-3 rounded-lg border border-[#e5e7eb] text-sm text-[#111827] bg-white focus:outline-none focus:ring-2 focus:ring-[#FF6B18]/40"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-[#374151]">Author <span className="text-[#9ca3af] font-normal">(optional)</span></label>
                  <input
                    value={coverAuthor}
                    onChange={e => setCoverAuthor(e.target.value)}
                    placeholder="e.g. Learning & Development Team"
                    className="w-full h-9 px-3 rounded-lg border border-[#e5e7eb] text-sm text-[#111827] bg-white focus:outline-none focus:ring-2 focus:ring-[#FF6B18]/40"
                  />
                </div>
                <div className="flex gap-2 pt-1">
                  <Button variant="outline" size="sm" className="flex-1" onClick={() => setCoverOpen(false)}>Cancel</Button>
                  <Button
                    size="sm"
                    className="flex-1 bg-[#FF6B18] hover:bg-[#e05a0d] text-white"
                    disabled={exportingPptx}
                    onClick={() => {
                      setCoverOpen(false);
                      onPptx(withTooltips, { subtitle: coverSubtitle.trim(), author: coverAuthor.trim() });
                    }}
                  >
                    {exportingPptx ? <span className="spinner" style={{width:10,height:10,borderWidth:1.5}}/> : 'Export PPTX'}
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>

          {/* Done — export actions */}
          {status === 'done' && (
            <div className="space-y-3">
              <div className="flex items-center gap-3 flex-wrap">
                {/* Tooltip toggle */}
                <AnimTooltip content="Include annotation callouts and step labels in the exported document" side="top">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <Switch checked={withTooltips} onCheckedChange={setWithTooltips} />
                    <span className="text-xs text-muted-foreground">Tooltips</span>
                  </label>
                </AnimTooltip>
                <Separator orientation="vertical" className="h-5" />
                {/* Export buttons */}
                <AnimTooltip content="Open an interactive HTML preview in a new tab" side="top">
                  <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5" onClick={onPreview}>
                    <Play size={11} /> Preview
                  </Button>
                </AnimTooltip>
                <AnimTooltip content="Edit step descriptions and remove steps before exporting" side="top">
                  <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5" onClick={onEdit}>
                    <Pencil size={11} /> Edit
                  </Button>
                </AnimTooltip>
                <AnimTooltip content="Open print-ready HTML in a new tab — use browser print to save as PDF" side="top">
                  <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => onPrint(withTooltips)}>PDF</Button>
                </AnimTooltip>
                <AnimTooltip content="Download as a Word document (.docx)" side="top">
                  <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => onDocx(withTooltips)} disabled={exportingDocx}>
                    {exportingDocx ? <span className="spinner" style={{width:10,height:10,borderWidth:1.5}}/> : 'DOCX'}
                  </Button>
                </AnimTooltip>
                <AnimTooltip content="Export as a PowerPoint presentation — customise the cover slide before downloading" side="top">
                  <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setCoverOpen(true)} disabled={exportingPptx}>
                    {exportingPptx ? <span className="spinner" style={{width:10,height:10,borderWidth:1.5}}/> : 'PPTX'}
                  </Button>
                </AnimTooltip>
                <Separator orientation="vertical" className="h-5" />
                <AnimTooltip content="Generate Seek-compatible step-by-step instructions optimised for screen reader navigation" side="top">
                  <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5" onClick={onSeek} disabled={exportingSeek}>
                    <Search size={11} /> {exportingSeek ? '…' : 'Seek'}
                  </Button>
                </AnimTooltip>
                {isDkpFlow && (<>
                  <Separator orientation="vertical" className="h-5" />
                  <AnimTooltip content="Open a printable flow chart tree showing slide titles and navigation paths — save as PDF via browser print" side="top">
                    <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5" onClick={() => onFlowChart(false)}>
                      <Layers size={11} /> Flow Chart
                    </Button>
                  </AnimTooltip>
                  <AnimTooltip content="Open a printable flow chart tree with slide screenshot thumbnails — save as PDF via browser print" side="top">
                    <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5" onClick={() => onFlowChart(true)}>
                      <Eye size={11} /> Flow Chart (Images)
                    </Button>
                  </AnimTooltip>
                </>)}
                <Separator orientation="vertical" className="h-5" />
                <AnimTooltip content="Push to an LMS or knowledge base, or download as a SCORM package" side="top">
                  <Button
                    variant="outline" size="sm"
                    className={cn('h-8 text-xs gap-1.5', publishOpen && 'bg-[#f3f4f6]')}
                    onClick={() => setPublishOpen(o => !o)}
                    aria-expanded={publishOpen}
                  >
                    <UploadCloud size={11} /> Publish
                    <ChevronDown size={10} className={cn('transition-transform', publishOpen && 'rotate-180')} />
                  </Button>
                </AnimTooltip>
              </div>

              <AnimatePresence>
                {publishOpen && (
                  <motion.div
                    initial={{ height:0, opacity:0 }} animate={{ height:'auto', opacity:1 }} exit={{ height:0, opacity:0 }}
                    transition={{ duration:0.25, ease:'easeInOut' }}
                    className="overflow-hidden"
                  >
                    <PublishDrawer onScorm={onScorm} onPublish={onPublish} />
                  </motion.div>
                )}
              </AnimatePresence>

              {publishedTo?.length > 0 && (
                <div className="flex items-center gap-2 flex-wrap pt-1">
                  <span className="text-xs text-muted-foreground">Published to:</span>
                  {publishedTo.map(pid => (
                    <Tooltip key={pid}>
                      <TooltipTrigger asChild>
                        <span><IntegrationIcon platformId={pid} size={20} /></span>
                      </TooltipTrigger>
                      <TooltipContent>{pid}</TooltipContent>
                    </Tooltip>
                  ))}
                </div>
              )}
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
});

// ─── Publish Drawer ──────────────────────────────────────────────────
function PublishDrawer({ onScorm, onPublish }) {
  const [tab, setTab]             = useState('lms');
  const [uploadState, setUploadState] = useState({});
  const [scormBusy, setScormBusy] = useState(false);

  const lmsPlatforms = PUBLISH_PLATFORMS.filter(p => p.type === 'lms');
  const kbPlatforms  = PUBLISH_PLATFORMS.filter(p => p.type === 'kb');
  const shown = tab === 'lms' ? lmsPlatforms : kbPlatforms;

  const isConfigured = (p) => hasConfig(p.id);

  const doUpload = async (platform, format) => {
    setUploadState(s => ({ ...s, [platform.id]: { busy: format, ok: false, err: null } }));
    try {
      const config = await loadDecryptedConfig(platform.id);
      await onPublish(platform.id, format, config);
      setUploadState(s => ({ ...s, [platform.id]: { busy: null, ok: true, err: null } }));
      setTimeout(() => setUploadState(s => ({ ...s, [platform.id]: { ...s[platform.id], ok: false } })), 4000);
    } catch (err) {
      setUploadState(s => ({ ...s, [platform.id]: { busy: null, ok: false, err: err.message || 'Upload failed' } }));
    }
  };

  const doScorm = async () => { setScormBusy(true); try { await onScorm(); } finally { setScormBusy(false); } };

  return (
    <div className="rounded-xl border border-[#e5e7eb] bg-[#f9fafb] p-4 space-y-4">
      {/* Tab bar + SCORM */}
      <div className="flex items-center gap-2 flex-wrap">
        <Tabs value={tab} onValueChange={setTab} className="flex-1">
          <TabsList className="h-8">
            <TabsTrigger value="lms" className="text-xs py-1">LMS ({lmsPlatforms.length})</TabsTrigger>
            <TabsTrigger value="kb"  className="text-xs py-1">Knowledge Base ({kbPlatforms.length})</TabsTrigger>
          </TabsList>
        </Tabs>
        <AnimTooltip content="Package as a SCORM 1.2 .zip — import directly into any SCORM-compatible LMS" side="top">
          <Button variant="glass" size="sm" className="h-8 text-xs gap-1.5" onClick={doScorm} disabled={scormBusy}>
            <Download size={11} />{scormBusy ? 'Generating…' : 'SCORM .zip'}
          </Button>
        </AnimTooltip>
      </div>

      {/* Platform grid */}
      <motion.div variants={staggerContainer} initial="hidden" animate="show" className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {shown.map(p => {
          const state = uploadState[p.id] || {};
          const configured = isConfigured(p);
          return (
            <motion.div key={p.id} variants={staggerItem}>
              <GlowBorder color={p.color} className="rounded-xl">
                <div className="rounded-xl bg-white border border-[#e5e7eb] p-3 space-y-2">
                  <div className="flex items-center gap-2.5">
                    <IntegrationIcon platformId={p.id} size={28} />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold text-foreground">{p.name}</p>
                      <p className="text-[10px] text-muted-foreground leading-tight line-clamp-2">{p.description}</p>
                    </div>
                    {configured
                      ? <Badge variant="success" className="text-[9px] shrink-0">Ready</Badge>
                      : <Badge variant="outline" className="text-[9px] shrink-0 opacity-50">Setup</Badge>
                    }
                  </div>

                  {!configured && (
                    <p className="text-[10px] text-[#6b7280] bg-[#f3f4f6] rounded-lg px-2.5 py-1.5">
                      Configure this integration in <button className="text-brand-orange hover:underline" onClick={() => {
                        // Integrations manager is at page level
                        document.querySelector('[data-integrations-trigger]')?.click();
                      }}>Integrations settings</button>
                    </p>
                  )}

                  {configured && (
                    <div className="flex gap-1.5 flex-wrap">
                      {p.formats.map(fmt => (
                        <Button
                          key={fmt}
                          variant="outline"
                          size="sm"
                          className="h-6 text-[10px] px-2"
                          disabled={!!state.busy}
                          onClick={() => doUpload(p, fmt)}
                        >
                          {state.busy === fmt ? <span className="spinner" style={{width:8,height:8,borderWidth:1.5}}/> : fmt.toUpperCase()}
                        </Button>
                      ))}
                    </div>
                  )}

                  {state.ok && (
                    <div className="flex items-center gap-1.5 text-[10px] text-emerald-400">
                      <CheckCircle2 size={10} /> Uploaded successfully
                    </div>
                  )}
                  {state.err && (
                    <div className="flex items-start gap-1.5 text-[10px] text-destructive">
                      <AlertCircle size={10} className="shrink-0 mt-0.5" />{state.err}
                    </div>
                  )}
                </div>
              </GlowBorder>
            </motion.div>
          );
        })}
      </motion.div>
    </div>
  );
}

// ─── History Panel ───────────────────────────────────────────────────
function HistoryPanel({ onClose }) {
  const [entries, setEntries] = useState(() => {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; }
  });

  const removeEntry = useCallback((id) => {
    setEntries(prev => {
      const next = prev.filter(e => e.id !== id);
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch { /**/ }
      return next;
    });
  }, []);

  const clearAll = useCallback(() => {
    setEntries([]);
    try { localStorage.removeItem(HISTORY_KEY); } catch { /**/ }
  }, []);

  const relativeTime = (ts) => {
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  };

  return (
    <div className="rounded-xl border border-[#e5e7eb] bg-white p-4 space-y-3 shadow-card">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-foreground flex items-center gap-2"><Clock size={13} className="text-brand-orange" />Conversion History</span>
        <div className="flex items-center gap-2">
          {entries.length > 0 && (
            <Button variant="ghost" size="sm" className="h-6 text-[10px] text-muted-foreground" onClick={clearAll}>Clear history</Button>
          )}
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onClose}><X size={12} /></Button>
        </div>
      </div>
      {entries.length === 0 ? (
        <p className="text-xs text-muted-foreground text-center py-4">No conversions yet.</p>
      ) : (
        <motion.div variants={staggerContainer} initial="hidden" animate="show" className="space-y-1.5">
          {entries.map(e => (
            <motion.div key={e.id} variants={staggerItem} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-[#f9fafb] border border-[#e5e7eb] text-sm">
              <span className="flex-1 truncate text-[#111827] text-xs font-medium">{e.name}</span>
              <Badge variant="secondary" className="text-[9px] shrink-0">{e.format.toUpperCase()}</Badge>
              <span className="text-[10px] text-muted-foreground shrink-0">{relativeTime(e.timestamp)}</span>
              <button onClick={() => removeEntry(e.id)} className="text-muted-foreground hover:text-destructive transition-colors shrink-0" aria-label="Remove entry">
                <X size={11} />
              </button>
            </motion.div>
          ))}
        </motion.div>
      )}
    </div>
  );
}

// ─── Preview Modal ───────────────────────────────────────────────────
function PreviewModal({ html, name, onClose }) {
  const [blobUrl, setBlobUrl] = useState(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const modalRef = useRef(null);

  useEffect(() => { const url = URL.createObjectURL(new Blob([html], { type: 'text/html' })); setBlobUrl(url); return () => URL.revokeObjectURL(url); }, [html]);
  useEffect(() => { const onKey = (e) => { if (e.key === 'Escape' && !document.fullscreenElement) onClose(); }; document.addEventListener('keydown', onKey); return () => document.removeEventListener('keydown', onKey); }, [onClose]);
  useEffect(() => { const onMsg = (e) => { if (e.data === 'preview:close') onClose(); }; window.addEventListener('message', onMsg); return () => window.removeEventListener('message', onMsg); }, [onClose]);
  useEffect(() => { const onChange = () => setIsFullscreen(!!document.fullscreenElement); document.addEventListener('fullscreenchange', onChange); return () => document.removeEventListener('fullscreenchange', onChange); }, []);

  const toggleFullscreen = useCallback(async () => {
    if (!document.fullscreenElement) await modalRef.current?.requestFullscreen();
    else await document.exitFullscreen();
  }, []);

  return (
    <motion.div
      initial={{ opacity:0 }} animate={{ opacity:1 }} exit={{ opacity:0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <motion.div
        ref={modalRef}
        initial={{ scale:0.94, y:20 }} animate={{ scale:1, y:0 }} exit={{ scale:0.94, y:20 }}
        transition={{ type:'spring', stiffness:400, damping:30 }}
        className="relative w-full max-w-5xl h-[85vh] bg-white rounded-2xl border border-[#e5e7eb] shadow-elevated flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 h-12 border-b border-border shrink-0">
          <Eye size={14} className="text-muted-foreground" />
          <span className="text-sm font-medium text-foreground flex-1 truncate">{name}</span>
          <div className="flex gap-1">
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={toggleFullscreen}>
              {isFullscreen ? <Minimize2 size={13} /> : <ExternalLink size={13} />}
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose}>
              <X size={14} />
            </Button>
          </div>
        </div>
        {blobUrl
          ? <iframe src={blobUrl} className="flex-1 w-full border-0" title={`Preview: ${name}`} sandbox="allow-scripts allow-same-origin allow-popups" />
          : <div className="flex-1 flex items-center justify-center gap-3 text-sm text-muted-foreground"><span className="spinner" />Loading preview…</div>
        }
      </motion.div>
    </motion.div>
  );
}
