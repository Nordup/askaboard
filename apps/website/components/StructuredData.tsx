import { DOWNLOAD_URL, REPO_URL, SITE_DESCRIPTION, SITE_NAME, SITE_URL, SOCIAL_IMAGE } from '@/lib/site'

/**
 * The page's structured data (schema.org JSON-LD) for search engines: the site and its name, the
 * maker, and the app. Every value is a fact the page shows: free, open source (MIT), for macOS.
 */
export function StructuredData() {
  const home = `${SITE_URL}/`
  const organization = `${home}#organization`
  const data = {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebSite', '@id': `${home}#website`, name: SITE_NAME, url: home, publisher: { '@id': organization } },
      {
        '@type': 'Organization',
        '@id': organization,
        name: SITE_NAME,
        url: home,
        logo: { '@type': 'ImageObject', url: `${SITE_URL}/apple-touch-icon.png`, width: 180, height: 180 },
        sameAs: [REPO_URL]
      },
      {
        '@type': 'SoftwareApplication',
        name: SITE_NAME,
        operatingSystem: 'macOS',
        applicationCategory: 'EducationalApplication',
        description: SITE_DESCRIPTION,
        url: home,
        downloadUrl: DOWNLOAD_URL,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        license: 'https://opensource.org/licenses/MIT',
        image: `${SITE_URL}${SOCIAL_IMAGE}`,
        publisher: { '@id': organization }
      }
    ]
  }
  // `<` as <, so no string in the data can close the script (the Next.js JSON-LD guide).
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, '\\u003c') }} />
}
