'use client';

import { useState, useRef, useCallback, useEffect, memo, useReducer } from 'react';
import ErrorBoundary from './error-boundary';

let _converterPromise = null;
function getConverter() {
  if (!_converterPromise) _converterPromise = import('../lib/converter');
  return _converterPromise;
}

const MAX_FILE_BYTES = 250 * 1024 * 1024; // 250 MB

// ── Items reducer ──────────────────────────────────────────────────
function itemsReducer(state, action) {
  switch (action.type) {
    case 'ADD':    return [action.item, ...state];
    case 'PATCH':  return state.map(it => it.id === action.id ? { ...it, ...action.patch } : it);
    case 'DELETE': return state.filter(it => it.id !== action.id);
    default: return state;
  }
}

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
  const [selectedFormats, setSelectedFormats] = useState({ docx: false, pptx: false });
  const [previewState, setPreviewState]     = useState(null); // { html, name }
  const [showWhatsNew, setShowWhatsNew]     = useState(false);
  const fileInputRef = useRef(null);
  const blobUrlsRef  = useRef([]);

  useEffect(() => {
    const fadeTimer = setTimeout(() => setFading(true), 1800);
    const hideTimer = setTimeout(() => setLoading(false), 2300);
    return () => { clearTimeout(fadeTimer); clearTimeout(hideTimer); };
  }, []);

  useEffect(() => {
    if (!localStorage.getItem('whatsnew_v1')) setShowWhatsNew(true);
  }, []);

  const dismissWhatsNew = useCallback(() => {
    localStorage.setItem('whatsnew_v1', '1');
    setShowWhatsNew(false);
  }, []);

  useEffect(() => {
    return () => { for (const url of blobUrlsRef.current) try { URL.revokeObjectURL(url); } catch { /* ignore */ } };
  }, []);

  useEffect(() => {
    return () => { if (undoData?.timer) clearTimeout(undoData.timer); };
  }, [undoData]);

  // Lock body scroll while preview modal is open
  useEffect(() => {
    document.body.style.overflow = previewState ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [previewState]);

  const createTrackedBlobUrl = useCallback((blob) => {
    const url = URL.createObjectURL(blob);
    blobUrlsRef.current.push(url);
    return url;
  }, []);

  const revokeBlobUrl = useCallback((url) => {
    if (!url) return;
    URL.revokeObjectURL(url);
    blobUrlsRef.current = blobUrlsRef.current.filter(u => u !== url);
  }, []);

  const downloadBlob = useCallback((blob, filename) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }, []);

  // ── File selection ────────────────────────────────────────────────
  const handleFileList = useCallback(async (fileList) => {
    setFileError(null);
    const valid = [...fileList].filter(f => /\.(odarc|dkp)$/i.test(f.name));
    if (!valid.length) { setFileError('Unsupported file type. Please choose .odarc or .dkp files.'); return; }
    const oversized = valid.find(f => f.size > MAX_FILE_BYTES);
    if (oversized) { setFileError(`"${oversized.name}" is too large (${(oversized.size / 1024 / 1024).toFixed(0)} MB). Maximum is 250 MB.`); return; }

    const newPending = valid.map(f => ({ id: crypto.randomUUID(), file: f, format: /\.dkp$/i.test(f.name) ? 'dkp' : 'odarc' }));
    setPendingFiles(newPending);
    setAvailTopics([]);
    setSelected(new Set());

    if (valid.length === 1) {
      const f = valid[0];
      const isDkp = /\.dkp$/i.test(f.name);
      setFileFormat(isDkp ? 'dkp' : 'odarc');
      setInspecting(true);
      try {
        const conv = await getConverter();
        const topics = isDkp ? await conv.inspectDkp(f) : await conv.inspectOdarc(f);
        setAvailTopics(topics);
        setSelected(new Set(topics.map(t => t.id)));
      } catch (err) { console.warn('Topic inspection failed:', err); }
      finally { setInspecting(false); }
    }
  }, []);

  // ── File removal with undo ────────────────────────────────────────
  const handleRemoveFiles = useCallback((e) => {
    e?.stopPropagation();
    if (!pendingFiles.length) return;
    const saved = { files: [...pendingFiles], topics: [...availTopics], selected: new Set(selected), format: fileFormat };
    if (undoData?.timer) clearTimeout(undoData.timer);
    const timer = setTimeout(() => setUndoData(null), 5000);
    setUndoData({ ...saved, timer });
    setPendingFiles([]); setAvailTopics([]); setSelected(new Set()); setFileError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [pendingFiles, availTopics, selected, fileFormat, undoData]);

  const handleUndo = useCallback(() => {
    if (!undoData) return;
    clearTimeout(undoData.timer);
    setPendingFiles(undoData.files); setAvailTopics(undoData.topics);
    setSelected(undoData.selected); setFileFormat(undoData.format);
    setUndoData(null);
  }, [undoData]);

  const clearPendingNoUndo = useCallback(() => {
    setPendingFiles([]); setAvailTopics([]); setSelected(new Set());
    setFileFormat('odarc'); setFileError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  // ── Conversion ────────────────────────────────────────────────────
  const runConversion = useCallback(async (id, fileObj, topicIds, itemName, autoFormats) => {
    const isDkp = /\.dkp$/i.test(fileObj.name);
    try {
      const { extractTopics, extractDkpTopics, generatePrintHtml, generateDocx, generatePptx, getLogoB64 } = await getConverter();
      const logoB64 = await getLogoB64();
      let prog = 8;
      const onProgress = (msg) => {
        prog = Math.round(prog + (88 - prog) * 0.35);
        dispatch({ type: 'PATCH', id, patch: { lastLog: msg, progress: prog } });
      };
      const topics = isDkp
        ? await extractDkpTopics(fileObj, topicIds, onProgress)
        : await extractTopics(fileObj, topicIds, onProgress);

      dispatch({ type: 'PATCH', id, patch: { lastLog: 'Generating document…', progress: 93 } });
      const html      = generatePrintHtml(topics, logoB64, true);
      const htmlClean = generatePrintHtml(topics, logoB64, false);
      const printUrl      = createTrackedBlobUrl(new Blob([html],      { type: 'text/html' }));
      const printUrlClean = createTrackedBlobUrl(new Blob([htmlClean], { type: 'text/html' }));
      dispatch({ type: 'PATCH', id, patch: { status: 'done', progress: 100, printUrl, printUrlClean, topics, lastLog: 'Done!' } });

      if (autoFormats?.docx) {
        dispatch({ type: 'PATCH', id, patch: { exportingDocx: true } });
        try { downloadBlob(await generateDocx(topics, itemName, logoB64, true), `${itemName}.docx`); }
        finally { dispatch({ type: 'PATCH', id, patch: { exportingDocx: false } }); }
      }
      if (autoFormats?.pptx) {
        dispatch({ type: 'PATCH', id, patch: { exportingPptx: true } });
        try { downloadBlob(await generatePptx(topics, itemName, logoB64, true), `${itemName}.pptx`); }
        finally { dispatch({ type: 'PATCH', id, patch: { exportingPptx: false } }); }
      }
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
    const filesToConvert  = [...pendingFiles];
    const topicsSnapshot  = [...availTopics];
    const selectedSnapshot = new Set(selected);
    const autoFormats     = { ...selectedFormats };
    clearPendingNoUndo();

    for (const pf of filesToConvert) {
      const topicIds = filesToConvert.length === 1 && topicsSnapshot.length > 1 ? [...selectedSnapshot] : null;
      const name = (() => {
        if (!topicsSnapshot.length || filesToConvert.length > 1) return pf.file.name.replace(/\.(odarc|dkp)$/i, '');
        const pool = topicIds ? topicsSnapshot.filter(t => topicIds.includes(t.id)) : topicsSnapshot;
        return pool.map(t => t.title).join(' · ') || pf.file.name.replace(/\.(odarc|dkp)$/i, '');
      })();
      const id = crypto.randomUUID();
      dispatch({ type: 'ADD', item: { id, name, status: 'converting', lastLog: '', progress: 8, printUrl: null, topics: null, error: null, _file: pf.file, _topicIds: topicIds } });
      runConversion(id, pf.file, topicIds, name, autoFormats);
    }
  }, [pendingFiles, availTopics, selected, selectedFormats, clearPendingNoUndo, runConversion]);

  const handleRetry = useCallback((item) => {
    dispatch({ type: 'PATCH', id: item.id, patch: { status: 'converting', lastLog: '', progress: 8, error: null } });
    runConversion(item.id, item._file, item._topicIds, item.name, {});
  }, [runConversion]);

  const handlePreview = useCallback(async (item) => {
    if (!item.topics) return;
    const { generatePreviewHtml, getLogoB64 } = await getConverter();
    const logoB64 = await getLogoB64();
    const html = generatePreviewHtml(item.topics, item.name, logoB64);
    setPreviewState({ html, name: item.name });
  }, []);

  const handleDocx = useCallback(async (item, withTooltips) => {
    if (!item.topics) return;
    const { generateDocx, getLogoB64 } = await getConverter();
    dispatch({ type: 'PATCH', id: item.id, patch: { exportingDocx: true } });
    try { downloadBlob(await generateDocx(item.topics, item.name, await getLogoB64(), withTooltips), `${item.name}${withTooltips ? '' : '-clean'}.docx`); }
    finally { dispatch({ type: 'PATCH', id: item.id, patch: { exportingDocx: false } }); }
  }, [downloadBlob]);

  const handlePptx = useCallback(async (item, withTooltips) => {
    if (!item.topics) return;
    const { generatePptx, getLogoB64 } = await getConverter();
    dispatch({ type: 'PATCH', id: item.id, patch: { exportingPptx: true } });
    try { downloadBlob(await generatePptx(item.topics, item.name, await getLogoB64(), withTooltips), `${item.name}${withTooltips ? '' : '-clean'}.pptx`); }
    finally { dispatch({ type: 'PATCH', id: item.id, patch: { exportingPptx: false } }); }
  }, [downloadBlob]);

  const handleDelete = useCallback((id) => {
    const it = items.find(x => x.id === id);
    if (it?.printUrl)      revokeBlobUrl(it.printUrl);
    if (it?.printUrlClean) revokeBlobUrl(it.printUrlClean);
    dispatch({ type: 'DELETE', id });
  }, [items, revokeBlobUrl]);

  const handleDownloadAll = useCallback(async () => {
    const doneItems = items.filter(it => it.status === 'done' && it.printUrlClean);
    if (!doneItems.length) return;
    setDownloadingAll(true);
    try {
      const { default: JSZip } = await import('jszip');
      const zip = new JSZip();
      for (const it of doneItems) { const res = await fetch(it.printUrlClean); zip.file(`${it.name}-guide.html`, await res.blob()); }
      downloadBlob(await zip.generateAsync({ type: 'blob' }), 'guides.zip');
    } catch (err) { console.error('Download all failed:', err); }
    finally { setDownloadingAll(false); }
  }, [items, downloadBlob]);

  const onDragOver  = useCallback((e) => { e.preventDefault(); setDragging(true); }, []);
  const onDragLeave = useCallback(() => setDragging(false), []);
  const onDrop      = useCallback((e) => { e.preventDefault(); setDragging(false); handleFileList(e.dataTransfer.files); }, [handleFileList]);

  const hasFiles   = pendingFiles.length > 0;
  const isBatch    = pendingFiles.length > 1;
  const canConvert = hasFiles && !inspecting && (isBatch || availTopics.length === 0 || selected.size > 0);
  const doneCount  = items.filter(it => it.status === 'done').length;
  const hasConfig  = hasFiles && (!isBatch && availTopics.length > 1 || true); // always show format row

  return (
    <ErrorBoundary>
      {/* ── Preview modal ──────────────────────────────────────── */}
      {previewState && (
        <PreviewModal
          html={previewState.html}
          name={previewState.name}
          onClose={() => setPreviewState(null)}
        />
      )}

      {/* ── Loading splash ─────────────────────────────────────── */}
      {loading && (
        <div className={`loading-screen${fading ? ' fading' : ''}`} role="status" aria-label="Loading">
          <img src="/whatfix-loader.gif" alt="" className="loading-gif" width="80" height="80" />
          <p className="loading-text">Software Clicks Smarter with Whatfix</p>
        </div>
      )}

      {/* ── Header ────────────────────────────────────────────── */}
      <header className="header">
        <img src="/Whatfix_logo.png" alt="Whatfix" className="header-logo" />
        <div className="header-divider" aria-hidden="true" />
        <span className="header-title">OdArc &amp; DKP Converter</span>
      </header>

      <main className="page">

        {/* ── Phase 1: Upload ───────────────────────────────── */}
        <div
          className={`upload-zone${dragging ? ' drag-over' : ''}${hasFiles ? ' has-file' : ''}`}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onClick={() => !hasFiles && fileInputRef.current?.click()}
          role={hasFiles ? undefined : 'button'}
          tabIndex={hasFiles ? undefined : 0}
          aria-label={hasFiles ? undefined : 'Upload — click or drop .odarc or .dkp files here'}
          onKeyDown={e => { if (!hasFiles && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); fileInputRef.current?.click(); } }}
        >
          {hasFiles ? (
            <div className="file-chips">
              {pendingFiles.map(pf => (
                <div key={pf.id} className="file-chip">
                  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                    <path d="M8 1.5H4a1 1 0 00-1 1v9a1 1 0 001 1h6a1 1 0 001-1V5L8 1.5z" stroke="#FF6B18" strokeWidth="1.3"/>
                    <path d="M8 1.5V5h3.5" stroke="#FF6B18" strokeWidth="1.3" strokeLinecap="round"/>
                  </svg>
                  <span className="file-chip-name">{pf.file.name}</span>
                  <span className="file-chip-size">{(pf.file.size / 1024 / 1024).toFixed(1)} MB</span>
                </div>
              ))}
              <div className="file-chips-actions">
                <button className="file-chips-add" onClick={e => { e.stopPropagation(); fileInputRef.current?.click(); }} aria-label="Add more files">
                  + Add more
                </button>
                <button className="file-chips-remove" onClick={handleRemoveFiles} aria-label="Remove all selected files">×</button>
              </div>
            </div>
          ) : (
            <>
              <div className="upload-icon" aria-hidden="true">
                <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
                  <path d="M11 15V7M11 7l-4 4M11 7l4 4" stroke="#FF6B18" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M4 17h14" stroke="#FF6B18" strokeWidth="1.7" strokeLinecap="round"/>
                </svg>
              </div>
              <p className="upload-text">
                Drop <strong>.odarc</strong> or <strong>.dkp</strong> files here, or{' '}
                <strong role="button" tabIndex={0}
                  onClick={e => { e.stopPropagation(); fileInputRef.current?.click(); }}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInputRef.current?.click(); } }}
                >browse</strong>
              </p>
              <p className="upload-hint">Oracle UPK (.odarc) &nbsp;·&nbsp; SAP Enable Now (.dkp) &nbsp;·&nbsp; Multiple files supported</p>
            </>
          )}
          <input ref={fileInputRef} type="file" accept=".odarc,.dkp" multiple style={{ display: 'none' }} aria-hidden="true" tabIndex={-1} onChange={e => handleFileList(e.target.files)} />
        </div>

        {fileError && (
          <div className="upload-error" role="alert">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" style={{ flexShrink: 0, marginTop: 1 }}>
              <circle cx="7" cy="7" r="6" stroke="#ef4444" strokeWidth="1.3"/>
              <path d="M7 4v3.5" stroke="#ef4444" strokeWidth="1.4" strokeLinecap="round"/>
              <circle cx="7" cy="10" r=".75" fill="#ef4444"/>
            </svg>
            {fileError}
          </div>
        )}

        {undoData && (
          <div className="undo-toast" role="status" aria-live="polite">
            <span>{undoData.files.length > 1 ? `${undoData.files.length} files` : `"${undoData.files[0].file.name}"`} removed.</span>
            <button className="undo-btn" onClick={handleUndo}>Undo</button>
          </div>
        )}

        {/* ── Phase 2: Configure ────────────────────────────── */}
        {hasFiles && (
          <div className="configure-section">
            <div className="phase-label">Configure</div>

            {inspecting && (
              <div className="inspect-row" role="status">
                <span className="spinner" aria-hidden="true" />
                <span>Reading file…</span>
              </div>
            )}

            {/* Topic picker — single file only */}
            {!inspecting && !isBatch && availTopics.length > 1 && (
              <fieldset className="topic-picker">
                <div className="topic-picker-header">
                  <legend className="topic-picker-label">
                    {fileFormat === 'dkp' ? 'Slides to include' : 'Processes to include'}
                  </legend>
                  <div className="topic-picker-actions">
                    <button className="topic-link" onClick={() => setSelected(new Set(availTopics.map(t => t.id)))}>All</button>
                    <button className="topic-link" style={{ color: '#6b7280' }} onClick={() => setSelected(new Set())}>None</button>
                  </div>
                </div>
                <div className="topic-list" role="group" aria-label="Select topics to include">
                  {availTopics.map((t, i) => (
                    <label key={t.id} className="topic-item">
                      <input type="checkbox" checked={selected.has(t.id)}
                        onChange={e => setSelected(prev => { const next = new Set(prev); e.target.checked ? next.add(t.id) : next.delete(t.id); return next; })}
                      />
                      <span className="topic-item-title">{t.title}</span>
                      <span className="topic-item-num">{fileFormat === 'dkp' ? `Slide ${i + 1}` : `Process ${i + 1}`}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}

            {/* Export format selection */}
            <div className="format-row" role="group" aria-label="Export formats">
              <span className="format-row-label">Export as:</span>
              <span className="format-pill">PDF</span>
              <label className="format-check">
                <input type="checkbox" checked={selectedFormats.docx} onChange={e => setSelectedFormats(f => ({ ...f, docx: e.target.checked }))} aria-label="Also export as DOCX" />
                <span>DOCX</span>
              </label>
              <label className="format-check">
                <input type="checkbox" checked={selectedFormats.pptx} onChange={e => setSelectedFormats(f => ({ ...f, pptx: e.target.checked }))} aria-label="Also export as PPTX" />
                <span>PPTX</span>
              </label>
              <span className="format-hint">{selectedFormats.docx || selectedFormats.pptx ? 'Additional formats will download automatically after conversion.' : 'PDF is always generated. Check to auto-download more.'}</span>
            </div>
          </div>
        )}

        {/* ── Phase 3: Convert ──────────────────────────────── */}
        {hasFiles && (
          <button className="btn-convert" disabled={!canConvert} onClick={handleConvert} aria-disabled={!canConvert}>
            {isBatch ? `Convert ${pendingFiles.length} Files` : 'Convert'}
          </button>
        )}

        {/* ── Phase 4: Results ──────────────────────────────── */}
        {items.length > 0 && (
          <section className="guide-list" aria-label="Conversion results">
            <div className="guide-list-header">
              <div className="phase-label" style={{ marginBottom: 0 }}>
                Results
                <span className="guide-count">{items.length}</span>
              </div>
              {doneCount >= 2 && (
                <button className="btn-download-all" onClick={handleDownloadAll} disabled={downloadingAll} aria-label={`Download all ${doneCount} completed guides as a zip`}>
                  <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
                    <path d="M6.5 2v6M6.5 8l-2.5-2.5M6.5 8l2.5-2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                    <path d="M2 10.5h9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                  </svg>
                  {downloadingAll ? 'Zipping…' : `Download All (${doneCount})`}
                </button>
              )}
            </div>
            {items.map(item => (
              <GuideCard
                key={item.id}
                item={item}
                onPreview={() => handlePreview(item)}
                onPrint={(wt) => window.open(wt ? item.printUrl : item.printUrlClean, '_blank')}
                onDocx={(wt) => handleDocx(item, wt)}
                onPptx={(wt) => handlePptx(item, wt)}
                onRetry={() => handleRetry(item)}
                onDelete={() => handleDelete(item.id)}
              />
            ))}
          </section>
        )}

        {/* ── What's New ────────────────────────────────────── */}
        {showWhatsNew && (
          <aside className="whats-new" aria-label="What's new">
            <div className="whats-new-header">
              <span className="whats-new-badge">New</span>
              <span className="whats-new-title">What's new</span>
              <button className="whats-new-close" onClick={dismissWhatsNew} aria-label="Dismiss">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
              </button>
            </div>
            <ul className="whats-new-list">
              <li>
                <span className="whats-new-icon" aria-hidden="true">
                  <svg width="15" height="15" viewBox="0 0 15 15" fill="none"><path d="M1.5 4.5A1 1 0 0 1 2.5 3.5h3l1.5 1.5h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1V4.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/></svg>
                </span>
                <span><strong>Upload multiple files</strong> — drop several .odarc or .dkp files at once and convert them all in one go.</span>
              </li>
              <li>
                <span className="whats-new-icon" aria-hidden="true">
                  <svg width="15" height="15" viewBox="0 0 15 15" fill="none"><rect x="1" y="1.5" width="13" height="9.5" rx="1.2" stroke="currentColor" strokeWidth="1.2"/><path d="M1 12.5h13" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/><path d="M5.5 5l3.5 2.5L5.5 10V5z" fill="currentColor"/></svg>
                </span>
                <span><strong>In-app preview</strong> — browse your guide in a full-screen slideshow without leaving the page.</span>
              </li>
              <li>
                <span className="whats-new-icon" aria-hidden="true">
                  <svg width="15" height="15" viewBox="0 0 15 15" fill="none"><path d="M9 1.5H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5L9 1.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/><path d="M9 1.5V5h3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/><path d="M5 8h5M5 10.5h3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/></svg>
                </span>
                <span><strong>Auto-export to Word &amp; PowerPoint</strong> — tick DOCX or PPTX before converting and they download automatically alongside your PDF.</span>
              </li>
              <li>
                <span className="whats-new-icon" aria-hidden="true">
                  <svg width="15" height="15" viewBox="0 0 15 15" fill="none"><path d="M2.5 7A4.5 4.5 0 1 1 4.8 11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/><path d="M2.5 4v3h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </span>
                <span><strong>Undo file removal</strong> — accidentally removed a file? A quick Undo brings it right back.</span>
              </li>
              <li>
                <span className="whats-new-icon" aria-hidden="true">
                  <svg width="15" height="15" viewBox="0 0 15 15" fill="none"><path d="M1.5 5A1 1 0 0 1 2.5 4h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1V5z" stroke="currentColor" strokeWidth="1.2"/><path d="M1.5 7h12" stroke="currentColor" strokeWidth="1.2"/><path d="M5.5 4V2.5M9.5 4V2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
                </span>
                <span><strong>SAP Enable Now support</strong> — .dkp files are now fully supported alongside Oracle UPK .odarc files.</span>
              </li>
            </ul>
            <button className="whats-new-dismiss" onClick={dismissWhatsNew}>Got it, thanks!</button>
          </aside>
        )}
      </main>
    </ErrorBoundary>
  );
}

const GuideCard = memo(function GuideCard({ item, onPreview, onPrint, onDocx, onPptx, onRetry, onDelete }) {
  const { status, name, lastLog, progress, error, exportingDocx, exportingPptx } = item;
  const [withTooltips, setWithTooltips] = useState(true);

  return (
    <div className="guide-card" role="article" aria-label={`Guide: ${name}`}>

      {/* ── Top row: name · badge · delete ────────────────── */}
      <div className="guide-card-top">
        <span className="guide-name" title={name}>{name}</span>

        {status === 'done'       && <span className="badge badge-done"      aria-label="Ready">&#10003; Ready</span>}
        {status === 'error'      && <span className="badge badge-error"     aria-label="Failed">&#10005; Failed</span>}
        {status === 'converting' && (
          <span className="badge badge-converting" aria-label="Converting">
            <span className="spinner" aria-hidden="true" style={{ width: 10, height: 10, borderWidth: 1.5 }} />
            Converting
          </span>
        )}

        <button className="btn-icon-delete" onClick={onDelete} aria-label={`Remove ${name}`} title="Remove">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </button>
      </div>

      {/* ── Converting: progress ──────────────────────────── */}
      {status === 'converting' && (
        <div className="guide-card-progress" aria-live="polite" aria-atomic="false">
          <div className="prog-track" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label={`${progress}%`}>
            <div className="prog-fill" style={{ width: `${progress}%` }} />
          </div>
          {lastLog && <p className="prog-log">{lastLog}</p>}
        </div>
      )}

      {/* ── Error: message + retry ────────────────────────── */}
      {status === 'error' && (
        <div className="guide-card-error">
          {error && <p className="error-msg" role="alert">{error}</p>}
          <button className="btn-retry" onClick={onRetry} aria-label={`Retry ${name}`}>
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
              <path d="M2 6.5A4.5 4.5 0 1 1 4 10.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
              <path d="M2 3.5v3h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            Retry
          </button>
        </div>
      )}

      {/* ── Done: export actions ──────────────────────────── */}
      {status === 'done' && (
        <div className="guide-card-actions">
          <button className="btn-action" onClick={onPreview} aria-label={`Preview ${name}`} title="Interactive slideshow">
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
              <rect x="1" y="1" width="11" height="9" rx="1" stroke="currentColor" strokeWidth="1.2"/>
              <path d="M1 11.5h11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
              <path d="M5.5 4.5L8 6.5l-2.5 2V4.5z" fill="currentColor"/>
            </svg>
            Preview
          </button>

          <div className="guide-exports">
            <label className="tooltip-toggle" title="Include tooltip overlays in exports" aria-label={`Tooltips ${withTooltips ? 'on' : 'off'}`}>
              <input type="checkbox" checked={withTooltips} onChange={e => setWithTooltips(e.target.checked)} aria-label="Include tooltip overlays" />
              <span className="toggle-track" aria-hidden="true"><span className="toggle-thumb" /></span>
              <span className="tooltip-toggle-label">Tooltips</span>
            </label>

            <button className="btn-action" onClick={() => onPrint(withTooltips)} aria-label="Export as PDF" title="Open print-ready view">
              PDF
            </button>
            <button className="btn-action" onClick={() => onDocx(withTooltips)} disabled={exportingDocx} aria-label="Export as DOCX" title="Download Word document">
              {exportingDocx ? '…' : 'DOCX'}
            </button>
            <button className="btn-action primary" onClick={() => onPptx(withTooltips)} disabled={exportingPptx} aria-label="Export as PPTX" title="Download PowerPoint">
              {exportingPptx ? '…' : 'PPTX'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
});

// ── Preview Modal ──────────────────────────────────────────────────
function PreviewModal({ html, name, onClose }) {
  const modalRef  = useRef(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [blobUrl, setBlobUrl]           = useState(null);

  // Create blob URL once and revoke on unmount
  useEffect(() => {
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    setBlobUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [html]);

  // Keyboard: Escape closes (when not in browser fullscreen)
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !document.fullscreenElement) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Sync fullscreen state with browser API
  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFullscreen = useCallback(async () => {
    if (!document.fullscreenElement) {
      await modalRef.current?.requestFullscreen();
    } else {
      await document.exitFullscreen();
    }
  }, []);

  return (
    <div
      className="preview-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Preview: ${name}`}
    >
      <div
        ref={modalRef}
        className="preview-modal"
        onClick={e => e.stopPropagation()}
      >
        {/* Header bar */}
        <div className="preview-header">
          <svg width="14" height="14" viewBox="0 0 13 13" fill="none" aria-hidden="true" style={{ flexShrink: 0, opacity: 0.5 }}>
            <rect x="1" y="1" width="11" height="9" rx="1" stroke="currentColor" strokeWidth="1.2"/>
            <path d="M1 11.5h11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            <path d="M5.5 4.5L8 6.5l-2.5 2V4.5z" fill="currentColor"/>
          </svg>
          <span className="preview-title">{name}</span>
          <div className="preview-controls">
            <button
              className="preview-btn"
              onClick={toggleFullscreen}
              aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
              title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            >
              {isFullscreen ? (
                <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
                  <path d="M5 1v4H1M10 1v4h4M5 14v-4H1M10 14v-4h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
                  <path d="M1 5V1h4M14 5V1h-4M1 10v4h4M14 10v4h-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              )}
            </button>
            <button
              className="preview-btn preview-btn-close"
              onClick={onClose}
              aria-label="Close preview"
              title="Close"
            >
              <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
                <path d="M2 2l11 11M13 2L2 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </button>
          </div>
        </div>

        {/* Iframe content */}
        {blobUrl ? (
          <iframe
            src={blobUrl}
            className="preview-iframe"
            title={`Preview: ${name}`}
            sandbox="allow-scripts allow-same-origin"
          />
        ) : (
          <div className="preview-loading">
            <span className="spinner" style={{ width: 20, height: 20, borderWidth: 2.5 }} aria-hidden="true" />
            <span>Loading preview…</span>
          </div>
        )}
      </div>
    </div>
  );
}
