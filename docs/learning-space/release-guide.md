# Publishing a macOS release

Status: 2026-11-07. This is the release plan and the local build recipe,
not a published release. The founder wants release automation later, when
GitHub is ready. Do not create a workflow, publish a release, push, or deploy
as part of this documentation step. Ask before pushing. The repository's
website deployment policy in `AGENTS.md` keeps the website local-only until
the founder explicitly revokes that rule.

## Where each part goes

- **App and source:** this repository. The current Git remote is
  `Nordup/math-tutor`; the final public repository name and URL wait for the
  brand. The plugin remains in the separate `learning-space-plugins` repo.
- **Mac download:** planned for GitHub Releases on the public app repo. A
  release holds a versioned tag, release notes and the signed DMG as a
  release asset. Do not commit the DMG to Git or Git LFS.
- **Website:** the planned host is Vercel. Its Download for Mac button should
  link directly to the GitHub release asset; the website does not serve the
  226 MiB file itself. Deployment remains blocked by the rule above.
- **Voice and analytics:** the existing private backend on Hetzner stays
  separate. It is not the file download host.

Use one universal download by default (D14). It runs natively on Apple
Silicon and Intel. A build on 2026-11-07 made a 226 MiB universal DMG;
separate arm64 and x64 DMGs were 127 MiB and 134 MiB. Both separate builds
remain available, but smaller downloads and automatic selection can wait.

## What is ready and what is not

- `space/scripts/dist-mac.mjs` builds the app, signs and notarizes the app
  and DMG, staples the DMG ticket and checks Gatekeeper. It fails if the
  Developer ID identity or notarytool profile is unavailable. A universal
  build passed these checks on 2026-11-07; the app inside has both CPU
  architectures and a valid ticket.
- A signed, notarized **arm64** DMG was copied to `~/Applications` and opened
  on the founder's Mac. This was not a clean Mac. A fresh download, install,
  plugin connection and voice flow on a clean Mac remain open; a real Intel
  Mac has not been checked. A normal macOS first-open confirmation may appear.
- The [Askaboard brand kit](../../assets/askaboard/README.md) supplies the Mac packaging icon and website artwork.
  The app still uses Learning Space, version `0.0.1`, and bundle ID
  `app.learningspace.desktop`. Review local data, updates and plugin
  connections before changing the app identity. The public repo URL, release
  version and website domain remain open.
- The release script creates **local artifacts only**. GitHub release upload,
  publishing, website deployment, update delivery and CI are not set up.
  Installing this build does not configure automatic app updates.

## Before the first public release

1. Set the desktop release name and version in `space/package.json`. Decide
   whether to retain the current bundle ID after checking migration and
   plugin behavior. The Askaboard packaging icon is `space/resources/icon.png`.
   Check other branding and links.
2. Review the app repository and its history for material that should not be
   public, including credentials and private data. Check the license, README,
   setup steps and the separate public plugin repo. Confirm the final GitHub
   repository, permissions, visibility and release/tag convention with the
   founder. The current `origin` exists; do not assume it is public or that
   its current name is final.
3. Check the deployed voice and analytics services, rate/cost controls,
   privacy notice and the plugin installation path. PostHog project 714991
   had `anonymize_ips: false` on 2026-11-07, as planned (P24); this means the
   project setting does not discard client IP data. The backend price update
   due before 2027-01-01 is in `launch-plan.md`.
4. Reconcile the bundled Claude Desktop extension before packaging. On
   2026-11-07, `space/resources/learning-space.mcpb` reported version 0.1.3,
   while the sibling plugin repo's `claude-extensions/learning-space/dist/learning-space.mcpb`
   reported 0.1.2. `npm run build` and `dist:mac` do not run
   `build:mcpb`; that separate command copies the sibling artifact if it
   exists, otherwise it creates a stand-in. Check the source and release
   versions, rebuild the intended plugin artifact using its repo README,
   and deliberately bundle it before building the app. Do not overwrite
   the newer 0.1.3 with the older 0.1.2. Verify what the final DMG contains.
5. Build the exact release after the final changes. Install and open the
   actual downloaded DMG on a clean Mac; complete folder setup, connect an
   agent through the public plugin and play a voiced scene. Check on Apple
   Silicon and an Intel Mac when available. Follow the no-tests rule in
   `AGENTS.md`; use the real app and its tools for checks.

## Build on the configured Mac

The login keychain has a valid **Developer ID Application** identity for
team `CDA73N3FRP`, expiring 2027-12-07. The notarytool profile is
`learning-space-notary`. A password-protected `.p12` backup is in the
founder's private storage. The founder was asked to
store its password separately; that storage has not been verified. Never put
the private key, backup password, app-specific password or other secrets in
the repository, logs or chat.
A replacement Mac needs the identity and its private key imported into
Keychain Access and a working notarytool credential profile.

```sh
cd space
npm run dist:mac
```

The artifact is `space/release/<productName>-<version>-universal.dmg`.
The command uses `stable` telemetry, notarizes the app before packaging,
then signs, notarizes, staples and checks the DMG. Apple processing takes
several minutes. It exits on a failed check; do not treat a file left by a
failed run as releasable. Optional builds: `npm run dist:mac -- --arm64`
or `npm run dist:mac -- --x64`. A different notarytool profile can be named
with `APPLE_KEYCHAIN_PROFILE`.

To recheck a finished DMG, replace `<dmg>` with its local path:

```sh
xcrun stapler validate "<dmg>"
spctl -a -vv -t open --context context:primary-signature "<dmg>"
```

Gatekeeper should report `accepted` and `Notarized Developer ID`. Check the
app inside the mounted DMG too. A DMG and its enclosed app both need the
right signatures and notarization; app notarization alone is not evidence
that the DMG itself passes the disk-image check.

## Publish later, when authorized

1. Confirm the exact commit, version, GitHub repository, tag and release
   notes. Check the working tree and any other active work before committing;
   never sweep unrelated edits into the release. Ask before pushing.
2. Create a draft release against the approved commit and attach the exact
   verified universal DMG. Keep a stable **asset filename** across releases,
   even though the local build filename includes the version. A copy or rename
   of the finished DMG does not change its contents; validate the uploaded
   artifact and download it back for the clean-Mac check.
3. Make the release public only when the founder has authorized publication.
   Do not rely on a private repo's asset link for public users. Drafts and
   prereleases must not be assumed to be the public `latest` release.
4. After the public release exists, replace the `#download` placeholder in
   `apps/website/components/DownloadButton.tsx` with the observed GitHub URL.
   Check the working name and repo URL in `apps/website/lib/site.ts` too.
   GitHub documents the pattern
   `https://github.com/OWNER/REPO/releases/latest/download/ASSET-NAME` for
   a manually uploaded asset. `OWNER`, `REPO` and `ASSET-NAME` are
   placeholders here; do not ship this example URL. Check the link from a
   signed-out browser and confirm it downloads the correct version.
5. Deploy the website only after the founder explicitly lifts its local-only
   rule and authorizes the deployment. Verify the live download and plugin
   instructions after publication.

Later, automate the approved flow after GitHub, release names and hosting are
settled: a reproducible build on an appropriate macOS runner, protected signing
and notarization credentials, upload to a draft release, and a deliberate
publication step. Decide how to protect CI credentials and how versioning,
release notes and updates work before implementing it. Never print secrets or
put a signing identity in source control. A GitHub release does not by itself
add an updater to the app.

References (checked 2026-11-07): [GitHub release assets and limits](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases),
[GitHub latest release links](https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases),
[Apple universal binaries](https://developer.apple.com/documentation/apple-silicon/building-a-universal-macos-binary),
[Vercel plans](https://vercel.com/docs/plans).
