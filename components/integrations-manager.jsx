'use client';

import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Settings2, Check, Eye, EyeOff, Trash2, ChevronDown, ChevronUp, AlertCircle, CheckCircle2, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { IntegrationIcon } from '@/components/brand-icons';
import { PUBLISH_PLATFORMS } from '@/lib/lms-connectors';
import {
  saveEncryptedConfig, loadRawConfigs, loadDecryptedConfig,
  deleteConfig, hasConfig, isEncrypted
} from '@/lib/crypto';

// Professional descriptions per platform
const PLATFORM_DESCRIPTIONS = {
  whatfix:        'Deliver procedural training content directly to your Whatfix content library as quick-read guides. Enables contextual in-app learning within Whatfix digital adoption flows.',
  workday:        'Publish training content to Workday Learning for enterprise workforce development. Automatically creates course content accessible within the Workday Human Capital Management suite.',
  successfactors: 'Integrate with SAP SuccessFactors Learning Management to distribute SCORM-compliant content across your organization\'s global learning catalog.',
  cornerstone:    'Upload learning content to Cornerstone OnDemand\'s Extended Enterprise platform. Streamlines content management for large-scale talent development and compliance training.',
  docebo:         'Publish to Docebo\'s AI-powered learning platform via its REST API. Delivers content to learners across web and mobile with full LMS tracking and analytics.',
  linkedin:       'Distribute proprietary training content to LinkedIn Learning Hub via the Content at Scale API. Reaches learners within the LinkedIn professional development ecosystem.',
  '360learning':  'Collaborate and publish training materials directly to 360Learning\'s collaborative LMS. Leverages social learning and peer-to-peer knowledge sharing capabilities.',
  absorb:         'Deliver content to Absorb LMS, a cloud-based learning management system built for enterprise scalability. Supports advanced reporting and multi-tenant deployment.',
  degreed:        'Publish learning resources to Degreed\'s upskilling platform. Integrates with skill-based learning pathways and workforce intelligence capabilities.',
  confluence:     'Publish documentation directly to Atlassian Confluence Cloud workspaces. Creates fully-formatted knowledge base articles with rich-text content accessible to your entire organization.',
  sharepoint:     'Share documentation to Microsoft SharePoint and Teams document libraries via Microsoft Graph API. Seamlessly integrates with the Microsoft 365 enterprise productivity suite.',
  notion:         'Create rich Notion pages from converted documentation. Leverages Notion\'s collaborative workspace for team knowledge management and documentation workflows.',
  zendesk:        'Publish help center articles to Zendesk Guide for customer support documentation. Keeps your support knowledge base synchronized with the latest training content.',
  servicenow:     'Create and publish knowledge articles to ServiceNow Knowledge Management. Integrates with ServiceNow workflows for IT service management and employee self-service portals.',
  guru:           'Capture and distribute verified knowledge cards to Guru\'s knowledge management platform. Ensures teams have access to trusted, up-to-date information within their existing workflows.',
};

function MaskedField({ value, placeholder }) {
  const [show, setShow] = useState(false);
  if (!value) return <span className="text-muted-foreground text-xs italic">Not set</span>;
  return (
    <span className="flex items-center gap-1.5 text-xs font-mono">
      {show ? value : '••••••••••••'}
      <button
        type="button"
        onClick={() => setShow(s => !s)}
        className="text-muted-foreground hover:text-foreground transition-colors"
        aria-label={show ? 'Hide value' : 'Show value'}
      >
        {show ? <EyeOff size={12} /> : <Eye size={12} />}
      </button>
    </span>
  );
}

function PlatformCard({ platform, onUpdate }) {
  const [expanded, setExpanded]     = useState(false);
  const [enabled, setEnabled]       = useState(false);
  const [configured, setConfigured] = useState(false);
  const [form, setForm]             = useState({});
  const [saved, setSaved]           = useState({});   // decrypted values for display
  const [saving, setSaving]         = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [editMode, setEditMode]     = useState(false);

  const desc = PLATFORM_DESCRIPTIONS[platform.id] || platform.description;

  useEffect(() => {
    const raw = loadRawConfigs()[platform.id];
    if (raw) {
      setConfigured(true);
      // Load decrypted values for display (show masked)
      loadDecryptedConfig(platform.id).then(dec => setSaved(dec));
      // Pre-populate form with empty values (user must re-type to update)
      const empty = {};
      platform.fields.forEach(f => { empty[f.key] = ''; });
      setForm(empty);
    } else {
      const defaults = {};
      platform.fields.forEach(f => { defaults[f.key] = f.defaultValue ?? ''; });
      setForm(defaults);
    }
  }, [platform]);

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      // Merge: if field is blank and already configured, keep existing encrypted value
      const raw = loadRawConfigs()[platform.id] || {};
      const toSave = {};
      for (const f of platform.fields) {
        if (form[f.key] && form[f.key].trim()) {
          toSave[f.key] = form[f.key].trim();
        } else if (raw[f.key]) {
          // keep existing encrypted value as-is (re-encrypt would require decrypting first)
          toSave[f.key] = isEncrypted(raw[f.key]) ? await (async () => {
            const { decryptValue } = await import('@/lib/crypto');
            return decryptValue(raw[f.key]);
          })() : raw[f.key];
        } else {
          toSave[f.key] = '';
        }
      }
      await saveEncryptedConfig(platform.id, toSave);
      const dec = await loadDecryptedConfig(platform.id);
      setSaved(dec);
      setConfigured(true);
      setEditMode(false);
      onUpdate?.();
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = () => {
    deleteConfig(platform.id);
    setConfigured(false);
    setSaved({});
    setShowDelete(false);
    setEditMode(false);
    const defaults = {};
    platform.fields.forEach(f => { defaults[f.key] = f.defaultValue ?? ''; });
    setForm(defaults);
    onUpdate?.();
  };

  const requiredMissing = platform.fields
    .filter(f => !f.optional && !saved[f.key])
    .length;

  const statusOk = configured && requiredMissing === 0;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className={`rounded-xl border transition-colors duration-200 ${
        expanded ? 'border-[#FF6B18]/30 bg-white' : 'border-[#e5e7eb] bg-white hover:border-[#d1d5db]'
      } shadow-card ${!enabled ? 'opacity-50' : ''}`}
    >
      {/* Card header */}
      <div className="flex items-center gap-3 p-4">
        <div className="shrink-0 rounded-lg overflow-hidden">
          <IntegrationIcon platformId={platform.id} size={36} />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-sm text-foreground">{platform.name}</span>
            {statusOk ? (
              <Badge variant="success" className="text-[10px] py-0">
                <CheckCircle2 size={9} /> Connected
              </Badge>
            ) : configured ? (
              <Badge variant="warning" className="text-[10px] py-0">
                <AlertCircle size={9} /> Incomplete
              </Badge>
            ) : (
              <Badge variant="outline" className="text-[10px] py-0 opacity-60">Not connected</Badge>
            )}
            <Badge variant="secondary" className="text-[10px] py-0 opacity-70">
              {platform.type === 'lms' ? 'LMS' : 'Knowledge Base'}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2 leading-relaxed">{desc}</p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Switch
            checked={enabled}
            onCheckedChange={setEnabled}
            aria-label={`${enabled ? 'Disable' : 'Enable'} ${platform.name}`}
          />
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground"
            onClick={() => setExpanded(e => !e)}
            aria-label={expanded ? 'Collapse' : 'Configure'}
          >
            {expanded ? <ChevronUp size={15} /> : <Settings2 size={15} />}
          </Button>
        </div>
      </div>

      {/* Expanded config */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <Separator className="mx-4" style={{ width: 'calc(100% - 2rem)' }} />
            <div className="p-4 pt-3 space-y-4">

              {/* Show masked saved values if configured and not in edit mode */}
              {configured && !editMode && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 mb-2">
                    <Lock size={12} className="text-[#059669]" />
                    <span className="text-xs font-medium text-[#059669]">Credentials saved &amp; encrypted</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {platform.fields.map(f => (
                      <div key={f.key} className="space-y-0.5">
                        <Label>{f.label}</Label>
                        {f.type === 'password' || f.key.toLowerCase().includes('secret') || f.key.toLowerCase().includes('token') || f.key.toLowerCase().includes('key') || f.key.toLowerCase().includes('password') ? (
                          <MaskedField value={saved[f.key]} />
                        ) : (
                          <span className="text-xs text-foreground font-mono truncate block">{saved[f.key] || <span className="text-muted-foreground italic">Not set</span>}</span>
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="flex gap-2 pt-1">
                    <Button variant="outline" size="sm" onClick={() => setEditMode(true)} className="h-7 text-xs">
                      Update credentials
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs text-destructive hover:text-destructive"
                      onClick={() => setShowDelete(true)}
                    >
                      <Trash2 size={11} /> Remove
                    </Button>
                  </div>
                  {showDelete && (
                    <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-3 flex items-center gap-3">
                      <AlertCircle size={14} className="text-destructive shrink-0" />
                      <span className="text-xs text-destructive flex-1">Remove all credentials for {platform.name}?</span>
                      <Button variant="destructive" size="sm" className="h-6 text-xs" onClick={handleDelete}>Confirm</Button>
                      <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => setShowDelete(false)}>Cancel</Button>
                    </div>
                  )}
                </div>
              )}

              {/* Config form — shown when not configured OR in edit mode */}
              {(!configured || editMode) && (
                <form onSubmit={handleSave} className="space-y-3">
                  {editMode && (
                    <div className="flex items-center gap-2 text-xs text-[#6b7280] bg-[#f3f4f6] rounded-lg px-3 py-2">
                      <Lock size={11} /> Leave any field blank to keep its existing encrypted value.
                    </div>
                  )}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {platform.fields.map(f => (
                      <div key={f.key} className="space-y-1.5">
                        <Label htmlFor={`${platform.id}-${f.key}`}>
                          {f.label}{f.optional ? <span className="text-muted-foreground"> (optional)</span> : ''}
                        </Label>
                        {f.type === 'select' ? (
                          <Select
                            value={form[f.key] || f.defaultValue || ''}
                            onValueChange={val => setForm(prev => ({ ...prev, [f.key]: val }))}
                          >
                            <SelectTrigger id={`${platform.id}-${f.key}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {f.options?.map(o => (
                                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <Input
                            id={`${platform.id}-${f.key}`}
                            type={f.type === 'password' ? 'password' : 'text'}
                            value={form[f.key] || ''}
                            onChange={e => setForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                            placeholder={editMode ? '(keep existing)' : (f.placeholder || '')}
                            required={!f.optional && !editMode}
                            autoComplete="off"
                            className="font-mono text-xs"
                          />
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="flex justify-end gap-2 pt-1">
                    {editMode && (
                      <Button type="button" variant="ghost" size="sm" onClick={() => setEditMode(false)}>Cancel</Button>
                    )}
                    <Button type="submit" variant="glow" size="sm" disabled={saving}>
                      {saving ? (
                        <><span className="spinner" style={{width:12,height:12,borderWidth:1.5}} />Saving…</>
                      ) : (
                        <><Check size={13} />{editMode ? 'Update' : 'Save credentials'}</>
                      )}
                    </Button>
                  </div>
                </form>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

export function IntegrationsManager({ open, onClose }) {
  const [tick, setTick] = useState(0); // force re-render after save

  const lmsPlatforms = PUBLISH_PLATFORMS.filter(p => p.type === 'lms');
  const kbPlatforms  = PUBLISH_PLATFORMS.filter(p => p.type === 'kb');

  const configuredCount = PUBLISH_PLATFORMS.filter(p => hasConfig(p.id)).length;

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm"
            onClick={onClose}
          />

          {/* Panel */}
          <motion.div
            key="panel"
            initial={{ x: '100%', opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: '100%', opacity: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            className="fixed right-0 top-0 h-full z-[61] w-full max-w-2xl bg-[#F7F7F0] border-l border-[#e5e7eb] shadow-elevated flex flex-col"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-5 border-b border-[#e5e7eb] shrink-0 bg-white">
              <div>
                <h2 className="text-lg font-bold text-foreground">Integrations</h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {configuredCount} of {PUBLISH_PLATFORMS.length} connected
                </p>
              </div>
              <Button variant="ghost" size="icon" onClick={onClose} className="text-muted-foreground">
                <X size={18} />
              </Button>
            </div>

            {/* Tabs */}
            <div className="px-6 pt-4 shrink-0">
              <Tabs defaultValue="lms">
                <TabsList className="w-full">
                  <TabsTrigger value="lms" className="flex-1">
                    LMS Platforms
                    <Badge variant="secondary" className="ml-1.5 text-[10px] h-4 px-1.5">
                      {lmsPlatforms.filter(p => hasConfig(p.id)).length}/{lmsPlatforms.length}
                    </Badge>
                  </TabsTrigger>
                  <TabsTrigger value="kb" className="flex-1">
                    Knowledge Bases
                    <Badge variant="secondary" className="ml-1.5 text-[10px] h-4 px-1.5">
                      {kbPlatforms.filter(p => hasConfig(p.id)).length}/{kbPlatforms.length}
                    </Badge>
                  </TabsTrigger>
                </TabsList>

                <ScrollArea className="h-[calc(100vh-280px)] mt-4 pr-1">
                  <TabsContent value="lms" className="mt-0 space-y-3 pb-4">
                    {lmsPlatforms.map(p => (
                      <PlatformCard key={p.id} platform={p} onUpdate={() => setTick(t => t + 1)} />
                    ))}
                  </TabsContent>
                  <TabsContent value="kb" className="mt-0 space-y-3 pb-4">
                    {kbPlatforms.map(p => (
                      <PlatformCard key={p.id} platform={p} onUpdate={() => setTick(t => t + 1)} />
                    ))}
                  </TabsContent>
                </ScrollArea>
              </Tabs>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
