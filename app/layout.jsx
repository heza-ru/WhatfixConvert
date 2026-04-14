import './globals.css';

const BASE_URL = 'https://whatfxconvert.vercel.app';

export const metadata = {
  metadataBase: new URL(BASE_URL),
  title: 'OdArc & DKP Converter — Oracle UPK & SAP Enable Now to PDF/DOCX/PPTX',
  description: 'Convert Oracle UPK (.odarc) and SAP Enable Now (.dkp) files to annotated PDF, Word, and PowerPoint guides. Runs entirely in your browser — no upload, no server.',
  keywords: ['odarc converter', 'oracle upk', 'sap enable now', 'dkp converter', 'pdf guide', 'docx', 'pptx', 'whatfix'],
  authors: [{ name: 'Whatfix' }],
  robots: { index: true, follow: true },
  alternates: { canonical: BASE_URL },
  openGraph: {
    type: 'website',
    url: BASE_URL,
    title: 'OdArc & DKP Converter — Oracle UPK & SAP Enable Now to PDF/DOCX/PPTX',
    description: 'Convert .odarc and .dkp files to annotated guides in your browser. No upload required.',
    siteName: 'OdArc Converter',
    images: [{ url: '/og-image.png', width: 1200, height: 630, alt: 'OdArc Converter by Whatfix' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'OdArc & DKP Converter — Oracle UPK & SAP Enable Now to PDF/DOCX/PPTX',
    description: 'Convert .odarc and .dkp files to annotated guides in your browser.',
    images: ['/og-image.png'],
  },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
};

export default function RootLayout({ children }) {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'OdArc Converter',
    applicationCategory: 'BusinessApplication',
    description: metadata.description,
    url: BASE_URL,
    author: { '@type': 'Organization', name: 'Whatfix' },
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    featureList: [
      'Convert Oracle UPK .odarc files',
      'Convert SAP Enable Now .dkp files',
      'Export to PDF, DOCX, PPTX',
      'Browser-only — no file upload to server',
    ],
  };

  return (
    <html lang="en">
      <head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
