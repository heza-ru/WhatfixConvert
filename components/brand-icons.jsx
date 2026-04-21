const BRANDFETCH_DOMAINS = {
  whatfix:        'whatfix.com',
  workday:        'workday.com',
  linkedin:       'linkedin.com',
  cornerstone:    'cornerstoneondemand.com',
  docebo:         'docebo.com',
  '360learning':  '360learning.com',
  absorb:         'absorblms.com',
  degreed:        'degreed.com',
  sharepoint:     'microsoft.com',
  servicenow:     'servicenow.com',
  guru:           'getguru.com',
  confluence:     'atlassian.com',
  notion:         'notion.so',
  zendesk:        'zendesk.com',
  successfactors: 'successfactors.com',
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
  const domain = BRANDFETCH_DOMAINS[platformId];

  if (domain) {
    return (
      <div
        style={{ width: size, height: size }}
        className="rounded-xl shrink-0 overflow-hidden bg-white border border-[#e5e7eb] flex items-center justify-center"
      >
        <img
          src={`https://cdn.brandfetch.io/${domain}/w/128/h/128/icon`}
          alt={platformId}
          width={size}
          height={size}
          style={{ objectFit: 'contain', display: 'block', width: '100%', height: '100%' }}
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
