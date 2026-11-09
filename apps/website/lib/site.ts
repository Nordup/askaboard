export const SITE_NAME = 'Askaboard'
/** The site's own address, without a trailing slash: the metadata base, robots.txt, the sitemap and the structured data (app/page.tsx) all use it. */
export const SITE_URL = (process.env.ASKABOARD_SITE_URL || 'https://askaboard.com').replace(/\/+$/, '')
/** The page's description: the meta tags and the structured data. */
export const SITE_DESCRIPTION = 'Your agent explains any topic on a shared board. It draws, animates and talks.'
/** The social preview image (1200 × 630). */
export const SOCIAL_IMAGE = '/askaboard-social.png'
export const REPO = 'Nordup/askaboard'
export const REPO_URL = `https://github.com/${REPO}`
/** The newest public GitHub release's Mac download. Every release keeps the asset name Askaboard.dmg. */
export const DOWNLOAD_URL = `${REPO_URL}/releases/latest/download/Askaboard.dmg`
/** The repo's GitHub Discussions: questions and ideas. */
export const DISCUSSIONS_URL = `${REPO_URL}/discussions`
/** The public plugin repo: the Claude Code, ChatGPT and Codex, Cursor plugins and the Claude Desktop extension. */
export const PLUGINS_URL = 'https://github.com/Nordup/askaboard-plugins'
/** The privacy page (app/privacy/page.tsx). */
export const PRIVACY_URL = '/privacy'
