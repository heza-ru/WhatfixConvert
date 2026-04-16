// Icons sourced from:
//   - Simple Icons CDN (cdn.simpleicons.org) — confirmed slugs only
//   - Google Favicon service (sz=128) — for all others

// Only slugs confirmed to exist in the Simple Icons catalog
const SI_SLUGS = {
  confluence:     'confluence',
  notion:         'notion',
  zendesk:        'zendesk',
  successfactors: 'sap',
};

// All others use Google's favicon service (reliable, no slug guessing)
const FAVICON_DOMAINS = {
  whatfix:        'whatfix.com',
  workday:        'workday.com',
  linkedin:       'linkedin.com',
  cornerstone:    'cornerstoneondemand.com',
  docebo:         'docebo.com',
  '360learning':  '360learning.com',
  absorb:         'absorblms.com',
  degreed:        'degreed.com',
  sharepoint:     'sharepoint.com',
  servicenow:     'servicenow.com',
  guru:           'getguru.com',
};

const BRAND_COLORS = {
  whatfix:        '#FF6B18',
  workday:        '#0875E1',
  successfactors: '#008FD3',
  cornerstone:    '#F9423A',
  docebo:         '#00B4D6',
  linkedin:       '#0077B5',
  '360learning':  '#FF5D39',
  absorb:         '#5B2D8E',
  degreed:        '#1A1A2E',
  confluence:     '#0052CC',
  sharepoint:     '#0078D4',
  notion:         '#000000',
  zendesk:        '#03363D',
  servicenow:     '#293E40',
  guru:           '#4D3C9B',
};

export function IntegrationIcon({ platformId, size = 32 }) {
  const color = BRAND_COLORS[platformId] ?? '#6b7280';
  const label = platformId?.[0]?.toUpperCase() ?? '?';

  // Simple Icons: SVG with transparent bg — pad slightly so the icon breathes
  if (SI_SLUGS[platformId]) {
    const pad = Math.round(size * 0.18);
    return (
      <div
        style={{ width: size, height: size, padding: pad }}
        className="rounded-xl bg-white border border-[#e5e7eb] flex items-center justify-center shrink-0 overflow-hidden"
      >
        <img
          src={`https://cdn.simpleicons.org/${SI_SLUGS[platformId]}`}
          alt={platformId}
          width={size - pad * 2}
          height={size - pad * 2}
          style={{ objectFit: 'contain', display: 'block' }}
          onError={e => replaceWithInitial(e.currentTarget, color, label, size)}
        />
      </div>
    );
  }

  // Favicons: rendered as-is at full size — they already contain their own background
  if (FAVICON_DOMAINS[platformId]) {
    return (
      <div
        style={{ width: size, height: size }}
        className="rounded-xl shrink-0 overflow-hidden"
      >
        <img
          src={`https://www.google.com/s2/favicons?domain=${FAVICON_DOMAINS[platformId]}&sz=128`}
          alt={platformId}
          width={size}
          height={size}
          style={{ objectFit: 'cover', display: 'block', width: '100%', height: '100%' }}
          onError={e => replaceWithInitial(e.currentTarget, color, label, size)}
        />
      </div>
    );
  }

  return <InitialBadge color={color} label={label} size={size} />;
}

function InitialBadge({ color, label, size }) {
  return (
    <div
      style={{ width: size, height: size, backgroundColor: color }}
      className="rounded-xl flex items-center justify-center shrink-0"
    >
      <span style={{ color: 'white', fontSize: Math.round(size * 0.38), fontWeight: 700 }}>
        {label}
      </span>
    </div>
  );
}

function replaceWithInitial(img, color, label, size) {
  const parent = img?.parentElement;
  if (!parent || parent.querySelector('[data-initial]')) return;
  parent.style.cssText += `;background-color:${color};border:none;`;
  img.style.display = 'none';
  const span = document.createElement('span');
  span.dataset.initial = '1';
  span.textContent = label;
  span.style.cssText = `color:white;font-size:${Math.round(size * 0.38)}px;font-weight:700;`;
  parent.appendChild(span);
}
