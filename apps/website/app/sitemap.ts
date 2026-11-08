import type { MetadataRoute } from 'next'
import { SITE_URL, SOCIAL_IMAGE } from '@/lib/site'

/** sitemap.xml: the one page. It changes with each build, so the build time is its last change. */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: `${SITE_URL}/`,
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 1,
      images: [`${SITE_URL}${SOCIAL_IMAGE}`]
    }
  ]
}
