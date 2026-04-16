'use client';

import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { motion } from 'framer-motion';
import { ArrowLeft, GripVertical, ChevronRight, ChevronDown, Trash2, Check, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';

// ── Segment helpers ────────────────────────────────────────────────
function segmentsToPlainText(segments) {
  if (!segments?.length) return '';
  return segments
    .filter(s => s.type === 'line')
    .flatMap(s => s.segs || [])
    .map(s => s.text || '')
    .join(' ')
    .trim();
}

function plainTextToSegments(text) {
  if (!text?.trim()) return [];
  return [{ type: 'line', segs: [{ text, bold: false, italic: false, underline: false, color: null }] }];
}

function deepCloneTopics(topics) {
  return topics.map(topic => ({
    ...topic,
    steps: topic.steps.map(step => ({
      ...step,
      _editorId: crypto.randomUUID(),
      bubble: step.bubble
        ? {
            ...step.bubble,
            segments: (step.bubble.segments || []).map(seg => ({
              ...seg,
              segs: (seg.segs || []).map(s => ({ ...s })),
            })),
          }
        : null,
    })),
  }));
}

// ── Main component ─────────────────────────────────────────────────
export function ContentEditor({ itemName, initialTopics, onSave, onClose }) {
  const [topics, setTopics]               = useState(() => deepCloneTopics(initialTopics));
  const [selTopic, setSelTopic]           = useState(0);
  const [selStep, setSelStep]             = useState(0);
  const [collapsed, setCollapsed]         = useState(new Set());
  const [editingTopicIdx, setEditingTopicIdx] = useState(null);
  const [draftTopicName, setDraftTopicName]   = useState('');
  const [editedSteps, setEditedSteps]     = useState(new Set());
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const topicRenameRef = useRef(null);
  const dragStepRef    = useRef(null); // { topicIdx, stepIdx }

  const originalStepCount = useMemo(
    () => initialTopics.reduce((n, t) => n + t.steps.length, 0),
    [initialTopics],
  );

  // Focus rename input when it appears
  useEffect(() => {
    if (editingTopicIdx !== null) topicRenameRef.current?.select();
  }, [editingTopicIdx]);

  // Escape key
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (confirmDiscard) { setConfirmDiscard(false); return; }
      if (editingTopicIdx !== null) { setEditingTopicIdx(null); return; }
      if (isDirty) setConfirmDiscard(true);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }); // no deps — reads live isDirty

  // Clamp selection to valid bounds whenever topics change
  useEffect(() => {
    if (!topics.length) return;
    const ti = Math.min(selTopic, topics.length - 1);
    const maxSi = Math.max(0, (topics[ti]?.steps?.length ?? 1) - 1);
    setSelTopic(ti);
    setSelStep(si => Math.min(si, maxSi));
  }, [topics, selTopic]);

  const currentTopic = topics[selTopic];
  const currentStep  = currentTopic?.steps?.[selStep];
  const totalSteps   = useMemo(() => topics.reduce((n, t) => n + t.steps.length, 0), [topics]);
  const stepsRemoved = originalStepCount - totalSteps;
  const isDirty      = editedSteps.size > 0 || stepsRemoved > 0 || topics.length !== initialTopics.length;

  // ── Step description edit ────────────────────────────────────────
  const handleDescriptionChange = useCallback((text) => {
    const editorId = currentStep?._editorId;
    setTopics(prev => {
      const next = prev.map((t, ti) =>
        ti !== selTopic ? t : {
          ...t,
          steps: t.steps.map((s, si) =>
            si !== selStep ? s : {
              ...s,
              bubble: s.bubble
                ? { ...s.bubble, segments: plainTextToSegments(text) }
                : { bgColor: '#C0FFFF', segments: plainTextToSegments(text) },
            }
          ),
        }
      );
      return next;
    });
    if (editorId) setEditedSteps(prev => new Set([...prev, editorId]));
  }, [selTopic, selStep, currentStep]);

  // ── Delete step ──────────────────────────────────────────────────
  const handleDeleteStep = useCallback(() => {
    if (topics.length === 1 && currentTopic?.steps?.length === 1) return;
    setTopics(prev => {
      const next = [...prev];
      const t = { ...next[selTopic], steps: [...next[selTopic].steps] };
      t.steps.splice(selStep, 1);
      if (t.steps.length === 0) {
        next.splice(selTopic, 1);
        setSelTopic(s => Math.max(0, s - 1));
        setSelStep(0);
      } else {
        next[selTopic] = t;
        setSelStep(s => Math.min(s, t.steps.length - 1));
      }
      return next;
    });
  }, [selTopic, selStep, currentTopic, topics.length]);

  // ── Delete topic ─────────────────────────────────────────────────
  const handleDeleteTopic = useCallback((ti) => {
    if (topics.length === 1) return;
    setTopics(prev => { const next = [...prev]; next.splice(ti, 1); return next; });
    setSelTopic(s => Math.min(s, topics.length - 2));
    setSelStep(0);
  }, [topics.length]);

  // ── Topic rename ─────────────────────────────────────────────────
  const startRenameTopic = useCallback((ti) => {
    setEditingTopicIdx(ti);
    setDraftTopicName(topics[ti].title);
  }, [topics]);

  const commitTopicRename = useCallback(() => {
    const trimmed = draftTopicName.trim();
    if (trimmed && editingTopicIdx !== null) {
      setTopics(prev => prev.map((t, i) => i === editingTopicIdx ? { ...t, title: trimmed } : t));
    }
    setEditingTopicIdx(null);
  }, [draftTopicName, editingTopicIdx]);

  // ── Step drag-and-drop (within same topic) ───────────────────────
  const handleStepDragStart = useCallback((topicIdx, stepIdx) => {
    dragStepRef.current = { topicIdx, stepIdx };
  }, []);

  const handleStepDragOver = useCallback((e, topicIdx, stepIdx) => {
    e.preventDefault();
    const from = dragStepRef.current;
    if (!from || from.topicIdx !== topicIdx || from.stepIdx === stepIdx) return;
    setTopics(prev => {
      const next = [...prev];
      const t = { ...next[topicIdx], steps: [...next[topicIdx].steps] };
      const [moved] = t.steps.splice(from.stepIdx, 1);
      t.steps.splice(stepIdx, 0, moved);
      next[topicIdx] = t;
      dragStepRef.current = { topicIdx, stepIdx };
      // Keep selection on the dragged step
      if (selTopic === topicIdx && selStep === from.stepIdx) setSelStep(stepIdx);
      return next;
    });
  }, [selTopic, selStep]);

  const handleStepDragEnd = useCallback(() => { dragStepRef.current = null; }, []);

  // ── Navigation helpers ───────────────────────────────────────────
  const goToPrev = useCallback(() => {
    if (selStep > 0) { setSelStep(s => s - 1); return; }
    if (selTopic > 0) {
      const prevTi = selTopic - 1;
      setSelTopic(prevTi);
      setSelStep(topics[prevTi].steps.length - 1);
    }
  }, [selStep, selTopic, topics]);

  const goToNext = useCallback(() => {
    if (selStep < currentTopic.steps.length - 1) { setSelStep(s => s + 1); return; }
    if (selTopic < topics.length - 1) { setSelTopic(t => t + 1); setSelStep(0); }
  }, [selStep, selTopic, currentTopic, topics.length]);

  const isFirst = selTopic === 0 && selStep === 0;
  const isLast  = selTopic === topics.length - 1 && selStep === (currentTopic?.steps?.length ?? 1) - 1;

  // ── Save ─────────────────────────────────────────────────────────
  const handleSave = useCallback(() => {
    const cleaned = topics.map(topic => ({
      ...topic,
      steps: topic.steps.map(({ _editorId, ...step }, idx) => ({
        ...step,
        stepNum: idx + 1,
      })),
    }));
    onSave(cleaned);
  }, [topics, onSave]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      className="fixed inset-0 z-[70] flex flex-col bg-[#F7F7F0]"
    >
      {/* ── Header ── */}
      <div className="flex items-center gap-3 px-4 h-14 border-b border-[#e5e7eb] bg-white shrink-0">
        <Button
          variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground shrink-0"
          onClick={() => isDirty ? setConfirmDiscard(true) : onClose()}
          aria-label="Back"
        >
          <ArrowLeft size={16} />
        </Button>
        <Separator orientation="vertical" className="h-5" />
        <span className="text-sm font-semibold text-foreground truncate max-w-[220px]">{itemName}</span>

        <div className="flex items-center gap-1.5">
          {editedSteps.size > 0 && (
            <Badge variant="secondary" className="text-[10px] h-5">{editedSteps.size} edited</Badge>
          )}
          {stepsRemoved > 0 && (
            <Badge variant="warning" className="text-[10px] h-5">{stepsRemoved} removed</Badge>
          )}
        </div>

        <div className="flex-1" />

        {confirmDiscard ? (
          <div className="flex items-center gap-2">
            <AlertCircle size={14} className="text-destructive shrink-0" />
            <span className="text-xs text-destructive font-medium">Discard changes?</span>
            <Button variant="destructive" size="sm" className="h-7 text-xs" onClick={onClose}>Discard</Button>
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setConfirmDiscard(false)}>Keep editing</Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Button
              variant="ghost" size="sm" className="text-xs text-muted-foreground"
              onClick={() => isDirty ? setConfirmDiscard(true) : onClose()}
            >
              Cancel
            </Button>
            <Button variant="glow" size="sm" className="gap-1.5" onClick={handleSave}>
              <Check size={13} /> Save changes
            </Button>
          </div>
        )}
      </div>

      {/* ── Body ── */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── Sidebar ── */}
        <div className="w-72 shrink-0 border-r border-[#e5e7eb] bg-white flex flex-col overflow-hidden">
          <div className="px-3 py-2.5 border-b border-[#e5e7eb] shrink-0">
            <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
              {topics.length} topic{topics.length !== 1 ? 's' : ''} · {totalSteps} step{totalSteps !== 1 ? 's' : ''}
            </span>
          </div>

          <div className="flex-1 overflow-y-auto py-1">
            {topics.map((topic, ti) => {
              const isCollapsed = collapsed.has(ti);
              return (
                <div key={ti}>
                  {/* Topic header */}
                  <div className="flex items-center gap-1 px-2 py-1.5 group hover:bg-[#f9fafb]">
                    <button
                      className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors shrink-0"
                      onClick={() => setCollapsed(prev => {
                        const next = new Set(prev);
                        if (next.has(ti)) next.delete(ti); else next.add(ti);
                        return next;
                      })}
                      aria-label={isCollapsed ? 'Expand' : 'Collapse'}
                    >
                      {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                    </button>

                    {editingTopicIdx === ti ? (
                      <input
                        ref={topicRenameRef}
                        value={draftTopicName}
                        onChange={e => setDraftTopicName(e.target.value)}
                        onBlur={commitTopicRename}
                        onKeyDown={e => {
                          if (e.key === 'Enter') { e.preventDefault(); commitTopicRename(); }
                          if (e.key === 'Escape') { setEditingTopicIdx(null); }
                        }}
                        className="flex-1 min-w-0 text-xs font-semibold bg-[#f9fafb] border border-[#FF6B18] rounded px-1.5 py-0.5 outline-none"
                      />
                    ) : (
                      <span
                        className="flex-1 min-w-0 text-xs font-semibold text-foreground truncate cursor-default"
                        onDoubleClick={() => startRenameTopic(ti)}
                        title="Double-click to rename"
                      >
                        {topic.title}
                      </span>
                    )}

                    <button
                      className={cn(
                        'p-0.5 rounded text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-all shrink-0',
                        topics.length === 1 && 'cursor-not-allowed opacity-30 hover:text-muted-foreground'
                      )}
                      onClick={() => handleDeleteTopic(ti)}
                      disabled={topics.length === 1}
                      aria-label="Delete topic"
                      title={topics.length === 1 ? 'Cannot delete the only topic' : 'Delete topic'}
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>

                  {/* Steps */}
                  {!isCollapsed && topic.steps.map((step, si) => {
                    const isSelected = ti === selTopic && si === selStep;
                    const isEdited   = editedSteps.has(step._editorId);
                    const label      = segmentsToPlainText(step.bubble?.segments);
                    return (
                      <div
                        key={step._editorId}
                        draggable
                        onDragStart={() => handleStepDragStart(ti, si)}
                        onDragOver={e => handleStepDragOver(e, ti, si)}
                        onDragEnd={handleStepDragEnd}
                        onClick={() => { setSelTopic(ti); setSelStep(si); }}
                        className={cn(
                          'flex items-center gap-2 pl-6 pr-2 py-2 cursor-pointer select-none transition-colors group/step',
                          isSelected
                            ? 'bg-[#FF6B18]/8 border-r-2 border-[#FF6B18]'
                            : 'hover:bg-[#f9fafb]',
                        )}
                      >
                        <GripVertical
                          size={11}
                          className="text-muted-foreground/30 group-hover/step:text-muted-foreground shrink-0 cursor-grab active:cursor-grabbing"
                        />
                        <span className={cn(
                          'text-[10px] font-mono font-bold w-4 shrink-0 tabular-nums',
                          isSelected ? 'text-brand-orange' : 'text-muted-foreground'
                        )}>{si + 1}</span>
                        <span className="text-xs text-foreground truncate flex-1 min-w-0">
                          {label || <span className="text-muted-foreground italic">No description</span>}
                        </span>
                        {isEdited && (
                          <div className="w-1.5 h-1.5 rounded-full bg-brand-orange shrink-0" title="Edited" />
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Main ── */}
        <div className="flex-1 overflow-y-auto">
          {currentStep ? (
            <div className="max-w-2xl mx-auto px-8 py-8 space-y-6">

              {/* Nav */}
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-muted-foreground truncate max-w-[280px]">{currentTopic?.title}</p>
                  <p className="text-sm font-semibold text-foreground">
                    Step {selStep + 1} <span className="text-muted-foreground font-normal">of {currentTopic?.steps?.length}</span>
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" className="h-7 text-xs" disabled={isFirst} onClick={goToPrev}>
                    ← Prev
                  </Button>
                  <Button variant="outline" size="sm" className="h-7 text-xs" disabled={isLast} onClick={goToNext}>
                    Next →
                  </Button>
                </div>
              </div>

              {/* Screenshot */}
              {currentStep.imageB64 ? (
                <div className="rounded-xl overflow-hidden border border-[#e5e7eb] shadow-card">
                  <img
                    src={currentStep.imageB64}
                    alt={`Step ${selStep + 1} screenshot`}
                    className="w-full object-contain block"
                  />
                </div>
              ) : (
                <div className="rounded-xl border-2 border-dashed border-[#e5e7eb] h-36 flex items-center justify-center">
                  <span className="text-sm text-muted-foreground">No screenshot for this step</span>
                </div>
              )}

              {/* Description */}
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground block">Step description</label>
                <textarea
                  key={`${selTopic}-${selStep}-${currentStep._editorId}`}
                  defaultValue={segmentsToPlainText(currentStep.bubble?.segments)}
                  onChange={e => handleDescriptionChange(e.target.value)}
                  placeholder="Describe what happens in this step…"
                  rows={4}
                  className="w-full rounded-xl border border-[#e5e7eb] bg-white px-4 py-3 text-sm text-[#111827] focus:outline-none focus:ring-2 focus:ring-[#FF6B18]/40 resize-none leading-relaxed"
                />
                <p className="text-xs text-muted-foreground">
                  Appears as the step caption in PDF, DOCX, and PPTX exports.
                </p>
              </div>

              {/* Interaction hint (read-only) */}
              {currentStep.interaction?.evtType && (
                <div className="rounded-xl bg-[#eff6ff] border border-[#bfdbfe] px-4 py-3 text-xs text-[#1d4ed8] space-y-0.5">
                  <p className="font-semibold uppercase tracking-wide text-[10px] text-[#3b82f6]">Recorded interaction</p>
                  <p>
                    {currentStep.interaction.evtType}
                    {currentStep.interaction.objName ? ` on "${currentStep.interaction.objName}"` : ''}
                  </p>
                </div>
              )}

              {/* Delete step */}
              <div className="flex justify-end border-t border-[#f3f4f6] pt-4">
                <Button
                  variant="ghost" size="sm"
                  className="text-xs text-destructive hover:text-destructive gap-1.5"
                  onClick={handleDeleteStep}
                  disabled={topics.length === 1 && currentTopic?.steps?.length === 1}
                  title={topics.length === 1 && currentTopic?.steps?.length === 1
                    ? 'Cannot delete the last step'
                    : 'Delete this step from the guide'
                  }
                >
                  <Trash2 size={12} /> Delete step
                </Button>
              </div>

            </div>
          ) : (
            <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
              Select a step from the sidebar
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}
