// Electron main for the README hero image (hero-image.mjs runs it): puts a Claude Code chat window in
// front of the app window's screenshot, in an offscreen page, at 2x: one rectangle the window's size.
// The chat window copies the website's agent prompt (apps/website/components/AgentPrompt.tsx,
// AgentPrompt.module.css, Board.module.css .window/.titlebar) in its active look, a little larger
// and with a stronger shadow, so it reads as a separate window in front of the app's lower-left corner.
// Usage: electron compose.cjs <app-window.png> <out.png> <scratch dir>
const { app, BrowserWindow } = require('electron')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')

const [appPng, outPng, scratch] = process.argv.slice(-3)
const CLAUDE = 'm4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z'
// The canvas is the app window, 1280 x 720 CSS px, at 2x: one plain rectangle. The capture's rounded
// corners are filled with the app's own colours (read from the capture: the top bar, the board).
const W = 1280
const H = 720
const SCALE = 2
// The chat window: the site's 340 px window at K, in front of the app's lower-left corner, inside the picture.
const K = 1.2
const CHAT = { left: 22, bottom: 30 }

const logo = (size) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path d="${CLAUDE}" fill="#d97757"/></svg>`
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
html, body { margin: 0; background: transparent; }
body { width: ${W}px; height: ${H}px; position: relative; overflow: hidden; zoom: ${SCALE};
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
.back { position: absolute; inset: 0; }
.shot { position: absolute; left: 0; top: 0; width: ${W}px; height: ${H}px; }
.chat { position: absolute; left: ${CHAT.left}px; bottom: ${CHAT.bottom}px; width: 340px; transform-origin: bottom left; transform: rotate(-2deg) scale(${K});
  border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 11px; background: #161618; overflow: hidden;
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.06) inset, 0 24px 60px rgba(0, 0, 0, 0.75), 0 6px 18px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(0, 0, 0, 0.5); }
.titlebar { position: relative; display: flex; align-items: center; gap: 8px; height: 28px; padding-left: 16px; background: #232327; }
.titlebar i { width: 12px; height: 12px; border-radius: 50%; background: #ff5f57; }
.titlebar i:nth-child(2) { background: #febc2e; }
.titlebar i:nth-child(3) { background: #28c840; }
.title { position: absolute; left: 50%; translate: -50% 0; display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 500; color: #a0a0a8; white-space: nowrap; }
.body { padding: 14px 14px 16px; font-size: 13px; line-height: 18px; }
.message { display: grid; justify-items: end; align-items: start; }
.bubble { max-width: 82%; padding: 7px 12px; border-radius: 14px; background: #232327; color: #ececef; }
.reply { display: flex; align-items: center; gap: 7px; margin-top: 10px; color: #a0a0a8; }
.reply svg { flex: none; }
</style></head><body>
<div class="back"></div>
<img class="shot" src="${pathToFileURL(appPng).href}">
<div class="chat">
  <div class="titlebar"><i></i><i></i><i></i><span class="title">${logo(13)}Claude Code</span></div>
  <div class="body">
    <div class="message"><span class="bubble">Make a hero image for our README</span></div>
    <div class="reply">${logo(14)}Drawing it on the board…</div>
  </div>
</div>
</body></html>`

app.whenReady().then(async () => {
  const page = join(scratch, 'compose.html')
  writeFileSync(page, html)
  const win = new BrowserWindow({ show: false, width: W * SCALE, height: H * SCALE, useContentSize: true, frame: false, transparent: true, backgroundColor: '#00000000', webPreferences: { offscreen: true } })
  await win.loadFile(page)
  await win.webContents.executeJavaScript('Promise.all([...document.images].map((i) => i.decode())).then(() => document.fonts.ready)')
  // The corner fill: the top bar's colour behind the top corners, the board's behind the bottom ones (pixels next to the corners).
  await win.webContents.executeJavaScript(`(() => {
    const img = document.querySelector('.shot'), c = document.createElement('canvas')
    c.width = img.naturalWidth; c.height = img.naturalHeight
    const g = c.getContext('2d'); g.drawImage(img, 0, 0)
    const at = (x, y) => { const d = g.getImageData(x, y, 1, 1).data; return 'rgb(' + d[0] + ',' + d[1] + ',' + d[2] + ')' }
    const s = img.naturalHeight / ${H}
    const bar = at(Math.round(c.width / 2), Math.round(4 * s)), board = at(Math.round(3 * s), Math.round(c.height - 40 * s))
    document.querySelector('.back').style.background = 'linear-gradient(' + bar + ' 0 50%, ' + board + ' 50% 100%)'
  })()`)
  await win.webContents.executeJavaScript('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))')
  await new Promise((r) => setTimeout(r, 300))
  let image = await win.webContents.capturePage()
  const size = image.getSize()
  if (size.width !== W * SCALE) image = image.resize({ width: W * SCALE, height: H * SCALE, quality: 'best' })
  writeFileSync(outPng, image.toPNG())
  console.log(JSON.stringify({ out: outPng, captured: size, size: image.getSize() }))
  app.quit()
}).catch((error) => { console.error(error); app.exit(1) })
