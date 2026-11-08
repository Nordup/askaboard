import type { MetadataRoute } from 'next'
import { SITE_URL } from '@/lib/site'

/** robots.txt: every crawler may read every page (and /_next/, whose scripts and styles render the page). */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/' },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL
  }
}
