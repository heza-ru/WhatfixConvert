'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Check, Palette, Upload, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { loadBrandKit, saveBrandKit, DEFAULT_BRAND_KIT } from '@/lib/brand-kit';

const FONT_OPTIONS = [
  { value: 'Segoe UI',    label: 'Segoe UI (default)' },
  { value: 'Inter',       label: 'Inter' },
  { value: 'Arial',       label: 'Arial' },
  { value: 'Georgia',     label: 'Georgia' },
  { value: 'Trebuchet MS', label: 'Trebuchet MS' },
  { value: 'Courier New', label: 'Courier New' },
];

const MAX_LOGO_BYTES = 400_000; // ~300 KB raw

export function BrandKitManager({ open, onClose }) {
  const [kit, setKit]         = useState(() => loadBrandKit());
  const [saved, setSaved]     = useState(false);
  const [logoError, setLogoError] = useState('');
  const fileRef = useRef(null);

  // Re-read from localStorage whenever the panel opens
  useEffect(() => { if (open) setKit(loadBrandKit()); }, [open]);

  const handleSave = useCallback(() => {
    saveBrandKit(kit);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }, [kit]);

  const handleReset = useCallback(() => {
    setKit({ ...DEFAULT_BRAND_KIT });
    setLogoError('');
  }, []);

  const handleLogoUpload = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLogoError('');
    const reader = new FileReader();
    reader.onload = (ev) => {
      const b64 = ev.target.result;
      if (b64.length > MAX_LOGO_BYTES) {
        setLogoError('Logo is too large (max ~300 KB). Please compress the image first.');
        return;
      }
      setKit(k => ({ ...k, logoB64: b64 }));
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  }, []);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="bk-backdrop"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm"
            onClick={onClose}
          />
          <motion.div
            key="bk-panel"
            initial={{ x: '100%', opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: '100%', opacity: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            className="fixed right-0 top-0 h-full z-[61] w-full max-w-lg bg-[#F7F7F0] border-l border-[#e5e7eb] shadow-elevated flex flex-col"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-5 border-b border-[#e5e7eb] shrink-0 bg-white">
              <div>
                <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
                  <Palette size={18} className="text-brand-orange" />
                  Brand Kit
                </h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Customise colours, fonts, and logo for all exported documents
                </p>
              </div>
              <Button variant="ghost" size="icon" onClick={onClose} className="text-muted-foreground">
                <X size={18} />
              </Button>
            </div>

            <ScrollArea className="flex-1">
              <div className="p-6 space-y-8">

                {/* ── Logo ── */}
                <section className="space-y-3">
                  <Label className="text-sm font-semibold text-foreground">Company Logo</Label>
                  <div className="flex items-start gap-4">
                    <div className="w-28 h-16 rounded-xl border border-[#e5e7eb] bg-white flex items-center justify-center overflow-hidden shrink-0">
                      {kit.logoB64
                        ? <img src={kit.logoB64} alt="Logo preview" className="max-w-full max-h-full object-contain p-2" />
                        : <span className="text-xs text-muted-foreground text-center px-2">No logo</span>
                      }
                    </div>
                    <div className="space-y-2">
                      <Button variant="outline" size="sm" className="gap-1.5 text-xs" onClick={() => fileRef.current?.click()}>
                        <Upload size={12} /> Upload logo
                      </Button>
                      {kit.logoB64 && (
                        <Button
                          variant="ghost" size="sm"
                          className="gap-1.5 text-xs text-destructive hover:text-destructive block"
                          onClick={() => { setKit(k => ({ ...k, logoB64: null })); setLogoError(''); }}
                        >
                          <Trash2 size={12} /> Remove
                        </Button>
                      )}
                      <p className="text-xs text-muted-foreground">PNG or SVG · max ~300 KB</p>
                      {logoError && <p className="text-xs text-destructive">{logoError}</p>}
                    </div>
                    <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleLogoUpload} />
                  </div>
                </section>

                <Separator />

                {/* ── Colours ── */}
                <section className="space-y-5">
                  <Label className="text-sm font-semibold text-foreground">Colours</Label>
                  {[
                    { key: 'primaryColor', label: 'Primary colour', hint: 'Accents, step badges, highlights' },
                    { key: 'accentColor',  label: 'Dark / header colour', hint: 'Cover slide, section headers' },
                  ].map(({ key, label, hint }) => (
                    <div key={key} className="space-y-1.5">
                      <div>
                        <Label className="text-xs text-foreground font-medium">{label}</Label>
                        <p className="text-xs text-muted-foreground">{hint}</p>
                      </div>
                      <div className="flex items-center gap-3">
                        <input
                          type="color"
                          value={kit[key]}
                          onChange={e => setKit(k => ({ ...k, [key]: e.target.value }))}
                          className="w-9 h-9 rounded-lg border border-[#e5e7eb] cursor-pointer p-0.5 bg-white"
                          aria-label={label}
                        />
                        <Input
                          value={kit[key]}
                          onChange={e => {
                            const v = e.target.value;
                            if (/^#[0-9a-fA-F]{0,6}$/.test(v)) setKit(k => ({ ...k, [key]: v }));
                          }}
                          className="font-mono text-sm w-32 h-9"
                          maxLength={7}
                          aria-label={`${label} hex`}
                        />
                        <div className="w-8 h-8 rounded-md border border-[#e5e7eb]" style={{ backgroundColor: kit[key] }} />
                      </div>
                    </div>
                  ))}
                </section>

                <Separator />

                {/* ── Font ── */}
                <section className="space-y-3">
                  <Label className="text-sm font-semibold text-foreground">Font Family</Label>
                  <p className="text-xs text-muted-foreground">Applied to DOCX and PPTX. PDF always uses Roboto.</p>
                  <Select value={kit.fontFamily} onValueChange={v => setKit(k => ({ ...k, fontFamily: v }))}>
                    <SelectTrigger className="w-56">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FONT_OPTIONS.map(o => (
                        <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </section>

                <Separator />

                {/* ── Identity ── */}
                <section className="space-y-4">
                  <Label className="text-sm font-semibold text-foreground">Document Identity</Label>
                  <div className="space-y-1.5">
                    <Label htmlFor="bk-company" className="text-xs">Company name</Label>
                    <Input
                      id="bk-company"
                      value={kit.companyName}
                      onChange={e => setKit(k => ({ ...k, companyName: e.target.value }))}
                      placeholder="e.g. Acme Corporation"
                      className="text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="bk-footer" className="text-xs">Footer text</Label>
                    <Input
                      id="bk-footer"
                      value={kit.footerText}
                      onChange={e => setKit(k => ({ ...k, footerText: e.target.value }))}
                      placeholder="e.g. Confidential — Internal Use Only"
                      className="text-sm"
                    />
                  </div>
                </section>

                <Separator />

                {/* ── Live preview ── */}
                <section className="space-y-3">
                  <Label className="text-sm font-semibold text-foreground">Preview</Label>
                  <div
                    className="rounded-xl overflow-hidden border border-[#e5e7eb] shadow-card select-none"
                    style={{ fontFamily: kit.fontFamily }}
                  >
                    {/* Cover */}
                    <div className="px-4 pt-4 pb-3" style={{ backgroundColor: kit.accentColor }}>
                      {kit.logoB64
                        ? <img src={kit.logoB64} alt="Logo" className="h-6 mb-3 object-contain" style={{ filter: 'brightness(0) invert(1)' }} />
                        : <div className="text-white font-bold text-sm mb-3 opacity-90">{kit.companyName || 'Company Name'}</div>
                      }
                      <div className="text-white font-bold text-base leading-tight">Guide Title</div>
                      <div className="text-white/50 text-xs mt-1">{kit.footerText || 'Standard Operating Procedure'}</div>
                    </div>
                    {/* Accent bar */}
                    <div className="h-1" style={{ backgroundColor: kit.primaryColor }} />
                    {/* Content mock */}
                    <div className="bg-white px-4 py-3 space-y-2">
                      <div className="flex items-center gap-2">
                        <div
                          className="w-6 h-6 rounded-full flex items-center justify-center text-white text-[10px] font-bold shrink-0"
                          style={{ backgroundColor: kit.primaryColor }}
                        >1</div>
                        <div className="text-xs font-medium text-[#111827]">Step description appears here</div>
                      </div>
                      <div className="h-10 rounded bg-[#f3f4f6] border border-[#e5e7eb]" />
                    </div>
                  </div>
                </section>

              </div>
            </ScrollArea>

            {/* Footer */}
            <div className="px-6 py-4 border-t border-[#e5e7eb] bg-white flex items-center justify-between shrink-0">
              <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={handleReset}>
                Reset to defaults
              </Button>
              <Button variant="glow" size="sm" className="gap-1.5" onClick={handleSave} disabled={saved}>
                {saved ? <><Check size={13} /> Saved!</> : 'Save Brand Kit'}
              </Button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
