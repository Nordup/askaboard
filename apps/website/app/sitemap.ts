import type { MetadataRoute } from 'next'
import { SITE_URL, SOCIAL_IMAGE } from '@/lib/site'

/** sitemap.xml: the home page and the privacy page. The home page changes with each build, so the build time is its last change. */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: `${SITE_URL}/`,
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 1,
      images: [`${SITE_URL}${SOCIAL_IMAGE}`]
    },
    {
      url: `${SITE_URL}/privacy`,
      lastModified: new Date('2026-11-10'),
      changeFrequency: 'yearly',
      priority: 0.3
    }
  ]
}
