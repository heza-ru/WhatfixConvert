// lib/brand-kit.js — Brand Kit localStorage helpers

const BRAND_KIT_KEY = 'wtfx_brand_kit';

export const DEFAULT_BRAND_KIT = {
  logoB64:      null,
  primaryColor: '#FF6B18',
  accentColor:  '#25223B',
  fontFamily:   'Segoe UI',
  companyName:  '',
  footerText:   '',
};

export function loadBrandKit() {
  try {
    const saved = JSON.parse(localStorage.getItem(BRAND_KIT_KEY) || 'null');
    if (saved && typeof saved === 'object') return { ...DEFAULT_BRAND_KIT, ...saved };
  } catch {}
  return { ...DEFAULT_BRAND_KIT };
}

export function saveBrandKit(kit) {
  try { localStorage.setItem(BRAND_KIT_KEY, JSON.stringify(kit)); } catch {}
}
